"""Chat image attachments.

- POST /rooms/{id}/chat/image as a multipart upload → returns a chat
  message with `attachment_image_url` set.
- GET on the served URL with query-string auth returns the webp.
- Non-member can't upload (403) or fetch (403).
"""
from __future__ import annotations

import io
import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


def _make_png() -> bytes:
    from PIL import Image

    im = Image.new("RGB", (64, 64), color=(20, 200, 80))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture()
def app(tmp_path):
    os.environ["BIBLE_IU_DATABASE_URL"] = f"sqlite:///{tmp_path}/test.sqlite"
    os.environ["BIBLE_IU_UPLOADS_DIR"] = str(tmp_path / "uploads")
    import backend.data.db as db_mod

    reload(db_mod)
    import backend.api.main as main_mod

    reload(main_mod)
    return main_mod.app


@pytest.fixture()
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def _register(client: TestClient, h: str) -> dict:
    r = client.post(
        "/auth/register",
        json={"handle": h, "password": "password1234", "display_name": h},
    )
    me = client.get("/auth/me", headers={"X-Session-Token": r.json()["token"]})
    return {"token": r.json()["token"], "user_id": me.json()["id"]}


def _hdr(t: str) -> dict:
    return {"X-Session-Token": t}


class TestChatImageUpload:
    def test_member_can_attach_image(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={
                "type": "group",
                "name": "Study",
                "member_ids": [bob["user_id"]],
            },
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        r = client.post(
            f"/rooms/{room_id}/chat/image",
            headers=_hdr(alice["token"]),
            data={"body": "look at this"},
            files={"file": ("a.png", _make_png(), "image/png")},
        )
        assert r.status_code == 200, r.text
        msg = r.json()
        assert msg["body"] == "look at this"
        assert msg["attachment_image_url"]
        assert msg["attachment_image_url"].startswith(
            f"/rooms/{room_id}/chat/{msg['id']}/image?v="
        )

    def test_listing_returns_attachment_url(self, client):
        alice = _register(client, "alice")
        room_id = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        client.post(
            f"/rooms/{room_id}/chat/image",
            headers=_hdr(alice["token"]),
            data={"body": ""},
            files={"file": ("a.png", _make_png(), "image/png")},
        )
        msgs = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(alice["token"])
        ).json()
        assert len(msgs) == 1
        assert msgs[0]["attachment_image_url"]

    def test_member_can_fetch_via_query_auth(self, client):
        alice = _register(client, "alice")
        room_id = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        msg = client.post(
            f"/rooms/{room_id}/chat/image",
            headers=_hdr(alice["token"]),
            data={"body": ""},
            files={"file": ("a.png", _make_png(), "image/png")},
        ).json()
        url = msg["attachment_image_url"]
        r = client.get(f"{url}&session={alice['token']}")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/webp"
        assert r.content[:4] == b"RIFF"

    def test_non_member_cannot_upload(self, client):
        alice = _register(client, "alice")
        carol = _register(client, "carol")
        room_id = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        r = client.post(
            f"/rooms/{room_id}/chat/image",
            headers=_hdr(carol["token"]),
            data={"body": ""},
            files={"file": ("a.png", _make_png(), "image/png")},
        )
        assert r.status_code == 403

    def test_reply_to_id_threads_parent_preview(self, client):
        """Replies carry the parent's body, author handle, and an
        `image` flag so the bubble can render the quoted preview."""
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        room_id = client.post(
            "/rooms",
            json={
                "type": "group",
                "name": "Study",
                "member_ids": [bob["user_id"]],
            },
            headers=_hdr(alice["token"]),
        ).json()["id"]
        parent = client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "first thought"},
            headers=_hdr(alice["token"]),
        ).json()
        reply = client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "agreed", "reply_to_id": parent["id"]},
            headers=_hdr(bob["token"]),
        ).json()
        assert reply["reply_to_id"] == parent["id"]
        assert reply["reply_to_body"] == "first thought"
        assert reply["reply_to_author_handle"] == "alice"
        assert reply["reply_to_has_image"] is False
        # List endpoint hydrates the same fields on each reply.
        msgs = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(alice["token"])
        ).json()
        listed_reply = next(m for m in msgs if m["id"] == reply["id"])
        assert listed_reply["reply_to_body"] == "first thought"

    def test_reply_to_id_must_belong_to_room(self, client):
        alice = _register(client, "alice")
        other = client.post(
            "/rooms",
            json={"type": "group", "name": "Other"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        cross_msg = client.post(
            f"/rooms/{other}/chat",
            json={"body": "hi"},
            headers=_hdr(alice["token"]),
        ).json()
        target = client.post(
            "/rooms",
            json={"type": "group", "name": "Target"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        r = client.post(
            f"/rooms/{target}/chat",
            json={"body": "x", "reply_to_id": cross_msg["id"]},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 400

    def test_non_member_cannot_fetch(self, client):
        alice = _register(client, "alice")
        carol = _register(client, "carol")
        room_id = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        ).json()["id"]
        msg = client.post(
            f"/rooms/{room_id}/chat/image",
            headers=_hdr(alice["token"]),
            data={"body": ""},
            files={"file": ("a.png", _make_png(), "image/png")},
        ).json()
        url = msg["attachment_image_url"]
        r = client.get(f"{url}&session={carol['token']}")
        assert r.status_code == 403

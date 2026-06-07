"""POST /dm/{user_id} — find-or-create direct room.

- Two users tap each other's avatars → same room each time (idempotent).
- DMing yourself is rejected.
- Unknown target user → 404.
- ChatMessageRead now includes author_avatar_url.
"""
from __future__ import annotations

import io
import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


def _make_png_bytes() -> bytes:
    from PIL import Image

    im = Image.new("RGB", (32, 32), color=(200, 100, 50))
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


def _register(client: TestClient, handle: str) -> dict:
    r = client.post(
        "/auth/register",
        json={"handle": handle, "password": "password1234", "display_name": handle},
    )
    me = client.get("/auth/me", headers={"X-Session-Token": r.json()["token"]})
    return {"token": r.json()["token"], "user_id": me.json()["id"]}


def _hdr(t: str) -> dict:
    return {"X-Session-Token": t}


class TestDirectMessage:
    def test_creates_room(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            f"/dm/{bob['user_id']}", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["type"] == "direct"
        assert body["role"] == "member"

    def test_idempotent(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r1 = client.post(
            f"/dm/{bob['user_id']}", headers=_hdr(alice["token"])
        )
        r2 = client.post(
            f"/dm/{bob['user_id']}", headers=_hdr(alice["token"])
        )
        assert r1.json()["id"] == r2.json()["id"], (
            "tapping the same avatar twice must return the same room"
        )

    def test_either_side_finds_the_same_room(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        a = client.post(
            f"/dm/{bob['user_id']}", headers=_hdr(alice["token"])
        ).json()
        b = client.post(
            f"/dm/{alice['user_id']}", headers=_hdr(bob["token"])
        ).json()
        assert a["id"] == b["id"]

    def test_dm_self_rejected(self, client):
        alice = _register(client, "alice")
        r = client.post(
            f"/dm/{alice['user_id']}", headers=_hdr(alice["token"])
        )
        assert r.status_code == 400

    def test_unknown_user_is_404(self, client):
        alice = _register(client, "alice")
        r = client.post(
            "/dm/not-a-real-user-id", headers=_hdr(alice["token"])
        )
        assert r.status_code == 404


class TestChatAvatarInPayload:
    def test_message_carries_author_avatar_url(self, client):
        """ChatMessageRead now has `author_avatar_url`. After bob
        uploads his photo, alice's chat list returns it on every
        message bob authored."""
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        # Group with both members
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
        # Bob posts a message — initially no avatar URL.
        client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "hello"},
            headers=_hdr(bob["token"]),
        )
        msgs = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(alice["token"])
        ).json()
        bob_msg = next(m for m in msgs if m["author_handle"] == "bob")
        assert bob_msg["author_avatar_url"] is None
        # Bob uploads a photo.
        client.post(
            "/auth/me/image",
            headers=_hdr(bob["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        # Bob posts a second message — should now carry the URL.
        client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "world"},
            headers=_hdr(bob["token"]),
        )
        msgs = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(alice["token"])
        ).json()
        latest_bob = [m for m in msgs if m["author_handle"] == "bob"][-1]
        assert latest_bob["author_avatar_url"] is not None
        assert latest_bob["author_avatar_url"].startswith(
            f"/auth/users/{bob['user_id']}/image?v="
        )

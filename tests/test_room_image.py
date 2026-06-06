"""Room avatar upload + admin gating.

Covers:
  • Non-admin members can't upload, can't delete.
  • Admin uploads a JPEG → server returns a webp URL whose token
    changes on every re-upload (cache busting works).
  • Members can GET the image; non-members cannot.
  • DELETE clears the file + the URL.
  • Oversize and non-image payloads are refused with 413 / 415.
"""
from __future__ import annotations

import io
import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


def _make_png_bytes(size_px: int = 64) -> bytes:
    from PIL import Image

    im = Image.new("RGB", (size_px, size_px), color=(50, 150, 240))
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
    assert r.status_code == 200, r.text
    me = client.get("/auth/me", headers={"X-Session-Token": r.json()["token"]})
    return {"token": r.json()["token"], "user_id": me.json()["id"]}


def _hdr(token: str) -> dict:
    return {"X-Session-Token": token}


def _make_room(client: TestClient, owner: dict, name: str = "Study") -> str:
    r = client.post(
        "/rooms",
        json={"type": "group", "name": name},
        headers=_hdr(owner["token"]),
    )
    return r.json()["id"]


class TestRoomImageUpload:
    def test_admin_can_upload_and_url_changes_each_time(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        # First upload
        r = client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("avatar.png", _make_png_bytes(), "image/png")},
        )
        assert r.status_code == 200, r.text
        url_a = r.json()["image_url"]
        assert url_a is not None
        assert url_a.startswith(f"/rooms/{room_id}/image?v=")
        # Re-upload — the token portion of the URL should rotate so
        # browsers refetch instead of serving the cached old image.
        r = client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("avatar2.png", _make_png_bytes(), "image/png")},
        )
        assert r.status_code == 200
        url_b = r.json()["image_url"]
        assert url_b and url_b != url_a, "image URL must change after re-upload"
        # And the room list reflects the new URL with the new token.
        rooms = client.get("/rooms", headers=_hdr(alice["token"])).json()
        mine = next(r for r in rooms if r["id"] == room_id)
        assert mine["image_url"] == url_b

    def test_non_admin_cannot_upload(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        # Alice creates the room with bob as a regular member.
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study", "member_ids": [bob["user_id"]]},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        r = client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(bob["token"]),
            files={"file": ("evil.png", _make_png_bytes(), "image/png")},
        )
        assert r.status_code == 403

    def test_oversize_upload_refused(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        # 21MB of zero bytes — over the 20MB raw cap. Doesn't need to
        # be a real image; the size check fires before decoding.
        oversize = b"\x00" * (21 * 1024 * 1024)
        r = client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("big.png", oversize, "image/png")},
        )
        assert r.status_code == 413

    def test_non_image_payload_refused(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        r = client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("notes.txt", b"hello world", "text/plain")},
        )
        assert r.status_code == 415


class TestRoomImageRead:
    def test_member_can_fetch_image(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study", "member_ids": [bob["user_id"]]},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        r = client.get(f"/rooms/{room_id}/image", headers=_hdr(bob["token"]))
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/webp"
        assert r.content[:4] == b"RIFF"  # webp magic

    def test_non_member_cannot_fetch_image(self, client):
        alice = _register(client, "alice")
        carol = _register(client, "carol")  # not in the room
        room_id = _make_room(client, alice)
        client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        r = client.get(f"/rooms/{room_id}/image", headers=_hdr(carol["token"]))
        assert r.status_code == 403

    def test_member_can_fetch_via_query_string_auth(self, client):
        """Browser `<img>` loaders can't send custom headers, so the
        GET also accepts `?session=...` (and the deployment password,
        when set). Locks in the auth fallback the frontend relies on."""
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        # No header — just query string. Test env has no app password.
        r = client.get(
            f"/rooms/{room_id}/image?session={alice['token']}",
        )
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/webp"

    def test_404_when_no_image_set(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        r = client.get(f"/rooms/{room_id}/image", headers=_hdr(alice["token"]))
        assert r.status_code == 404


class TestRoomAccent:
    """PATCH /rooms/{id}/accent — admin-only, validates against the
    server-side palette so the column can't hold arbitrary strings."""

    def test_admin_can_set_and_clear(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        # Default: no accent (auto-derived on the frontend).
        rooms = client.get("/rooms", headers=_hdr(alice["token"])).json()
        assert next(r for r in rooms if r["id"] == room_id)["accent_color"] is None
        # Set one.
        r = client.patch(
            f"/rooms/{room_id}/accent",
            json={"accent_color": "rose"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200, r.text
        assert r.json()["accent_color"] == "rose"
        # Listing reflects it.
        rooms = client.get("/rooms", headers=_hdr(alice["token"])).json()
        assert next(r for r in rooms if r["id"] == room_id)["accent_color"] == "rose"
        # Clear it.
        r = client.patch(
            f"/rooms/{room_id}/accent",
            json={"accent_color": None},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        assert r.json()["accent_color"] is None

    def test_rejects_unknown_color(self, client):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        r = client.patch(
            f"/rooms/{room_id}/accent",
            json={"accent_color": "neon-purple"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 400
        assert "accent_color must be one of" in r.json()["detail"]

    def test_non_admin_cannot_set(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study", "member_ids": [bob["user_id"]]},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        r = client.patch(
            f"/rooms/{room_id}/accent",
            json={"accent_color": "amber"},
            headers=_hdr(bob["token"]),
        )
        assert r.status_code == 403


class TestRoomImageDelete:
    def test_admin_delete_clears_url_and_file(self, client, tmp_path):
        alice = _register(client, "alice")
        room_id = _make_room(client, alice)
        client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        # File exists on disk under the configured uploads dir.
        path = tmp_path / "uploads" / "rooms" / f"{room_id}.webp"
        assert path.exists()
        r = client.delete(
            f"/rooms/{room_id}/image", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200
        assert r.json()["image_url"] is None
        assert not path.exists()
        # Subsequent GET 404s.
        r = client.get(f"/rooms/{room_id}/image", headers=_hdr(alice["token"]))
        assert r.status_code == 404

    def test_non_admin_cannot_delete(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study", "member_ids": [bob["user_id"]]},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        client.post(
            f"/rooms/{room_id}/image",
            headers=_hdr(alice["token"]),
            files={"file": ("a.png", _make_png_bytes(), "image/png")},
        )
        r = client.delete(
            f"/rooms/{room_id}/image", headers=_hdr(bob["token"])
        )
        assert r.status_code == 403

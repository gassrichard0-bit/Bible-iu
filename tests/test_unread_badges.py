"""In-app unread badges — `unread_count` on GET /rooms + POST /rooms/{id}/read.

Coverage:
  • New room: unread_count is 0.
  • Bob posts → Alice's GET /rooms shows unread_count = 1.
  • Bob posts twice more → unread_count = 3.
  • Alice's OWN posts don't add to her own count.
  • POST /rooms/{id}/read clears the count back to 0.
  • Non-member can't mark read (403).
"""
from __future__ import annotations

import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app(tmp_path):
    os.environ["BIBLE_IU_DATABASE_URL"] = f"sqlite:///{tmp_path}/test.sqlite"
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


def _make_group(client: TestClient, owner: dict, others: list[dict]) -> str:
    r = client.post(
        "/rooms",
        json={
            "type": "group",
            "name": "Study",
            "member_ids": [o["user_id"] for o in others],
        },
        headers=_hdr(owner["token"]),
    )
    return r.json()["id"]


def _alice_unread(client: TestClient, alice: dict, room_id: str) -> int:
    rooms = client.get("/rooms", headers=_hdr(alice["token"])).json()
    return next(r for r in rooms if r["id"] == room_id)["unread_count"]


class TestUnreadCount:
    def test_new_room_is_zero(self, client):
        alice = _register(client, "alice")
        room_id = _make_group(client, alice, [])
        assert _alice_unread(client, alice, room_id) == 0

    def test_others_messages_count(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        room_id = _make_group(client, alice, [bob])
        # Bob sends three. Alice's unread should be 3.
        for _ in range(3):
            client.post(
                f"/rooms/{room_id}/chat",
                json={"body": "hi"},
                headers=_hdr(bob["token"]),
            )
        assert _alice_unread(client, alice, room_id) == 3

    def test_own_messages_dont_count(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        room_id = _make_group(client, alice, [bob])
        # Alice's own posts shouldn't pad her own unread number.
        for _ in range(5):
            client.post(
                f"/rooms/{room_id}/chat",
                json={"body": "me"},
                headers=_hdr(alice["token"]),
            )
        assert _alice_unread(client, alice, room_id) == 0
        # Bob posts → that one should show.
        client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "bob here"},
            headers=_hdr(bob["token"]),
        )
        assert _alice_unread(client, alice, room_id) == 1

    def test_mark_read_clears(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        room_id = _make_group(client, alice, [bob])
        for _ in range(2):
            client.post(
                f"/rooms/{room_id}/chat",
                json={"body": "hey"},
                headers=_hdr(bob["token"]),
            )
        assert _alice_unread(client, alice, room_id) == 2
        r = client.post(
            f"/rooms/{room_id}/read", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200
        assert r.json()["unread_count"] == 0
        assert _alice_unread(client, alice, room_id) == 0
        # A NEW message after the mark-read should show as 1.
        client.post(
            f"/rooms/{room_id}/chat",
            json={"body": "later"},
            headers=_hdr(bob["token"]),
        )
        assert _alice_unread(client, alice, room_id) == 1

    def test_non_member_cannot_mark_read(self, client):
        alice = _register(client, "alice")
        carol = _register(client, "carol")
        room_id = _make_group(client, alice, [])
        r = client.post(
            f"/rooms/{room_id}/read", headers=_hdr(carol["token"])
        )
        assert r.status_code == 403

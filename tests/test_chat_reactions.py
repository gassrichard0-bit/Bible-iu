"""Chat reactions — iMessage-style tapback per message.

- Toggle on / off.
- Tally aggregates with `mine` set for the viewer.
- Multiple emojis per user OK (heart + thumbs).
- Same emoji twice from one user counts as a remove (toggle).
- Non-member can't react.
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


def _register(client: TestClient, h: str) -> dict:
    r = client.post(
        "/auth/register",
        json={"handle": h, "password": "password1234", "display_name": h},
    )
    me = client.get("/auth/me", headers={"X-Session-Token": r.json()["token"]})
    return {"token": r.json()["token"], "user_id": me.json()["id"]}


def _hdr(t: str) -> dict:
    return {"X-Session-Token": t}


def _setup(client):
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
    msg = client.post(
        f"/rooms/{room_id}/chat",
        json={"body": "hello"},
        headers=_hdr(alice["token"]),
    ).json()
    return alice, bob, room_id, msg


def _react(client, token, room_id, msg_id, emoji):
    return client.post(
        f"/rooms/{room_id}/chat/{msg_id}/react",
        json={"emoji": emoji},
        headers=_hdr(token),
    )


class TestReactions:
    def test_add_and_aggregate(self, client):
        alice, bob, room_id, msg = _setup(client)
        r = _react(client, alice["token"], room_id, msg["id"], "❤️")
        assert r.status_code == 200
        body = r.json()
        assert body["reactions"] == [
            {"emoji": "❤️", "count": 1, "mine": True}
        ]
        # Bob adds the same one — alice sees count 2, mine still true.
        _react(client, bob["token"], room_id, msg["id"], "❤️")
        msgs = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(alice["token"])
        ).json()
        m = next(x for x in msgs if x["id"] == msg["id"])
        assert m["reactions"][0] == {"emoji": "❤️", "count": 2, "mine": True}
        # And bob's perspective: count 2, mine true.
        msgs_b = client.get(
            f"/rooms/{room_id}/chat", headers=_hdr(bob["token"])
        ).json()
        m_b = next(x for x in msgs_b if x["id"] == msg["id"])
        assert m_b["reactions"][0] == {"emoji": "❤️", "count": 2, "mine": True}

    def test_toggle_removes_own(self, client):
        alice, _, room_id, msg = _setup(client)
        _react(client, alice["token"], room_id, msg["id"], "👍")
        r = _react(client, alice["token"], room_id, msg["id"], "👍")
        assert r.status_code == 200
        assert r.json()["reactions"] == []

    def test_stack_different_emojis(self, client):
        alice, _, room_id, msg = _setup(client)
        _react(client, alice["token"], room_id, msg["id"], "❤️")
        r = _react(client, alice["token"], room_id, msg["id"], "👍")
        emojis = {x["emoji"] for x in r.json()["reactions"]}
        assert emojis == {"❤️", "👍"}

    def test_non_member_cannot_react(self, client):
        alice, _, room_id, msg = _setup(client)
        carol = _register(client, "carol")
        r = _react(client, carol["token"], room_id, msg["id"], "🎉")
        assert r.status_code == 403

    def test_react_on_unknown_message(self, client):
        alice, _, room_id, _ = _setup(client)
        r = _react(
            client, alice["token"], room_id, "not-a-real-id", "🎉"
        )
        assert r.status_code == 404

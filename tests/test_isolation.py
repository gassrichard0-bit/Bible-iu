"""WhatsApp-style data isolation + admin role enforcement.

These tests verify the boundaries the audit flagged:
    1. Per-user Yjs docs reject cross-user websocket connections.
    2. Social endpoints (likes / comments) refuse note IDs that
       weren't explicitly registered as group notes.
    3. Group room creator becomes admin; direct rooms have no admin.
    4. Admin endpoints (member patch, agent settings) reject
       non-admins with 403 and won't strand the room with zero admins.
    5. `POST /reason` honors the per-room agent settings.
    6. `GET /rooms` returns the caller's role on each row.

Two-user flows use distinct sessions on the same in-memory DB so we
exercise the access checks for real.
"""
from __future__ import annotations

import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Test app — one fresh in-memory DB per test, like test_api.py but
# without auto-auth so each test picks its own users.
# ---------------------------------------------------------------------------
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


def _register(client: TestClient, handle: str, pw: str = "password1234") -> dict:
    r = client.post(
        "/auth/register",
        json={"handle": handle, "password": pw, "display_name": handle},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    me = client.get("/auth/me", headers={"X-Session-Token": body["token"]})
    assert me.status_code == 200
    return {"token": body["token"], "user_id": me.json()["id"], "handle": handle}


def _hdr(token: str) -> dict:
    return {"X-Session-Token": token}


# ---------------------------------------------------------------------------
# Yjs personal-doc gating
# ---------------------------------------------------------------------------
class TestYjsPersonalDocGating:
    """Per-user notes Y.Doc names look like
    `notes_private__{userId}__{roomId}`. Only the user whose id is in
    the name may connect. This is what makes "personal notes private"
    actually true at the wire level."""

    def test_owner_can_connect_to_their_personal_doc(self, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        doc_name = f"notes_private__{alice['user_id']}__{room_id}"
        with client.websocket_connect(
            f"/ws/yjs/{doc_name}?session={alice['token']}"
        ) as ws:
            assert ws is not None  # handshake completed

    def test_other_user_cannot_connect_to_someone_elses_personal_doc(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Bob tries to connect to Alice's private doc
        alice_doc = f"notes_private__{alice['user_id']}__{room_id}"
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                f"/ws/yjs/{alice_doc}?session={bob['token']}"
            ) as ws:
                # Some servers complete the accept then close; pull a
                # message so the close surfaces.
                ws.receive_text()

    def test_no_session_cannot_connect_to_personal_doc(self, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        from starlette.websockets import WebSocketDisconnect

        alice_doc = f"notes_private__{alice['user_id']}__{room_id}"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/yjs/{alice_doc}") as ws:
                ws.receive_text()


# ---------------------------------------------------------------------------
# Social-endpoint scope check
# ---------------------------------------------------------------------------
class TestSocialScope:
    """Likes / comments only attach to notes the frontend explicitly
    registered as group-scope. Anything else 404s — even if the caller
    is a room member and the UUID is well-formed."""

    def _join(self, client) -> tuple[dict, str]:
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        return alice, r.json()["id"]

    def test_like_unregistered_note_returns_404(self, client):
        alice, room_id = self._join(client)
        r = client.post(
            f"/rooms/{room_id}/notes/fake-id/like",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 404

    def test_register_then_like_succeeds(self, client):
        alice, room_id = self._join(client)
        note_id = "group-note-1"
        r = client.post(
            f"/rooms/{room_id}/notes/{note_id}/register_group",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        r = client.post(
            f"/rooms/{room_id}/notes/{note_id}/like",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        assert r.json()["likes"] == 1

    def test_register_is_idempotent_same_user(self, client):
        alice, room_id = self._join(client)
        for _ in range(3):
            r = client.post(
                f"/rooms/{room_id}/notes/group-x/register_group",
                headers=_hdr(alice["token"]),
            )
            assert r.status_code == 200

    def test_cross_room_register_is_rejected(self, client):
        alice, room_a = self._join(client)
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Other"},
            headers=_hdr(alice["token"]),
        )
        room_b = r.json()["id"]
        # First register in room A
        r = client.post(
            f"/rooms/{room_a}/notes/dup-id/register_group",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        # Trying to register the same ID in room B is rejected
        r = client.post(
            f"/rooms/{room_b}/notes/dup-id/register_group",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 409

    def test_comment_on_unregistered_note_returns_404(self, client):
        alice, room_id = self._join(client)
        r = client.post(
            f"/rooms/{room_id}/notes/leaked-id/comments",
            json={"body": "hi"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Admin role
# ---------------------------------------------------------------------------
class TestAdminRole:
    def test_group_room_creator_is_admin(self, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        assert r.json()["role"] == "admin"

    def test_direct_room_has_no_admin(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        create = client.post(
            "/rooms",
            json={"type": "direct", "member_ids": [bob["user_id"]]},
            headers=_hdr(alice["token"]),
        )
        assert create.status_code == 200
        room_id = create.json()["id"]
        assert create.json()["role"] == "member"
        # Members can still READ settings on a direct room — the
        # GET is just informational.
        settings = client.get(
            f"/rooms/{room_id}/agent_settings", headers=_hdr(alice["token"])
        )
        assert settings.status_code == 200
        # But admin-gated endpoints (e.g. member patch) 400 because
        # direct rooms have no admin concept.
        patch = client.patch(
            f"/rooms/{room_id}/members/{bob['user_id']}",
            json={"role": "admin"},
            headers=_hdr(alice["token"]),
        )
        assert patch.status_code == 400

    def test_member_cannot_promote(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        carol = _register(client, "carol")
        r = client.post(
            "/rooms",
            json={
                "type": "group",
                "name": "Study",
                "member_ids": [bob["user_id"], carol["user_id"]],
            },
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Bob (member) tries to promote Carol
        r = client.patch(
            f"/rooms/{room_id}/members/{carol['user_id']}",
            json={"role": "admin"},
            headers=_hdr(bob["token"]),
        )
        assert r.status_code == 403

    def test_admin_can_promote_then_demote(self, client):
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
        # Alice (admin) promotes Bob
        r = client.patch(
            f"/rooms/{room_id}/members/{bob['user_id']}",
            json={"role": "admin"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200 and r.json()["role"] == "admin"
        # Now Alice demotes Bob
        r = client.patch(
            f"/rooms/{room_id}/members/{bob['user_id']}",
            json={"role": "member"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200 and r.json()["role"] == "member"

    def test_cannot_demote_last_admin(self, client):
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
        # Only Alice is admin — demoting her should be rejected.
        r = client.patch(
            f"/rooms/{room_id}/members/{alice['user_id']}",
            json={"role": "member"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 400

    def test_cannot_remove_last_admin(self, client):
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
        r = client.delete(
            f"/rooms/{room_id}/members/{alice['user_id']}",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Per-room agent settings
# ---------------------------------------------------------------------------
class TestAgentSettings:
    def _solo_group(self, client) -> tuple[dict, str]:
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        return alice, r.json()["id"]

    def test_defaults_are_conservative(self, client):
        alice, room_id = self._solo_group(client)
        r = client.get(
            f"/rooms/{room_id}/agent_settings", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200
        data = r.json()
        assert data["agent_enabled"] is True
        assert data["allow_web_search"] is False
        assert data["allow_external_links"] is False
        assert data["bypass_citation_engine_allowed"] is False
        assert data["max_questions_per_user_per_day"] is None

    def test_member_cannot_patch_settings(self, client):
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
        r = client.patch(
            f"/rooms/{room_id}/agent_settings",
            json={
                "agent_enabled": False,
                "allow_web_search": False,
                "allow_external_links": False,
                "bypass_citation_engine_allowed": False,
                "max_questions_per_user_per_day": None,
            },
            headers=_hdr(bob["token"]),
        )
        assert r.status_code == 403

    def test_agent_disabled_blocks_reason(self, client):
        alice, room_id = self._solo_group(client)
        # Admin turns the agent off
        r = client.patch(
            f"/rooms/{room_id}/agent_settings",
            json={
                "agent_enabled": False,
                "allow_web_search": False,
                "allow_external_links": False,
                "bypass_citation_engine_allowed": False,
                "max_questions_per_user_per_day": None,
            },
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        # /reason should 403
        r = client.post(
            "/reason",
            json={
                "room_id": room_id,
                "verse_ref": "GEN.1.1",
                "question": "What does this mean?",
            },
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# /rooms returns the caller's role
# ---------------------------------------------------------------------------
class TestAccountDeletion:
    """`DELETE /auth/me` must wipe every per-user surface AND
    tombstone group artifacts so room history stays intact."""

    def test_personal_data_is_wiped(self, client):
        alice = _register(client, "alice")
        # Drop a bookmark + an annotation
        r = client.put(
            "/auth/bookmarks/GEN",
            json={"chapter": 1, "verse": 1},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        r = client.put(
            "/auth/annotations/GEN.1.1/highlight",
            json={"color": "yellow"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200

        # Delete account
        r = client.delete("/auth/me", headers=_hdr(alice["token"]))
        assert r.status_code == 200

        # New user with same handle shouldn't see old data
        alice2 = _register(client, "alice")
        bookmarks = client.get(
            "/auth/bookmarks", headers=_hdr(alice2["token"])
        )
        assert bookmarks.status_code == 200
        assert bookmarks.json() == []
        anns = client.get(
            "/auth/annotations", headers=_hdr(alice2["token"])
        )
        assert anns.json() == []

    def test_group_comments_tombstone_not_vanish(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={
                "type": "group",
                "name": "Joint",
                "member_ids": [bob["user_id"]],
            },
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Alice registers a group note + Bob comments on it
        r = client.post(
            f"/rooms/{room_id}/notes/note-x/register_group",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        r = client.post(
            f"/rooms/{room_id}/notes/note-x/comments",
            json={"body": "I see what you mean"},
            headers=_hdr(bob["token"]),
        )
        assert r.status_code == 200
        # Bob deletes his account
        r = client.delete("/auth/me", headers=_hdr(bob["token"]))
        assert r.status_code == 200
        # Alice still sees Bob's comment, but author is anonymized
        r = client.get(
            f"/rooms/{room_id}/notes/note-x/social",
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["comments"]) == 1
        c = data["comments"][0]
        assert c["body"] == "I see what you mean"
        # author_user_id null → frontend shows "deleted user"
        assert c["author_user_id"] is None or c["author_user_id"] == ""

    def test_last_admin_deletion_promotes_member(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={
                "type": "group",
                "name": "Joint",
                "member_ids": [bob["user_id"]],
            },
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Alice (sole admin) deletes account; Bob should become admin
        r = client.delete("/auth/me", headers=_hdr(alice["token"]))
        assert r.status_code == 200
        members = client.get(
            f"/rooms/{room_id}/members", headers=_hdr(bob["token"])
        )
        assert members.status_code == 200
        rows = members.json()
        assert len(rows) == 1
        assert rows[0]["user_id"] == bob["user_id"]
        assert rows[0]["role"] == "admin"


class TestChatWebsocket:
    """The `/ws/chat/{room_id}` endpoint must:
      • reject non-members with 4403
      • broadcast a new chat message to every subscriber in the room
    """

    def test_non_member_cannot_subscribe(self, client):
        alice = _register(client, "alice")
        bob = _register(client, "bob")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Alice only"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Bob isn't a member — connect attempt should be rejected.
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                f"/ws/chat/{room_id}?session={bob['token']}"
            ) as ws:
                ws.receive_text()

    def test_post_fans_out_to_subscriber(self, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        with client.websocket_connect(
            f"/ws/chat/{room_id}?session={alice['token']}"
        ) as ws:
            # Post a message via HTTP from the same connection.
            r = client.post(
                f"/rooms/{room_id}/chat",
                json={"body": "hello world"},
                headers=_hdr(alice["token"]),
            )
            assert r.status_code == 200
            # The hub should fan the same payload to the WS subscriber.
            import json as _json
            frame = ws.receive_text()
            payload = _json.loads(frame)
            assert payload["body"] == "hello world"
            assert payload["author_handle"] == "alice"
            assert payload["room_id"] == room_id


def test_list_rooms_includes_role(client):
    alice = _register(client, "alice")
    bob = _register(client, "bob")
    # Each /auth/register also seeds a personal Welcome room with the
    # registering user as admin — account for it in the role checks.
    alice_owned = client.post(
        "/rooms",
        json={"type": "group", "name": "Alice's room"},
        headers=_hdr(alice["token"]),
    )
    assert alice_owned.status_code == 200
    joint = client.post(
        "/rooms",
        json={
            "type": "group",
            "name": "Joint",
            "member_ids": [bob["user_id"]],
        },
        headers=_hdr(alice["token"]),
    )
    assert joint.status_code == 200
    joint_id = joint.json()["id"]

    # Alice is admin in everything she's in (welcome + alice's room + joint)
    r = client.get("/rooms", headers=_hdr(alice["token"]))
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 3
    for row in rows:
        assert row["role"] == "admin", row

    # Bob is admin in his own welcome room, member of the joint room
    r = client.get("/rooms", headers=_hdr(bob["token"]))
    assert r.status_code == 200
    rows = r.json()
    by_id = {row["id"]: row for row in rows}
    assert by_id[joint_id]["role"] == "member"
    other_roles = {r["role"] for r in rows if r["id"] != joint_id}
    assert other_roles == {"admin"}

"""End-to-end tests for the per-room admin enforcement work:

  • `agent_settings.allow_external_links` — when off, URLs in the
    answer are rewritten to `[link removed]`.
  • `agent_settings.max_questions_per_user_per_day` — when set, the
    Nth+1 question in a UTC day returns HTTP 429.
  • Verse-scope retrieval pulls the Hebrew / Greek row for the anchor
    when the seed translations exist.

The placeholder generator returns a deterministic stub, so the link
test injects a URL via the stub's answer template (monkeypatched).
"""
from __future__ import annotations

import os
from importlib import reload
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fresh-DB fixtures, same pattern as test_isolation.py
# ---------------------------------------------------------------------------
@pytest.fixture()
def app(tmp_path):
    os.environ["BIBLE_IU_DATABASE_URL"] = f"sqlite:///{tmp_path}/test.sqlite"
    import backend.data.db as db_mod
    reload(db_mod)
    # `backend.data.__init__` re-exports SessionLocal from .db. Without
    # reloading the package, callers that do `from backend.data import
    # SessionLocal` keep their reference to the previous test's engine,
    # which has a stale (or now-deleted) sqlite file behind it.
    import backend.data as data_mod
    reload(data_mod)
    import backend.api.main as main_mod
    reload(main_mod)
    return main_mod


@pytest.fixture()
def client(app) -> Iterator[TestClient]:
    with TestClient(app.app) as c:
        yield c


def _register(client: TestClient, handle: str) -> dict:
    r = client.post(
        "/auth/register",
        json={"handle": handle, "password": "password1234", "display_name": handle},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    me = client.get("/auth/me", headers={"X-Session-Token": body["token"]})
    return {"token": body["token"], "user_id": me.json()["id"]}


def _hdr(token: str) -> dict:
    return {"X-Session-Token": token}


def _settings_body(**overrides) -> dict:
    base = {
        "agent_enabled": True,
        "allow_web_search": False,
        "allow_external_links": False,
        "bypass_citation_engine_allowed": False,
        "max_questions_per_user_per_day": None,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# allow_external_links
# ---------------------------------------------------------------------------
class TestAllowExternalLinks:
    def test_urls_stripped_when_disallowed(self, app, client, monkeypatch):
        # Force the placeholder generator to emit a URL we can check for.
        from backend.agent.skills import default_backends as backends

        def fake_generate(self, verse_ref, question, retrieval, history=None, bypass=False, scope_kind="verse"):
            return (
                "Reasoning with a https://example.com/foo link.",
                "See more at https://example.com/sources and www.bible.com",
                [],
                None,
            )

        monkeypatch.setattr(backends.PlaceholderGenerator, "generate", fake_generate)

        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # admin defaults already have allow_external_links=False
        r = client.post(
            "/reason",
            json={
                "room_id": room_id,
                "verse_ref": "GEN.1.1",
                "question": "?",
            },
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "https://" not in body["answer"]
        assert "www." not in body["answer"]
        assert "[link removed]" in body["answer"]
        assert "[link removed]" in body["reasoning"]

    def test_urls_kept_when_allowed(self, app, client, monkeypatch):
        from backend.agent.skills import default_backends as backends

        def fake_generate(self, verse_ref, question, retrieval, history=None, bypass=False, scope_kind="verse"):
            return ("R", "https://example.com/keep", [], None)

        monkeypatch.setattr(backends.PlaceholderGenerator, "generate", fake_generate)

        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        # Admin flips allow_external_links on
        r = client.patch(
            f"/rooms/{room_id}/agent_settings",
            json=_settings_body(allow_external_links=True),
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        r = client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200
        assert "https://example.com/keep" in r.json()["answer"]


# ---------------------------------------------------------------------------
# max_questions_per_user_per_day
# ---------------------------------------------------------------------------
class TestDailyQuota:
    def test_quota_blocks_after_n(self, app, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        r = client.patch(
            f"/rooms/{room_id}/agent_settings",
            json=_settings_body(max_questions_per_user_per_day=2),
            headers=_hdr(alice["token"]),
        )
        assert r.status_code == 200

        ask = lambda: client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(alice["token"]),
        )
        assert ask().status_code == 200  # 1/2
        assert ask().status_code == 200  # 2/2
        third = ask()
        assert third.status_code == 429
        assert "midnight" in third.json()["detail"].lower()

    def test_quota_is_per_user(self, app, client):
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
        client.patch(
            f"/rooms/{room_id}/agent_settings",
            json=_settings_body(max_questions_per_user_per_day=1),
            headers=_hdr(alice["token"]),
        )
        # Alice burns her one
        assert client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(alice["token"]),
        ).status_code == 200
        assert client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(alice["token"]),
        ).status_code == 429
        # Bob still has his
        assert client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(bob["token"]),
        ).status_code == 200


class TestQuotaEndpoint:
    """GET /rooms/{room_id}/quota mirrors the in-memory counter so the
    frontend can show "X questions left today" without re-implementing
    the math."""

    def test_unlimited_when_no_cap(self, app, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        r = client.get(
            f"/rooms/{room_id}/quota", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200
        body = r.json()
        assert body["limit"] is None
        assert body["remaining"] is None
        assert body["used"] == 0

    def test_quota_reflects_consumption(self, app, client):
        alice = _register(client, "alice")
        r = client.post(
            "/rooms",
            json={"type": "group", "name": "Study"},
            headers=_hdr(alice["token"]),
        )
        room_id = r.json()["id"]
        client.patch(
            f"/rooms/{room_id}/agent_settings",
            json=_settings_body(max_questions_per_user_per_day=3),
            headers=_hdr(alice["token"]),
        )
        # Ask once → quota should drop to 2 remaining.
        client.post(
            "/reason",
            json={"room_id": room_id, "verse_ref": "GEN.1.1", "question": "?"},
            headers=_hdr(alice["token"]),
        )
        r = client.get(
            f"/rooms/{room_id}/quota", headers=_hdr(alice["token"])
        )
        assert r.status_code == 200
        body = r.json()
        assert body["limit"] == 3
        assert body["used"] == 1
        assert body["remaining"] == 2


# ---------------------------------------------------------------------------
# Original-language retrieval
# ---------------------------------------------------------------------------
class TestOriginalLanguage:
    def test_hebrew_row_pulled_at_verse_scope(self, app):
        """The retriever should surface a `Hebrew (WLC)` row alongside
        the KJV verse when the seed data has one for that verse_id."""
        import backend.data as data_mod
        from backend.data import models as m
        from backend.agent.skills.default_backends import SqlRetriever

        data_mod.init_db()
        with data_mod.SessionLocal() as s:
            s.add(m.Verse(id="GEN.1.1", book="GEN", chapter=1, verse=1))
            s.add(m.Translation(
                id="KJV:GEN.1.1", name="King James Version",
                verse_id="GEN.1.1",
                text="In the beginning God created the heaven and the earth.",
                license="Public Domain (KJV)",
            ))
            s.add(m.Translation(
                id="HEB:GEN.1.1", name="Hebrew (WLC)",
                verse_id="GEN.1.1",
                text="בְּרֵאשִׁית בָּרָא אֱלֹהִים",
                license="Public Domain (WLC)",
            ))
            s.commit()
            chunks = SqlRetriever(s).retrieve(
                "GEN.1.1", "what does this mean", scope_kind="verse",
            )
            orig = [c for c in chunks if c.source_kind == "original_language"]
            assert len(orig) == 1
            assert "בְּרֵאשִׁית" in orig[0].text

    def test_no_original_at_wider_scope(self, app):
        """Pulling Hebrew/Greek at chapter / testament / bible scope
        would flood the context — verify it's gated to verse scope."""
        import backend.data as data_mod
        from backend.data import models as m
        from backend.agent.skills.default_backends import SqlRetriever

        data_mod.init_db()
        with data_mod.SessionLocal() as s:
            s.add(m.Verse(id="GEN.1.1", book="GEN", chapter=1, verse=1))
            s.add(m.Translation(
                id="KJV:GEN.1.1", name="King James Version",
                verse_id="GEN.1.1",
                text="In the beginning…",
                license="Public Domain (KJV)",
            ))
            s.add(m.Translation(
                id="HEB:GEN.1.1", name="Hebrew (WLC)",
                verse_id="GEN.1.1",
                text="בְּרֵאשִׁית",
                license="Public Domain (WLC)",
            ))
            s.commit()
            chunks = SqlRetriever(s).retrieve(
                "GEN.1.1", "anything", scope_kind="chapter",
            )
            orig = [c for c in chunks if c.source_kind == "original_language"]
            assert orig == []

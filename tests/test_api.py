"""End-to-end API smoke tests."""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path) -> TestClient:
    os.environ["BIBLE_IU_DATABASE_URL"] = f"sqlite:///{tmp_path}/test.sqlite"
    # Re-import so the env var takes effect
    from importlib import reload

    import backend.data.db as db_mod

    reload(db_mod)
    # `backend.data.__init__` re-exports SessionLocal — without reloading
    # the package, modules that do `from backend.data import SessionLocal`
    # keep the previous test's stale engine reference.
    import backend.data as data_mod

    reload(data_mod)
    import backend.api.main as main_mod

    reload(main_mod)
    with TestClient(main_mod.app) as c:
        # Auto-authenticate: register a throwaway user and attach the
        # session token to every subsequent request. Lets tests focus on
        # the endpoint under test without re-doing the auth dance.
        r = c.post(
            "/auth/register",
            json={"handle": "testuser", "password": "testpass1234"},
        )
        assert r.status_code == 200, r.text
        token = r.json()["token"]
        c.headers["X-Session-Token"] = token
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_create_room_and_post_chat(client):
    r = client.post("/rooms", json={"type": "group", "name": "Study"})
    assert r.status_code == 200
    room_id = r.json()["id"]

    r = client.post(
        f"/rooms/{room_id}/chat",
        json={"body": "Hello", "language": "en"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["body"] == "Hello"
    assert body["author_is_agent"] is False


def test_reason_endpoint_runs_pipeline(client):
    r = client.post("/rooms", json={"type": "group", "name": "Study"})
    room_id = r.json()["id"]
    r = client.post(
        "/reason",
        json={
            "room_id": room_id,
            "verse_ref": "GEN.1.1",
            "question": "What does this mean?",
        },
    )
    assert r.status_code == 200
    data = r.json()
    # Placeholder generator emits no statements, so no claims; the
    # middleware should pass (no factual claims to gate).
    assert data["decision"] == "pass"
    assert "reasoning" in data

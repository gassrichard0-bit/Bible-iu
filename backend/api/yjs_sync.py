"""Yjs / CRDT sync endpoint (`architecture.MD` §3 sync service,
`CLAUDE.md` §8 offline / local sync, `notes-system.MD` §3.1 substrate).

One Y.Doc per room. Clients connect to `/ws/yjs/{room_id}` and the
pycrdt-websocket server handles SyncStep1 / SyncStep2 / Update framing.

Persistence: each Y.Doc has a `SQLiteYStore` attached so updates are
written to `backend/data/yjs/{room_name}.db` incrementally. Server
restart re-hydrates from disk.

Auth: the same password gate as the rest of the API, via `?password=`
query param (browsers can't set headers on WS handshakes).
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect
from pycrdt.store import SQLiteYStore, YDocNotFound
from pycrdt.websocket import WebsocketServer, YRoom
from pycrdt.websocket.asgi_server import ASGIWebsocket


_STORE_DIR = Path(__file__).resolve().parent.parent / "data" / "yjs"
_STORE_DIR.mkdir(parents=True, exist_ok=True)
_STORE_DB_PATH = str(_STORE_DIR / "ystore.db")


# SQLiteYStore reads its db_path from a class attribute, not a constructor
# arg. Subclass it once and freeze the path so all rooms write to the same
# database file (one row-per-update keyed by doc path).
class _SharedSQLiteYStore(SQLiteYStore):
    db_path = _STORE_DB_PATH


class _PersistentWebsocketServer(WebsocketServer):
    """Same as WebsocketServer but attaches a SQLiteYStore to each YRoom
    so updates persist across server restarts.

    Mirrors the parent's `get_room()` but supplies `ystore=...` so the
    `YRoom` runtime writes every CRDT update to disk (line 183-185 of
    `yroom.py`).

    All rooms share a single SQLite db at
    `backend/data/yjs/ystore.db`. The `path` argument passed to the
    store is the doc-name discriminator within that db.
    """

    async def get_room(self, name: str) -> YRoom:  # type: ignore[override]
        if name not in self.rooms:
            from functools import partial

            provider_factory = (
                partial(self.provider_factory, path=name)
                if self.provider_factory is not None
                else None
            )
            ystore = _SharedSQLiteYStore(path=name)
            self.rooms[name] = YRoom(
                ready=self.rooms_ready,
                log=self.log,
                ystore=ystore,
                provider_factory=provider_factory,
            )
            # First-time setup: start the ystore in OUR task group so it
            # initializes before the room would lazily start it. Then
            # hydrate the new ydoc with any persisted updates so a fresh
            # client doesn't see an empty doc just because the server
            # restarted.
            if self._task_group is not None:
                await self._task_group.start(ystore.start)
                try:
                    await ystore.apply_updates(self.rooms[name].ydoc)
                except YDocNotFound:
                    # No prior updates — first time we see this doc name.
                    pass
        room = self.rooms[name]
        await self.start_room(room)
        return room


# Module-level server — a single instance manages all rooms.
# `auto_clean_rooms=False` keeps a Y.Doc alive across periods of zero
# clients so the next visitor sees the last state until we persist.
_server = _PersistentWebsocketServer(rooms_ready=True, auto_clean_rooms=False)
_server_ctx = None


async def startup() -> None:
    global _server_ctx
    _server_ctx = _server
    await _server.__aenter__()


async def shutdown() -> None:
    global _server_ctx
    if _server_ctx is not None:
        await _server_ctx.__aexit__(None, None, None)
        _server_ctx = None


def is_running() -> bool:
    """Used by /healthz to report whether the CRDT sync server is
    currently accepting connections."""
    return _server_ctx is not None


def _password_ok(ws: WebSocket) -> bool:
    expected = (os.environ.get("BIBLE_IU_PASSWORD") or "").strip() or None
    if expected is None:
        return True
    return ws.query_params.get("password", "") == expected


def _conv_doc_owner(doc_name: str) -> str | None:
    """Return the handle that owns a `conv__{handle}__{roomId}` doc, or
    None for non-conversation docs (which are shared room-scope)."""
    if doc_name.startswith("conv__"):
        rest = doc_name[len("conv__"):]
        sep = rest.find("__")
        if sep > 0:
            return rest[:sep]
    return None


def _personal_notes_doc_owner(doc_name: str) -> str | None:
    """Per-user personal-notes Y.Doc — `notes_private__{userId}__{roomId}`.
    The user's stable id (not handle) is in the name so renaming a user
    doesn't orphan their notes. Returns the user_id if this is such a
    doc, None for shared docs."""
    if doc_name.startswith("notes_private__"):
        rest = doc_name[len("notes_private__"):]
        sep = rest.find("__")
        if sep > 0:
            return rest[:sep]
    return None


async def handle_yjs(ws: WebSocket, room_id: str) -> None:
    """Bridge a FastAPI websocket into pycrdt's `WebsocketServer.serve`.

    pycrdt's server expects an object with `path`, `recv`, and `send`.
    `ASGIWebsocket` already wraps an ASGI receive/send pair into that
    shape, so we feed it FastAPI's underlying callables.

    Per-user scoping: docs named `conv__{handle}__{roomId}` belong to a
    specific user. Anyone connecting must hold a valid session token
    whose user matches that handle. Room-scope docs (notes) only
    require the deployment password.
    """
    await ws.accept()
    if not _password_ok(ws):
        await ws.close(code=4001, reason="Unauthorized")
        return

    # Two kinds of per-user doc are gated here:
    #   conv__{handle}__{roomId}            — agent conversation history
    #   notes_private__{userId}__{roomId}   — personal notes (NEW)
    # Both require a session token that proves the user is the doc owner,
    # so even if an attacker guesses the doc name they can't connect.
    conv_owner = _conv_doc_owner(room_id)
    notes_owner_id = _personal_notes_doc_owner(room_id)
    if conv_owner is not None or notes_owner_id is not None:
        # Local import to avoid a circular import at module load time.
        from .auth_users import resolve_user

        token = ws.query_params.get("session", "")
        user = resolve_user(token) if token else None
        if user is None:
            await ws.close(code=4001, reason="Wrong user for doc")
            return
        if conv_owner is not None and user.handle != conv_owner:
            await ws.close(code=4001, reason="Wrong user for doc")
            return
        if notes_owner_id is not None and user.id != notes_owner_id:
            await ws.close(code=4001, reason="Wrong user for doc")
            return

    if _server_ctx is None:
        # Lifespan didn't initialize yet — refuse rather than spinning up
        # a half-managed server here.
        await ws.close(code=1011, reason="sync server not ready")
        return
    async_ws = ASGIWebsocket(
        receive=ws.receive,
        send=ws.send,
        path=f"/{room_id}",
    )
    try:
        await _server.serve(async_ws)
    except WebSocketDisconnect:
        return
    except Exception:
        # Don't crash the request handler if the underlying CRDT loop
        # raises — log via uvicorn's default and close cleanly.
        try:
            await ws.close()
        except Exception:
            pass

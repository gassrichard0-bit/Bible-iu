"""In-process pub/sub for room chat fan-out.

When `POST /rooms/{id}/chat` lands, we serialize the message and push
it to every connected websocket subscribed to that room. Single-
process only — distributed deployments need Redis pub/sub (in the
"scale-out" Phase 4 work).

Auth: every websocket validates the session token + room membership
before subscribing. The hub doesn't keep auth state; it just routes
messages once the endpoint has decided the client may listen.
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any


_subs: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)
_lock = asyncio.Lock()


async def subscribe(room_id: str) -> asyncio.Queue[str]:
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
    async with _lock:
        _subs[room_id].add(q)
    return q


async def unsubscribe(room_id: str, q: asyncio.Queue[str]) -> None:
    async with _lock:
        if q in _subs.get(room_id, set()):
            _subs[room_id].discard(q)
            if not _subs[room_id]:
                del _subs[room_id]


def publish(room_id: str, payload: dict[str, Any]) -> None:
    """Best-effort fan-out. Slow subscribers (full queues) drop the
    message rather than blocking the writer — they'll catch up on
    next page reload via GET /chat."""
    body = json.dumps(payload, separators=(",", ":"))
    for q in list(_subs.get(room_id, set())):
        try:
            q.put_nowait(body)
        except asyncio.QueueFull:
            pass

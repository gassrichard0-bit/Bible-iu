"""Pub/sub for room chat fan-out.

Local subscribers (websocket connections in this process) get fed via
in-memory `asyncio.Queue` per room. When `REDIS_URL` is set, every
local publish ALSO goes to a Redis pub/sub channel so peer processes
in a multi-instance deploy can deliver to their own subscribers. The
Redis path is opt-in — without a configured URL the hub stays
single-process (its original behavior).

Auth: every websocket validates the session token + room membership
before subscribing. The hub doesn't keep auth state; it just routes
messages once the endpoint has decided the client may listen.

Design notes
------------
* The publisher tags each envelope with a per-process `_origin` UUID
  so the Redis listener can ignore frames it sent itself (otherwise a
  publish would be locally fanned out twice — once directly, once via
  the Redis loopback).
* `publish()` stays SYNCHRONOUS because FastAPI's sync endpoints
  invoke it from a threadpool — making it async would require
  rewriting every call site. We hand the Redis publish to the event
  loop via `run_coroutine_threadsafe`.
* Redis failures degrade silently: if PUBLISH errors out, the local
  fan-out still happened; cross-process subscribers will catch up on
  their next page load via `GET /chat`. Better than dropping the WS
  delivery to local users because the hub is having a bad minute.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections import defaultdict
from typing import Any, Optional

try:
    import redis.asyncio as aioredis  # redis-py >= 4.2
except ImportError:  # pragma: no cover — dep is in requirements.txt
    aioredis = None  # type: ignore[assignment]


_LOG = logging.getLogger("bible_iu.chat_hub")

# Per-process identifier. Used to dedupe Redis loopback frames so the
# publisher doesn't get its own message back as a remote one.
_INSTANCE_ID = uuid.uuid4().hex

_subs: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)
_lock = asyncio.Lock()

# Filled in by `setup()` so the sync `publish` can schedule Redis
# publishes on the running event loop from FastAPI's threadpool.
_event_loop: Optional[asyncio.AbstractEventLoop] = None

# Redis runtime — None when REDIS_URL isn't set OR the connect failed.
_redis: Optional["aioredis.Redis"] = None  # type: ignore[name-defined]
_redis_listener: Optional[asyncio.Task[None]] = None

# Once set, `publish` is a no-op for the Redis path. Prevents racing
# the teardown — a sync endpoint scheduling a coroutine onto a loop
# that's about to be closed would either crash (RuntimeError) or
# silently drop the frame mid-flight. Setting the flag earliest in
# teardown closes that window.
_shutting_down: bool = False
# Tracks every in-flight `_safe_publish` future so `teardown` can
# await them before closing the Redis client. Without this, the
# coroutines reference a Redis client that's been aclose()'d under
# them and raise.
_inflight_publishes: "set[asyncio.Future[None]]" = set()

# Single Redis channel for ALL rooms. The envelope carries the room
# id so subscribers route locally. Cheaper than dynamic per-room
# subscribe/unsubscribe; the fan-out filter below skips rooms with no
# local subscribers in O(1).
_REDIS_CHANNEL = "bible-iu:chat"


# ---------------------------------------------------------------------------
# Setup / teardown — called from the FastAPI lifespan in main.py.
# ---------------------------------------------------------------------------

async def setup() -> None:
    """Wire Redis pub/sub. Safe to call when REDIS_URL is unset —
    in that case we stay in-process only."""
    global _event_loop, _redis, _redis_listener, _shutting_down
    _event_loop = asyncio.get_running_loop()
    _shutting_down = False

    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        _LOG.info("chat_hub: in-process mode (no REDIS_URL)")
        return
    if aioredis is None:
        _LOG.warning(
            "chat_hub: REDIS_URL set but redis-py not installed — "
            "falling back to in-process mode"
        )
        return
    try:
        client = aioredis.from_url(
            url, encoding="utf-8", decode_responses=True
        )
        await client.ping()
    except Exception as e:
        _LOG.warning("chat_hub: Redis unreachable (%s) — in-process only", e)
        _redis = None
        return
    _redis = client
    _redis_listener = asyncio.create_task(_redis_loop())
    _LOG.info("chat_hub: cross-process mode via %s (instance=%s)",
              url, _INSTANCE_ID[:8])


async def teardown() -> None:
    global _redis, _redis_listener, _event_loop, _shutting_down
    # Close the publish window FIRST so no new schedules race in.
    _shutting_down = True
    # Drain anything already scheduled before tearing down Redis.
    # Bound the wait so a hung publish doesn't block shutdown forever.
    if _inflight_publishes:
        try:
            await asyncio.wait_for(
                asyncio.gather(*_inflight_publishes, return_exceptions=True),
                timeout=2.0,
            )
        except asyncio.TimeoutError:
            pass
        _inflight_publishes.clear()
    if _redis_listener is not None:
        _redis_listener.cancel()
        try:
            await _redis_listener
        except (asyncio.CancelledError, Exception):
            pass
        _redis_listener = None
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None
    _event_loop = None


async def _redis_loop() -> None:
    """Long-running task that pulls remote publishes off Redis and
    fans them out to local subscribers. Reconnects on transient
    errors with a short backoff."""
    assert _redis is not None
    backoff = 1.0
    while True:
        try:
            pubsub = _redis.pubsub()
            await pubsub.subscribe(_REDIS_CHANNEL)
            backoff = 1.0
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                _handle_remote(msg.get("data"))
        except asyncio.CancelledError:
            return
        except Exception as e:
            _LOG.warning("chat_hub: redis listener error (%s), retrying", e)
            try:
                await asyncio.sleep(min(backoff, 30.0))
            except asyncio.CancelledError:
                return
            backoff *= 2


def _handle_remote(data: Any) -> None:
    if not isinstance(data, str):
        return
    try:
        envelope = json.loads(data)
    except Exception:
        return
    if envelope.get("_origin") == _INSTANCE_ID:
        # We already fanned out locally; ignore the loopback.
        return
    room_id = envelope.get("_room")
    body = envelope.get("_body")
    if not isinstance(room_id, str) or not isinstance(body, str):
        return
    _local_fanout(room_id, body)


# ---------------------------------------------------------------------------
# Subscription API — used by the chat websocket endpoint.
# ---------------------------------------------------------------------------

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


def _local_fanout(room_id: str, body: str) -> None:
    """Best-effort drop on slow consumers — full queues lose the
    frame; they'll catch up on next page load via GET /chat."""
    for q in list(_subs.get(room_id, set())):
        try:
            q.put_nowait(body)
        except asyncio.QueueFull:
            pass


def publish(room_id: str, payload: dict[str, Any]) -> None:
    """Fan out a payload to every subscriber of `room_id`, locally and
    (when Redis is configured) across peer processes."""
    body = json.dumps(payload, separators=(",", ":"))
    # Local fan-out first — peers in this process get the message
    # without a Redis round-trip.
    _local_fanout(room_id, body)
    # Cross-process fan-out via Redis. Fire-and-forget: scheduling on
    # the event loop from whichever thread this is.
    if _redis is None or _event_loop is None or _shutting_down:
        return
    envelope = {
        "_origin": _INSTANCE_ID,
        "_room": room_id,
        "_body": body,
    }
    payload_str = json.dumps(envelope, separators=(",", ":"))
    try:
        fut = asyncio.run_coroutine_threadsafe(
            _safe_publish(payload_str), _event_loop
        )
    except RuntimeError:
        # Loop already closed (mid-shutdown). Skip silently.
        return
    # Track the concurrent.futures.Future as an asyncio future so the
    # teardown can wait for the chain to drain. Wrap it on the loop
    # because the future originates from a different thread.
    try:
        afut = asyncio.run_coroutine_threadsafe(
            _track_publish(fut), _event_loop
        )
        # Don't keep the wrapper itself in the set — just rely on
        # _track_publish to register the awaitable. Discard the
        # wrapper future so it doesn't keep refs around.
        afut.add_done_callback(lambda _f: None)
    except RuntimeError:
        pass


async def _track_publish(fut: "Any") -> None:
    """Wrap the threadsafe future into an asyncio future on the loop
    so it can be awaited by `teardown`."""
    loop = asyncio.get_running_loop()
    afut = loop.create_future()
    _inflight_publishes.add(afut)

    def _done(_concurrent_future: Any) -> None:
        if not afut.done():
            loop.call_soon_threadsafe(afut.set_result, None)

    fut.add_done_callback(_done)
    try:
        await afut
    finally:
        _inflight_publishes.discard(afut)


async def _safe_publish(payload_str: str) -> None:
    if _redis is None:
        return
    try:
        await _redis.publish(_REDIS_CHANNEL, payload_str)
    except Exception as e:
        _LOG.debug("chat_hub: redis publish failed (%s)", e)

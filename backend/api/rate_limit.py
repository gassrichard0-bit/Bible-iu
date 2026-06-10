"""Per-IP token-bucket rate limit for expensive endpoints.

Operational only — not in the design docs. Exists to bound DeepSeek
spend while the URL is shared. The bucket lives in-process (one uvicorn
worker is enough for the current scale); if we move to multi-worker we
should swap for Redis.

Apply via FastAPI Depends on the expensive routes; cheap reads (Bible
text, health) aren't gated by this.
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


# Configurable via env so we can tune without redeploying.
_RATE = float(os.environ.get("BIBLE_IU_RATE_PER_MIN", "6"))  # ~6 / min
_BURST = float(os.environ.get("BIBLE_IU_RATE_BURST", "3"))   # short burst
# TTS endpoint has its own much-larger bucket — the voice reader
# fires one request per verse, so ~6/min was instantly exhausted
# (a chapter has 10–20 verses). Deepgram Aura is cheap enough that
# 120/min / burst 30 is fine for read-aloud sessions.
_TTS_RATE = float(os.environ.get("BIBLE_IU_TTS_RATE_PER_MIN", "120"))
_TTS_BURST = float(os.environ.get("BIBLE_IU_TTS_RATE_BURST", "30"))

_buckets: dict[str, _Bucket] = {}
_tts_buckets: dict[str, _Bucket] = {}
_lock = threading.Lock()


def _take(
    ip: str,
    buckets: dict[str, _Bucket] | None = None,
    rate_per_min: float | None = None,
    burst: float | None = None,
) -> bool:
    now = time.time()
    bk = buckets if buckets is not None else _buckets
    rate = rate_per_min if rate_per_min is not None else _RATE
    cap = burst if burst is not None else _BURST
    refill_per_sec = rate / 60.0
    with _lock:
        b = bk.get(ip)
        if b is None:
            b = _Bucket(tokens=cap, updated_at=now)
            bk[ip] = b
        elapsed = now - b.updated_at
        b.tokens = min(cap, b.tokens + elapsed * refill_per_sec)
        b.updated_at = now
        if b.tokens >= 1.0:
            b.tokens -= 1.0
            return True
        return False


def _client_ip(request: Request) -> str:
    """Prefer X-Forwarded-For (Fly / cloudflared / any proxy) then the
    raw client. Never falls through to a constant — that would make
    one bad actor knock out everyone."""
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (
        request.client.host if request.client else "unknown"
    )


def rate_limit(request: Request) -> None:
    """Per-user (when signed in) or per-IP (when not) token-bucket.
    Keying by `user:<id>` when a session token is present means a
    shared IP (dorm / NAT / coffee shop) doesn't share a bucket, and
    a logged-in attacker can't bypass the limit by hopping IPs."""
    token = request.headers.get("x-session-token", "").strip()
    key = f"user:{token}" if token else f"ip:{_client_ip(request)}"
    if not _take(key):
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Limit ~{int(_RATE)}/min.",
        )


def tts_rate_limit(request: Request) -> None:
    """Same per-user/per-IP keying as `rate_limit`, but against the
    larger TTS bucket. Used by /tts/speak; the voice reader fires
    one request per verse and the ~6/min bucket was bouncing the
    chapter halfway through."""
    token = request.headers.get("x-session-token", "").strip()
    key = f"user:{token}" if token else f"ip:{_client_ip(request)}"
    if not _take(key, buckets=_tts_buckets, rate_per_min=_TTS_RATE, burst=_TTS_BURST):
        raise HTTPException(
            status_code=429,
            detail=f"Voice reader throttled (limit ~{int(_TTS_RATE)}/min).",
        )

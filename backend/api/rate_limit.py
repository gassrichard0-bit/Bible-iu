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

_buckets: dict[str, _Bucket] = {}
_lock = threading.Lock()


def _take(ip: str) -> bool:
    now = time.time()
    refill_per_sec = _RATE / 60.0
    with _lock:
        b = _buckets.get(ip)
        if b is None:
            b = _Bucket(tokens=_BURST, updated_at=now)
            _buckets[ip] = b
        elapsed = now - b.updated_at
        b.tokens = min(_BURST, b.tokens + elapsed * refill_per_sec)
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

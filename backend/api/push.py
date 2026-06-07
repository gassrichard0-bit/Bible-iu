"""Web Push fan-out (chat + notes → phone).

The browser hands us a `PushSubscription` (endpoint + keys); we store
it in `push_subscriptions` and, when a new chat message / group note
arrives, encrypt a small JSON payload with VAPID and POST it to each
endpoint. The service worker's `push` event in /public/sw.js decodes
the JSON and calls `showNotification`.

Dead endpoints (404 / 410 / "expired subscription") get deleted in
place — there's no separate sweeper job.

VAPID keys are loaded from `backend/.env` at process start:
  VAPID_PUBLIC_KEY   — URL-safe base64 of the uncompressed EC point
  VAPID_PRIVATE_KEY  — PEM (the "-----BEGIN PRIVATE KEY-----" block)
  VAPID_SUBJECT      — mailto: or https: URL identifying us to Apple
                       Push Service / FCM. APS rejects non-URL aud.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..data.models import PushSubscription

log = logging.getLogger("bible_iu.push")

# Lazily-instantiated Vapid object. py-vapid's `from_string()` (which
# is what pywebpush calls when you hand it a PEM string) chokes on our
# PKCS#8 PEM with "ASN.1 parsing error: invalid length". Loading via
# `from_pem(bytes)` works; we cache the parsed object so we don't pay
# the parse on every push.
_VAPID_OBJ = None  # type: ignore[var-annotated]


def vapid_public_key() -> Optional[str]:
    """The URL-safe base64 public key the browser passes to
    `pushManager.subscribe({ applicationServerKey: ... })`. Returns
    None if push isn't configured — callers should 503 in that case."""
    v = (os.environ.get("VAPID_PUBLIC_KEY") or "").strip()
    return v or None


def _vapid_claims() -> dict[str, Any]:
    sub = (os.environ.get("VAPID_SUBJECT") or "").strip()
    if not sub:
        # APS rejects subscriptions whose VAPID JWT has a non-URL aud,
        # so we refuse to send anything if subject isn't a URL.
        raise RuntimeError("VAPID_SUBJECT must be a mailto: or https: URL")
    return {"sub": sub}


def _private_key_pem() -> Optional[str]:
    pem = (os.environ.get("VAPID_PRIVATE_KEY") or "").strip()
    return pem or None


def _vapid_object():
    """Return a cached py-vapid Vapid instance parsed from the PEM in
    the env. Returns None if push isn't configured."""
    global _VAPID_OBJ
    if _VAPID_OBJ is not None:
        return _VAPID_OBJ
    pem = _private_key_pem()
    if not pem:
        return None
    try:
        from py_vapid import Vapid  # type: ignore
    except ImportError:
        return None
    _VAPID_OBJ = Vapid.from_pem(pem.encode())
    return _VAPID_OBJ


def send_push_to_user(
    session: Session,
    user_id: str,
    payload: dict[str, Any],
) -> int:
    """Fan a single payload out to every active subscription of
    `user_id`. Returns the count of successful sends. Dead endpoints
    (404 / 410) are deleted so the table doesn't fill up with stale
    devices."""
    vapid_obj = _vapid_object()
    pub = vapid_public_key()
    if vapid_obj is None or not pub:
        # Push isn't configured (dev box without VAPID keys) — no-op.
        return 0
    try:
        # Lazy import — keeps the module loadable in test envs that
        # haven't installed pywebpush.
        from pywebpush import WebPushException, webpush  # type: ignore
    except ImportError:
        log.warning("pywebpush not installed — skipping push fan-out")
        return 0

    rows = list(
        session.scalars(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        )
    )
    if not rows:
        return 0

    body = json.dumps(payload, separators=(",", ":"))
    claims = _vapid_claims()
    sent = 0
    for row in rows:
        try:
            webpush(
                subscription_info={
                    "endpoint": row.endpoint,
                    "keys": {"p256dh": row.p256dh, "auth": row.auth},
                },
                data=body,
                vapid_private_key=vapid_obj,
                vapid_claims=dict(claims),
                ttl=60 * 60 * 24,  # 24h — phone offline overnight is fine
            )
            row.last_used_at = datetime.now(timezone.utc)
            sent += 1
        except WebPushException as e:  # noqa: BLE001
            status = getattr(e.response, "status_code", None) if e.response else None
            if status in (404, 410):
                # Subscription expired or was unregistered. Drop it so
                # we don't keep retrying every send.
                session.delete(row)
                log.info("dropped dead push endpoint user=%s status=%s", user_id, status)
            else:
                log.warning(
                    "push send failed user=%s status=%s err=%s",
                    user_id, status, str(e),
                )
        except Exception as e:  # noqa: BLE001
            log.warning("push send crashed user=%s err=%s", user_id, e)
    try:
        session.commit()
    except Exception:  # noqa: BLE001
        session.rollback()
    return sent


def fanout_to_room(
    session: Session,
    room_id: str,
    *,
    exclude_user_id: Optional[str],
    payload: dict[str, Any],
) -> int:
    """Push `payload` to every member of `room_id` except the actor.
    Used by chat-send and note-create. Returns the total successful
    pushes across all members."""
    from ..data.models import RoomMember  # local import keeps cycles out

    rows = list(
        session.scalars(
            select(RoomMember).where(RoomMember.room_id == room_id)
        )
    )
    total = 0
    for m in rows:
        if exclude_user_id is not None and m.user_id == exclude_user_id:
            continue
        total += send_push_to_user(session, m.user_id, payload)
    return total

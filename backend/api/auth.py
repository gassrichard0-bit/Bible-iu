"""Simple shared-password gate.

Reads `BIBLE_IU_PASSWORD` from the environment. If set, every API route
this dependency is attached to must include a matching `X-App-Password`
header. If unset, the gate is open (back-compat with the current public
deploy and the test suite).

This is intentionally lightweight — one shared secret, not per-user
auth (`TODO(spec)` per CLAUDE.md §4.11, §14). It exists to keep the
LLM bill bounded while the URL is shared with friends.
"""
from __future__ import annotations

import os

from fastapi import Header, HTTPException


def _expected() -> str | None:
    pw = os.environ.get("BIBLE_IU_PASSWORD", "").strip()
    return pw or None


def require_password(
    x_app_password: str | None = Header(default=None),
) -> None:
    expected = _expected()
    if expected is None:
        return
    if not x_app_password or x_app_password != expected:
        raise HTTPException(
            status_code=401,
            detail="App password required (header X-App-Password).",
        )

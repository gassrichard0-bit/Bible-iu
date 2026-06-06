"""Observability — structured logging + optional Sentry.

JSON logs (one event per line) make Fly / any log aggregator parseable
without regex gymnastics. Sentry is gated on `SENTRY_DSN`; when unset
the import never runs so we don't ship the SDK to dev.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any


class _JsonFormatter(logging.Formatter):
    """One line per record, JSON-encoded. `extra={}` fields land at the
    top level so they're query-able without parsing the message text."""

    _RESERVED = {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "taskName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": int(time.time() * 1000),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Pass-through any `extra=` keys the caller passed in.
        for k, v in record.__dict__.items():
            if k in self._RESERVED or k.startswith("_"):
                continue
            try:
                json.dumps(v)
                payload[k] = v
            except (TypeError, ValueError):
                payload[k] = repr(v)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, separators=(",", ":"))


def configure_logging() -> None:
    """Idempotent — safe to call from lifespan startup."""
    root = logging.getLogger()
    if any(getattr(h, "_bible_iu_json", False) for h in root.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    handler._bible_iu_json = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    # Uvicorn duplicates access logs at INFO; let them flow through the
    # same JSON pipeline rather than the default colored text format.
    for noisy in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        log = logging.getLogger(noisy)
        log.handlers.clear()
        log.propagate = True


def configure_sentry() -> None:
    """No-op when DSN is unset, so dev/test never load the SDK."""
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return
    try:
        import sentry_sdk  # type: ignore[import-not-found]
        from sentry_sdk.integrations.fastapi import FastApiIntegration  # type: ignore[import-not-found]
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration  # type: ignore[import-not-found]
    except ImportError:
        logging.getLogger("bible_iu.observability").warning(
            "SENTRY_DSN set but `sentry-sdk` not installed; skipping."
        )
        return
    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("BIBLE_IU_ENV", "production"),
        traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
        send_default_pii=False,
        integrations=[FastApiIntegration(), SqlalchemyIntegration()],
    )

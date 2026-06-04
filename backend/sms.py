"""SMS sender abstraction for phone verification.

Two implementations:
  * LogOnlySender  — writes the code to `backend/data/sms.log`. Dev/no-keys mode.
  * TwilioSender   — POSTs to the Twilio REST API. Activated when
                     TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM are
                     all set in the environment.

The message body is the canonical WebOTP format so Chrome on Android (and
Safari ≥17.4) auto-fills the code into the OTP input:

    Your Bible IU code is 814932

    @bible.access-term.com #814932

The trailing line bound to our origin is what the browser reads.
"""
from __future__ import annotations

import base64
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol


_LOG = logging.getLogger("bible_iu.sms")
_LOG_FILE = Path(__file__).resolve().parent / "data" / "sms.log"


# Bound to the production origin so WebOTP only auto-fills on that origin.
# When testing locally over http://127.0.0.1:8765 the browser will not auto-
# fill, but the visible "Your … code is XXXXXX" line still works — the user
# can read and type it.
WEBOTP_ORIGIN = os.environ.get("WEBOTP_ORIGIN", "bible.access-term.com")


def format_otp_message(code: str) -> str:
    return (
        f"Your Bible IU code is {code}\n"
        f"\n"
        f"@{WEBOTP_ORIGIN} #{code}"
    )


class SmsSender(Protocol):
    def send(self, to_e164: str, body: str) -> None: ...


class LogOnlySender:
    """Append the message to data/sms.log. Used when no provider is
    configured — fine for local testing, NOT for production."""

    def send(self, to_e164: str, body: str) -> None:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        with _LOG_FILE.open("a") as f:
            f.write(f"=== {ts} → {to_e164} ===\n{body}\n\n")
        _LOG.warning("SMS (log-only) to %s: %s", to_e164, body.splitlines()[0])


class TwilioSender:
    """Sends via Twilio REST API. No SDK dependency — uses stdlib urllib
    so we don't pull in 80 transitive deps for one HTTP POST."""

    def __init__(self, sid: str, token: str, from_number: str):
        self._sid = sid
        self._token = token
        self._from = from_number

    def send(self, to_e164: str, body: str) -> None:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Messages.json"
        data = urllib.parse.urlencode(
            {"From": self._from, "To": to_e164, "Body": body}
        ).encode("utf-8")
        auth = base64.b64encode(f"{self._sid}:{self._token}".encode()).decode()
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        # 10s timeout — Twilio normally responds in <500ms; anything slower
        # is a network problem we'd rather fail fast on.
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"Twilio rejected with {resp.status}")


def get_sender() -> SmsSender:
    """Picks Twilio if creds are present, else LogOnlySender."""
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_FROM")
    if sid and token and from_number:
        return TwilioSender(sid, token, from_number)
    return LogOnlySender()

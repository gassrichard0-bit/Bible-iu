"""Rule-bounded web search (CLAUDE.md §6.2, rule-guide.MD §8).

Lets the agent reach for outside commentary when scripture + cross-refs
aren't enough. Every result is filtered (allowlist, length bounds,
profanity, injection patterns) before it returns; the citation engine
then runs entailment-verifies the agent's claims against the web text
just as it does for any other source.

Architectural notes
-------------------
- Per `architecture.MD` §3, web search should run in a *sandbox worker*.
  This first version runs in-process behind the `WebSearcher` Protocol —
  the boundary is logical, not yet process-level. Returns are treated as
  data only (never as instructions): the agent's prompt encloses them in
  a SOURCES block that the model knows not to follow as commands.
- `TODO(spec)`: move to a subprocess once we have multi-source search
  (rule-guide.MD §13.2 — sandbox isolated from user data).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import quote_plus, urlparse

import httpx


# Allowlist of domains we trust enough to surface commentary from.
# Each is public-domain or aggregates public-domain commentary. The
# agent's truth filter still validates length / injection / profanity
# regardless.
DEFAULT_ALLOWLIST: frozenset[str] = frozenset({
    "biblehub.com",
    "studylight.org",
    "blueletterbible.org",
    "preceptaustin.org",
    "enduringword.com",
    "biblestudytools.com",
    "ccel.org",
})


# Patterns that suggest a fetched page is trying to subvert the agent.
# We never execute these strings — they're data — but if a page has them
# the source itself is suspect (rule-guide.MD §8.4 — no deceptive sources).
_INJECTION_PATTERNS = re.compile(
    r"(ignore (?:previous|the above)|disregard (?:your|the)|"
    r"new instructions|system prompt|you are now |forget your|"
    r"override the rule)",
    re.IGNORECASE,
)


# Light profanity check — reuses the seed list from the rule middleware
# rather than letting the model decide what's clean.
_PROFANITY = {
    "shit", "fuck", "fucking", "bitch", "asshole", "bastard",
    "cunt", "cock", "whore", "slut",
}
_PROFANITY_RE = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in _PROFANITY) + r")\b",
    re.IGNORECASE,
)


@dataclass
class WebSearchResult:
    title: str
    url: str
    body: str
    source_domain: str


class WebSearcher(Protocol):
    def search(
        self,
        query: str,
        *,
        verse_ref: str = "",
        limit: int = 3,
    ) -> list[WebSearchResult]: ...


@dataclass
class DuckDuckGoSearcher:
    """Searches via DuckDuckGo's HTML-only interface (no API key), then
    fetches each top hit and runs the truth filter.

    Stays inside the rule-bounded sandbox by:
      1. Restricting result URLs to the `allowlist`.
      2. Rejecting pages with prompt-injection patterns.
      3. Bounding body length (no full-page dumps).
      4. Filtering profanity (rule-guide.MD §6.1).
    """

    allowlist: frozenset[str] = DEFAULT_ALLOWLIST
    user_agent: str = (
        "Mozilla/5.0 (Bible IU; +https://bible.access-term.com)"
    )
    timeout: float = 12.0
    max_body_chars: int = 2200
    min_body_chars: int = 120

    def search(
        self,
        query: str,
        *,
        verse_ref: str = "",
        limit: int = 3,
    ) -> list[WebSearchResult]:
        urls = self._ddg_links(query, want=limit * 3)
        out: list[WebSearchResult] = []
        for url in urls:
            if len(out) >= limit:
                break
            try:
                domain = urlparse(url).netloc.lower().removeprefix("www.")
                if domain not in self.allowlist:
                    continue
                page = self._fetch(url)
                title = _extract_title(page)
                body = _extract_main_text(page, self.max_body_chars)
                if len(body) < self.min_body_chars:
                    continue
                if _INJECTION_PATTERNS.search(body):
                    continue
                if _PROFANITY_RE.search(body):
                    continue
                out.append(
                    WebSearchResult(
                        title=title or domain,
                        url=url,
                        body=body,
                        source_domain=domain,
                    )
                )
            except (httpx.HTTPError, ValueError):
                continue
        return out

    # -- internals --

    def _ddg_links(self, query: str, *, want: int) -> list[str]:
        # DDG's HTML search avoids JS and rate-limits less harshly than
        # google. We extract the "uddg" param (real URL) from the result
        # anchors.
        params = {"q": query}
        try:
            r = httpx.post(
                "https://html.duckduckgo.com/html/",
                data=params,
                headers={"User-Agent": self.user_agent},
                timeout=self.timeout,
                follow_redirects=True,
            )
            r.raise_for_status()
            html = r.text
        except httpx.HTTPError:
            return []
        urls: list[str] = []
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"', html):
            href = m.group(1)
            # DDG wraps real URLs as /l/?uddg=...&...
            mm = re.search(r"[?&]uddg=([^&]+)", href)
            real = httpx.URL(href).params.get("uddg", "") if "uddg=" in href else ""
            if mm:
                real = httpx.URL(href).params.get("uddg", "")
            if real:
                # urldecode
                from urllib.parse import unquote
                urls.append(unquote(real))
            elif href.startswith("http"):
                urls.append(href)
            if len(urls) >= want:
                break
        return urls

    def _fetch(self, url: str) -> str:
        r = httpx.get(
            url,
            headers={"User-Agent": self.user_agent},
            timeout=self.timeout,
            follow_redirects=True,
        )
        r.raise_for_status()
        return r.text


_TAG = re.compile(r"<[^>]+>")
_SCRIPT_STYLE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)
_WS = re.compile(r"\s+")


def _extract_title(html: str) -> str:
    m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    return (m.group(1).strip() if m else "")[:200]


def _extract_main_text(html: str, limit: int) -> str:
    """Naïve main-text extraction: strip scripts + tags, collapse
    whitespace, truncate. Good enough for static commentary pages on
    the allowlist; we accept that JS-heavy sites won't be usable."""
    cleaned = _SCRIPT_STYLE.sub(" ", html)
    text = _TAG.sub(" ", cleaned)
    text = _WS.sub(" ", text).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


@dataclass
class _NoopWebSearcher:
    """Default — returns nothing. Used when web search is disabled."""

    def search(
        self,
        query: str,
        *,
        verse_ref: str = "",
        limit: int = 3,
    ) -> list[WebSearchResult]:
        return []


def make_searcher(enabled: bool = False) -> WebSearcher:
    """Factory — the default is a no-op so deployments don't accidentally
    hit the network without an explicit opt-in."""
    return DuckDuckGoSearcher() if enabled else _NoopWebSearcher()

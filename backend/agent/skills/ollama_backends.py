"""Ollama-based generator + verifier — fully local inference path.

The DeepSeek backends are great when you have an API key and a
network. For the local-first promise (`CLAUDE.md` §8), this module
provides a drop-in replacement that talks to a locally-running
`ollama` daemon (default `http://localhost:11434`).

Activation: set `OLLAMA_MODEL` in the env (e.g. `OLLAMA_MODEL=llama3.1`)
and `_orchestrator()` in `backend/api/main.py` will pick this generator
over DeepSeek. No DeepSeek key required when this is active.

Verifier: `OllamaVerifier` uses the same model with a tightly-bounded
yes/no NLI prompt. For best results pair it with `LocalNLIVerifier`
via `StackedVerifier` — the cross-encoder is a more reliable
entailment judge than a general chat model.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

from ..reasoning.types import GeneratedStatement, NoteSuggestion, RetrievedChunk
from .deepseek_backends import (
    _PREAMBLE,
    _PREAMBLE_BYPASS,
    _GENERATOR_SCHEMA_PROMPT,
    _BYPASS_SCHEMA_PROMPT,
    _format_history,
    _scope_label,
    _format_sources,
)


log = logging.getLogger("bible_iu.ollama")


_OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://localhost:11434")
_OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1")
_OLLAMA_TIMEOUT_S = float(os.environ.get("OLLAMA_TIMEOUT_S", "120"))


def ollama_configured() -> bool:
    """Cheap probe so the orchestrator can prefer this generator
    over DeepSeek when the user explicitly enabled it."""
    return os.environ.get("OLLAMA_MODEL") is not None


def _chat(
    system: str,
    user: str,
    on_stream: Optional[Callable[[str], None]] = None,
) -> str:
    """One round-trip to ollama's /api/chat. When `on_stream` is set,
    we stream tokens and call the callback for each chunk; otherwise
    we wait for the final assembled response."""
    payload = {
        "model": _OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": on_stream is not None,
        "options": {"temperature": 0.4},
    }
    with httpx.Client(timeout=_OLLAMA_TIMEOUT_S) as client:
        if on_stream is None:
            r = client.post(f"{_OLLAMA_BASE}/api/chat", json=payload)
            r.raise_for_status()
            data = r.json()
            return data.get("message", {}).get("content", "") or ""
        # Streaming: ollama emits one JSON object per line.
        chunks: list[str] = []
        with client.stream(
            "POST", f"{_OLLAMA_BASE}/api/chat", json=payload
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                tok = obj.get("message", {}).get("content", "")
                if tok:
                    chunks.append(tok)
                    on_stream(tok)
                if obj.get("done"):
                    break
        return "".join(chunks)


@dataclass
class OllamaGenerator:
    """Mirrors `DeepSeekGenerator` but routes through a local
    ollama daemon. Returns the same `(reasoning, answer, statements,
    note_suggestion)` tuple so the orchestrator + citation engine
    don't care which backend is in use."""

    model: str = _OLLAMA_MODEL

    def generate(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        history: Optional[list] = None,
        bypass: bool = False,
        scope_kind: str = "verse",
        revision_hints: Optional[list[str]] = None,
    ) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
        return self.generate_streaming(
            verse_ref, question, retrieval, None,
            history=history, bypass=bypass, scope_kind=scope_kind,
            revision_hints=revision_hints,
        )

    def generate_streaming(
        self,
        verse_ref: str,
        question: str,
        retrieval: list[RetrievedChunk],
        on_reasoning_chunk: Optional[Callable[[str], None]],
        history: Optional[list] = None,
        bypass: bool = False,
        scope_kind: str = "verse",
        revision_hints: Optional[list[str]] = None,
    ) -> tuple[str, str, list[GeneratedStatement], Optional[NoteSuggestion]]:
        sources_text, short_to_real = _format_sources(retrieval)
        history_block = _format_history(history or [])
        scope_label = _scope_label(scope_kind, verse_ref)

        if bypass:
            system = _PREAMBLE_BYPASS
            schema = _BYPASS_SCHEMA_PROMPT
        else:
            system = _PREAMBLE
            schema = _GENERATOR_SCHEMA_PROMPT

        revision_block = ""
        if revision_hints and not bypass:
            lines = "\n".join(f"  - {h}" for h in revision_hints if h)
            revision_block = (
                "REVIEWER FEEDBACK FROM PRIOR ATTEMPT — address each item:\n"
                + lines
            )

        user_msg = "\n\n".join(
            filter(
                None,
                [
                    scope_label,
                    f"SOURCES:\n{sources_text}",
                    f"PRIOR DISCUSSION:\n{history_block}" if history_block else "",
                    revision_block,
                    f"QUESTION: {question}",
                    schema,
                ],
            )
        )
        try:
            raw = _chat(system, user_msg, on_stream=on_reasoning_chunk)
        except Exception as e:  # noqa: BLE001
            log.warning("ollama generate failed: %s", e)
            return (
                "Local model unreachable; the citation engine has no "
                "model output to verify.",
                f"(local model error: {e})",
                [],
                None,
            )
        # Best-effort JSON parse — same fallback as the DeepSeek path.
        try:
            # Strip code-fence wrappers some local models add.
            text = raw.strip()
            if text.startswith("```"):
                text = text.strip("`")
                # First line might be `json` after the fence.
                if "\n" in text:
                    text = text.split("\n", 1)[1]
            data = json.loads(text)
        except Exception:
            return (
                "Local model returned non-JSON output; surfaced raw.",
                raw,
                [],
                None,
            )
        reasoning = data.get("reasoning", "") or ""
        answer = data.get("answer", "") or ""
        claims = data.get("claims", []) or []
        statements: list[GeneratedStatement] = []
        for c in claims:
            text = c.get("text", "")
            cited = c.get("cited_ids", []) or []
            real_ids = [short_to_real.get(c_id, c_id) for c_id in cited]
            statements.append(
                GeneratedStatement(text=text, source_ids=real_ids)
            )
        note_to_append = data.get("note_to_append") or None
        suggestion: Optional[NoteSuggestion] = None
        if isinstance(note_to_append, dict):
            body = (note_to_append.get("body") or "").strip()
            if body:
                suggestion = NoteSuggestion(
                    body=body[:240],
                    verse_anchor=note_to_append.get("verse_anchor"),
                )
        return reasoning, answer, statements, suggestion


@dataclass
class OllamaVerifier:
    """Yes/no NLI judge against the same local model. Use sparingly —
    a small cross-encoder NLI (LocalNLIVerifier) is more reliable.
    Provided so the rule layer's `contradicts_scripture` path has
    a fully-local option when the user runs `OLLAMA_ONLY=1`."""

    model: str = _OLLAMA_MODEL

    def _yesno(self, system: str, user: str) -> bool:
        try:
            reply = _chat(system, user).strip().lower()
        except Exception:
            return False
        # Permissive parse — many local models hedge.
        return reply.startswith("yes")

    def entails(self, claim: str, source_text: str) -> bool:
        system = (
            "You are a strict entailment judge. Answer with only `yes` "
            "or `no`. Reply `yes` only when the SOURCE clearly supports "
            "the CLAIM. Hedging answers count as `no`."
        )
        user = f"SOURCE: {source_text}\nCLAIM: {claim}"
        return self._yesno(system, user)

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        system = (
            "You are a contradiction judge. Answer with only `yes` or "
            "`no`. Reply `yes` only when the CLAIM directly contradicts "
            "the SCRIPTURE."
        )
        user = f"SCRIPTURE: {scripture_text}\nCLAIM: {claim}"
        return self._yesno(system, user)

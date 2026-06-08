"""Local NLI (natural-language inference) verifier.

Implements the `Verifier` protocol in `agent/reasoning/interfaces.py`
using a small cross-encoder NLI model that runs on CPU. Replaces
`PassThroughVerifier` (which returns False always) as the meaningful
default when no cloud generator/verifier is configured, and can
also be stacked alongside `DeepSeekVerifier` so the same vendor
doesn't both generate and verify (citation-engine.MD §5 invariant).

Defaults to `cross-encoder/nli-deberta-v3-base` — ~440MB once
downloaded, runs at ~200-500ms/claim on a recent CPU. The model
outputs three scores per (premise, hypothesis) pair:
   [contradiction, entailment, neutral]
We treat:
   entails(claim, source)        → entailment is the top label AND
                                    score >= ENTAIL_THRESHOLD.
   contradicts_scripture(claim,
                         scripture) → contradiction is top AND
                                       score >= CONTRA_THRESHOLD.

Thresholds bias toward false-negatives over false-positives — the
citation engine drops unverified claims, which is the SAFE failure
mode (`citation-engine.MD` §10). It is better to drop a true claim
than to pass a false one through.

Lazy-loaded so importing this module never costs the model load.
Thread-safe singleton — once the model is in memory it's shared
across all verification calls.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Optional

log = logging.getLogger("bible_iu.local_nli")


# Model choice — overridable via env. Stick to a base-size NLI model
# so CPU latency is acceptable. If we ever want a tiny fast model:
# `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` or a distil variant.
_MODEL_NAME = os.environ.get(
    "LOCAL_NLI_MODEL",
    "cross-encoder/nli-deberta-v3-base",
)

# Score thresholds. Tuned conservatively — see module docstring.
_ENTAIL_THRESHOLD = float(os.environ.get("LOCAL_NLI_ENTAIL_THRESHOLD", "0.70"))
_CONTRA_THRESHOLD = float(os.environ.get("LOCAL_NLI_CONTRA_THRESHOLD", "0.70"))

# Label order this family of models emits (cross-encoder/nli-*).
# Verified against the HuggingFace model card; double-check if the
# model is swapped via env. Hard-coding the order avoids paying a
# config lookup per call.
_LABEL_ORDER = ("contradiction", "entailment", "neutral")


class _ModelHolder:
    """Lazy singleton wrapping (tokenizer, model). First `get()` call
    pays the load; subsequent calls reuse the cached pair. Failure
    to load is cached as None so we don't retry on every call."""

    _instance: Optional["_ModelHolder"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._loaded = False
        self._tokenizer = None
        self._model = None
        self._load_lock = threading.Lock()

    @classmethod
    def shared(cls) -> "_ModelHolder":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def get(self):
        """Returns (tokenizer, model). On load failure returns (None, None)
        and caches that — every subsequent call is a quick no-op."""
        if self._loaded:
            return self._tokenizer, self._model
        with self._load_lock:
            if self._loaded:
                return self._tokenizer, self._model
            try:
                from transformers import (  # type: ignore
                    AutoTokenizer,
                    AutoModelForSequenceClassification,
                )
                import torch  # type: ignore
                log.info("loading local NLI model: %s", _MODEL_NAME)
                tok = AutoTokenizer.from_pretrained(_MODEL_NAME)
                model = AutoModelForSequenceClassification.from_pretrained(
                    _MODEL_NAME
                )
                model.eval()
                # Hint torch toward inference-only — disables autograd
                # bookkeeping for every forward pass.
                torch.set_grad_enabled(False)
                self._tokenizer = tok
                self._model = model
                log.info("local NLI model ready")
            except Exception as e:  # noqa: BLE001
                log.warning(
                    "local NLI unavailable (%s) — verifier will refuse all "
                    "claims as a safe default", e,
                )
                self._tokenizer = None
                self._model = None
            self._loaded = True
        return self._tokenizer, self._model


def _score(premise: str, hypothesis: str) -> dict[str, float] | None:
    """Run the NLI head on a (premise, hypothesis) pair. Returns
    {label: prob} or None if the model couldn't be loaded."""
    tok, model = _ModelHolder.shared().get()
    if tok is None or model is None:
        return None
    try:
        import torch  # type: ignore
        with torch.inference_mode():
            inputs = tok(
                premise,
                hypothesis,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            logits = model(**inputs).logits
            probs = torch.softmax(logits, dim=-1).squeeze(0).tolist()
        # `_LABEL_ORDER` is the model's id2label order for this family.
        return {label: float(p) for label, p in zip(_LABEL_ORDER, probs)}
    except Exception as e:  # noqa: BLE001
        log.warning("local NLI scoring crashed: %s", e)
        return None


class LocalNLIVerifier:
    """Verifier protocol implementation using a local cross-encoder
    NLI model. See module docstring for thresholds + failure model."""

    def entails(self, claim: str, source_text: str) -> bool:
        if not claim.strip() or not source_text.strip():
            return False
        scores = _score(premise=source_text, hypothesis=claim)
        if scores is None:
            return False
        top_label = max(scores, key=scores.get)
        return top_label == "entailment" and scores["entailment"] >= _ENTAIL_THRESHOLD

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        if not claim.strip() or not scripture_text.strip():
            return False
        scores = _score(premise=scripture_text, hypothesis=claim)
        if scores is None:
            return False
        top_label = max(scores, key=scores.get)
        return top_label == "contradiction" and scores["contradiction"] >= _CONTRA_THRESHOLD


class StackedVerifier:
    """Composes two verifiers so neither grades its own homework
    (`citation-engine.MD` §5: 'the verifier must be a separate pass
    from generation'). When the DeepSeekVerifier is paired with the
    LocalNLIVerifier this guards against the failure mode where the
    generator's vendor is also the one approving the claim.

    Semantics:
      entails              — BOTH must say entails (AND)
      contradicts_scripture — EITHER flagging contradiction is enough (OR)

    The asymmetric AND/OR is intentional: we want entailment to be
    the conservative path (drop unless both agree), and contradiction
    to be the aggressive path (flag if either suspects)."""

    def __init__(self, primary, secondary) -> None:
        self.primary = primary
        self.secondary = secondary

    def entails(self, claim: str, source_text: str) -> bool:
        if not self.primary.entails(claim, source_text):
            return False
        return self.secondary.entails(claim, source_text)

    def contradicts_scripture(self, claim: str, scripture_text: str) -> bool:
        if self.primary.contradicts_scripture(claim, scripture_text):
            return True
        return self.secondary.contradicts_scripture(claim, scripture_text)

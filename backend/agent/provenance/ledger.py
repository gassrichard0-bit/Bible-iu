"""Provenance ledger (CLAUDE.md §7.5, citation-engine.MD §8).

Every surviving claim writes one record. Powers the left-panel "resources
used" view and the audit log. In-memory implementation is sufficient for
the eval suite; production swaps in SQLite/Postgres via the same
interface.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, Protocol


@dataclass
class ProvenanceRecord:
    claim_id: str
    session_id: str
    room_id: str
    text: str
    citation_ids: list[str]
    kind: str
    verification: str
    tradition: str | None = None
    reliability: str | None = None
    verse_refs: list[str] = field(default_factory=list)
    reasoning_step_ref: str | None = None


class Ledger(Protocol):
    def open_session(
        self,
        session_id: str,
        room_id: str,
        verse_ref: str,
        question: str,
    ) -> None: ...
    def close_session(
        self,
        session_id: str,
        reasoning: str,
        answer: str,
        resources_used: list[str],
        recommendations: list[str],
    ) -> None: ...
    def write(self, record: ProvenanceRecord) -> None: ...
    def for_session(self, session_id: str) -> list[ProvenanceRecord]: ...


@dataclass
class InMemoryLedger:
    records: list[ProvenanceRecord] = field(default_factory=list)
    sessions: dict[str, dict] = field(default_factory=dict)

    def open_session(
        self,
        session_id: str,
        room_id: str,
        verse_ref: str,
        question: str,
    ) -> None:
        self.sessions[session_id] = {
            "room_id": room_id,
            "verse_ref": verse_ref,
            "question": question,
            "reasoning": "",
            "answer": "",
            "resources_used": [],
            "recommendations": [],
        }

    def close_session(
        self,
        session_id: str,
        reasoning: str,
        answer: str,
        resources_used: list[str],
        recommendations: list[str],
    ) -> None:
        if session_id in self.sessions:
            self.sessions[session_id].update({
                "reasoning": reasoning,
                "answer": answer,
                "resources_used": resources_used,
                "recommendations": recommendations,
            })

    def write(self, record: ProvenanceRecord) -> None:
        self.records.append(record)

    def for_session(self, session_id: str) -> list[ProvenanceRecord]:
        return [r for r in self.records if r.session_id == session_id]

    def __iter__(self) -> Iterator[ProvenanceRecord]:
        return iter(self.records)


@dataclass
class SqlLedger:
    """Persists provenance to the `Provenance` + `ReasoningSession` SQL
    tables (CLAUDE.md §7.5, data-model.MD §5).

    Each write opens its own short-lived session so callers don't need
    to thread one through — important because the citation engine runs
    inside FastAPI request handlers AND in tests, and we never want a
    half-written ledger row to roll back with an unrelated transaction.
    """

    session_factory: object  # callable returning a Session

    def open_session(
        self,
        session_id: str,
        room_id: str,
        verse_ref: str,
        question: str,
    ) -> None:
        """Insert a `ReasoningSession` row at the start of a turn. The
        Provenance rows that follow point to this id via FK so the audit
        trail can reconstruct the full turn (data-model.MD §5)."""
        from ...data.models import ReasoningSession
        s = self.session_factory()
        try:
            s.add(
                ReasoningSession(
                    id=session_id,
                    room_id=room_id,
                    verse_id=None,  # verse_ref is a "BOOK.C.V" string, not the FK id
                    question=question,
                    reasoning="",
                    answer="",
                    resources_used=[],
                    recommendations=[],
                )
            )
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    def close_session(
        self,
        session_id: str,
        reasoning: str,
        answer: str,
        resources_used: list[str],
        recommendations: list[str],
    ) -> None:
        """Populate the finished turn's reasoning/answer/resources after
        the citation engine returns."""
        from ...data.models import ReasoningSession
        s = self.session_factory()
        try:
            row = s.get(ReasoningSession, session_id)
            if row is not None:
                row.reasoning = reasoning
                row.answer = answer
                row.resources_used = resources_used
                row.recommendations = recommendations
                s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    def write(self, record: ProvenanceRecord) -> None:
        from ...data.models import Provenance
        from uuid import uuid4
        session = self.session_factory()
        try:
            session.add(
                Provenance(
                    id=str(uuid4()),
                    claim_id=record.claim_id,
                    session_id=record.session_id,
                    source_refs=record.citation_ids,
                    verse_refs=record.verse_refs,
                    tradition=record.tradition,
                    reliability=record.reliability,
                    reasoning_step_ref=record.reasoning_step_ref,
                    verification_result=record.verification,
                    kind=record.kind,
                )
            )
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def for_session(self, session_id: str) -> list[ProvenanceRecord]:
        from ...data.models import Provenance
        from sqlalchemy import select
        s = self.session_factory()
        try:
            rows = s.scalars(
                select(Provenance).where(Provenance.session_id == session_id)
            ).all()
            return [
                ProvenanceRecord(
                    claim_id=r.claim_id,
                    session_id=r.session_id,
                    room_id="",  # not stored at row level
                    text="",
                    citation_ids=list(r.source_refs or []),
                    kind=r.kind,
                    verification=r.verification_result,
                    tradition=r.tradition,
                    reliability=r.reliability,
                    verse_refs=list(r.verse_refs or []),
                    reasoning_step_ref=r.reasoning_step_ref,
                )
                for r in rows
            ]
        finally:
            s.close()

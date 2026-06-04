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


class Ledger(Protocol):
    def write(self, record: ProvenanceRecord) -> None: ...
    def for_session(self, session_id: str) -> list[ProvenanceRecord]: ...


@dataclass
class InMemoryLedger:
    records: list[ProvenanceRecord] = field(default_factory=list)

    def write(self, record: ProvenanceRecord) -> None:
        self.records.append(record)

    def for_session(self, session_id: str) -> list[ProvenanceRecord]:
        return [r for r in self.records if r.session_id == session_id]

    def __iter__(self) -> Iterator[ProvenanceRecord]:
        return iter(self.records)


@dataclass
class SqlLedger:
    """Persists provenance to the `Provenance` SQL table (CLAUDE.md §7.5).

    Each `write` opens its own short-lived session so callers don't need
    to thread one through — important because the citation engine runs
    inside FastAPI request handlers AND in tests, and we never want a
    half-written ledger row to roll back with an unrelated transaction.

    `TODO(spec)`: the schema's reasoning_step_ref + Provenance.reasoning
    metadata is not yet populated (CLAUDE.md §10).
    """

    session_factory: object  # callable returning a Session

    def write(self, record: ProvenanceRecord) -> None:
        # Local import to avoid a cycle with the data layer at module load.
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
                    verse_refs=[],
                    tradition=record.tradition,
                    reliability=record.reliability,
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
                )
                for r in rows
            ]
        finally:
            s.close()

/**
 * Left panel — Resources (CLAUDE.md §4.3, §4.4, §4.5).
 *
 * Room scope: the whole study library (placeholder until commentary +
 * cross-references are seeded).
 *
 * Verse focus: "resources used for this verse" — lighting up exactly
 * what the citation engine pulled (CLAUDE.md §4.5 step 4, citation-engine.MD §8).
 * That data comes straight from the last reasoning response's verified
 * claims, so what you see here was actually used.
 */
import { useEffect, useState } from "react";
import type {
  CitationOut,
  ClaimOut,
  CrossRefOut,
} from "../../lib/api";
import { api, parseVerseRef } from "../../lib/api";

interface Props {
  scopedToVerse: boolean;
  citationsUsed: ClaimOut[];
  /** Focused verse — drives the cross-references fetch (CLAUDE.md §7.4). */
  focusVerseId?: string | null;
  /** Mobile-only: when provided, renders a close button in the header. */
  onCloseMobile?: () => void;
  /** When provided, clicking a source jumps focus there. */
  onJumpToCitation?: (source_id: string) => void;
}

/**
 * Friendly display names for the upper-cased getbible.net abbreviations
 * the seed script bakes into translation citation_ids. Without this map
 * a Hebrew row reads "CODEX · GEN.1.1" — true to the API origin, useless
 * to the reader. Anything not in the map falls back to the raw prefix.
 */
const TRANSLATION_LABELS: Record<string, string> = {
  CODEX: "Hebrew (WLC)",
  TEXTUSRECEPTUS: "Greek (TR)",
  ARABICSV: "Arabic (SVD)",
};

/**
 * Turn a citation source_id like "trans:KJV:GEN.1.1" into:
 *   { display, sub, kind }   where display = "KJV", sub = "GEN.1.1"
 * Falls back gracefully for unknown formats.
 */
function describeSource(ct: CitationOut): {
  display: string;
  sub: string;
  kind: "translation" | "resource" | "other";
} {
  const id = ct.source_id;
  if (id.startsWith("trans:")) {
    const rest = id.slice("trans:".length);
    // rest is like "KJV:GEN.1.1" — split on the LAST occurrence of a
    // verse_id pattern. The translation name can contain colons.
    const m = rest.match(/^(.+?):([A-Z0-9]+\.\d+\.\d+)$/);
    if (m) {
      const rawPrefix = m[1];
      const display = TRANSLATION_LABELS[rawPrefix] ?? rawPrefix;
      return { display, sub: m[2], kind: "translation" };
    }
    return { display: rest, sub: "", kind: "translation" };
  }
  if (id.startsWith("res:")) {
    return {
      display: id.slice("res:".length),
      sub: ct.tradition ?? "",
      kind: "resource",
    };
  }
  const parsed = parseVerseRef(id);
  if (parsed) return { display: parsed.ref, sub: "", kind: "translation" };
  return { display: id, sub: "", kind: "other" };
}

export function ResourcesPanel({
  scopedToVerse,
  citationsUsed,
  focusVerseId,
  onCloseMobile,
  onJumpToCitation,
}: Props) {
  // Unique sources actually pulled, in first-seen order.
  const seen = new Map<string, CitationOut>();
  for (const claim of citationsUsed) {
    for (const ct of claim.citations) {
      if (!seen.has(ct.source_id)) seen.set(ct.source_id, ct);
    }
  }
  const used = Array.from(seen.values());

  // Cross-references for the focused verse (CLAUDE.md §7.4).
  const [xrefs, setXrefs] = useState<CrossRefOut[]>([]);
  const [xrefsLoading, setXrefsLoading] = useState(false);
  useEffect(() => {
    if (!focusVerseId) {
      setXrefs([]);
      return;
    }
    let alive = true;
    setXrefsLoading(true);
    api
      .bibleXrefs(focusVerseId, 25)
      .then((rs) => alive && setXrefs(rs))
      .catch(() => alive && setXrefs([]))
      .finally(() => alive && setXrefsLoading(false));
    return () => {
      alive = false;
    };
  }, [focusVerseId]);

  return (
    <div className="flex h-full flex-col bg-paper dark:bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          {onCloseMobile && (
            <button
              onClick={onCloseMobile}
              className="rounded p-1 text-neutral-500 hover:bg-paper-soft dark:text-neutral-400 dark:hover:bg-neutral-800"
              aria-label="Close resources"
            >
              ✕
            </button>
          )}
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Sources used
          </div>
        </div>
        <span className="rounded-full border border-neutral-200 bg-paper-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {scopedToVerse ? "verse" : "room"}
        </span>
      </div>

      <ul className="flex-1 space-y-1.5 overflow-y-auto p-2.5 text-sm">
        {used.length === 0 && (
          <li className="mx-auto mt-3 max-w-xs rounded-2xl border border-neutral-200 bg-paper px-4 py-5 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
              No sources yet. Ask a question and the sources the agent
              pulled will land here.
            </div>
          </li>
        )}
        {used.map((ct) => {
          const d = describeSource(ct);
          const verified = ct.verification_result === "supported";
          return (
            <li key={ct.source_id}>
              <button
                onClick={() => onJumpToCitation?.(ct.source_id)}
                disabled={!onJumpToCitation}
                className={`group flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] transition dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
                  verified
                    ? "border-amber-200 bg-amber-50/80 hover:border-amber-300 dark:border-amber-900/50 dark:bg-amber-950/40 dark:hover:border-amber-700"
                    : "border-neutral-200 bg-paper hover:border-neutral-300 hover:bg-paper-soft dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800/60"
                } ${
                  onJumpToCitation ? "cursor-pointer" : "cursor-default"
                }`}
                title={`Jump to ${ct.source_id}`}
              >
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                    verified ? "bg-amber-500" : "bg-neutral-400"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-neutral-900 dark:text-neutral-50">
                    {d.display}
                  </div>
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {d.sub || d.kind}
                    {ct.tradition ? ` · ${ct.tradition}` : ""}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                    verified
                      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                      : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                  }`}
                >
                  {ct.verification_result}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {focusVerseId && (
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Cross-references
            </div>
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
              {xrefsLoading ? "loading…" : `${xrefs.length}`}
            </span>
          </div>
          <ul className="max-h-64 space-y-1.5 overflow-y-auto px-2.5 pb-2.5 text-sm">
            {!xrefsLoading && xrefs.length === 0 && (
              <li className="px-2 py-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                None linked.
              </li>
            )}
            {xrefs.map((x) => (
              <li key={x.to_verse_id}>
                <button
                  onClick={() => onJumpToCitation?.(x.to_verse_id)}
                  disabled={!onJumpToCitation}
                  className={`group flex w-full items-start gap-2 rounded-xl border border-neutral-200 bg-paper px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] transition hover:border-neutral-300 hover:bg-paper-soft dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:bg-neutral-800/60 ${
                    onJumpToCitation ? "cursor-pointer" : "cursor-default"
                  }`}
                  title={`Jump to ${x.to_verse_id}`}
                >
                  <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
                    {x.to_verse_id}
                  </span>
                  {x.text && (
                    <div className="line-clamp-2 text-[12px] text-neutral-600 dark:text-neutral-400">
                      {x.text}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-neutral-200 px-3 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        Cross-refs: CC-BY OpenBible.info. Sources verified per
        rule-guide.MD §4.
      </div>
    </div>
  );
}

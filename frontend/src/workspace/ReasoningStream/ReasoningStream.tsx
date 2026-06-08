/**
 * Top of center — the agent's conversation thread (CLAUDE.md §4.3, §4.7).
 *
 * Renders each prior reasoning turn as Q → reasoning → Answer + claim
 * cards (rule-guide.MD §7.3 keeps reasoning visually distinct from the
 * answer). The newest turn auto-scrolls into view.
 *
 * Each new turn went through the full citation engine — prior turns are
 * conversational context for the model, not implicit fact carriers
 * (citation-engine.MD §10).
 */
import { useEffect, useRef, useState } from "react";
import type { ClaimOut } from "../../lib/api";
import { RichText } from "../../lib/RichText";
import type { ConversationTurn } from "../Workspace";
import { speak, ttsSupported } from "../../lib/tts";
import { SpeakerIcon } from "../../lib/Icons";

/** Strip the inline citation markers `[trans:KJV:GEN.1.1]` /
 *  `[note:abc]` etc. before sending the answer to TTS — read aloud
 *  the model's actual prose, not the engine's internal source
 *  pointers. RichText already does this visually; for audio we
 *  redo it on the raw string. */
function stripCitationMarkers(text: string): string {
  return text
    // The citation engine wraps source ids in `[type:rest]` brackets.
    // Match conservatively — only `[a-z_]+:` openings so we don't
    // accidentally chew through markdown like `[link](url)`.
    .replace(/\[[a-z_]+:[^\]\s][^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Props {
  turns: ConversationTurn[];
  showOriginal: boolean;
  onToggleOriginal: () => void;
  onJumpToCitation: (source_id: string) => void;
  debugMode: boolean;
}

export function ReasoningStream({
  turns,
  showOriginal,
  onToggleOriginal,
  onJumpToCitation,
  debugMode,
}: Props) {
  const latest = turns[turns.length - 1];
  const scroller = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the latest turn into view as it streams.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    latest?.id,
    latest?.reasoning,
    latest?.response,
    latest?.pending,
  ]);

  // Track when the latest answer just settled, so we can give the
  // 🔊 button a brief amber pulse drawing the user's eye to it. We
  // don't try to auto-play (iOS PWA's autoplay block makes it
  // unreliable); the prominent button is the dependable path.
  const [freshAnswerId, setFreshAnswerId] = useState<string | null>(null);
  useEffect(() => {
    if (!latest || latest.pending) return;
    if (!latest.response?.answer) return;
    setFreshAnswerId(latest.id);
    const t = window.setTimeout(() => setFreshAnswerId(null), 4000);
    return () => window.clearTimeout(t);
  }, [latest?.id, latest?.pending, latest?.response?.answer]);

  const decision = latest?.response?.decision;
  const isStreaming = !!latest?.pending;

  return (
    <div className="flex h-full flex-col bg-paper-soft dark:bg-neutral-950">
      <div className="glass-specular flex items-center justify-between gap-2 border-b border-white/40 bg-paper/55 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 backdrop-blur-2xl backdrop-saturate-[1.8] dark:border-white/10 dark:bg-neutral-900/45 dark:text-neutral-400">
        <div className="flex items-center gap-2 truncate">
          <span>Reasoning</span>
          {isStreaming && (
            <span className="text-neutral-400 dark:text-neutral-500">
              streaming…
            </span>
          )}
          {decision && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                decision === "pass"
                  ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                  : decision === "revise"
                    ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
              }`}
            >
              {decision}
            </span>
          )}
          {turns.length > 1 && (
            <span className="text-[10px] font-normal normal-case text-neutral-400 dark:text-neutral-500">
              · turn {turns.length}
            </span>
          )}
        </div>
        <label
          className="flex shrink-0 items-center gap-1 text-[10px] font-normal normal-case text-neutral-500 dark:text-neutral-400"
          title="RTL-aware (CLAUDE.md §4.9). Hebrew + Greek + Arabic."
        >
          <input
            type="checkbox"
            checked={showOriginal}
            onChange={onToggleOriginal}
          />
          Original language
        </label>
      </div>

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-4 py-3 text-sm"
      >
        {turns.length === 0 && (
          <p className="text-neutral-500 dark:text-neutral-400">
            Pick a verse on the right and ask a question below. Reasoning
            shows here, and the gated answer follows. Follow-ups continue
            the conversation.
          </p>
        )}
        {turns.map((t, idx) => (
          <TurnBlock
            key={t.id}
            turn={t}
            index={idx + 1}
            onJumpToCitation={onJumpToCitation}
            debugMode={debugMode}
            isFresh={freshAnswerId === t.id}
          />
        ))}
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  index,
  onJumpToCitation,
  debugMode,
  isFresh,
}: {
  turn: ConversationTurn;
  index: number;
  onJumpToCitation: (source_id: string) => void;
  debugMode: boolean;
  isFresh: boolean;
}) {
  const r = turn.response;
  return (
    <article className="mb-5 border-b border-neutral-200 pb-4 last:mb-0 last:border-b-0 last:pb-0 dark:border-neutral-800">
      <section className="mb-3 rounded-2xl border border-neutral-200 bg-paper-soft px-3.5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          <span>Question · turn {index}</span>
          <span className="font-normal normal-case text-neutral-400 dark:text-neutral-500">
            {/* Prefer the scope label ("the Old Testament", "John 3")
                over the raw `verse_ref` — at non-verse scope the
                verse_ref is a placeholder anchor (e.g. GEN.1.1 for
                OT) and reading "on GEN.1.1" misleads the user into
                thinking they asked about Genesis 1:1. */}
            {turn.scope_kind && turn.scope_kind !== "verse"
              ? `about ${turn.scope_label || turn.verse_ref}`
              : `on ${turn.scope_label || turn.verse_ref}`}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-100">
          <RichText text={turn.question} onJump={onJumpToCitation} />
        </p>
      </section>

      {turn.reasoning && (
        <section className="mb-3">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Walking the steps
          </h3>
          <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-200">
            <RichText text={turn.reasoning} onJump={onJumpToCitation} />
          </p>
        </section>
      )}

      {turn.pending && !turn.reasoning && (
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          …
        </p>
      )}

      {r && (
        <>
          <section className="mb-3">
            <div className="mb-1 flex items-center gap-2">
              <h3 className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Answer
              </h3>
              {r.answer && ttsSupported() && (
                <button
                  type="button"
                  onClick={() =>
                    speak(stripCitationMarkers(r.answer), {
                      language: "en-US",
                    })
                  }
                  title="Read the answer aloud"
                  aria-label="Read the answer aloud"
                  className={`inline-flex h-10 items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100 px-3 text-[13px] font-semibold text-amber-900 shadow-[0_2px_6px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all active:scale-[0.96] dark:border-amber-700 dark:bg-amber-900/60 dark:text-amber-100 dark:shadow-[0_2px_6px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.10)] ${
                    isFresh
                      ? "animate-pulse ring-2 ring-amber-400/60 ring-offset-2 ring-offset-paper-soft dark:ring-amber-500/60 dark:ring-offset-neutral-900"
                      : ""
                  }`}
                >
                  <SpeakerIcon className="h-5 w-5" />
                  Read aloud
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-100">
              {r.answer ? (
                <RichText text={r.answer} onJump={onJumpToCitation} />
              ) : (
                "—"
              )}
            </p>
            {r.refusal_reason && (
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                Refused: {r.refusal_reason}
              </p>
            )}
            {r.revision_hints.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-yellow-800 dark:text-yellow-300">
                {r.revision_hints.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
          </section>
          {r.claims.length > 0 && (
            <ClaimList
              title="Claims"
              claims={r.claims}
              onJumpToCitation={onJumpToCitation}
            />
          )}
          {r.dropped.length > 0 && (
            <ClaimList
              title="Dropped"
              claims={r.dropped}
              onJumpToCitation={onJumpToCitation}
              muted
            />
          )}
        </>
      )}

      {debugMode && <DebugPanel turn={turn} />}

      {turn.error && (
        <p className="text-xs text-red-700 dark:text-red-300">
          Error: {turn.error}
        </p>
      )}
    </article>
  );
}

function ClaimList({
  title,
  claims,
  muted,
  onJumpToCitation,
}: {
  title: string;
  claims: ClaimOut[];
  muted?: boolean;
  onJumpToCitation: (source_id: string) => void;
}) {
  return (
    <section className="mb-2">
      <h3 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {claims.map((c, i) => (
          <li
            key={i}
            className={`rounded-xl border px-3 py-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
              muted
                ? "border-neutral-200 bg-paper-soft text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500"
                : c.kind === "scripture" || c.kind === "original_language"
                  ? "border-amber-200 bg-scripture text-neutral-800 dark:border-amber-900/60 dark:bg-scripture-dark dark:text-amber-100"
                  : c.kind === "commentary"
                    ? "border-sky-200 bg-commentary text-neutral-800 dark:border-sky-900/60 dark:bg-commentary-dark dark:text-sky-100"
                    : "border-violet-200 bg-inference text-neutral-800 dark:border-violet-900/60 dark:bg-inference-dark dark:text-violet-100"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {c.kind.replace("_", " ")}
              </span>
              {c.contradicts_scripture && (
                <span className="text-[10px] text-red-700 dark:text-red-300">
                  contradicts scripture
                </span>
              )}
            </div>
            <div className="mt-0.5">
              <RichText text={c.text} onJump={onJumpToCitation} />
            </div>
            {c.citations.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {c.citations.map((ct, j) => (
                  <button
                    key={j}
                    onClick={() => onJumpToCitation(ct.source_id)}
                    className="rounded-full border border-neutral-200 bg-paper px-2 py-0.5 font-mono shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900 dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-amber-700 dark:hover:bg-amber-950/40 dark:hover:text-amber-200"
                    title={`Jump to ${ct.source_id}`}
                  >
                    [{ct.source_id}
                    {ct.tradition ? ` · ${ct.tradition}` : ""}]
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Debug panel — only rendered when `settings.debugMode` is on. Shows
 * the pipeline's intermediate state (stage timings, raw streamed CoT,
 * any dropped claims). The citation engine still ran; this just makes
 * what it did visible.
 */
function DebugPanel({ turn }: { turn: ConversationTurn }) {
  const r = turn.response;
  return (
    <section className="mt-3 rounded border border-dashed border-neutral-300 bg-paper-soft/60 px-3 py-2 text-[11px] dark:border-neutral-700 dark:bg-neutral-950/40">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Debug
      </div>

      {turn.stages.length > 0 && (
        <div className="mb-2">
          <div className="text-neutral-500 dark:text-neutral-400">Stages</div>
          <ul className="font-mono">
            {turn.stages.map((s, i) => (
              <li key={i} className="flex justify-between">
                <span>
                  {s.name}
                  {s.count != null ? ` · ${s.count}` : ""}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {s.t.toFixed(2)}s
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {turn.rawCot && (
        <details className="mb-2">
          <summary className="cursor-pointer text-neutral-500 dark:text-neutral-400">
            Raw chain-of-thought ({turn.rawCot.length} chars)
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-700 dark:text-neutral-300">
            {turn.rawCot}
          </pre>
        </details>
      )}

      {r && r.dropped.length === 0 && (
        <div className="text-neutral-500 dark:text-neutral-400">
          No claims were dropped this turn.
        </div>
      )}
    </section>
  );
}

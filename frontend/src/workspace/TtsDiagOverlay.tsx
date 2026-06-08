/**
 * On-screen TTS diagnostic overlay. Shows the last 8 lifecycle events
 * dispatched by `lib/tts.ts` so we can see exactly where audio
 * playback is failing without needing Safari Web Inspector. Tap to
 * collapse / expand.
 *
 * Temporary debugging aid — when the auto-speak path is stable, this
 * can be removed.
 */
import { useEffect, useState } from "react";

interface DiagEntry {
  stage: string;
  detail?: unknown;
  at: number;
}

export function TtsDiagOverlay() {
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    function onDiag(e: Event) {
      const detail = (e as CustomEvent).detail as DiagEntry;
      setEntries((prev) => [...prev.slice(-7), detail]);
    }
    window.addEventListener("tts:diag", onDiag);
    return () => window.removeEventListener("tts:diag", onDiag);
  }, []);

  if (entries.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed left-2 top-16 z-[200] rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-amber-300"
        style={{ fontFamily: "monospace" }}
      >
        tts · {entries[entries.length - 1]?.stage}
      </button>
    );
  }

  return (
    <div
      role="log"
      aria-label="TTS diagnostic"
      className="fixed left-2 top-16 z-[200] max-w-[280px] rounded-lg bg-black/80 p-2 text-[10px] text-amber-200 backdrop-blur-md"
      style={{ fontFamily: "monospace" }}
    >
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="float-right text-amber-400"
        aria-label="Collapse diagnostic"
      >
        ×
      </button>
      <div className="mb-1 font-bold">tts diag</div>
      <ol className="space-y-0.5">
        {entries.map((e, i) => (
          <li key={i} className="truncate">
            <span className="text-amber-400">{e.stage}</span>
            {e.detail !== undefined && (
              <>
                {" "}
                <span className="text-amber-200/80">
                  {typeof e.detail === "string"
                    ? e.detail
                    : JSON.stringify(e.detail)}
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

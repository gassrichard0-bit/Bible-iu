/**
 * App-wide settings. Persisted to localStorage so the choice survives
 * a page refresh.
 *
 * `debugMode` is the only non-cosmetic flag here — when on, the
 * Reasoning panel exposes raw chain-of-thought, stage timings, the
 * retrieved-sources list, and the dropped-claims list. The citation
 * engine STILL runs in debug mode; debug just shows more of the
 * pipeline's intermediate state to the user.
 */
export interface Settings {
  debugMode: boolean;
  /** When true, every reasoning request sends `bypass_citation_engine`
   *  to the backend. The orchestrator skips verification AND the rule
   *  layer, returning raw LLM output. Off by default — turning it on
   *  overrides the safety invariant in rule-guide.MD §14 /
   *  citation-engine.MD §10. The user is warned in Settings. */
  bypassCitationEngine: boolean;
  /** IANA timezone name (e.g. "America/Los_Angeles") used to render
   *  bookmark timestamps and any other absolute times. Empty = use
   *  the browser's auto-detected timezone. */
  timezone: string;
  /** When true, group notes become small posts: hearts + flat
   *  comments. Personal notes and agent-authored notes never expose
   *  this UI, per rule-guide.MD §12. Off by default; the app stays
   *  in humble-study mode unless opted in. */
  socialNotesEnabled: boolean;
}

const KEY = "bible-iu:settings";

export const defaultSettings: Settings = {
  debugMode: false,
  bypassCitationEngine: false,
  timezone: "",
  socialNotesEnabled: false,
};

export function readSettings(): Settings {
  if (typeof localStorage === "undefined") return { ...defaultSettings };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

export function writeSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

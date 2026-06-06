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
  /** When true, the agent works even when the room admin has toggled
   *  agent_enabled off. Only takes effect for the user who enables it
   *  — other members still see the gate. Dev-mode escape hatch for
   *  shell-level access. */
  bypassAgentGate: boolean;
}

const KEY = "bible-iu:settings";

export const defaultSettings: Settings = {
  debugMode: false,
  bypassCitationEngine: false,
  timezone: "",
  socialNotesEnabled: false,
  bypassAgentGate: false,
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

/** Project the settings shape into the server's `preferences` JSON,
 *  scoped under `ui` so we don't collide with other prefs
 *  (default_translation, default_note_scope, etc.). */
export function settingsToPreferences(s: Settings): { ui: Partial<Settings> } {
  return {
    ui: {
      debugMode: s.debugMode,
      bypassCitationEngine: s.bypassCitationEngine,
      timezone: s.timezone,
      socialNotesEnabled: s.socialNotesEnabled,
      bypassAgentGate: s.bypassAgentGate,
    },
  };
}

/** Pull our keys back out of the server's `preferences` JSON,
 *  falling back to whatever the caller already had. Empty / missing
 *  ui block keeps the local defaults intact, so a fresh server
 *  account doesn't blow away the user's localStorage choices. */
export function settingsFromPreferences(
  base: Settings,
  prefs: Record<string, unknown> | null | undefined,
): Settings {
  const ui = (prefs?.ui ?? {}) as Partial<Settings>;
  return {
    debugMode:
      typeof ui.debugMode === "boolean" ? ui.debugMode : base.debugMode,
    bypassCitationEngine:
      typeof ui.bypassCitationEngine === "boolean"
        ? ui.bypassCitationEngine
        : base.bypassCitationEngine,
    timezone:
      typeof ui.timezone === "string" ? ui.timezone : base.timezone,
    socialNotesEnabled:
      typeof ui.socialNotesEnabled === "boolean"
        ? ui.socialNotesEnabled
        : base.socialNotesEnabled,
    bypassAgentGate:
      typeof ui.bypassAgentGate === "boolean"
        ? ui.bypassAgentGate
        : base.bypassAgentGate,
  };
}

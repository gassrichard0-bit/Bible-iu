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
  /** When true (default), the "Today's reading" banner shows at the
   *  top of the Bible scroller whenever the user is enrolled in a
   *  reading plan. Toggle off to read in peace without the prompt. */
  todaysReadingBanner: boolean;
  /** Default note scope shown on the Notes page. The page no longer
   *  carries a Personal/Group radio — the user picks once here and
   *  the page just shows that scope. `personal` keeps notes invisible
   *  to the agent (rule-guide.MD §12.1). */
  defaultNoteScope: "personal" | "group";
  /** Room ids the user has pinned to the top of the rooms rail.
   *  Order is significant — the rail renders pinned rooms in this
   *  exact order (so the user can later drag-reorder if we add it). */
  pinnedRoomIds: string[];
  /** Room ids the user has hidden from the rail. They still belong
   *  to the room (membership / messages untouched) — the row just
   *  doesn't render unless they flip "Show hidden" in the rail. */
  hiddenRoomIds: string[];
  /** Default translation name shown in the Bible reader. Matches a
   *  Translation.name in the DB (e.g. "King James Version" or
   *  "World English Bible"). Empty string falls back to KJV at the
   *  reader level. */
  defaultTranslation: string;
  /** Local hour (0-23) the daily reading-plan reminder should fire.
   *  The scheduler reads this from `preferences.ui.readingReminderHour`
   *  and falls back to 8 AM when missing. */
  readingReminderHour: number;
  /** Room ids whose push notifications the user has silenced. The
   *  fan-out helper on the server reads this from the user's prefs
   *  and skips matching rooms, so a muted room never wakes the phone. */
  mutedRoomIds: string[];
  /** Do-not-disturb window. When `quietHoursEnabled` is on, the
   *  push fan-out checks the recipient's local time against
   *  `[quietStartHour, quietEndHour)` and skips. End wrap-around
   *  is handled — `start=22 end=7` = 10pm through 7am. */
  quietHoursEnabled: boolean;
  quietStartHour: number; // 0-23
  quietEndHour: number;   // 0-23
  /** When true, the agent's answers in the ReasoningStream are read
   *  aloud automatically using the same Deepgram Aura voice as the
   *  Bible reader. Triggers once per turn — on the answer's first
   *  render with non-empty text. */
  autoSpeakAgentAnswers: boolean;
  /** Deepgram Aura voice id used for both the Bible reader's voice
   *  panel and the manual "Read aloud" button on agent answers.
   *  Available IDs match Aura's catalog (aura-athena-en, aura-luna-en,
   *  aura-orion-en, etc.). The frontend Settings picker exposes a
   *  curated subset. */
  ttsVoice: string;
}

const KEY = "bible-iu:settings";

export const defaultSettings: Settings = {
  debugMode: false,
  bypassCitationEngine: false,
  timezone: "",
  socialNotesEnabled: true,
  bypassAgentGate: false,
  todaysReadingBanner: true,
  defaultNoteScope: "personal",
  pinnedRoomIds: [],
  hiddenRoomIds: [],
  defaultTranslation: "King James Version",
  readingReminderHour: 8,
  mutedRoomIds: [],
  quietHoursEnabled: false,
  quietStartHour: 22,
  quietEndHour: 7,
  autoSpeakAgentAnswers: false,
  ttsVoice: "aura-athena-en",
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

/** Dispatched on `window` after every successful `writeSettings()`.
 *  `storage` only fires across tabs; this fills the same-tab gap so
 *  subscribers (e.g. the Today's-reading banner) react immediately. */
export const SETTINGS_CHANGED = "bible-iu:settings-changed";

export function writeSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
  try {
    window.dispatchEvent(new Event(SETTINGS_CHANGED));
  } catch {
    // Older browsers / non-DOM contexts: subscribers will catch the
    // next storage event or the next mount.
  }
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
      todaysReadingBanner: s.todaysReadingBanner,
      defaultNoteScope: s.defaultNoteScope,
      pinnedRoomIds: s.pinnedRoomIds,
      hiddenRoomIds: s.hiddenRoomIds,
      defaultTranslation: s.defaultTranslation,
      readingReminderHour: s.readingReminderHour,
      mutedRoomIds: s.mutedRoomIds,
      quietHoursEnabled: s.quietHoursEnabled,
      quietStartHour: s.quietStartHour,
      quietEndHour: s.quietEndHour,
      autoSpeakAgentAnswers: s.autoSpeakAgentAnswers,
      ttsVoice: s.ttsVoice,
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
    todaysReadingBanner:
      typeof ui.todaysReadingBanner === "boolean"
        ? ui.todaysReadingBanner
        : base.todaysReadingBanner,
    defaultNoteScope:
      ui.defaultNoteScope === "personal" || ui.defaultNoteScope === "group"
        ? ui.defaultNoteScope
        : base.defaultNoteScope,
    pinnedRoomIds: Array.isArray(ui.pinnedRoomIds)
      ? ui.pinnedRoomIds.filter((x): x is string => typeof x === "string")
      : base.pinnedRoomIds,
    hiddenRoomIds: Array.isArray(ui.hiddenRoomIds)
      ? ui.hiddenRoomIds.filter((x): x is string => typeof x === "string")
      : base.hiddenRoomIds,
    defaultTranslation:
      typeof ui.defaultTranslation === "string" && ui.defaultTranslation
        ? ui.defaultTranslation
        : base.defaultTranslation,
    readingReminderHour:
      typeof ui.readingReminderHour === "number" &&
      Number.isFinite(ui.readingReminderHour) &&
      ui.readingReminderHour >= 0 &&
      ui.readingReminderHour <= 23
        ? Math.floor(ui.readingReminderHour)
        : base.readingReminderHour,
    mutedRoomIds: Array.isArray(ui.mutedRoomIds)
      ? ui.mutedRoomIds.filter((x): x is string => typeof x === "string")
      : base.mutedRoomIds,
    quietHoursEnabled:
      typeof ui.quietHoursEnabled === "boolean"
        ? ui.quietHoursEnabled
        : base.quietHoursEnabled,
    quietStartHour:
      typeof ui.quietStartHour === "number" &&
      ui.quietStartHour >= 0 &&
      ui.quietStartHour <= 23
        ? Math.floor(ui.quietStartHour)
        : base.quietStartHour,
    quietEndHour:
      typeof ui.quietEndHour === "number" &&
      ui.quietEndHour >= 0 &&
      ui.quietEndHour <= 23
        ? Math.floor(ui.quietEndHour)
        : base.quietEndHour,
    autoSpeakAgentAnswers:
      typeof ui.autoSpeakAgentAnswers === "boolean"
        ? ui.autoSpeakAgentAnswers
        : base.autoSpeakAgentAnswers,
    ttsVoice:
      typeof ui.ttsVoice === "string" && ui.ttsVoice
        ? ui.ttsVoice
        : base.ttsVoice,
  };
}

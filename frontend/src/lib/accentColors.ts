/**
 * Per-group accent palette.
 *
 * Admins pick a key here (rose / sky / etc.) and the chosen color
 * tints the top header band and the floating AI composer ring. Each
 * entry carries:
 *   • a soft band color for the header tint (light + dark mode)
 *   • a ring tone for the AI pill border (light + dark mode)
 *   • a swatch color for the picker
 *
 * When no override is set (`null` from the server), the frontend
 * falls back to `colorFromId()` — a deterministic hash of the room
 * id so brand-new groups still look distinct out of the box.
 */
export type AccentKey =
  | "amber"
  | "rose"
  | "violet"
  | "sky"
  | "emerald"
  | "lime"
  | "fuchsia"
  | "slate";

export const ACCENT_KEYS: AccentKey[] = [
  "amber",
  "rose",
  "violet",
  "sky",
  "emerald",
  "lime",
  "fuchsia",
  "slate",
];

interface AccentTones {
  /** Top app-bar band tint (soft, light + dark). */
  band: string;
  bandDark: string;
  /** Ring color for the AI composer pill — solid enough to read. */
  ring: string;
  ringDark: string;
  /** Solid swatch for the picker. */
  swatch: string;
  /** Solid bubble fill for "mine" chat messages — saturated enough
   *  that white body text stays readable. */
  bubble: string;
  /** Foreground color paired with `bubble`. Most accents take white;
   *  amber + lime swap to dark text for AAA contrast. */
  bubbleFg: string;
}

export const ACCENT_PALETTE: Record<AccentKey, AccentTones> = {
  amber: {
    band: "rgba(251, 191, 36, 0.18)",
    bandDark: "rgba(146, 64, 14, 0.35)",
    ring: "rgba(217, 119, 6, 0.65)",
    ringDark: "rgba(245, 158, 11, 0.6)",
    swatch: "#f59e0b",
    bubble: "#fbbf24",
    bubbleFg: "#451a03",
  },
  rose: {
    band: "rgba(244, 63, 94, 0.18)",
    bandDark: "rgba(159, 18, 57, 0.35)",
    ring: "rgba(225, 29, 72, 0.65)",
    ringDark: "rgba(244, 63, 94, 0.6)",
    swatch: "#e11d48",
    bubble: "#e11d48",
    bubbleFg: "#ffffff",
  },
  violet: {
    band: "rgba(139, 92, 246, 0.18)",
    bandDark: "rgba(91, 33, 182, 0.35)",
    ring: "rgba(124, 58, 237, 0.65)",
    ringDark: "rgba(167, 139, 250, 0.6)",
    swatch: "#7c3aed",
    bubble: "#7c3aed",
    bubbleFg: "#ffffff",
  },
  sky: {
    band: "rgba(56, 189, 248, 0.18)",
    bandDark: "rgba(7, 89, 133, 0.35)",
    ring: "rgba(2, 132, 199, 0.65)",
    ringDark: "rgba(56, 189, 248, 0.6)",
    swatch: "#0284c7",
    bubble: "#0284c7",
    bubbleFg: "#ffffff",
  },
  emerald: {
    band: "rgba(52, 211, 153, 0.18)",
    bandDark: "rgba(6, 95, 70, 0.35)",
    ring: "rgba(5, 150, 105, 0.65)",
    ringDark: "rgba(52, 211, 153, 0.6)",
    swatch: "#059669",
    bubble: "#059669",
    bubbleFg: "#ffffff",
  },
  lime: {
    band: "rgba(163, 230, 53, 0.22)",
    bandDark: "rgba(63, 98, 18, 0.40)",
    ring: "rgba(101, 163, 13, 0.7)",
    ringDark: "rgba(163, 230, 53, 0.6)",
    swatch: "#65a30d",
    bubble: "#a3e635",
    bubbleFg: "#1a2e05",
  },
  fuchsia: {
    band: "rgba(217, 70, 239, 0.18)",
    bandDark: "rgba(112, 26, 117, 0.35)",
    ring: "rgba(192, 38, 211, 0.65)",
    ringDark: "rgba(217, 70, 239, 0.6)",
    swatch: "#c026d3",
    bubble: "#c026d3",
    bubbleFg: "#ffffff",
  },
  slate: {
    band: "rgba(100, 116, 139, 0.18)",
    bandDark: "rgba(51, 65, 85, 0.45)",
    ring: "rgba(71, 85, 105, 0.7)",
    ringDark: "rgba(148, 163, 184, 0.55)",
    swatch: "#475569",
    bubble: "#475569",
    bubbleFg: "#ffffff",
  },
};

/** Deterministic fallback when no admin override is set. djb2-ish
 *  hash of the room id mod the palette length. */
export function colorFromId(id: string): AccentKey {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return ACCENT_KEYS[Math.abs(h) % ACCENT_KEYS.length];
}

/** Server values are nullable strings — coerce to a known key. */
export function resolveAccent(
  override: string | null | undefined,
  fallbackId: string,
): AccentKey {
  if (override && (ACCENT_KEYS as readonly string[]).includes(override)) {
    return override as AccentKey;
  }
  return colorFromId(fallbackId);
}

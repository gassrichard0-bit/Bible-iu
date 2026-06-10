/**
 * Visual style maps for verse annotations. The backend stores a
 * palette key (`yellow|green|blue|pink|orange`); these tables
 * translate to Tailwind classes the renderer applies to the verse
 * text span.
 *
 * Six kinds (paper-Bible toolset, minus strikethrough which the user
 * dropped): highlight, underline, double-underline, wavy-underline,
 * box (border around the verse), bold (color-weighted emphasis).
 */
import type { AnnotationColor, AnnotationOut } from "../../lib/api";

export const ANNOTATION_COLORS: AnnotationColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
];

/** Highlight backgrounds — soft tints so the text underneath stays
 *  readable. */
export const HIGHLIGHT_BG: Record<AnnotationColor, string> = {
  yellow: "bg-amber-200/70 dark:bg-amber-300/30",
  green: "bg-emerald-200/70 dark:bg-emerald-300/30",
  blue: "bg-sky-200/70 dark:bg-sky-300/30",
  pink: "bg-pink-200/70 dark:bg-pink-300/30",
  orange: "bg-orange-200/70 dark:bg-orange-300/30",
};

/** Solid dot fills for toolbar swatches. */
export const SWATCH_FILL: Record<AnnotationColor, string> = {
  yellow: "bg-amber-400",
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  pink: "bg-pink-500",
  orange: "bg-orange-500",
};

/** Underline + strike-style decoration color. */
export const DECORATION_COLOR: Record<AnnotationColor, string> = {
  yellow: "decoration-amber-500",
  green: "decoration-emerald-500",
  blue: "decoration-sky-500",
  pink: "decoration-pink-500",
  orange: "decoration-orange-500",
};

/** Border color for "box around verse". Slightly stronger than the
 *  underline shade so the box reads as deliberate. */
export const BOX_BORDER: Record<AnnotationColor, string> = {
  yellow: "border-amber-500/80",
  green: "border-emerald-500/80",
  blue: "border-sky-500/80",
  pink: "border-pink-500/80",
  orange: "border-orange-500/80",
};

/** Text color for the bold-emphasis tool. */
export const BOLD_TEXT: Record<AnnotationColor, string> = {
  yellow: "text-amber-700 dark:text-amber-300",
  green: "text-emerald-700 dark:text-emerald-300",
  blue: "text-sky-700 dark:text-sky-300",
  pink: "text-pink-700 dark:text-pink-300",
  orange: "text-orange-700 dark:text-orange-300",
};

/** Per-verse annotation lookup. Each kind is a LIST now — sub-verse
 *  ranges of the same kind stack (e.g. yellow highlight on chars
 *  0-17 + green highlight on chars 40-53). Whole-verse rows (both
 *  offsets null) live in the same list — the renderer just treats
 *  null offsets as "spans the whole verse." */
export interface VerseAnnotations {
  highlight: AnnotationOut[];
  underline: AnnotationOut[];
  double_underline: AnnotationOut[];
  wavy: AnnotationOut[];
  box: AnnotationOut[];
  bold: AnnotationOut[];
}

const emptyVerseAnnotations = (): VerseAnnotations => ({
  highlight: [],
  underline: [],
  double_underline: [],
  wavy: [],
  box: [],
  bold: [],
});

/** Group a flat annotations list by kind for one verse. */
export function annotationsForVerse(
  all: AnnotationOut[] | undefined,
  verseId: string,
): VerseAnnotations {
  const out = emptyVerseAnnotations();
  if (!all) return out;
  for (const a of all) {
    if (a.verse_id !== verseId) continue;
    switch (a.kind) {
      case "highlight":
        out.highlight.push(a);
        break;
      case "underline":
        out.underline.push(a);
        break;
      case "double_underline":
        out.double_underline.push(a);
        break;
      case "wavy":
        out.wavy.push(a);
        break;
      case "box":
        out.box.push(a);
        break;
      case "bold":
        out.bold.push(a);
        break;
    }
  }
  return out;
}

/** One contiguous segment of verse text that shares the same set of
 *  overlapping annotations. The render layer emits one <span> per run
 *  with classes derived from `active`. */
export interface AnnotatedRun {
  text: string;
  /** All annotations currently active on this run — whole-verse rows
   *  appear in every run; sub-verse rows appear only in runs whose
   *  range they cover. */
  active: AnnotationOut[];
}

/** Compose the className string for one run from the active annotations.
 *  Mirrors the legacy whole-verse class composition (decoration
 *  precedence: wavy > double > single) so a run carrying a single
 *  whole-verse highlight looks identical to the v1 render. */
export function runClasses(active: AnnotationOut[]): string {
  if (active.length === 0) return "";
  const pick = (kind: string): AnnotationOut | undefined =>
    active.find((a) => a.kind === kind);
  const wavy = pick("wavy");
  const dbl = pick("double_underline");
  const und = pick("underline");
  const underline = wavy
    ? `underline decoration-wavy decoration-2 underline-offset-2 ${DECORATION_COLOR[wavy.color]}`
    : dbl
      ? `underline decoration-double decoration-2 underline-offset-2 ${DECORATION_COLOR[dbl.color]}`
      : und
        ? `underline decoration-2 underline-offset-2 ${DECORATION_COLOR[und.color]}`
        : "";
  const highlight = pick("highlight");
  const bold = pick("bold");
  return [
    highlight ? `rounded-sm px-0.5 ${HIGHLIGHT_BG[highlight.color]}` : "",
    underline,
    bold ? `font-semibold ${BOLD_TEXT[bold.color]}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Split verse text into runs, each tagged with the annotations covering
 * it. Used by BibleView to paint character-range marks without leaking
 * styling into neighboring characters.
 *
 * The algorithm:
 *   1. Collect every "edge" (annotation start + end + text bounds).
 *   2. Walk pairwise — each adjacent pair defines a [start, end) segment.
 *   3. For each segment, the active annotations are: every whole-verse
 *      row + every sub-verse row that fully contains [start, end).
 *
 * Whole-verse rows are pushed into every segment, which makes the
 * downstream classNames computation oblivious to whether a row is
 * whole- or sub-verse.
 */
export function splitVerseIntoRuns(
  text: string,
  annotations: AnnotationOut[],
): AnnotatedRun[] {
  if (!text) return [];
  if (annotations.length === 0) return [{ text, active: [] }];

  // Cap offsets at text length so a stale/malformed row can't push the
  // breakpoint outside the actual string.
  const wholeVerse: AnnotationOut[] = [];
  const subVerse: AnnotationOut[] = [];
  const edges = new Set<number>([0, text.length]);
  for (const a of annotations) {
    if (a.start_offset == null || a.end_offset == null) {
      wholeVerse.push(a);
      continue;
    }
    const s = Math.max(0, Math.min(text.length, a.start_offset));
    const e = Math.max(0, Math.min(text.length, a.end_offset));
    if (e <= s) continue;
    subVerse.push({ ...a, start_offset: s, end_offset: e });
    edges.add(s);
    edges.add(e);
  }

  const sorted = [...edges].sort((a, b) => a - b);
  const runs: AnnotatedRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start >= text.length) break;
    if (end <= start) continue;
    const slice = text.slice(start, end);
    const active = [
      ...wholeVerse,
      ...subVerse.filter(
        (a) => a.start_offset! <= start && a.end_offset! >= end,
      ),
    ];
    runs.push({ text: slice, active });
  }
  return runs;
}

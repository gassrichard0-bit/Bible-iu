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

export interface VerseAnnotations {
  highlight?: AnnotationOut;
  underline?: AnnotationOut;
  double_underline?: AnnotationOut;
  wavy?: AnnotationOut;
  box?: AnnotationOut;
  bold?: AnnotationOut;
}

/** Group a flat annotations list by kind for one verse. */
export function annotationsForVerse(
  all: AnnotationOut[] | undefined,
  verseId: string,
): VerseAnnotations {
  const out: VerseAnnotations = {};
  if (!all) return out;
  for (const a of all) {
    if (a.verse_id !== verseId) continue;
    switch (a.kind) {
      case "highlight":
        out.highlight = a;
        break;
      case "underline":
        out.underline = a;
        break;
      case "double_underline":
        out.double_underline = a;
        break;
      case "wavy":
        out.wavy = a;
        break;
      case "box":
        out.box = a;
        break;
      case "bold":
        out.bold = a;
        break;
    }
  }
  return out;
}

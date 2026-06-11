/**
 * Annotation tool strip — occupies the bottom-panel slot when the
 * user long-presses a verse. Same outer geometry as the tab bar
 * (h-[64px], rounded-[28px], same border/surface/shadow recipe) so
 * the strip reads as the same panel re-rendering its contents.
 *
 * Layout: [✕] [verse-label] · [kind picker ▾] · 5 color swatches · [⌫]
 *
 * Per user request 2026-06-11: switched from a horizontally scrolling
 * 6-kind × 5-color strip to a kind-picker + per-kind swatch row. Tap
 * the kind pill to open a small menu listing every kind; tap a kind to
 * make it active. Only the active kind's 5 colors are visible at any
 * time — way less scrolling, no second-tap to find Wavy or Box.
 *
 * Triggered + dismissed by the shell; this component is purely the
 * presentation of the active target. Pass `target = null` to hide.
 */
import { useEffect, useRef, useState } from "react";
import type {
  AnnotationColor,
  AnnotationKind,
  AnnotationOut,
} from "../../lib/api";
import {
  ANNOTATION_COLORS,
  BOLD_TEXT,
  BOX_BORDER,
  DECORATION_COLOR,
  SWATCH_FILL,
} from "./annotations";

export interface AnnotationTarget {
  verseId: string;
  /** Optional short label shown in the banner header (e.g. "Gen 1:1"). */
  label?: string;
  /** Sub-verse character range — both set together when the user
   *  drag-selected a portion of the verse text. Both null (the
   *  default) means apply to the whole verse, matching v1. */
  selStart?: number | null;
  selEnd?: number | null;
  /** Multi-verse selection. When set, the user dragged the OS
   *  selection across more than one verse and the toolbar should
   *  apply the chosen tool to every span in the list (one new
   *  annotation row per verse). For a single-verse selection this
   *  is undefined and the legacy verseId/selStart/selEnd path is
   *  used unchanged. */
  spans?: Array<{ verseId: string; selStart: number; selEnd: number }>;
}

interface Props {
  target: AnnotationTarget | null;
  annotations?: AnnotationOut[];
  onApply: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
    range?: { start: number; end: number } | null,
  ) => void;
  onClearKind: (verseId: string, kind: AnnotationKind) => void;
  /** Row-precise delete — used when the user taps a sub-verse swatch
   *  whose (kind, color, range) already exists on this verse, which
   *  reads as "toggle this exact mark off." Whole-verse rows still
   *  go through onClearKind. */
  onClearById?: (annotationId: string) => void;
  onClearAll: (verseId: string) => void;
  onClose: () => void;
  /** Triggers the share sheet for the active verse. Hidden when not
   *  supplied so the strip can stay annotation-only in contexts that
   *  haven't wired sharing yet (the SocialShell desktop, e.g.). */
  onShare?: (verseId: string) => void;
}

interface ToolSection {
  kind: AnnotationKind;
  label: string;
}

const SECTIONS: ToolSection[] = [
  { kind: "highlight", label: "Highlight" },
  { kind: "underline", label: "Underline" },
  { kind: "double_underline", label: "Double" },
  { kind: "wavy", label: "Wavy" },
  { kind: "box", label: "Box" },
  { kind: "bold", label: "Bold" },
];

export function AnnotationToolbar({
  target,
  annotations,
  onApply,
  onClearKind,
  onClearById,
  onClearAll,
  onClose,
  onShare,
}: Props) {
  // Hooks must run unconditionally — early-return on null target moved
  // below the hooks so React doesn't complain about hook count changes
  // when the toolbar closes.
  const [activeKind, setActiveKind] = useState<AnnotationKind>("highlight");
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the kind menu on outside tap. Pointerdown rather than click
  // so the menu dismisses before any background tap re-opens the
  // selector or fires another rule.
  useEffect(() => {
    if (!kindMenuOpen) return;
    function onDown(e: PointerEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      setKindMenuOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [kindMenuOpen]);

  if (!target) return null;

  const current = (annotations || []).filter(
    (a) => a.verse_id === target.verseId,
  );
  const activeColorFor = (kind: AnnotationKind) =>
    current.find((a) => a.kind === kind)?.color;
  const activeSection =
    SECTIONS.find((s) => s.kind === activeKind) ?? SECTIONS[0];

  return (
    <div
      role="toolbar"
      aria-label={`Annotation tools for ${target.label ?? target.verseId}`}
      aria-orientation="horizontal"
      // Same glass recipe + outer dimensions as the bottom tab bar in
      // MobileShell — the strip lives in the same slot, so visually
      // it should read as the same panel switching modes.
      // The outer panel ALSO needs `min-w-0` — its `flex-1` only
      // expands toward the parent's bounds when the item is allowed
      // to shrink below its content size, otherwise iOS Safari lets
      // the strip grow past the viewport pl-/pr- gutters.
      className="pointer-events-auto flex h-[64px] min-w-0 max-w-full flex-1 items-center gap-1 rounded-[28px] border border-white/40 bg-paper/55 pl-1.5 pr-1 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
    >
      <button
        onClick={onClose}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
        aria-label="Close annotation tools"
        title="Close"
      >
        ✕
      </button>
      <span className="hidden shrink-0 truncate pr-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 sm:inline dark:text-neutral-400">
        {target.label ?? target.verseId}
      </span>
      <div
        ref={menuRef}
        className="relative flex h-full min-w-0 flex-1 items-center gap-2 overflow-visible pr-1"
      >
        {/* Kind picker — the "hamburger" entry point. Tap it to open
            a small menu listing every kind; tap a kind to make it
            active. The swatch row to the right then shows only that
            kind's 5 colors. */}
        <button
          type="button"
          onClick={() => setKindMenuOpen((o) => !o)}
          aria-expanded={kindMenuOpen}
          aria-haspopup="menu"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-neutral-300 bg-paper px-2.5 text-[12px] font-semibold text-neutral-800 shadow-[0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.55)] transition active:scale-[0.97] dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:shadow-[0_1px_2px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.06)]"
          title="Pick annotation tool"
        >
          <HamburgerIcon />
          <span>{activeSection.label}</span>
          <span aria-hidden className="text-[9px] opacity-60">
            {kindMenuOpen ? "▴" : "▾"}
          </span>
        </button>

        {/* Active kind's 5 color swatches — the row that does the work. */}
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {ANNOTATION_COLORS.map((c) => (
            <Swatch
              key={`${activeSection.kind}-${c}`}
              color={c}
              kind={activeSection.kind}
              active={activeColorFor(activeSection.kind) === c}
              onTap={() => {
                const kind = activeSection.kind;
                // Multi-verse selection — apply (or toggle-off) the
                // chosen tool on every span the user dragged across.
                if (target.spans && target.spans.length > 0) {
                  const allMatched =
                    annotations &&
                    target.spans.every((sp) =>
                      annotations.some(
                        (a) =>
                          a.verse_id === sp.verseId &&
                          a.kind === kind &&
                          a.color === c &&
                          a.start_offset === sp.selStart &&
                          a.end_offset === sp.selEnd,
                      ),
                    );
                  if (allMatched && onClearById) {
                    for (const sp of target.spans) {
                      const matched = annotations!.find(
                        (a) =>
                          a.verse_id === sp.verseId &&
                          a.kind === kind &&
                          a.color === c &&
                          a.start_offset === sp.selStart &&
                          a.end_offset === sp.selEnd,
                      );
                      if (matched) onClearById(matched.id);
                    }
                  } else {
                    for (const sp of target.spans) {
                      onApply(sp.verseId, kind, c, {
                        start: sp.selStart,
                        end: sp.selEnd,
                      });
                    }
                  }
                  return;
                }
                const range =
                  target.selStart != null && target.selEnd != null
                    ? { start: target.selStart, end: target.selEnd }
                    : null;
                if (range) {
                  const matched = annotations?.find(
                    (a) =>
                      a.verse_id === target.verseId &&
                      a.kind === kind &&
                      a.color === c &&
                      a.start_offset === range.start &&
                      a.end_offset === range.end,
                  );
                  if (matched && onClearById) {
                    onClearById(matched.id);
                  } else {
                    onApply(target.verseId, kind, c, range);
                  }
                } else if (activeColorFor(kind) === c) {
                  onClearKind(target.verseId, kind);
                } else {
                  onApply(target.verseId, kind, c, null);
                }
              }}
            />
          ))}
        </div>

        {/* Kind menu — pops up from the picker pill. Each row has a
            mini preview of what that kind looks like. Tap to switch. */}
        {kindMenuOpen && (
          <div
            role="menu"
            aria-label="Annotation kind"
            className="absolute bottom-[calc(100%+8px)] left-0 z-50 grid w-[180px] gap-1 rounded-2xl border border-neutral-200 bg-paper p-2 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.kind}
                type="button"
                role="menuitemradio"
                aria-checked={s.kind === activeKind}
                onClick={() => {
                  setActiveKind(s.kind);
                  setKindMenuOpen(false);
                }}
                className={`flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] transition ${
                  s.kind === activeKind
                    ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                    : "text-neutral-700 hover:bg-paper-soft dark:text-neutral-200 dark:hover:bg-neutral-800"
                }`}
              >
                <KindPreviewSwatch kind={s.kind} />
                <span className="flex-1">{s.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={() => {
          onClearAll(target.verseId);
          onClose();
        }}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-900/5 text-neutral-700 hover:bg-neutral-900/10 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
        aria-label="Erase all marks on this verse"
        title="Erase all"
      >
        <EraserIcon />
      </button>
      {onShare && (
        <button
          onClick={() => onShare(target.verseId)}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          aria-label="Share this verse"
          title="Share"
        >
          <ShareIcon />
        </button>
      )}
    </div>
  );
}

/** Tiny preview of what a kind looks like, shown next to its label in
 *  the kind-picker menu. Just uses the yellow color for all kinds so
 *  the preview reads as "the shape of this mark," not "the color." */
function KindPreviewSwatch({ kind }: { kind: AnnotationKind }) {
  const c: AnnotationColor = "yellow";
  if (kind === "highlight") {
    return <span className={`h-5 w-5 rounded-full ${SWATCH_FILL[c]}`} />;
  }
  if (kind === "underline") {
    return (
      <span className="grid h-5 w-5 place-items-end">
        <span
          className={`underline decoration-2 underline-offset-2 ${DECORATION_COLOR[c]}`}
        >
          U
        </span>
      </span>
    );
  }
  if (kind === "double_underline") {
    return (
      <span className="grid h-5 w-5 place-items-end">
        <span
          className={`underline decoration-double decoration-2 underline-offset-2 ${DECORATION_COLOR[c]}`}
        >
          U
        </span>
      </span>
    );
  }
  if (kind === "wavy") {
    return (
      <span className="grid h-5 w-5 place-items-end">
        <span
          className={`underline decoration-wavy decoration-2 underline-offset-2 ${DECORATION_COLOR[c]}`}
        >
          U
        </span>
      </span>
    );
  }
  if (kind === "box") {
    return (
      <span
        className={`h-5 w-5 rounded-md border-2 bg-white dark:bg-neutral-800 ${BOX_BORDER[c]}`}
      />
    );
  }
  // bold
  return (
    <span className="grid h-5 w-5 place-items-center">
      <span className={`font-bold ${BOLD_TEXT[c]}`}>B</span>
    </span>
  );
}

function HamburgerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function Swatch({
  color,
  kind,
  active,
  onTap,
}: {
  color: AnnotationColor;
  kind: AnnotationKind;
  active: boolean;
  onTap: () => void;
}) {
  const ring = active
    ? "ring-2 ring-offset-2 ring-neutral-900 dark:ring-neutral-100 ring-offset-paper/55 dark:ring-offset-neutral-900/45"
    : "";
  if (kind === "highlight") {
    return (
      <button
        onClick={onTap}
        aria-pressed={active}
        title={`Highlight ${color}`}
        className={`h-8 w-8 shrink-0 rounded-full ${SWATCH_FILL[color]} shadow-sm ${ring}`}
      />
    );
  }
  if (kind === "underline") {
    return (
      <SampleSwatch ring={ring} title={`Underline ${color}`} onTap={onTap}>
        <span
          className={`mb-0.5 underline decoration-2 underline-offset-2 ${DECORATION_COLOR[color]}`}
        >
          U
        </span>
      </SampleSwatch>
    );
  }
  if (kind === "double_underline") {
    return (
      <SampleSwatch ring={ring} title={`Double underline ${color}`} onTap={onTap}>
        <span
          className={`mb-0.5 underline decoration-double decoration-2 underline-offset-2 ${DECORATION_COLOR[color]}`}
        >
          U
        </span>
      </SampleSwatch>
    );
  }
  if (kind === "wavy") {
    return (
      <SampleSwatch ring={ring} title={`Wavy underline ${color}`} onTap={onTap}>
        <span
          className={`mb-0.5 underline decoration-wavy decoration-2 underline-offset-2 ${DECORATION_COLOR[color]}`}
        >
          U
        </span>
      </SampleSwatch>
    );
  }
  if (kind === "box") {
    return (
      <button
        onClick={onTap}
        aria-pressed={active}
        title={`Box ${color}`}
        className={`h-8 w-8 shrink-0 rounded-md border-2 bg-white shadow-sm dark:bg-neutral-800 ${BOX_BORDER[color]} ${ring}`}
      />
    );
  }
  // bold
  return (
    <SampleSwatch ring={ring} title={`Bold ${color}`} onTap={onTap}>
      <span className={`font-bold ${BOLD_TEXT[color]}`}>B</span>
    </SampleSwatch>
  );
}

function SampleSwatch({
  ring,
  title,
  onTap,
  children,
}: {
  ring: string;
  title: string;
  onTap: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onTap}
      title={title}
      className={`flex h-8 w-8 shrink-0 items-end justify-center rounded-xl bg-white text-[11px] font-bold text-neutral-700 shadow-sm dark:bg-neutral-800 dark:text-neutral-200 ${ring}`}
    >
      {children}
    </button>
  );
}

function ShareIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m7 21-4-4 11-11 7 7-8 8z" />
      <path d="m14 6 4 4" />
      <path d="M21 21H10" />
    </svg>
  );
}

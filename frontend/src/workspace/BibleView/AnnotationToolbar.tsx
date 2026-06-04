/**
 * Glass annotation toolbar — pops up when the user long-presses a
 * verse. iOS-style "select-and-hold": nothing visible until selection,
 * then a frosted column slides in on the right with a scrollable list
 * of tool sections.
 *
 * Layout (top → bottom inside the scrolling column):
 *   header (verse ref + ✕)
 *   ─ Highlight ─ [5 color swatches in a row]
 *   ─ Underline ─ [5 swatches]
 *   ─ Double underline ─
 *   ─ Wavy underline ─
 *   ─ Box ─
 *   ─ Bold ─
 *   [Erase all]
 * Six tool kinds — strikethrough was dropped at the user's request.
 *
 * Sits above the 64px AI pill (bottom-right) so the thumb can reach
 * without dodging.
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
}

interface Props {
  target: AnnotationTarget | null;
  /** All of the user's annotations — used to render the "active" ring
   *  on whichever swatch currently applies to this verse. */
  annotations?: AnnotationOut[];
  onApply: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => void;
  onClearKind: (verseId: string, kind: AnnotationKind) => void;
  onClearAll: (verseId: string) => void;
  onClose: () => void;
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

/** Persisted between sessions so the user finds the toolbar where they
 *  parked it last. Stored as offsets from the right and bottom edges
 *  so a viewport resize keeps the panel roughly in the same corner. */
const POS_STORAGE_KEY = "bible-iu:annotation-toolbar-pos";

interface ToolbarPos {
  right: number;
  bottom: number;
}

const DEFAULT_POS: ToolbarPos = { right: 10, bottom: 96 };
const PANEL_W = 200;
const SAFE_MARGIN = 6;

function readSavedPos(): ToolbarPos {
  if (typeof localStorage === "undefined") return DEFAULT_POS;
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<ToolbarPos>;
    if (
      typeof parsed.right !== "number" ||
      typeof parsed.bottom !== "number"
    ) {
      return DEFAULT_POS;
    }
    return parsed as ToolbarPos;
  } catch {
    return DEFAULT_POS;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function AnnotationToolbar({
  target,
  annotations,
  onApply,
  onClearKind,
  onClearAll,
  onClose,
}: Props) {
  const [pos, setPos] = useState<ToolbarPos>(() => readSavedPos());
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
  } | null>(null);

  // Esc to dismiss on desktop.
  useEffect(() => {
    if (!target) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [target, onClose]);

  // Pointer-based drag from the top handle. Stores offsets from right
  // and bottom so the toolbar stays anchored in its corner if the
  // viewport resizes between sessions.
  const onHandleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startRight: pos.right,
      startBottom: pos.bottom,
      moved: false,
    };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && dx * dx + dy * dy < 16) return; // ignore micro-jitter
    d.moved = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next: ToolbarPos = {
      right: clamp(d.startRight - dx, SAFE_MARGIN, vw - PANEL_W - SAFE_MARGIN),
      bottom: clamp(d.startBottom - dy, SAFE_MARGIN, vh - 80 - SAFE_MARGIN),
    };
    setPos(next);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
    } catch {
      // Ignore — private mode etc.
    }
  };

  if (!target) return null;

  const current = (annotations || []).filter(
    (a) => a.verse_id === target.verseId,
  );
  const activeColorFor = (kind: AnnotationKind) =>
    current.find((a) => a.kind === kind)?.color;

  return (
    <>
      {/* Tap-outside scrim — transparent, dismisses on tap. */}
      <button
        onClick={onClose}
        aria-label="Close annotation toolbar"
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        role="toolbar"
        aria-label={`Annotation tools for ${target.label ?? target.verseId}`}
        style={{ right: pos.right, bottom: pos.bottom }}
        className="fixed z-50 flex h-[min(42vh,320px)] w-[200px] flex-col rounded-[28px] border border-white/40 bg-paper/55 px-3 pt-2 pb-2 shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]"
      >
        {/* Drag handle — grab anywhere on this strip and move the
            panel. The grip pill in the middle makes the affordance
            visible without a chunky title bar. */}
        <div
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          className="-mt-1 mb-1 flex cursor-grab items-center justify-between px-1 pt-1 pb-0.5 touch-none active:cursor-grabbing"
          aria-label="Drag to move toolbar"
          role="separator"
        >
          <span className="max-w-[120px] truncate text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {target.label ?? target.verseId}
          </span>
          <span
            className="mx-2 inline-block h-1 w-8 shrink-0 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60"
            aria-hidden
          />
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            className="rounded text-[11px] leading-none text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            aria-label="Close annotation toolbar"
            title="Close"
          >
            ✕
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto overscroll-contain pr-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          // Soft fade at top + bottom signals "more to scroll" without
          // a visible scrollbar.
          style={{
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
            maskImage:
              "linear-gradient(180deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
          }}
        >
          {SECTIONS.map((s, i) => (
            <div
              key={s.kind}
              className={i > 0 ? "mt-1.5 border-t border-neutral-300/50 pt-1.5 dark:border-neutral-700/50" : ""}
            >
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                {s.label}
              </div>
              <div className="flex items-center justify-between gap-1">
                {ANNOTATION_COLORS.map((c) => (
                  <Swatch
                    key={`${s.kind}-${c}`}
                    color={c}
                    kind={s.kind}
                    active={activeColorFor(s.kind) === c}
                    onTap={() =>
                      activeColorFor(s.kind) === c
                        ? onClearKind(target.verseId, s.kind)
                        : onApply(target.verseId, s.kind, c)
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            onClearAll(target.verseId);
            onClose();
          }}
          className="mt-2 flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-neutral-300 bg-white text-[11px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          aria-label="Erase all marks on this verse"
          title="Erase all"
        >
          <EraserIcon />
          <span>Erase all</span>
        </button>
      </div>
    </>
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
    ? "ring-2 ring-offset-2 ring-neutral-900 dark:ring-neutral-100 ring-offset-white/60 dark:ring-offset-neutral-900/60"
    : "";
  if (kind === "highlight") {
    return (
      <button
        onClick={onTap}
        aria-pressed={active}
        title={`Highlight ${color}`}
        className={`h-7 w-7 rounded-full ${SWATCH_FILL[color]} shadow-sm ${ring}`}
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
        className={`h-7 w-7 rounded-md border-2 bg-white shadow-sm dark:bg-neutral-800 ${BOX_BORDER[color]} ${ring}`}
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
      className={`flex h-7 w-7 items-end justify-center rounded-md bg-white text-[11px] font-bold text-neutral-700 shadow-sm dark:bg-neutral-800 dark:text-neutral-200 ${ring}`}
    >
      {children}
    </button>
  );
}

function EraserIcon() {
  return (
    <svg
      width="14"
      height="14"
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

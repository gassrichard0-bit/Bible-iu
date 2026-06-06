/**
 * Annotation tool strip — occupies the bottom-panel slot when the
 * user long-presses a verse. Same outer geometry as the tab bar
 * (h-[64px], rounded-[28px], same border/surface/shadow recipe) so
 * the strip reads as the same panel re-rendering its contents.
 *
 * Layout: [✕] [verse-label] · horizontally scrollable tool row · [⌫ Erase]
 * Tool row = highlight × 5 colors · underline × 5 · double × 5 ·
 * wavy × 5 · box × 5 · bold × 5 (with small kind-label chips between
 * groups so the user can find a kind at a glance).
 *
 * Triggered + dismissed by the shell; this component is purely the
 * presentation of the active target. Pass `target = null` to hide.
 */
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
  annotations?: AnnotationOut[];
  onApply: (
    verseId: string,
    kind: AnnotationKind,
    color: AnnotationColor,
  ) => void;
  onClearKind: (verseId: string, kind: AnnotationKind) => void;
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
  { kind: "highlight", label: "High" },
  { kind: "underline", label: "Und" },
  { kind: "double_underline", label: "Dbl" },
  { kind: "wavy", label: "Wavy" },
  { kind: "box", label: "Box" },
  { kind: "bold", label: "Bold" },
];

export function AnnotationToolbar({
  target,
  annotations,
  onApply,
  onClearKind,
  onClearAll,
  onClose,
  onShare,
}: Props) {
  if (!target) return null;

  const current = (annotations || []).filter(
    (a) => a.verse_id === target.verseId,
  );
  const activeColorFor = (kind: AnnotationKind) =>
    current.find((a) => a.kind === kind)?.color;

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
        // `min-w-0` is the load-bearing class: without it, a flex
        // item won't shrink below its content's natural width, so
        // the tool row would push the panel wider than the tab bar
        // instead of scrolling inside it.
        className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-x-auto overscroll-contain pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          WebkitMaskImage:
            "linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
          maskImage:
            "linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
        }}
      >
        {SECTIONS.map((s, i) => (
          <ToolGroup
            key={s.kind}
            label={s.label}
            divider={i > 0}
            section={s}
            activeColor={activeColorFor(s.kind)}
            onTap={(color) => {
              activeColorFor(s.kind) === color
                ? onClearKind(target.verseId, s.kind)
                : onApply(target.verseId, s.kind, color);
            }}
          />
        ))}
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

function ToolGroup({
  label,
  divider,
  section,
  activeColor,
  onTap,
}: {
  label: string;
  divider: boolean;
  section: ToolSection;
  activeColor: AnnotationColor | undefined;
  onTap: (color: AnnotationColor) => void;
}) {
  return (
    <div className="flex h-full shrink-0 items-center gap-1.5">
      {divider && (
        <div className="mx-0.5 h-7 w-px shrink-0 bg-neutral-300/70 dark:bg-neutral-700/70" />
      )}
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      {ANNOTATION_COLORS.map((c) => (
        <Swatch
          key={`${section.kind}-${c}`}
          color={c}
          kind={section.kind}
          active={activeColor === c}
          onTap={() => onTap(c)}
        />
      ))}
    </div>
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

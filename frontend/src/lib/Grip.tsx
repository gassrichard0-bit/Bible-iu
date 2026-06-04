import { PanelResizeHandle } from "react-resizable-panels";

/**
 * A grabable resize handle for `react-resizable-panels`.
 *
 * The strip itself is ~14px (touch target ≥ Apple HIG minimum) with a
 * thin visible divider inside. `touch-none` disables browser scroll
 * inside the strip so the drag fires instead of scrolling the page.
 */
export function Grip({ horizontal }: { horizontal?: boolean } = {}) {
  return (
    <PanelResizeHandle
      className={
        horizontal
          ? "group relative h-3.5 cursor-row-resize touch-none select-none bg-transparent"
          : "group relative w-3.5 cursor-col-resize touch-none select-none bg-transparent"
      }
    >
      <span
        aria-hidden
        className={
          horizontal
            ? "pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-neutral-200 group-hover:bg-neutral-400 group-data-[resize-handle-state=drag]:bg-neutral-500 dark:bg-neutral-800 dark:group-hover:bg-neutral-600"
            : "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-200 group-hover:bg-neutral-400 group-data-[resize-handle-state=drag]:bg-neutral-500 dark:bg-neutral-800 dark:group-hover:bg-neutral-600"
        }
      />
      {/* A tiny grip pip so it's obvious where to grab on touch. */}
      <span
        aria-hidden
        className={
          horizontal
            ? "pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300 group-hover:bg-neutral-500 dark:bg-neutral-700 dark:group-hover:bg-neutral-400"
            : "pointer-events-none absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300 group-hover:bg-neutral-500 dark:bg-neutral-700 dark:group-hover:bg-neutral-400"
        }
      />
    </PanelResizeHandle>
  );
}

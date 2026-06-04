/**
 * Rich-text note field — a contenteditable that pairs with a small
 * glass formatting toolbar. The toolbar slides in when the field is
 * focused and dismisses when focus leaves.
 *
 * Storage: sanitized HTML in the note body. We don't run a real Markdown
 * pipeline because notes-system.MD §3 plans a TipTap+tldraw editor for
 * the long-term build; this is the lightweight version that lets you
 * bold/underline a note today.
 *
 * Threat model: notes can be shared (group scope), so the HTML coming
 * out of one user's editor must not be able to inject scripts when
 * rendered for another. `sanitizeNoteHtml` walks the parsed DOM and
 * keeps only a whitelist of inline-formatting tags, dropping every
 * attribute. Scripts, links, images, event handlers — all stripped.
 */
import { useEffect, useRef, useState } from "react";

const ALLOWED_TAGS = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "DEL",
  "BR",
  "P",
  "DIV",
  "UL",
  "OL",
  "LI",
  "SPAN",
]);

/** Walk the parsed HTML, strip every tag not in ALLOWED_TAGS, and drop
 *  every attribute. Returns a safe HTML string. */
export function sanitizeNoteHtml(raw: string): string {
  if (typeof window === "undefined" || !raw) return raw;
  const doc = new DOMParser().parseFromString(`<root>${raw}</root>`, "text/html");
  const root = doc.querySelector("root");
  if (!root) return "";
  walk(root);
  return root.innerHTML;
}

function walk(node: Element) {
  const children = Array.from(node.children);
  for (const child of children) {
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Unwrap (move children up) so the surviving text isn't lost.
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    // Drop every attribute — including style + on* event handlers.
    for (const attr of Array.from(child.attributes)) {
      child.removeAttribute(attr.name);
    }
    walk(child);
  }
}

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Hint text rendered under the toolbar; not stored. */
  ariaLabel?: string;
  /** Compact mode shrinks heights/text size for inline panels. */
  compact?: boolean;
  /** Auto-focus on mount (used by the "open note + start typing" flow
   *  in BibleView). */
  autoFocus?: boolean;
}

export function RichNoteField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  compact,
  autoFocus,
}: Props) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);

  // Push the value in only when it changes from outside — never on
  // every keystroke, or the caret will jump to the start.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (el.innerHTML !== value) el.innerHTML = value;
  }, [value]);

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  // Apply a formatting command and re-sync the body. execCommand is
  // deprecated but remains supported in every browser we target, and
  // it's the simplest path to bold/italic/underline today. We'll swap
  // to the TipTap stack when the spec build lands.
  const run = (cmd: string, arg?: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    document.execCommand(cmd, false, arg);
    onChange(sanitizeNoteHtml(el.innerHTML));
  };

  const handleInput = () => {
    const el = editorRef.current;
    if (!el) return;
    onChange(sanitizeNoteHtml(el.innerHTML));
  };

  // Blur with a small delay: if the blur target is a toolbar button,
  // its mousedown will refocus the editor before this fires, so the
  // toolbar stays put.
  const handleBlur = () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!editorRef.current?.contains(active)) setFocused(false);
    }, 0);
  };

  const empty = !value || value === "<br>";

  return (
    <div className="relative">
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={ariaLabel}
        data-placeholder={placeholder ?? ""}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onInput={handleInput}
        className={`w-full bg-transparent outline-none ${compact ? "min-h-[28px] text-sm" : "min-h-[44px] text-sm"} ${empty ? "before:pointer-events-none before:text-neutral-400 before:content-[attr(data-placeholder)] dark:before:text-neutral-500" : ""}`}
      />
      {focused && (
        <FormatToolbar
          onCmd={run}
          compact={compact}
        />
      )}
    </div>
  );
}

function FormatToolbar({
  onCmd,
  compact,
}: {
  onCmd: (cmd: string, arg?: string) => void;
  compact?: boolean;
}) {
  // mousedown (NOT click) prevents focus from leaving the editor when
  // the toolbar button is pressed — without this, execCommand would
  // run with no selection and do nothing.
  const stop = (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
  };

  const size = compact ? "h-6 min-w-6 text-[11px]" : "h-7 min-w-7 text-xs";

  return (
    <div
      onMouseDown={stop}
      onPointerDown={stop}
      // Same glass recipe as the annotation toolbar pill so the two
      // surfaces feel like the same material.
      className="absolute -top-9 right-0 z-30 flex items-center gap-1 rounded-[18px] border border-white/40 bg-paper/55 px-1.5 py-1 shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_4px_14px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]"
    >
      <Btn label="B" title="Bold" size={size} weight="font-bold" onTap={() => onCmd("bold")} />
      <Btn
        label="I"
        title="Italic"
        size={size}
        weight="italic font-semibold"
        onTap={() => onCmd("italic")}
      />
      <Btn
        label="U"
        title="Underline"
        size={size}
        weight="underline font-semibold"
        onTap={() => onCmd("underline")}
      />
      <Btn
        label="S"
        title="Strikethrough"
        size={size}
        weight="line-through font-semibold"
        onTap={() => onCmd("strikeThrough")}
      />
      <Divider />
      <Btn
        label="•"
        title="Bullet list"
        size={size}
        weight="font-bold"
        onTap={() => onCmd("insertUnorderedList")}
      />
      <Btn
        label="1."
        title="Numbered list"
        size={size}
        weight="font-bold"
        onTap={() => onCmd("insertOrderedList")}
      />
      <Divider />
      <Btn
        label="⟲"
        title="Clear formatting"
        size={size}
        weight=""
        onTap={() => onCmd("removeFormat")}
      />
    </div>
  );
}

function Btn({
  label,
  title,
  size,
  weight,
  onTap,
}: {
  label: string;
  title: string;
  size: string;
  weight: string;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      title={title}
      aria-label={title}
      className={`${size} ${weight} flex items-center justify-center rounded-full px-1.5 text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-700/60`}
    >
      {label}
    </button>
  );
}

function Divider() {
  return (
    <div className="mx-0.5 h-4 w-px bg-neutral-300/70 dark:bg-neutral-700/70" />
  );
}

/** Read-only renderer for sanitized note HTML. Used wherever a note
 *  is shown without an editor (e.g. another user's group note in the
 *  inline panel — they shouldn't be editing yours). */
export function RichNoteView({
  html,
  compact,
}: {
  html: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`prose-sm w-full whitespace-pre-wrap break-words ${compact ? "text-sm" : "text-sm"}`}
      dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(html) }}
    />
  );
}

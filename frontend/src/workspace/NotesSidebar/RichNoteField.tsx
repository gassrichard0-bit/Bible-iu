/**
 * Rich-text note field — now powered by TipTap (ProseMirror).
 *
 * The external API is unchanged from the previous contenteditable
 * implementation (`value` / `onChange` carry sanitized HTML), so the
 * rest of the app — NotesSidebar, InlineNotePanel, ChapterNotePanel
 * — is untouched by this swap. Existing Yjs note bodies are still
 * HTML strings; TipTap parses them on mount via its HTML extension.
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
 *
 * Why TipTap (notes-system.MD §3.1):
 *   - ProseMirror schema lets us evolve the document model without
 *     re-parsing HTML each time.
 *   - Extension system makes the future tldraw + image + table
 *     additions additive instead of rewrites.
 *   - Yjs binding via `@tiptap/extension-collaboration` is the next
 *     step (we still go through the HTML round-trip here so the
 *     existing Yjs schema doesn't change in this commit).
 */
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { ClipIcon } from "../../lib/Icons";
import Image from "@tiptap/extension-image";
import { api, getPassword, getSessionToken } from "../../lib/api";
import { useNoteMentions } from "./useNoteMentions";
import { MentionPopover, detectMentionTrigger } from "./MentionPopover";

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
  "IMG",
]);

/** Image src patterns the sanitizer keeps. Only same-origin URLs
 *  that target our note-image serve endpoint survive; absolute
 *  external URLs and `data:` URIs get stripped to prevent SSRF
 *  beacons and tracking pixels. Patterns are anchored. */
const IMG_SRC_ALLOWLIST: RegExp[] = [
  /^\/rooms\/[A-Za-z0-9_-]+\/notes\/image\/[A-Za-z0-9]+(\?.*)?$/,
  /^\/api\/rooms\/[A-Za-z0-9_-]+\/notes\/image\/[A-Za-z0-9]+(\?.*)?$/,
];

/** Walk the parsed HTML, strip every tag not in ALLOWED_TAGS, and drop
 *  every attribute. Returns a safe HTML string. Re-exported for other
 *  modules (e.g. the share-card preview) that need the same scrub. */
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
    if (child.tagName === "IMG") {
      // Special-case <img>: validate src against the allowlist, and
      // drop every attribute except src + a sanitized alt. Anything
      // not on the allowlist (data:, external URL, javascript:) gets
      // the whole element removed.
      const rawSrc = child.getAttribute("src") || "";
      const alt = (child.getAttribute("alt") || "").slice(0, 200);
      const ok = IMG_SRC_ALLOWLIST.some((re) => re.test(rawSrc));
      for (const attr of Array.from(child.attributes)) {
        child.removeAttribute(attr.name);
      }
      if (!ok) {
        child.remove();
        continue;
      }
      child.setAttribute("src", rawSrc);
      if (alt) child.setAttribute("alt", alt);
      // Don't recurse — <img> is void.
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
  /** When set, the editor exposes an image-upload affordance that
   *  attaches images to notes in this room. Required for image
   *  embeds because the upload endpoint is per-room. */
  roomId?: string;
  /** Lock the editor for reading. Used to display group notes that
   *  belong to other members — the rule is "only the author can
   *  edit," matching the delete affordance gate. */
  readOnly?: boolean;
  /** Optional rendered canvas image written by the native app's
   *  tldraw surface. PWA-side this is read-only: we render it above
   *  the text body when present and leave drawing to the native app.
   *  Same Yjs Y.Doc carries it, so updates land here automatically. */
  canvasDataUrl?: string;
  /** When set together with `noteScope === "group"`, the field
   *  watches the body for `@handle` mentions and POSTs them to the
   *  backend so the tagged room member gets a Web Push. The backend
   *  dedupes per (note, user) so this is safe to call on every edit.
   *  Drafts (no noteId) silently no-op. */
  noteId?: string;
  noteScope?: "personal" | "group";
  /** Caller's user id — passed to the `@`-mention popover so it
   *  doesn't offer to tag the author themselves. When absent the
   *  popover still works but self-mentions land as no-ops at the
   *  server (which already filters them). */
  selfUserId?: string;
}

export function RichNoteField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  compact,
  autoFocus,
  roomId,
  readOnly,
  canvasDataUrl,
  noteId,
  noteScope,
  selfUserId,
}: Props) {
  // Watch the body for @handle mentions and push notify when a new
  // member is tagged. The hook is a no-op for personal-scope notes
  // and for the draft composer (no noteId yet).
  useNoteMentions(noteScope, roomId, noteId, value);

  // `@`-mention autocomplete state. The popover only opens for
  // group-scope notes — there's no one to tag in a personal note.
  // `query` is the partial token after the `@` (empty until the user
  // types a char). `anchor` is the caret's viewport position so the
  // popover can float next to it.
  const [mentionAnchor, setMentionAnchor] = useState<
    { left: number; top: number; bottom: number } | null
  >(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionReplaceFrom, setMentionReplaceFrom] = useState<number | null>(
    null,
  );
  const mentionEnabled = !!roomId && noteScope === "group" && !readOnly;
  const [focused, setFocused] = useState(false);

  const editor = useEditor({
    extensions: [
      // StarterKit ships bold/italic/strike/lists/history/etc. We
      // explicitly disable a few things we don't want in note bodies:
      //   - headings: too heavy for a note-pad
      //   - code blocks: same
      //   - horizontalRule: same
      //   - blockquote: keep — useful for citing verses
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Underline,
      Placeholder.configure({
        placeholder: placeholder ?? "",
        emptyEditorClass: "is-empty",
      }),
      // Inline image attachments. `inline: false` keeps them as
      // block-level so they don't break paragraph flow; the
      // sanitizer enforces the src allowlist before persistence.
      Image.configure({
        inline: false,
        allowBase64: false,
        HTMLAttributes: {
          class: "max-w-full rounded-xl",
        },
      }),
    ],
    content: value || "",
    autofocus: autoFocus ? "end" : false,
    editable: !readOnly,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel ?? "Note editor",
        // `auto` lets the browser pick LTR vs RTL per paragraph
        // based on the first strong-directional character. Handles
        // mixed Hebrew/English notes cleanly without forcing
        // either direction at the element level.
        dir: "auto",
        // ProseMirror sets contenteditable + tabindex itself; we
        // only need to layer our visual classes.
        class: [
          "w-full bg-transparent outline-none whitespace-pre-wrap break-words",
          compact ? "min-h-[28px] text-sm" : "min-h-[44px] text-sm",
          // Re-style placeholder via the data-placeholder pattern the
          // Placeholder extension emits.
          "[&_.is-empty]:before:content-[attr(data-placeholder)]",
          "[&_.is-empty]:before:pointer-events-none",
          "[&_.is-empty]:before:text-neutral-400",
          "[&_.is-empty]:before:float-left",
          "[&_.is-empty]:before:h-0",
          "dark:[&_.is-empty]:before:text-neutral-500",
        ].join(" "),
      },
    },
    onFocus: () => setFocused(true),
    onBlur: ({ event }) => {
      // Same defer as the old field — let toolbar mousedown commit
      // before we tear the toolbar away. Toolbar buttons set
      // preventDefault on mousedown so the editor never blurs to
      // them in the first place; the timeout is a belt-and-braces
      // measure for stray pointer events.
      const relatedInsideToolbar =
        event.relatedTarget instanceof HTMLElement &&
        event.relatedTarget.closest("[data-note-toolbar]");
      if (relatedInsideToolbar) return;
      setTimeout(() => setFocused(false), 50);
    },
    onUpdate: ({ editor: ed }) => {
      const html = sanitizeNoteHtml(ed.getHTML());
      onChange(html);
      maybeUpdateMentionTrigger(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      // Caret moves (arrow keys, click reposition) might exit a
      // trigger range without changing the text — re-detect on every
      // selection.
      maybeUpdateMentionTrigger(ed);
    },
  });

  // Lifted out of the editor callbacks so we can reuse on both
  // onUpdate and onSelectionUpdate without duplicating the parsing.
  function maybeUpdateMentionTrigger(ed: NonNullable<typeof editor>) {
    if (!mentionEnabled) {
      if (mentionAnchor !== null) {
        setMentionAnchor(null);
        setMentionQuery("");
        setMentionReplaceFrom(null);
      }
      return;
    }
    const sel = ed.state.selection;
    if (!sel.empty) {
      // No popover during text selection — the user is doing something
      // else.
      setMentionAnchor(null);
      return;
    }
    const from = sel.from;
    // Pull the text node content before the caret. We only need the
    // current paragraph; anything across blocks closes the trigger.
    const $from = sel.$from;
    const blockStart = $from.start();
    const textBefore = ed.state.doc.textBetween(blockStart, from, "\n", "\n");
    const hit = detectMentionTrigger(textBefore);
    if (!hit) {
      setMentionAnchor(null);
      setMentionQuery("");
      setMentionReplaceFrom(null);
      return;
    }
    // Pixel coords of the `@` token start, used to anchor the popover.
    const coords = ed.view.coordsAtPos(blockStart + hit.replaceStart);
    setMentionAnchor({
      left: coords.left,
      top: coords.top,
      bottom: coords.bottom,
    });
    setMentionQuery(hit.query);
    setMentionReplaceFrom(blockStart + hit.replaceStart);
  }

  function insertMentionHandle(handle: string) {
    if (!editor || mentionReplaceFrom === null) return;
    const from = mentionReplaceFrom;
    const to = editor.state.selection.from;
    // Replace `@partial` with `@handle ` — trailing space so the
    // next keystroke continues the sentence and closes the trigger.
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, `@${handle} `)
      .run();
    setMentionAnchor(null);
    setMentionQuery("");
    setMentionReplaceFrom(null);
  }

  // Sync external value changes (e.g. Yjs remote update) into the
  // editor without resetting the cursor while the user types.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current && !editor.isFocused) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  // Keep ProseMirror's editable flag in sync with our prop. The hook's
  // `editable` option is only read at init time, so this is what
  // flips read-only on/off when ownership data resolves late.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Tear down ProseMirror on unmount (the hook does its own cleanup,
  // but make sure focus state doesn't leak into a stale closure).
  useEffect(() => {
    return () => {
      setFocused(false);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleImageFile(file: File) {
    if (!roomId || !editor) return;
    setUploading(true);
    try {
      const out = await api.noteUploadImage(roomId, file);
      // Browser <img> loaders can't send custom headers, so the
      // backend's note-image route accepts the same ?password=&session=
      // query auth that chat images, room avatars, and profile use.
      // Without this the <img> request 401s and the note shows a
      // broken image. Same shape as chatImageWithAuth in MobileShell.
      const base = `/api${out.serve_url}`;
      const pw = getPassword();
      const tok = getSessionToken();
      const qs: string[] = [];
      if (pw) qs.push(`password=${encodeURIComponent(pw)}`);
      if (tok) qs.push(`session=${encodeURIComponent(tok)}`);
      const src = qs.length ? `${base}?${qs.join("&")}` : base;
      editor.chain().focus().setImage({ src, alt: file.name }).run();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[notes] image upload failed:", (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="relative">
      {canvasDataUrl && (
        <figure className="mb-2 overflow-hidden rounded-xl border border-neutral-200 bg-paper-soft dark:border-neutral-800 dark:bg-neutral-900">
          <img
            src={canvasDataUrl}
            alt="Note canvas"
            className="block max-h-72 w-full object-contain"
            draggable={false}
          />
          <figcaption className="border-t border-neutral-200 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            Canvas &middot; view-only on web &middot; draw in the native app
          </figcaption>
        </figure>
      )}
      <EditorContent editor={editor} />
      {mentionEnabled && roomId && mentionAnchor && (
        <MentionPopover
          roomId={roomId}
          anchor={mentionAnchor}
          query={mentionQuery}
          selfUserId={selfUserId ?? ""}
          onPick={insertMentionHandle}
          onClose={() => setMentionAnchor(null)}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleImageFile(f);
          e.target.value = "";
        }}
      />
      {focused && editor && (
        <FormatToolbar
          showImage={!!roomId}
          imageUploading={uploading}
          onImage={() => fileInputRef.current?.click()}
          onCmd={(cmd) => {
            // Each toolbar tap routes through TipTap commands; the
            // editor's onUpdate fires onChange with the new HTML.
            const chain = editor.chain().focus();
            switch (cmd) {
              case "bold":
                chain.toggleBold().run();
                break;
              case "italic":
                chain.toggleItalic().run();
                break;
              case "underline":
                chain.toggleUnderline().run();
                break;
              case "strike":
                chain.toggleStrike().run();
                break;
              case "bullet":
                chain.toggleBulletList().run();
                break;
              case "ordered":
                chain.toggleOrderedList().run();
                break;
              case "clear":
                chain.unsetAllMarks().clearNodes().run();
                break;
            }
          }}
          compact={compact}
        />
      )}
    </div>
  );
}

function FormatToolbar({
  onCmd,
  compact,
  showImage,
  imageUploading,
  onImage,
}: {
  onCmd: (cmd: string) => void;
  compact?: boolean;
  showImage?: boolean;
  imageUploading?: boolean;
  onImage?: () => void;
}) {
  // mousedown (NOT click) prevents focus from leaving the editor when
  // the toolbar button is pressed — without this, the command would
  // run with no selection and do nothing.
  const stop = (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
  };
  const size = compact ? "h-6 min-w-6 text-[11px]" : "h-7 min-w-7 text-xs";
  return (
    <div
      data-note-toolbar
      onMouseDown={stop}
      onPointerDown={stop}
      // Positioned BELOW the editor (top-full mt-1) so the formatting
      // strip never floats over the verse text, an adjacent note, or
      // whatever else sits above this card.
      className="absolute top-full right-0 z-30 mt-1 flex items-center gap-1 rounded-[18px] border border-white/40 bg-paper/55 px-1.5 py-1 shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_4px_14px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]"
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
        onTap={() => onCmd("strike")}
      />
      <Divider />
      <Btn
        label="•"
        title="Bullet list"
        size={size}
        weight="font-bold"
        onTap={() => onCmd("bullet")}
      />
      <Btn
        label="1."
        title="Numbered list"
        size={size}
        weight="font-bold"
        onTap={() => onCmd("ordered")}
      />
      <Divider />
      <Btn
        label="⟲"
        title="Clear formatting"
        size={size}
        weight=""
        onTap={() => onCmd("clear")}
      />
      {showImage && (
        <>
          <Divider />
          <Btn
            label={imageUploading ? "…" : <ClipIcon className="h-4 w-4" />}
            title={imageUploading ? "Uploading…" : "Attach image"}
            size={size}
            weight=""
            onTap={() => {
              if (!imageUploading) onImage?.();
            }}
          />
        </>
      )}
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
  label: React.ReactNode;
  title: string;
  size: string;
  weight: string;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Keep selection / focus inside the editor.
        e.preventDefault();
      }}
      onClick={onTap}
      className={`grid place-items-center rounded-full px-1.5 text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-200 dark:hover:bg-neutral-700/60 ${size} ${weight}`}
      title={title}
      aria-label={title}
    >
      {label}
    </button>
  );
}

function Divider() {
  return (
    <span className="mx-0.5 h-3 w-px bg-neutral-300/70 dark:bg-neutral-600/70" />
  );
}

/**
 * Heart + flat comment thread for a single GROUP note. Rendered both
 * in the Notes sidebar/panel and inline under each verse-anchored
 * note in the Bible view. Personal and agent-authored notes never
 * mount this — gate at the call site (see callers).
 *
 * Behavior: hearts toggle on tap, the comment row expands on tap of
 * the speech-bubble. Comments are flat (no replies). The author can
 * delete their own comment.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type NoteReactionKind, type NoteSocialOut } from "../../lib/api";
import { GLASS_CARD_INLINE } from "../../lib/glass";
import { MentionPopover, detectMentionTrigger } from "./MentionPopover";

export function NoteSocialBlock({
  roomId,
  noteId,
  selfUserId,
}: {
  roomId: string;
  noteId: string;
  selfUserId?: string;
}) {
  const [state, setState] = useState<NoteSocialOut | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // @-mention autocomplete state for the comment textarea. Mirrors
  // what RichNoteField does for note bodies, but works against a
  // plain <textarea> by tracking selectionStart on the underlying
  // input element.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<
    { left: number; top: number; bottom: number } | null
  >(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionReplaceFrom, setMentionReplaceFrom] = useState<number | null>(
    null,
  );

  function refreshMentionTrigger() {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? draft.length;
    const textBefore = draft.slice(0, caret);
    const hit = detectMentionTrigger(textBefore);
    if (!hit) {
      setMentionAnchor(null);
      setMentionQuery("");
      setMentionReplaceFrom(null);
      return;
    }
    // Anchor the popover above the textarea — the textarea is one
    // line tall and lives at the bottom of the social block, so
    // the popover floats up out of the way. MentionPopover flips
    // automatically when the caret is near the viewport top.
    const rect = ta.getBoundingClientRect();
    setMentionAnchor({
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
    });
    setMentionQuery(hit.query);
    setMentionReplaceFrom(hit.replaceStart);
  }

  function pickMention(handle: string) {
    const ta = textareaRef.current;
    if (mentionReplaceFrom === null) return;
    const caret = ta?.selectionStart ?? draft.length;
    const next =
      draft.slice(0, mentionReplaceFrom) +
      `@${handle} ` +
      draft.slice(caret);
    setDraft(next);
    setMentionAnchor(null);
    setMentionQuery("");
    setMentionReplaceFrom(null);
    // Move the caret to just after the inserted handle so typing
    // continues naturally.
    setTimeout(() => {
      const t = textareaRef.current;
      if (!t) return;
      const pos = mentionReplaceFrom + handle.length + 2; // "@handle "
      t.focus();
      t.setSelectionRange(pos, pos);
    }, 0);
  }

  const load = useCallback(async () => {
    try {
      setState(await api.noteSocial(roomId, noteId));
    } catch {
      // Non-essential surface — stay quiet if the backend is unreachable.
    }
  }, [roomId, noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleReaction(kind: NoteReactionKind) {
    if (busy) return;
    setBusy(true);
    try {
      setState(await api.noteLikeToggle(roomId, noteId, kind));
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      setState(await api.noteCommentAdd(roomId, noteId, body));
      setDraft("");
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(commentId: string) {
    if (busy) return;
    if (!confirm("Delete this comment?")) return;
    setBusy(true);
    try {
      setState(await api.noteCommentDelete(roomId, noteId, commentId));
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  const likes = state?.likes ?? 0;
  const liked = state?.liked_by_me ?? false;
  const thumbsups = state?.thumbsups ?? 0;
  const thumbed = state?.thumbsuped_by_me ?? false;
  const commentCount = state?.comments.length ?? 0;

  return (
    <div className="mt-2 border-t border-neutral-200/70 pt-1.5 dark:border-neutral-800/70">
      <div className="flex items-center gap-3 text-[11px]">
        <button
          onClick={() => toggleReaction("heart")}
          disabled={busy}
          aria-pressed={liked}
          className={`flex items-center gap-1 rounded px-1 py-0.5 transition ${
            liked
              ? "text-rose-600 dark:text-rose-300"
              : "text-neutral-500 hover:text-rose-500 dark:text-neutral-400 dark:hover:text-rose-300"
          }`}
          title={liked ? "Remove heart" : "Heart"}
        >
          <HeartIcon filled={liked} />
          <span className="tabular-nums">{likes}</span>
        </button>
        <button
          onClick={() => toggleReaction("thumbsup")}
          disabled={busy}
          aria-pressed={thumbed}
          className={`flex items-center gap-1 rounded px-1 py-0.5 transition ${
            thumbed
              ? "text-amber-600 dark:text-amber-300"
              : "text-neutral-500 hover:text-amber-500 dark:text-neutral-400 dark:hover:text-amber-300"
          }`}
          title={thumbed ? "Unlike" : "Like"}
        >
          <ThumbIcon filled={thumbed} />
          <span className="tabular-nums">{thumbsups}</span>
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          title={open ? "Hide comments" : "Show comments"}
        >
          <SpeechIcon />
          <span className="tabular-nums">{commentCount}</span>
        </button>
      </div>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {state?.comments.map((c) => (
            <div
              key={c.id}
              className={`group/comment flex items-start gap-2 px-2 py-1.5 text-[12px] ${GLASS_CARD_INLINE}`}
            >
              <div className="flex-1">
                <div className="text-[10px] text-neutral-500 dark:text-neutral-400">
                  {c.author_display_name || c.author_handle}
                </div>
                <div className="whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">
                  {c.body}
                </div>
              </div>
              {selfUserId && c.author_user_id === selfUserId && (
                <button
                  onClick={() => removeComment(c.id)}
                  className="text-neutral-400 opacity-60 hover:text-red-600 group-hover/comment:opacity-100 md:opacity-0"
                  aria-label="Delete comment"
                  title="Delete your comment"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          <form
            onSubmit={submitComment}
            className={`flex items-stretch gap-1 p-1 ${GLASS_CARD_INLINE}`}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // Defer to next tick so selectionStart reflects the
                // post-input caret position.
                setTimeout(refreshMentionTrigger, 0);
              }}
              onKeyUp={() => refreshMentionTrigger()}
              onClick={() => refreshMentionTrigger()}
              onBlur={() => {
                // Let the popover's mousedown commit before tearing
                // it down.
                setTimeout(() => setMentionAnchor(null), 120);
              }}
              placeholder="Comment…"
              aria-label="Add a comment"
              rows={1}
              className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-[12px] text-neutral-900 placeholder:text-neutral-500 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-400"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="rounded-full bg-neutral-900 px-3 text-[11px] font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Post
            </button>
          </form>
        </div>
      )}
      {mentionAnchor && (
        <MentionPopover
          roomId={roomId}
          anchor={mentionAnchor}
          query={mentionQuery}
          selfUserId={selfUserId ?? ""}
          onPick={pickMention}
          onClose={() => setMentionAnchor(null)}
        />
      )}
    </div>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function ThumbIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l5-8h.86a2 2 0 0 1 1.97 2.34l-.83 1.54z" />
    </svg>
  );
}

function SpeechIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

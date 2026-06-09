/**
 * Horizontal status strip that sits above the chat scroller. Groups
 * the room's active statuses by author and renders one circular avatar
 * per author with a ring that fills in around it — solid when there
 * are unseen statuses from that author, dashed/dim when everything is
 * seen.
 *
 * The viewer-self slot is always first and acts as a composer trigger
 * ("Add status" + "+" badge). Tapping any other slot opens the
 * full-screen viewer at that author's first unseen status.
 */
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Profile";
import type { StatusOut } from "../lib/api";

const STATUS_COLLAPSED_KEY = "bible-iu:status-collapsed";

interface Props {
  statuses: StatusOut[];
  selfUserId: string | undefined;
  selfHandle: string | undefined;
  selfAvatarUrl: string | null | undefined;
  /** Tap the "Add status" tile. */
  onCompose: () => void;
  /** Tap another member's avatar — receives the ordered list of
   *  their statuses so the viewer can step through them. */
  onOpenAuthor: (statuses: StatusOut[]) => void;
}

/** One row per author. Self always sorts first so the user's own
 *  story sits next to the "Add" tile. Within an author the statuses
 *  are oldest→newest so the viewer ticks through in posting order. */
function groupByAuthor(
  statuses: StatusOut[],
  selfUserId: string | undefined,
): Array<{
  authorId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  list: StatusOut[];
  hasUnseen: boolean;
}> {
  const byAuthor = new Map<string, StatusOut[]>();
  for (const s of statuses) {
    const arr = byAuthor.get(s.author_user_id) ?? [];
    arr.push(s);
    byAuthor.set(s.author_user_id, arr);
  }
  const out: ReturnType<typeof groupByAuthor> = [];
  for (const [authorId, list] of byAuthor) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const head = list[0];
    out.push({
      authorId,
      handle: head.author_handle,
      displayName: head.author_display_name,
      avatarUrl: head.author_avatar_url,
      list,
      hasUnseen:
        authorId !== selfUserId &&
        list.some((s) => !s.viewer_has_viewed),
    });
  }
  // Self first; then unseen authors; then seen-all authors.
  out.sort((a, b) => {
    const aSelf = a.authorId === selfUserId ? 0 : 1;
    const bSelf = b.authorId === selfUserId ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    // Most-recent post first within each bucket so the strip reads
    // newest-on-the-left after the unseen group.
    const at = a.list[a.list.length - 1].created_at;
    const bt = b.list[b.list.length - 1].created_at;
    return bt.localeCompare(at);
  });
  return out;
}

export function ChatStatusStrip({
  statuses,
  selfUserId,
  selfHandle,
  selfAvatarUrl,
  onCompose,
  onOpenAuthor,
}: Props) {
  const groups = useMemo(
    () => groupByAuthor(statuses, selfUserId),
    [statuses, selfUserId],
  );
  const selfGroup = groups.find((g) => g.authorId === selfUserId);

  // Collapse state persists in localStorage so the user's choice
  // survives reloads. Default = expanded so the strip is discoverable.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STATUS_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STATUS_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // best-effort persistence
    }
  }, [collapsed]);

  const hasUnseen = groups.some((g) => g.hasUnseen);

  // Collapsed state — strip is hidden, only the small chevron pill
  // hangs from the top edge of the chat area, mirroring the Bible
  // page's focus-mode handle. The triangle GLYPH lights amber +
  // pulses when there's unseen activity; the pill itself stays the
  // same neutral surface so the bright cue carries entirely on the
  // chevron color.
  if (collapsed) {
    return (
      <div className="relative flex h-0 shrink-0 justify-center">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="absolute -top-px z-30 rounded-b-full border border-t-0 border-neutral-300 bg-paper px-3 py-0.5 text-[10px] shadow-sm hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          aria-label={hasUnseen ? "New statuses — show them" : "Show statuses"}
          title={hasUnseen ? "New statuses" : "Show statuses"}
        >
          <span
            aria-hidden
            className={
              hasUnseen
                ? "font-bold text-amber-500 dark:text-amber-300"
                : "text-neutral-500 dark:text-neutral-400"
            }
            style={
              hasUnseen
                ? {
                    animation: "statusPulseGlyph 1.4s ease-in-out infinite",
                    textShadow: "0 0 4px rgba(245, 158, 11, 0.7)",
                  }
                : undefined
            }
          >
            ▼
          </span>
        </button>
        {/* Inlined keyframes — the strip is fully self-contained. */}
        <style>{`@keyframes statusPulseGlyph {
          0%, 100% {
            text-shadow: 0 0 3px rgba(245, 158, 11, 0.55);
            opacity: 1;
          }
          50% {
            text-shadow: 0 0 8px rgba(245, 158, 11, 0.95);
            opacity: 0.85;
          }
        }`}</style>
      </div>
    );
  }

  return (
    <div className="relative shrink-0 border-b border-neutral-200 bg-paper-soft dark:border-neutral-800 dark:bg-neutral-950">
      <div
        className="flex items-center gap-3 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="list"
        aria-label="Room statuses"
      >
      {/* "Add status" / "Your status" tile — composer trigger. If the
       *  viewer already posted today, the slot doubles as a quick way
       *  to open their own story. */}
      <button
        type="button"
        onClick={() => {
          if (selfGroup) onOpenAuthor(selfGroup.list);
          else onCompose();
        }}
        className="group relative flex shrink-0 flex-col items-center gap-1"
        aria-label={selfGroup ? "View your status" : "Add a status"}
      >
        <div
          className={`relative grid place-items-center rounded-full ${
            selfGroup
              ? "p-[2px] bg-gradient-to-br from-amber-400 via-amber-500 to-amber-600"
              : ""
          }`}
        >
          <div className="rounded-full bg-paper-soft p-[2px] dark:bg-neutral-950">
            <Avatar
              handle={selfHandle ?? "?"}
              url={selfAvatarUrl ?? null}
              size={56}
            />
          </div>
          {/* "+" badge: only when the viewer hasn't posted yet OR
           *  always, so they can stack a second status. We always
           *  show it; tapping the avatar opens the composer when
           *  there's no existing self-status, and the viewer when
           *  there is. The "+" stays as the universal "post new". */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCompose();
            }}
            className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-paper-soft bg-amber-500 text-[12px] font-bold text-white shadow-sm hover:bg-amber-600 dark:border-neutral-950"
            aria-label="Add a new status"
            title="Add a new status"
          >
            +
          </button>
        </div>
        <span className="max-w-[68px] truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-200">
          {selfGroup ? "Your status" : "Add status"}
        </span>
      </button>

      {/* Remaining authors. */}
      {groups
        .filter((g) => g.authorId !== selfUserId)
        .map((g) => (
          <button
            key={g.authorId}
            type="button"
            onClick={() => onOpenAuthor(g.list)}
            className="flex shrink-0 flex-col items-center gap-1"
            role="listitem"
            aria-label={`View status from ${g.handle ?? g.displayName ?? "member"}`}
          >
            <div
              className={`grid place-items-center rounded-full p-[2px] ${
                g.hasUnseen
                  ? "bg-gradient-to-br from-amber-400 via-amber-500 to-amber-600"
                  : "bg-neutral-300 dark:bg-neutral-700"
              }`}
            >
              <div className="rounded-full bg-paper-soft p-[2px] dark:bg-neutral-950">
                <Avatar
                  handle={g.handle ?? "?"}
                  url={g.avatarUrl}
                  size={56}
                />
              </div>
            </div>
            <span className="max-w-[68px] truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-200">
              {g.displayName ?? g.handle ?? "Member"}
            </span>
          </button>
        ))}
      </div>
      {/* Collapse handle — same pill the Bible page uses to toggle
       *  focus mode. Hangs off the bottom-center of the strip border.
       *  Triangle glyph itself glows amber when there's unseen
       *  activity; the pill background stays neutral. */}
      <div className="relative flex h-0 justify-center">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="absolute -top-px z-30 rounded-b-full border border-t-0 border-neutral-300 bg-paper px-3 py-0.5 text-[10px] shadow-sm hover:bg-paper-soft dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          aria-label="Hide statuses"
          title="Hide statuses"
        >
          <span
            aria-hidden
            className={
              hasUnseen
                ? "font-bold text-amber-500 dark:text-amber-300"
                : "text-neutral-500 dark:text-neutral-400"
            }
            style={
              hasUnseen
                ? {
                    animation: "statusPulseGlyph 1.4s ease-in-out infinite",
                    textShadow: "0 0 4px rgba(245, 158, 11, 0.7)",
                  }
                : undefined
            }
          >
            ▲
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Per-room admin panel. Opens as a bottom-sheet from the room header
 * for any signed-in user; non-admins see a read-only view with no
 * actionable controls.
 *
 * Two sections:
 *   1. Members — list with role badges. Admins can promote / demote /
 *      remove anyone except the last admin (server enforces that).
 *   2. Agent — per-room toggles: enable/disable, web search, citation
 *      bypass allowed, external links, per-user daily question cap.
 */
import { useEffect, useRef, useState } from "react";
import {
  api,
  type AgentSettingsOut,
  type RoomMemberOut,
} from "../lib/api";
import { BottomSheet } from "./BottomSheet";
import { GLASS_CARD_INLINE } from "../lib/glass";
import { RoomAvatar } from "./RoomAvatar";
import { Pill } from "./SettingsButtons";
import {
  ACCENT_KEYS,
  ACCENT_PALETTE,
  resolveAccent,
  type AccentKey,
} from "../lib/accentColors";

interface Props {
  open: boolean;
  onClose: () => void;
  roomId: string;
  roomName?: string;
  roomType?: "group" | "direct";
  /** Current avatar URL (server-relative) so the panel shows a
   *  preview without a refetch. Updated locally after upload/clear. */
  roomImageUrl?: string | null;
  /** Fired after a successful upload or clear so the parent shell can
   *  refetch /rooms and propagate the new URL into the rooms rail. */
  onRoomImageChanged?: (newUrl: string | null) => void;
  /** Admin-picked accent color key. Null = auto-derived from id. */
  roomAccentColor?: string | null;
  /** Fires when the admin picks a new accent or clears it. The parent
   *  uses this to update its rooms cache so the header tint and the
   *  AI pill ring refresh immediately. */
  onRoomAccentChanged?: (newAccent: string | null) => void;
  /** Authoritative role from the parent (which already knows it from
   *  /rooms). Skips the loading flicker where the in-panel members
   *  fetch hasn't returned yet and admin-only controls (photo upload,
   *  member ops) appear missing. */
  selfRole?: "admin" | "member";
  selfUserId: string;
}

export function AdminPanel({
  open,
  onClose,
  roomId,
  roomName,
  roomType = "group",
  roomImageUrl,
  onRoomImageChanged,
  roomAccentColor,
  onRoomAccentChanged,
  selfRole,
  selfUserId,
}: Props) {
  const [members, setMembers] = useState<RoomMemberOut[]>([]);
  const [settings, setSettings] = useState<AgentSettingsOut | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(
    roomImageUrl ?? null,
  );
  // Track prop changes so reopening the sheet after the parent refetched
  // /rooms shows the new URL.
  useEffect(() => {
    setImageUrl(roomImageUrl ?? null);
  }, [roomImageUrl]);
  const [accentOverride, setAccentOverride] = useState<string | null>(
    roomAccentColor ?? null,
  );
  useEffect(() => {
    setAccentOverride(roomAccentColor ?? null);
  }, [roomAccentColor]);
  const resolvedAccent: AccentKey = resolveAccent(accentOverride, roomId);

  async function pickAccent(next: AccentKey | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.roomAccentPatch(roomId, next);
      const v = updated.accent_color ?? null;
      setAccentOverride(v);
      onRoomAccentChanged?.(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reload when the panel opens (or the room changes while open).
  useEffect(() => {
    if (!open || !roomId) return;
    setError(null);
    let alive = true;
    Promise.all([
      api.roomMembers(roomId).catch(() => [] as RoomMemberOut[]),
      api.roomAgentSettings(roomId).catch(() => null),
    ]).then(([m, s]) => {
      if (!alive) return;
      setMembers(m);
      setSettings(s);
    });
    return () => {
      alive = false;
    };
  }, [open, roomId]);

  const me = members.find((m) => m.user_id === selfUserId);
  // Trust the parent's role when supplied — `members` doesn't load
  // until the sheet has been open for a beat and otherwise admins see
  // a blank no-photo state for that beat.
  const isAdmin = (selfRole ?? me?.role) === "admin";
  const adminCount = members.filter((m) => m.role === "admin").length;

  async function setRole(
    target: RoomMemberOut,
    role: "admin" | "member",
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.roomMemberPatch(
        roomId,
        target.user_id,
        role,
      );
      setMembers((prev) =>
        prev.map((m) => (m.user_id === updated.user_id ? updated : m)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(target: RoomMemberOut) {
    if (busy) return;
    if (
      !confirm(
        `Remove ${target.display_name || target.handle} from this room?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.roomMemberRemove(roomId, target.user_id);
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== target.user_id),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(file: File) {
    if (busy) return;
    // 20MB matches the backend cap. Modern phone JPEGs land around
    // 8-15MB so the old 4MB was a soft bug — most camera-roll picks
    // were rejected before the server ever saw them.
    if (file.size > 20 * 1024 * 1024) {
      setError(
        `Image is ${(file.size / (1024 * 1024)).toFixed(1)}MB — must be under 20MB.`,
      );
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { image_url } = await api.roomImageUpload(roomId, file);
      setImageUrl(image_url);
      onRoomImageChanged?.(image_url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearImage() {
    if (busy) return;
    if (!confirm("Remove the group photo?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.roomImageDelete(roomId);
      setImageUrl(null);
      onRoomImageChanged?.(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patchSetting<K extends keyof AgentSettingsOut>(
    key: K,
    value: AgentSettingsOut[K],
  ) {
    if (!settings || busy) return;
    const next = { ...settings, [key]: value };
    setSettings(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      const saved = await api.roomAgentSettingsPatch(roomId, next);
      setSettings(saved);
    } catch (e) {
      // Revert on failure.
      setSettings(settings);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={roomName ?? "Room"} fullPage>
      <div className="space-y-4 px-1 pb-4">
        {error && (
          <p className="text-xs text-red-600 dark:text-red-300">{error}</p>
        )}

        <Section
          title="Group photo"
          subtitle={
            isAdmin
              ? "Shown on every member's room list."
              : "Set by an admin."
          }
        >
          <div className="flex items-center gap-4">
            <RoomAvatar
              id={roomId}
              name={roomName ?? "Room"}
              type={roomType}
              imageUrl={imageUrl}
              size={72}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {isAdmin ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadImage(f);
                      e.target.value = "";
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Pill
                      type="button"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {busy ? "Uploading…" : imageUrl ? "Change photo" : "Upload photo"}
                    </Pill>
                    {imageUrl && (
                      <Pill
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void clearImage()}
                      >
                        Remove
                      </Pill>
                    )}
                  </div>
                  {error && (
                    <p
                      role="alert"
                      className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {error}
                    </p>
                  )}
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Any image format — under 20MB. Stored as WebP at 512px.
                  </p>
                </>
              ) : (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {imageUrl ? "Photo set by admin." : "No photo set."}
                </p>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="Accent color"
          subtitle={
            isAdmin
              ? "Tints the header band and the AI pill so each group looks its own."
              : "Set by an admin."
          }
        >
          <div className="space-y-2 p-1">
            <div className="flex flex-wrap items-center gap-2">
              {ACCENT_KEYS.map((key) => {
                const tones = ACCENT_PALETTE[key];
                const picked = resolvedAccent === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => isAdmin && void pickAccent(key)}
                    disabled={!isAdmin || busy}
                    aria-pressed={picked}
                    aria-label={`Use ${key} accent`}
                    title={`Use ${key} accent`}
                    className={`relative h-9 w-9 rounded-full transition disabled:opacity-50 ${
                      picked
                        ? "ring-2 ring-offset-2 ring-neutral-900 dark:ring-neutral-50 dark:ring-offset-neutral-900"
                        : "hover:scale-110"
                    }`}
                    style={{
                      backgroundColor: tones.swatch,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 4px rgba(0,0,0,0.18)",
                    }}
                  >
                    {picked && (
                      <span
                        className="absolute inset-0 grid place-items-center text-white"
                        aria-hidden
                      >
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
              {isAdmin && accentOverride && (
                <Pill onClick={() => void pickAccent(null)} disabled={busy}>
                  Reset
                </Pill>
              )}
            </div>
            {!accentOverride && (
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Auto: <span className="font-mono">{resolvedAccent}</span> — derived from the group id.
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Members"
          subtitle={
            isAdmin
              ? "Tap a member to change their role or remove them."
              : "Only admins can change roles or remove members."
          }
        >
          {members.length === 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              No members loaded.
            </p>
          )}
          <ul className="space-y-1.5">
            {members.map((m) => (
              <MemberRow
                key={m.user_id}
                member={m}
                isSelf={m.user_id === selfUserId}
                canManage={isAdmin}
                adminCount={adminCount}
                busy={busy}
                onPromote={() => setRole(m, "admin")}
                onDemote={() => setRole(m, "member")}
                onRemove={() => removeMember(m)}
              />
            ))}
          </ul>
        </Section>

        <Section
          title="Agent"
          subtitle={
            isAdmin
              ? "Per-room limits on what the AI can do. Members see these settings but can't change them."
              : "Per-room limits set by an admin."
          }
        >
          {settings ? (
            <div className="space-y-1.5">
              <Toggle
                label="Agent enabled"
                description="Turn the AI off entirely in this room. Members can still write notes + chat."
                checked={settings.agent_enabled}
                disabled={!isAdmin || busy}
                onChange={(v) => patchSetting("agent_enabled", v)}
              />
              <Toggle
                label="Allow web search"
                description="When on, the agent may search the web for context. Off keeps every answer scripture-anchored."
                checked={settings.allow_web_search}
                disabled={!isAdmin || busy || !settings.agent_enabled}
                onChange={(v) => patchSetting("allow_web_search", v)}
              />
              <Toggle
                label="Allow external links"
                description="The agent may include outbound links in its answers."
                checked={settings.allow_external_links}
                disabled={!isAdmin || busy || !settings.agent_enabled}
                onChange={(v) => patchSetting("allow_external_links", v)}
              />
              <Toggle
                label="Allow citation-engine bypass"
                description="Lets users individually override the safety pipeline in their own Settings. Even with this on, the rule layer (rule-guide.MD) still runs."
                checked={settings.bypass_citation_engine_allowed}
                disabled={!isAdmin || busy || !settings.agent_enabled}
                onChange={(v) =>
                  patchSetting("bypass_citation_engine_allowed", v)
                }
              />
              <NumberRow
                label="Daily question cap per user"
                description="Empty = unlimited. Caps DeepSeek spend without policing individuals."
                value={settings.max_questions_per_user_per_day}
                disabled={!isAdmin || busy}
                onChange={(v) =>
                  patchSetting("max_questions_per_user_per_day", v)
                }
              />
            </div>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Loading…
            </p>
          )}
        </Section>
      </div>
    </BottomSheet>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      {subtitle && (
        <p className="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400">
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

function MemberRow({
  member,
  isSelf,
  canManage,
  adminCount,
  busy,
  onPromote,
  onDemote,
  onRemove,
}: {
  member: RoomMemberOut;
  isSelf: boolean;
  canManage: boolean;
  adminCount: number;
  busy: boolean;
  onPromote: () => void;
  onDemote: () => void;
  onRemove: () => void;
}) {
  const isAdmin = member.role === "admin";
  // Server enforces this too, but disabling client-side avoids a
  // round-trip + confusing error toast.
  const isLastAdmin = isAdmin && adminCount <= 1;
  return (
    <li className={`flex items-center gap-2 px-2 py-1.5 ${GLASS_CARD_INLINE}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-sm">
          <span className="truncate">
            {member.display_name || member.handle}
          </span>
          {isSelf && (
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
              (you)
            </span>
          )}
          {isAdmin && (
            <span className="rounded-full bg-amber-200/70 px-1.5 text-[9px] font-semibold uppercase text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
              admin
            </span>
          )}
        </div>
        <div className="truncate text-[10px] text-neutral-500 dark:text-neutral-400">
          @{member.handle}
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1.5">
          {isAdmin ? (
            <Pill
              onClick={onDemote}
              disabled={busy || isLastAdmin}
              title={isLastAdmin ? "Promote someone else first" : "Demote to member"}
            >
              Demote
            </Pill>
          ) : (
            <Pill
              onClick={onPromote}
              disabled={busy}
              title="Promote to admin"
            >
              Promote
            </Pill>
          )}
          <Pill
            variant="destructive"
            onClick={onRemove}
            disabled={busy || isLastAdmin}
            title={
              isLastAdmin
                ? "Promote someone else first"
                : `Remove ${member.display_name || member.handle}`
            }
          >
            Remove
          </Pill>
        </div>
      )}
    </li>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 px-2.5 py-2 text-sm ${GLASS_CARD_INLINE} ${disabled ? "opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {description && (
          <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {description}
          </div>
        )}
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-amber-600"
      />
    </div>
  );
}

function NumberRow({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: number | null;
  disabled?: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-2.5 py-2 text-sm ${GLASS_CARD_INLINE} ${disabled ? "opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {description && (
          <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {description}
          </div>
        )}
      </div>
      <input
        type="number"
        min={1}
        max={9999}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === "" ? null : Number(v));
        }}
        placeholder="∞"
        className="w-24 shrink-0 rounded-xl border border-neutral-200 bg-paper px-3 py-2 text-right text-sm outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
      />
    </div>
  );
}

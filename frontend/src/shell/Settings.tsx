/**
 * Settings modal — opened from the ⚙ in the room rail header.
 *
 * The toggles are intentionally limited. Per `rule-guide.MD` §14 and
 * `citation-engine.MD` §10, the citation engine and rule middleware
 * are not user-disablable. Debug mode reveals more of the pipeline's
 * intermediate state without bypassing it.
 */
import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import type { Theme } from "../lib/theme";
import { TTS_VOICES } from "../lib/tts";
import {
  BellIcon,
  BellMuteIcon,
  FlameIcon,
  JumpIcon,
} from "../lib/Icons";
import {
  api,
  type ReadingPlanDayOut,
  type ReadingPlanSummary,
} from "../lib/api";
import { ProfileSection } from "./Profile";
import { BottomSheet } from "./BottomSheet";
import { GLASS_CARD_INLINE } from "../lib/glass";
import { ActionButton, Pill } from "./SettingsButtons";
import {
  getPushStatus,
  subscribeToPush,
  unsubscribeFromPush,
  type PushStatus,
} from "../lib/pushNotifications";

/** Just the fields the Profile/Admin section needs. Avoids forcing
 *  the caller to convert their `RoomItem[]` into a `RoomOut[]`. */
interface RoomForProfile {
  id: string;
  type: string;
  name: string | null;
  role?: "admin" | "member";
}

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (s: Settings) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  /** Called when the user deletes their account — App handles the
   *  full sign-out flow from there. */
  onDeleted: () => void;
  /** All rooms the user belongs to, with their role in each. Used to
   *  render the "Admin in N rooms" section. Empty / undefined hides it. */
  rooms?: RoomForProfile[];
  /** The currently active group room (or null for direct rooms /
   *  not-yet-persisted local rooms). Drives the "This room" section
   *  with Share + Admin shortcuts. `role` is the caller's authoritative
   *  role and supersedes the `rooms` array if both are present —
   *  rooms may not have loaded yet when the sheet opens. */
  activeRoom?: {
    id: string;
    name: string;
    role?: "admin" | "member";
    type?: string;
  } | null;
  /** Open the share-link modal for the active room. */
  onShareRoom?: () => void;
  /** Switch to a room and open its admin panel. Called from the
   *  Admin section + the "This room" shortcut. */
  onOpenRoomAdmin?: (roomId: string) => void;
  /** Bubbles every refresh of /auth/me so the shell can update its
   *  header avatar in real time after a photo upload. */
  onProfile?: (p: { avatar_url?: string | null; display_name?: string }) => void;
  /** Skip the root list and open straight into this page. The back
   *  chevron closes the sheet rather than navigating to a root the
   *  caller didn't want shown. */
  initialPage?: SettingsPage;
}

type SettingsPage =
  | null
  | "profile"
  | "this-room"
  | "general"
  | "notes-reading"
  | "notifications"
  | "advanced"
  | "admin-other";

/** When the sheet opens straight into a detail page (e.g. the avatar
 *  taps right into Profile), the back chevron should close instead of
 *  going to a root list the user never asked to see. */
export interface SettingsModalAPI {
  /** When set, opens the sheet directly to this page and the back
   *  button closes the sheet (instead of bouncing to the root list). */
  initialPage?: SettingsPage;
}

export function SettingsModal({
  open,
  onClose,
  settings,
  onChange,
  theme,
  onToggleTheme,
  onSignOut,
  onDeleted,
  rooms,
  activeRoom,
  onShareRoom,
  onOpenRoomAdmin,
  onProfile,
  initialPage,
}: Props) {
  const adminRooms = (rooms || []).filter(
    (r) => r.role === "admin" && r.type === "group",
  );
  // Authoritative: trust the role baked into `activeRoom` when present
  // (the caller knows it without needing the /rooms list to settle).
  // Otherwise fall back to scanning the rooms array.
  const isAdminHere =
    activeRoom?.role === "admin" ||
    (activeRoom !== null &&
      activeRoom !== undefined &&
      adminRooms.some((r) => r.id === activeRoom.id));
  const otherAdminRooms = adminRooms.filter(
    (r) => !activeRoom || r.id !== activeRoom.id,
  );

  const [page, setPage] = useState<SettingsPage>(initialPage ?? null);
  // Re-apply the initial page on every open so the avatar tap always
  // lands on Profile (even after the user previously navigated away).
  useEffect(() => {
    if (open) setPage(initialPage ?? null);
  }, [open, initialPage]);

  // Catalog of routable detail pages, in the order they appear on root.
  // Reorganized from 10 pages to 6 by merging related concerns:
  //   - "notes" (group-notes social toggle), "all-notes" (cross-room
  //     browser), and "plans" (reading plans) collapsed into a single
  //     "notes-reading" page since they're all about written content
  //     + study habits.
  //   - "account" (just a Sign out button) folded into "profile" at the
  //     bottom — they belong to the same identity stack.
  const PAGE_TITLES: Record<Exclude<SettingsPage, null>, string> = {
    "profile": "Profile",
    "this-room": "This room",
    "general": "General",
    "notes-reading": "Notes & Reading",
    "notifications": "Notifications",
    "advanced": "Advanced",
    "admin-other": `Admin in ${otherAdminRooms.length} other room${otherAdminRooms.length === 1 ? "" : "s"}`,
  };
  const title = page ? PAGE_TITLES[page] : "Settings";

  return (
    <BottomSheet open={open} onClose={onClose} title={title} fullPage>
      <div className="px-4 py-3">
        {page !== null && (
          <button
            type="button"
            onClick={() => {
              if (initialPage) onClose();
              else setPage(null);
            }}
            className="-ml-2 mb-3 inline-flex items-center gap-1 rounded-full px-3 py-2 text-[15px] font-semibold text-amber-700 transition active:scale-[0.97] hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-900/30"
          >
            <span
              aria-hidden
              className="text-[22px] leading-none"
              style={{ marginTop: "-2px" }}
            >
              ‹
            </span>
            {initialPage ? "Close" : "Settings"}
          </button>
        )}
        {page === null && (
          <ul className="space-y-1.5">
            {activeRoom && (
              <PageRow
                label="This room"
                hint={activeRoom.name || "(unnamed room)"}
                onClick={() => setPage("this-room")}
              />
            )}
            {activeRoom && isAdminHere && onOpenRoomAdmin && (
              <PageRow
                label="Group admin"
                hint="Photo, members, and agent settings"
                onClick={() => {
                  onClose();
                  onOpenRoomAdmin(activeRoom.id);
                }}
              />
            )}
            <PageRow
              label="General"
              hint={`Theme · ${theme === "dark" ? "Dark" : "Light"}`}
              onClick={() => setPage("general")}
            />
            <PageRow
              label="Notes & Reading"
              hint="Group-note social · All my notes · Reading plans"
              onClick={() => setPage("notes-reading")}
            />
            <PageRow
              label="Notifications"
              hint="Push chat + group notes to this device"
              onClick={() => setPage("notifications")}
            />
            <PageRow
              label="Advanced"
              hint="Debug + engine bypass + audit"
              onClick={() => setPage("advanced")}
            />
            {otherAdminRooms.length > 0 && (
              <PageRow
                label={`Admin in ${otherAdminRooms.length} other room${otherAdminRooms.length === 1 ? "" : "s"}`}
                hint="Members + agent settings"
                onClick={() => setPage("admin-other")}
              />
            )}
          </ul>
        )}
        {page !== null && (
          <div>
          {/* ── Identity ─────────────────────────────────────────────
              Display name, avatar, language preferences, plus the
              account-level controls (password, backup codes, phone,
              delete). */}
          {page === "profile" && (
            <>
              <ProfileSection
                onProfile={onProfile}
                onDeleted={() => {
                  onClose();
                  onDeleted();
                }}
              />
              {/* Sign-out used to be its own "Account" page — folded
               *  here so the identity stack lives in one place. */}
              <Section title="Account">
                <div className="flex flex-col gap-3 px-1 py-2">
                  <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
                    Signing out clears your local session. Notes you wrote
                    stay safe on the server.
                  </p>
                  <ActionButton
                    variant="destructive"
                    fullWidth
                    onClick={() => {
                      onClose();
                      onSignOut();
                    }}
                  >
                    Sign out
                  </ActionButton>
                </div>
              </Section>
            </>
          )}

          {/* ── This room (Share + Admin) ────────────────────────────
              Only when a group room is active. Skips for direct rooms
              (no admin concept) and local-only rooms. */}
          {page === "this-room" && activeRoom && (
            <Section title="This room">
              <div className="space-y-1.5 p-1">
                <p className="px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {activeRoom.name || "(unnamed room)"}
                </p>
                {onShareRoom && (
                  <button
                    onClick={() => {
                      onClose();
                      onShareRoom();
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:ring-1 hover:ring-neutral-400/40 dark:hover:ring-neutral-500/40 ${GLASS_CARD_INLINE}`}
                  >
                    <span className="text-neutral-500 dark:text-neutral-400" aria-hidden>
                      <JumpIcon className="h-4 w-4" />
                    </span>
                    <span className="flex-1">Share room link</span>
                    <span className="text-neutral-400" aria-hidden>
                      ›
                    </span>
                  </button>
                )}
                {isAdminHere && onOpenRoomAdmin && (
                  <button
                    onClick={() => {
                      onClose();
                      onOpenRoomAdmin(activeRoom.id);
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:ring-1 hover:ring-neutral-400/40 dark:hover:ring-neutral-500/40 ${GLASS_CARD_INLINE}`}
                  >
                    <span className="text-neutral-500 dark:text-neutral-400" aria-hidden>
                      ⚙
                    </span>
                    <span className="flex-1">Members + agent settings</span>
                    <span className="rounded-full bg-amber-200/70 px-1.5 text-[9px] font-semibold uppercase text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
                      admin
                    </span>
                    <span className="text-neutral-400" aria-hidden>
                      ›
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const cur = settings.mutedRoomIds;
                    const next = cur.includes(activeRoom.id)
                      ? cur.filter((x) => x !== activeRoom.id)
                      : [...cur, activeRoom.id];
                    onChange({ ...settings, mutedRoomIds: next });
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:ring-1 hover:ring-neutral-400/40 dark:hover:ring-neutral-500/40 ${GLASS_CARD_INLINE}`}
                >
                  <span className="text-neutral-500 dark:text-neutral-400" aria-hidden>
                    {settings.mutedRoomIds.includes(activeRoom.id) ? (
                      <BellMuteIcon className="h-4 w-4" />
                    ) : (
                      <BellIcon className="h-4 w-4" />
                    )}
                  </span>
                  <span className="flex-1">
                    {settings.mutedRoomIds.includes(activeRoom.id)
                      ? "Notifications muted"
                      : "Mute notifications"}
                  </span>
                  <span className="text-neutral-400" aria-hidden>
                    ›
                  </span>
                </button>
                {activeRoom.type === "group" && (
                  <button
                    onClick={async () => {
                      const confirmText = isAdminHere
                        ? "You're an admin here. Promote another admin first or you'll be blocked."
                        : "Leave this group? You can rejoin later from an invite link.";
                      if (!confirm(confirmText)) return;
                      try {
                        await api.leaveRoom(activeRoom.id);
                        onClose();
                        // Caller pages re-fetch rooms on next mount; the
                        // user sees the room drop out of the rail.
                      } catch (e) {
                        alert(`Couldn't leave: ${(e as Error).message}`);
                      }
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-red-700 transition hover:ring-1 hover:ring-red-400/40 dark:text-red-300 dark:hover:ring-red-500/40 ${GLASS_CARD_INLINE}`}
                  >
                    <span className="text-red-600 dark:text-red-300" aria-hidden>
                      ⎋
                    </span>
                    <span className="flex-1">Leave group</span>
                    <span className="text-red-400" aria-hidden>
                      ›
                    </span>
                  </button>
                )}
                {activeRoom.type === "group" && isAdminHere && (
                  <button
                    onClick={async () => {
                      if (
                        !confirm(
                          `Permanently delete "${activeRoom.name || "this group"}"? ` +
                            "Members lose access, and every chat message + note " +
                            "in this room is removed. This can't be undone.",
                        )
                      )
                        return;
                      try {
                        await api.deleteRoom(activeRoom.id);
                        onClose();
                      } catch (e) {
                        alert(`Couldn't delete: ${(e as Error).message}`);
                      }
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-red-800 transition hover:ring-1 hover:ring-red-500/50 dark:text-red-300 dark:hover:ring-red-500/40 ${GLASS_CARD_INLINE}`}
                  >
                    <span className="text-red-700 dark:text-red-300" aria-hidden>
                      🗑
                    </span>
                    <span className="flex-1 font-semibold">Delete group</span>
                    <span className="rounded-full bg-red-100 px-1.5 text-[9px] font-semibold uppercase text-red-700 dark:bg-red-900/40 dark:text-red-200">
                      admin
                    </span>
                    <span className="text-red-400" aria-hidden>
                      ›
                    </span>
                  </button>
                )}
              </div>
            </Section>
          )}

          {/* ── Settings ─────────────────────────────────────────────
              Personal app preferences. Theme, timezone. */}
          {page === "general" && (
          <Section title="General">
            <Row>
              <span>Theme</span>
              <Pill onClick={onToggleTheme}>
                {theme === "dark" ? "☼ Light" : "☾ Dark"}
              </Pill>
            </Row>
            <Row>
              <div className="flex-1">
                <div>Time zone</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Used for bookmark timestamps and other absolute times.
                </div>
              </div>
              <select
                value={settings.timezone}
                onChange={(e) =>
                  onChange({ ...settings, timezone: e.target.value })
                }
                aria-label="Time zone"
                className="ml-3 max-w-[50%] rounded-xl border border-neutral-200 bg-paper px-2.5 py-2 text-[12px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
              >
                <option value="">Auto ({autoTz()})</option>
                <option value="UTC">UTC</option>
                <option value="America/New_York">US Eastern</option>
                <option value="America/Chicago">US Central</option>
                <option value="America/Denver">US Mountain</option>
                <option value="America/Los_Angeles">US Pacific</option>
                <option value="America/Anchorage">Alaska</option>
                <option value="Pacific/Honolulu">Hawaii</option>
                <option value="America/Sao_Paulo">São Paulo</option>
                <option value="Europe/London">London</option>
                <option value="Europe/Paris">Paris / Berlin / Rome</option>
                <option value="Europe/Moscow">Moscow</option>
                <option value="Asia/Dubai">Dubai</option>
                <option value="Asia/Kolkata">India</option>
                <option value="Asia/Singapore">Singapore</option>
                <option value="Asia/Tokyo">Tokyo</option>
                <option value="Australia/Sydney">Sydney</option>
              </select>
            </Row>
            <Row>
              <div className="flex-1">
                <div>Default translation</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  The Bible reader opens with this translation. Until
                  more public-domain texts ship, the only options are
                  KJV and WEB.
                </div>
              </div>
              <select
                value={settings.defaultTranslation}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    defaultTranslation: e.target.value,
                  })
                }
                aria-label="Default translation"
                className="ml-3 max-w-[50%] rounded-xl border border-neutral-200 bg-paper px-2.5 py-2 text-[12px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
              >
                <optgroup label="Modern English">
                  <option value="Berean Standard Bible">BSB (modern, free)</option>
                  <option value="World English Bible">WEB (modern, public domain)</option>
                  <option value="New English Translation">NET (scholarly, free)</option>
                </optgroup>
                <optgroup label="Classic English">
                  <option value="King James Version">KJV (1611)</option>
                  <option value="Geneva Bible (1599)">Geneva (1599)</option>
                  <option value="Douay-Rheims Bible">Douay-Rheims (Catholic)</option>
                </optgroup>
                <optgroup label="Literal / Study">
                  <option value="Young's Literal Translation">YLT (literal, 1898)</option>
                </optgroup>
              </select>
            </Row>
            <Row>
              <div className="flex-1">
                <div>Voice</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Used by the Bible reader and the "Read aloud" button on
                  agent answers. Female and male options from Deepgram Aura.
                </div>
              </div>
              <select
                value={settings.ttsVoice}
                onChange={(e) => {
                  onChange({ ...settings, ttsVoice: e.target.value });
                  void import("../lib/tts").then((m) => {
                    m.speak(
                      "This is the voice that will read scripture and agent answers.",
                      { voice: e.target.value, language: "en-US" },
                    );
                  });
                }}
                className="ml-3 rounded-md border border-neutral-300 bg-paper px-2 py-1 text-[12px] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              >
                <optgroup label="Female">
                  {TTS_VOICES.filter((v) => v.gender === "F").map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Male">
                  {TTS_VOICES.filter((v) => v.gender === "M").map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Row>
            <Row>
              <div className="flex-1">
                <div>Read agent answers aloud</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Speaks each agent response automatically with the same
                  natural voice as the Bible reader.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.autoSpeakAgentAnswers}
                onChange={(e) => {
                  if (e.target.checked) {
                    void import("../lib/tts").then((m) => m.armAudioSession());
                  }
                  onChange({
                    ...settings,
                    autoSpeakAgentAnswers: e.target.checked,
                  });
                }}
                className="ml-3 h-4 w-4 accent-amber-600"
              />
            </Row>
            <Row>
              <div className="flex-1">
                <div>Default note scope</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Which side of Notes opens by default. Personal stays
                  private to you; Group is shared with the room.
                </div>
              </div>
              <div
                className="ml-3 flex rounded-2xl border border-neutral-200 bg-neutral-100/60 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-700 dark:bg-neutral-800/60 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                role="radiogroup"
                aria-label="Default note scope"
              >
                {(["personal", "group"] as const).map((s) => {
                  const picked = settings.defaultNoteScope === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      onClick={() =>
                        onChange({ ...settings, defaultNoteScope: s })
                      }
                      className={`rounded-xl px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
                        picked
                          ? "bg-paper text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-neutral-900 dark:text-neutral-50"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </Row>
          </Section>
          )}

          {page === "advanced" && (<>
          <Section title="Debug">
            <Row>
              <div className="flex-1">
                <div>Debug mode</div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Show raw chain-of-thought, stage timings, retrieved
                  sources, and dropped claims in the Reasoning panel.
                  The citation engine still runs.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.debugMode}
                onChange={(e) =>
                  onChange({ ...settings, debugMode: e.target.checked })
                }
                className="ml-3 h-4 w-4"
              />
            </Row>
          </Section>

          {/* Advanced toggles live on the same page as Debug. */}
          <Section title="Advanced">
            <Row>
              <div className="flex-1">
                <div className="flex items-center gap-1">
                  <span>Disable citation engine</span>
                  <span className="rounded bg-amber-100 px-1 text-[9px] font-bold uppercase text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
                    raw
                  </span>
                </div>
                <div className="text-[11px] text-neutral-600 dark:text-neutral-300">
                  Overrides citation-engine.MD §10. The agent's reply
                  skips claim parsing, verification, and citation
                  gating — you'll get raw LLM prose with no source pills.
                  The rule layer (rule-guide.MD) still runs, so the
                  other safety predicates (chat scope, notes privacy,
                  language, etc.) remain enforced.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.bypassCitationEngine}
                onChange={(e) => {
                  const enabling = e.target.checked;
                  if (
                    enabling &&
                    !confirm(
                      "Disable the citation engine?\n\nThe agent will return raw LLM prose without verified scripture citations. The rule layer (rule-guide.MD) still enforces the other safety predicates.\n\nContinue?",
                    )
                  ) {
                    return;
                  }
                  onChange({ ...settings, bypassCitationEngine: enabling });
                }}
                className="ml-3 h-4 w-4 accent-amber-600"
              />
            </Row>
            <Row>
              <div className="flex-1">
                <div className="flex items-center gap-1">
                  <span>Bypass agent gate</span>
                  <span className="rounded bg-amber-100 px-1 text-[9px] font-bold uppercase text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
                    dev
                  </span>
                </div>
                <div className="text-[11px] text-neutral-600 dark:text-neutral-300">
                  Overrides the room admin&apos;s agent_enabled toggle for your
                  account only. Lets you use the agent even when it&apos;s
                  turned off for the room.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.bypassAgentGate}
                onChange={(e) =>
                  onChange({ ...settings, bypassAgentGate: e.target.checked })
                }
                className="ml-3 h-4 w-4 accent-amber-600"
              />
            </Row>
          </Section>
          </>)}

          {/* ── Notes & Reading (consolidated from 3 old pages) ─────
              Group-note social toggle, default scope, the cross-room
              All-my-notes browser, reading-plan enrollment, and the
              "Today's reading" banner + daily reminder all live here
              now so written content + study habits share a page. */}
          {page === "notes-reading" && (
          <>
            <Section title="Social">
              <Row>
                <div className="flex-1">
                  <div className="text-sm">Social on group notes</div>
                  <div className="text-[11px] text-neutral-600 dark:text-neutral-300">
                    Adds a heart and a comment thread under each group
                    note. Personal notes and agent-authored notes are
                    never affected — they stay private to you and quiet.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.socialNotesEnabled}
                  onChange={(e) =>
                    onChange({ ...settings, socialNotesEnabled: e.target.checked })
                  }
                  className="ml-3 h-4 w-4 accent-amber-600"
                />
              </Row>
            </Section>
            <Section title="All my notes">
              <AllNotesSection />
            </Section>
            <Section title="Reading plans">
              <div className="p-1">
                <ReadingPlansSection />
              </div>
            </Section>
          </>
          )}

          {/* ── Admin in other rooms ─────────────────────────────────
              Only lists rooms where the user is admin AND that aren't
              the active one (the active room already appears under
              "This room" above). */}
          {page === "admin-other" && otherAdminRooms.length > 0 && (
              <Section title={`Admin in ${otherAdminRooms.length} other room${otherAdminRooms.length === 1 ? "" : "s"}`}>
                <div className="space-y-1.5 p-1">
                  {otherAdminRooms.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        onClose();
                        onOpenRoomAdmin?.(r.id);
                      }}
                      className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:ring-1 hover:ring-neutral-400/40 dark:hover:ring-neutral-500/40 ${GLASS_CARD_INLINE}`}
                    >
                      <span className="flex-1 truncate">
                        {r.name || "(unnamed room)"}
                      </span>
                      <span className="rounded-full bg-amber-200/70 px-1.5 text-[9px] font-semibold uppercase text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
                        admin
                      </span>
                      <span className="text-neutral-400" aria-hidden>
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
          )}

          {page === "notifications" && (
            <>
              <NotificationsSection />
              <QuietHoursSection
                settings={settings}
                onChange={onChange}
              />
              <Section title="Daily reading reminder">
                <Row>
                  <div className="flex-1">
                    <div>Show "Today's reading" banner</div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      Pinned to the top of the Bible scroller while you're
                      enrolled in a reading plan.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.todaysReadingBanner}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        todaysReadingBanner: e.target.checked,
                      })
                    }
                    className="ml-3 h-4 w-4 accent-amber-600"
                  />
                </Row>
                <Row>
                  <div className="flex-1">
                    <div>Reminder time</div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      Push notification arrives at this hour in your local
                      timezone, only on days the reading isn't already done.
                    </div>
                  </div>
                  <select
                    value={settings.readingReminderHour}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        readingReminderHour: Number(e.target.value),
                      })
                    }
                    aria-label="Daily reminder hour"
                    className="ml-3 rounded-xl border border-neutral-200 bg-paper px-2.5 py-2 text-[12px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
                  >
                    {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                      <option key={h} value={h}>
                        {h === 0
                          ? "12 AM"
                          : h < 12
                            ? `${h} AM`
                            : h === 12
                              ? "12 PM"
                              : `${h - 12} PM`}
                      </option>
                    ))}
                  </select>
                </Row>
              </Section>
            </>
          )}

          {page === "advanced" && (
            <>
              <p className="mt-4 text-[10px] text-neutral-400 dark:text-neutral-500">
                Debug mode reveals the citation pipeline's intermediate state
                without changing the output. "Disable citation engine" skips
                claim parsing + verification only; the rule layer
                (rule-guide.MD) is non-bypassable and always runs.
              </p>
              {settings.debugMode && (
                <Section title="Audit log (last 50 claims)">
                  <ProvenanceViewer />
                </Section>
              )}
              <Section title="Voice reader diagnostic">
                <VoiceDiagPanel />
              </Section>
            </>
          )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}

function PageRow({
  label,
  hint,
  onClick,
  destructive,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-paper px-3 py-3 text-left transition hover:bg-paper-soft dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800 ${
          destructive ? "text-red-700 dark:text-red-300" : ""
        }`}
      >
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[15px] font-medium">{label}</span>
          {hint && (
            <span className="block truncate text-[12px] text-neutral-500 dark:text-neutral-400">
              {hint}
            </span>
          )}
        </span>
        <span className="text-neutral-400" aria-hidden>›</span>
      </button>
    </li>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      <div className="glass-specular overflow-hidden rounded-[18px] border border-white/40 bg-paper/55 shadow-[0_4px_14px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_0_rgba(0,0,0,0.05)] backdrop-blur-2xl backdrop-saturate-[1.8] dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_4px_14px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.10),inset_0_-1px_0_rgba(0,0,0,0.20)]">
        {children}
      </div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-3 py-2 text-sm last:border-b-0 dark:border-neutral-800">
      {children}
    </div>
  );
}

/** Lightweight viewer over the agent's Provenance ledger. Each row
 *  is one verified/inferred/dropped claim with its source
 *  citations, verification verdict, and timestamp. Sourced from
 *  GET /admin/provenance — the same gate as every other endpoint
 *  (deployment password + signed-in session). Surfaced in Settings
 *  → Advanced when debug mode is on so non-debug users aren't
 *  flooded with engine internals. */
function ProvenanceViewer() {
  const [rows, setRows] = useState<
    import("../lib/api").ProvenanceRow[] | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .provenanceList(50)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (err) {
    return (
      <p className="px-1 py-2 text-[12px] text-red-700 dark:text-red-300">
        Couldn't load audit log: {err}
      </p>
    );
  }
  if (rows === null) {
    return (
      <p className="px-1 py-2 text-[12px] text-neutral-500 dark:text-neutral-400">
        Loading…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] text-neutral-500 dark:text-neutral-400">
        No reasoning turns logged yet.
      </p>
    );
  }
  return (
    <div className="max-h-[60vh] space-y-1.5 overflow-y-auto p-1 font-mono text-[11px]">
      {rows.map((r) => {
        const verdictColor =
          r.verification_result === "supported"
            ? "text-emerald-700 dark:text-emerald-300"
            : r.verification_result === "dropped"
              ? "text-red-700 dark:text-red-300"
              : "text-amber-700 dark:text-amber-300";
        return (
          <div
            key={r.id}
            className="rounded-xl border border-neutral-200 bg-paper px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="flex items-center gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
              <span className={`font-semibold ${verdictColor}`}>
                {r.verification_result}
              </span>
              <span>· {r.kind}</span>
              {r.tradition && <span>· {r.tradition}</span>}
              <span className="ml-auto">
                {r.created_at
                  ? new Date(r.created_at).toLocaleString()
                  : ""}
              </span>
            </div>
            {r.verse_refs.length > 0 && (
              <div className="mt-0.5 text-neutral-700 dark:text-neutral-200">
                refs: {r.verse_refs.join(", ")}
              </div>
            )}
            {r.source_refs.length > 0 && (
              <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">
                sources: {r.source_refs.join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Cross-room note review page. Lists every note the caller can see
 *  (personal: own only; group: every room they're a member of) with
 *  a search bar that calls the dedicated server-side notes-search
 *  endpoint when typed in. Tap a row → opens the room rail to that
 *  room (the caller can then navigate to the note inside).
 *  Privacy: gated at the data layer by `/notes/all` and
 *  `/notes/search` (rule-guide §12.1). */
function AllNotesSection() {
  const [hits, setHits] = useState<
    import("../lib/api").NoteSearchHit[] | null
  >(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"personal" | "group" | "both">("both");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    setLoading(true);
    setErr(null);
    const scopeArg = scope === "both" ? undefined : scope;
    const promise =
      q.length >= 2
        ? api.notesSearch(q, { scope: scopeArg, limit: 100 })
        : api.notesAll({ scope: scopeArg, limit: 200 });
    const timer = window.setTimeout(() => {
      promise
        .then((rows) => alive && setHits(rows))
        .catch((e) => alive && setErr((e as Error).message))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, scope]);

  return (
    <Section title="Your notes across rooms">
      <div className="space-y-2 p-1">
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your notes…"
            aria-label="Search your notes"
            className="w-full rounded-full border border-neutral-200 bg-paper px-3 py-2 pl-8 text-[14px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          />
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400"
            aria-hidden
          >
            ⌕
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {(["both", "personal", "group"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize transition ${
                scope === s
                  ? "bg-neutral-900 text-white dark:bg-neutral-50 dark:text-neutral-900"
                  : "border border-neutral-200 bg-paper text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {err && (
          <p className="text-[12px] text-red-700 dark:text-red-300">{err}</p>
        )}
        {loading && hits === null && (
          <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
            Loading…
          </p>
        )}
        {hits && hits.length === 0 && (
          <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
            {query.trim().length >= 2
              ? `No notes match "${query.trim()}".`
              : "No notes yet."}
          </p>
        )}
        {hits && hits.length > 0 && (
          <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {hits.map((h) => (
              <li
                key={h.note_id}
                className={`rounded-xl border border-neutral-200 bg-paper px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900`}
              >
                <div className="flex items-center gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-semibold uppercase tracking-wide ${
                      h.scope === "personal"
                        ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                        : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    }`}
                  >
                    {h.scope}
                  </span>
                  {h.by_agent && (
                    <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-700/70 dark:text-neutral-200">
                      agent
                    </span>
                  )}
                  {h.room_name && <span>· {h.room_name}</span>}
                  {h.verse_anchors.length > 0 && (
                    <span>· {h.verse_anchors[0]}</span>
                  )}
                  <span className="ml-auto">
                    {h.updated_at
                      ? new Date(h.updated_at).toLocaleDateString()
                      : ""}
                  </span>
                </div>
                <div className="mt-1 text-[13px] text-neutral-800 dark:text-neutral-100">
                  {h.body || (
                    <span className="italic text-neutral-400">(empty)</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

/** Do-not-disturb window control. Backend `_is_quiet_hours_for` in
 *  `backend/api/push.py` reads these three preferences and skips
 *  push fan-out for the recipient when the window is open. Same
 *  setting controls reading-plan reminders since they go through
 *  the same fan-out path. */
function QuietHoursSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const hourOpts = Array.from({ length: 24 }, (_, h) => h);
  const fmt = (h: number) =>
    h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
  return (
    <Section title="Quiet hours">
      <Row>
        <div className="flex-1">
          <div>Silence push during a window</div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            Skips push notifications between the two times below in your
            local timezone. Messages still arrive — your phone just
            doesn't buzz.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.quietHoursEnabled}
          onChange={(e) =>
            onChange({ ...settings, quietHoursEnabled: e.target.checked })
          }
          className="ml-3 h-4 w-4 accent-amber-600"
        />
      </Row>
      {settings.quietHoursEnabled && (
        <Row>
          <div className="flex-1">From</div>
          <select
            value={settings.quietStartHour}
            onChange={(e) =>
              onChange({
                ...settings,
                quietStartHour: Number(e.target.value),
              })
            }
            aria-label="Quiet hours start"
            className="ml-3 rounded-xl border border-neutral-200 bg-paper px-2.5 py-2 text-[12px] outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {hourOpts.map((h) => (
              <option key={h} value={h}>
                {fmt(h)}
              </option>
            ))}
          </select>
          <span className="mx-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            to
          </span>
          <select
            value={settings.quietEndHour}
            onChange={(e) =>
              onChange({
                ...settings,
                quietEndHour: Number(e.target.value),
              })
            }
            aria-label="Quiet hours end"
            className="rounded-xl border border-neutral-200 bg-paper px-2.5 py-2 text-[12px] outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {hourOpts.map((h) => (
              <option key={h} value={h}>
                {fmt(h)}
              </option>
            ))}
          </select>
        </Row>
      )}
    </Section>
  );
}

function NotificationsSection() {
  const [status, setStatus] = useState<PushStatus | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  async function refresh() {
    setStatus(await getPushStatus());
  }

  async function turnOn() {
    setBusy(true);
    setErr(null);
    try {
      const s = await subscribeToPush();
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const isStandalone =
    typeof window !== "undefined" &&
    ((window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true ||
      (typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)").matches
        : false));

  return (
    <Section title="Push to this device">
      <div className="space-y-2 px-3 py-2 text-sm">
        <p className="text-[12px] text-neutral-600 dark:text-neutral-300">
          Wake your phone for new chat messages and shared group notes.
          Personal notes stay private and never push.
        </p>
        {status === "loading" && (
          <p className="text-[12px] text-neutral-500">Checking…</p>
        )}
        {status === "unsupported" && (
          <p className="text-[12px] text-neutral-500">
            This browser can't receive push notifications.
          </p>
        )}
        {status === "needs-install" && (
          <p className="text-[12px] text-amber-700 dark:text-amber-300">
            iOS only delivers push when the app is installed to your
            Home Screen. Open Safari's Share sheet → "Add to Home
            Screen", then open Bible IU from the new icon and try
            again.
          </p>
        )}
        {status === "permission-denied" && (
          <p className="text-[12px] text-red-700 dark:text-red-300">
            Notifications are blocked in your browser settings. Allow
            them for this site, then come back.
          </p>
        )}
        {status === "not-subscribed" && (
          <ActionButton fullWidth onClick={() => void turnOn()} disabled={busy}>
            {busy ? "Turning on…" : "Turn on push notifications"}
          </ActionButton>
        )}
        {status === "subscribed" && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
              ✓ On — this device will receive push
            </span>
            <Pill onClick={() => void turnOff()} disabled={busy}>
              {busy ? "…" : "Turn off"}
            </Pill>
          </div>
        )}
        {err && (
          <p className="text-[11px] text-red-700 dark:text-red-300">{err}</p>
        )}
        {!isStandalone && status !== "unsupported" && (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
            Tip: install the app to your Home Screen for the best
            notification experience.
          </p>
        )}
      </div>
    </Section>
  );
}

function ReadingPlansSection() {
  const [plans, setPlans] = useState<ReadingPlanSummary[] | null>(null);
  const [today, setToday] = useState<Record<string, ReadingPlanDayOut>>({});
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const list = await api.readingPlansList();
      setPlans(list);
      // For every enrolled plan, pull today's reading so the card
      // shows the actual references inline.
      const enrolled = list.filter((p) => p.enrolled);
      const todays = await Promise.all(
        enrolled.map((p) =>
          api
            .readingPlanToday(p.id)
            .then((d) => [p.id, d] as const)
            .catch(() => null),
        ),
      );
      const next: Record<string, ReadingPlanDayOut> = {};
      for (const row of todays) {
        if (row) next[row[0]] = row[1];
      }
      setToday(next);
    } catch {
      // Surface nothing — section just stays empty.
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function toggleEnrollment(p: ReadingPlanSummary) {
    if (busy) return;
    setBusy(true);
    try {
      if (p.enrolled) {
        await api.readingPlanLeave(p.id);
      } else {
        await api.readingPlanEnroll(p.id);
      }
      await reload();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function markToday(plan_id: string, day_index: number) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.readingPlanComplete(plan_id, day_index);
      setToday((t) => ({ ...t, [plan_id]: updated }));
      await reload();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  if (plans === null) {
    return (
      <p className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        Loading plans…
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        Pick a plan to follow. Today&apos;s reading appears on the card
        once you&apos;re enrolled; tap Done to log progress.
      </p>
      {plans.map((p) => {
        const day = today[p.id];
        return (
          <div
            key={p.id}
            className={`flex flex-col gap-1.5 p-2.5 text-sm ${GLASS_CARD_INLINE}`}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.enrolled && (
                    <span className="rounded-full bg-emerald-200/70 px-1.5 text-[9px] font-semibold uppercase text-emerald-900 dark:bg-emerald-500/30 dark:text-emerald-100">
                      enrolled
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {p.summary} ({p.length_days} days)
                </p>
                {p.enrolled && (
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-300">
                    <span>
                      Day {p.current_day} of {p.length_days} ·{" "}
                      {p.completed_days} done
                    </span>
                    {p.streak_days > 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"
                        title={`${p.streak_days}-day streak`}
                      >
                        <FlameIcon className="h-3 w-3" filled />
                        {p.streak_days}-day streak
                      </span>
                    )}
                  </p>
                )}
              </div>
              <Pill
                variant={p.enrolled ? "default" : "primary"}
                onClick={() => toggleEnrollment(p)}
                disabled={busy}
                className="shrink-0"
              >
                {p.enrolled ? "Leave" : "Join"}
              </Pill>
            </div>
            {p.enrolled && day && (
              <div
                className={`flex items-center gap-2 rounded-[14px] px-2.5 py-1.5 text-[12px] ${
                  day.completed
                    ? "bg-emerald-100/70 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-100"
                    : "bg-neutral-100/70 text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200"
                }`}
              >
                <span className="flex-1 truncate">
                  <span className="font-semibold">Day {day.day_index}:</span>{" "}
                  {day.refs.join(" · ")}
                </span>
                {day.completed ? (
                  <span className="text-[11px] font-semibold uppercase">✓ done</span>
                ) : (
                  <Pill
                    variant="primary"
                    onClick={() => markToday(p.id, day.day_index)}
                    disabled={busy}
                  >
                    Done
                  </Pill>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function autoTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "system";
  }
}


/** Voice-reader diagnostic. Subscribes to the global `tts:diag` event
 *  stream + `voice:session-start` so we can read off exactly where a
 *  read session began, the verse it's currently on (or stopped at),
 *  and the last 18 `[tts]` events. Lets us debug stalls without
 *  opening Safari Web Inspector. Lives in Settings → Advanced
 *  because it's a debug surface, not a primary UI affordance. */
function VoiceDiagPanel() {
  const [startVerseId, setStartVerseId] = useState<string | null>(null);
  const [currentVerseId, setCurrentVerseId] = useState<string | null>(null);
  const [log, setLog] = useState<
    Array<{ stage: string; detail: string; at: number }>
  >([]);

  useEffect(() => {
    const onDiag = (e: Event) => {
      const ce = e as CustomEvent<{
        stage: string;
        detail?: unknown;
        at: number;
      }>;
      const stage = ce.detail?.stage ?? "?";
      let detail = "";
      const d = ce.detail?.detail;
      if (typeof d === "string") detail = d;
      else if (d != null) {
        try {
          detail = JSON.stringify(d);
        } catch {
          detail = String(d);
        }
      }
      setLog((prev) => {
        const next = [
          ...prev,
          { stage, detail, at: ce.detail?.at ?? Date.now() },
        ];
        return next.length > 18 ? next.slice(next.length - 18) : next;
      });
      // Track "current verse" off the speak-at events — that's the
      // verse the reader is announcing right now.
      if (stage === "speak-at" && typeof detail === "string") {
        // detail shape: "14: PSA.10.15" — pull the verse id.
        const m = detail.match(/:\s*(\S+)/);
        if (m) setCurrentVerseId(m[1]);
      }
    };
    const onStart = (e: Event) => {
      const ce = e as CustomEvent<{ startVerseId: string | null }>;
      setStartVerseId(ce.detail?.startVerseId ?? null);
      setCurrentVerseId(null);
      setLog([]);
    };
    window.addEventListener("tts:diag", onDiag);
    window.addEventListener("voice:session-start", onStart);
    return () => {
      window.removeEventListener("tts:diag", onDiag);
      window.removeEventListener("voice:session-start", onStart);
    };
  }, []);

  // Idle state: nothing to show yet.
  if (!startVerseId && !currentVerseId && log.length === 0) {
    return (
      <Row>
        <div className="flex-1">
          <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
            Start the voice reader from the Bible page; events will show
            up here in real time.
          </div>
        </div>
      </Row>
    );
  }

  const copyAll = () => {
    try {
      const text = [
        `start: ${startVerseId ?? "—"}`,
        `current: ${currentVerseId ?? "—"}`,
        "---",
        ...log.map(
          (e) =>
            `${new Date(e.at).toISOString().slice(11, 23)} ${e.stage} ${e.detail}`,
        ),
      ].join("\n");
      navigator.clipboard?.writeText(text);
    } catch {
      // best-effort
    }
  };

  return (
    <>
      <Row>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-neutral-700 dark:text-neutral-200">
              {startVerseId ?? "—"} → {currentVerseId ?? "—"}
            </span>
            <button
              type="button"
              onClick={copyAll}
              className="ml-auto rounded-full bg-amber-500 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-sm hover:bg-amber-600"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                setStartVerseId(null);
                setCurrentVerseId(null);
                setLog([]);
              }}
              className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Clear
            </button>
          </div>
          {log.length > 0 && (
            <ul className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-neutral-200 bg-paper-soft px-2 py-1.5 font-mono text-[10px] leading-tight dark:border-neutral-800 dark:bg-neutral-950">
              {log.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 opacity-70">
                    {new Date(e.at).toISOString().slice(14, 23)}
                  </span>
                  <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">
                    {e.stage}
                  </span>
                  <span className="truncate text-neutral-700 dark:text-neutral-300">
                    {e.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Row>
    </>
  );
}

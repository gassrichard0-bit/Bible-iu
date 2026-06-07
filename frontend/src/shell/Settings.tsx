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
  activeRoom?: { id: string; name: string; role?: "admin" | "member" } | null;
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
  | "notes"
  | "plans"
  | "notifications"
  | "advanced"
  | "admin-other"
  | "account";

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
  const PAGE_TITLES: Record<Exclude<SettingsPage, null>, string> = {
    "profile": "Profile",
    "this-room": "This room",
    "general": "General",
    "notes": "Group notes",
    "plans": "Reading plans",
    "notifications": "Notifications",
    "advanced": "Advanced",
    "admin-other": `Admin in ${otherAdminRooms.length} other room${otherAdminRooms.length === 1 ? "" : "s"}`,
    "account": "Account",
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
            className="-ml-1 mb-3 inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-neutral-600 hover:bg-paper-soft dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <span aria-hidden>‹</span> {initialPage ? "Close" : "Settings"}
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
                label="Group photo"
                hint="Change or remove the group's image"
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
              label="Group notes"
              hint={settings.socialNotesEnabled ? "Social: on" : "Social: off"}
              onClick={() => setPage("notes")}
            />
            <PageRow
              label="Reading plans"
              hint="Enroll, today's reading"
              onClick={() => setPage("plans")}
            />
            <PageRow
              label="Notifications"
              hint="Push chat + group notes to this device"
              onClick={() => setPage("notifications")}
            />
            <PageRow
              label="Advanced"
              hint="Debug + engine bypass"
              onClick={() => setPage("advanced")}
            />
            {otherAdminRooms.length > 0 && (
              <PageRow
                label={`Admin in ${otherAdminRooms.length} other room${otherAdminRooms.length === 1 ? "" : "s"}`}
                hint="Members + agent settings"
                onClick={() => setPage("admin-other")}
              />
            )}
            <PageRow
              label="Account"
              hint="Sign out"
              onClick={() => setPage("account")}
              destructive
            />
          </ul>
        )}
        {page !== null && (
          <div>
          {/* ── Identity ─────────────────────────────────────────────
              Display name, avatar, language preferences, plus the
              account-level controls (password, backup codes, phone,
              delete). */}
          {page === "profile" && (
            <ProfileSection
              onProfile={onProfile}
              onDeleted={() => {
                onClose();
                onDeleted();
              }}
            />
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
                      ↗
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

          {page === "notes" && (
          <>
            <Section title="Default scope">
              <div className="space-y-1.5 p-1">
                <p className="px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  Which side of Notes shows when you open the tab.
                  Personal notes stay private to you and never reach
                  the agent. Group notes are shared with the room.
                </p>
                <div
                  className="flex rounded-2xl border border-neutral-200 bg-neutral-100/60 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-neutral-700 dark:bg-neutral-800/60 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
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
                        className={`flex-1 rounded-xl px-3 py-2 text-[13px] font-semibold capitalize transition ${
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
              </div>
            </Section>
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

          {page === "plans" && (
          <>
            <Section title="Reading plans">
              <div className="p-1">
                <ReadingPlansSection />
              </div>
            </Section>
            <Section title="Banner">
              <Row>
                <div className="flex-1">
                  <div>Show "Today's reading" banner</div>
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Pinned to the top of the Bible scroller while you're
                    enrolled. Toggle off to read in peace.
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
            </Section>
          </>
          )}

          {page === "notifications" && <NotificationsSection />}

          {page === "account" && (
            <div className="flex flex-col gap-3 px-1 pt-2">
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
          )}

          {page === "advanced" && (
            <p className="mt-4 text-[10px] text-neutral-400 dark:text-neutral-500">
              Debug mode reveals the citation pipeline's intermediate state
              without changing the output. "Disable citation engine" skips
              claim parsing + verification only; the rule layer
              (rule-guide.MD) is non-bypassable and always runs.
            </p>
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
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-paper shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.04)]">
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
                  <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                    Day {p.current_day} of {p.length_days} · {p.completed_days}{" "}
                    done
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

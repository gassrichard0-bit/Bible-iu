/**
 * Settings modal — opened from the ⚙ in the room rail header.
 *
 * The toggles are intentionally limited. Per `rule-guide.MD` §14 and
 * `citation-engine.MD` §10, the citation engine and rule middleware
 * are not user-disablable. Debug mode reveals more of the pipeline's
 * intermediate state without bypassing it.
 */
import type { Settings } from "../lib/settings";
import type { Theme } from "../lib/theme";
import { ProfileSection } from "./Profile";
import { BottomSheet } from "./BottomSheet";

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
}: Props) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Settings">
      <div className="px-4 py-3">
          <ProfileSection
            onDeleted={() => {
              onClose();
              onDeleted();
            }}
          />

          <Section title="General">
            <Row>
              <span>Theme</span>
              <button
                onClick={onToggleTheme}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {theme === "dark" ? "☼ Light" : "☾ Dark"}
              </button>
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
                className="ml-3 max-w-[40%] rounded border border-neutral-300 bg-paper px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
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
          </Section>

          <Section title="Group notes">
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

          <Section title="Account">
            <Row>
              <span>Sign out</span>
              <button
                onClick={() => {
                  onClose();
                  onSignOut();
                }}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Sign out
              </button>
            </Row>
          </Section>

          <p className="mt-4 text-[10px] text-neutral-400 dark:text-neutral-500">
            Debug mode reveals the citation pipeline's intermediate state
            without changing the output. "Disable citation engine" skips
            claim parsing + verification only; the rule layer
            (rule-guide.MD) is non-bypassable and always runs.
          </p>
      </div>
    </BottomSheet>
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
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      <div className="overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
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

function autoTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "system";
  }
}

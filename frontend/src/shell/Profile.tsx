/**
 * Profile + Account + Preferences (CLAUDE.md §4.11).
 *
 * Lives inside the Settings modal. Loads the current profile from
 * `/auth/me`, lets the user edit display name / avatar URL / languages
 * (which drive multilingual responses per `rule-guide.MD` §11) and
 * preferences (default translation, note scope). Change password and
 * delete account live here too.
 */
import { useEffect, useState } from "react";
import { api, type UserProfile } from "../lib/api";
import { PhoneVerifyModal } from "./PhoneVerifyModal";
import { BackupCodesSection } from "./BackupCodes";

interface Props {
  /** Called when the profile is reloaded so callers can pick up new
   *  display_name / preferences. */
  onProfile?: (p: UserProfile) => void;
  onDeleted: () => void;
}

export function ProfileSection({ onProfile, onDeleted }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .authMe()
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        onProfile?.(p);
      })
      .catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [onProfile]);

  if (loadError) {
    return (
      <p className="px-3 py-2 text-xs text-red-700 dark:text-red-300">
        Couldn't load profile: {loadError}
      </p>
    );
  }
  if (!profile) {
    return (
      <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
        Loading…
      </p>
    );
  }

  return (
    <>
      <ProfileForm
        profile={profile}
        onSaved={(p) => {
          setProfile(p);
          onProfile?.(p);
        }}
      />
      <PhoneForm
        profile={profile}
        onSaved={(p) => {
          setProfile(p);
          onProfile?.(p);
        }}
      />
      <PreferencesForm
        profile={profile}
        onSaved={(p) => {
          setProfile(p);
          onProfile?.(p);
        }}
      />
      <PasswordForm />
      <BackupCodesSection />
      <DangerSection onDeleted={onDeleted} />
    </>
  );
}

function ProfileForm({
  profile,
  onSaved,
}: {
  profile: UserProfile;
  onSaved: (p: UserProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? "");
  const [languages, setLanguages] = useState((profile.languages || []).join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty =
    displayName !== profile.display_name ||
    avatarUrl !== (profile.avatar_url ?? "") ||
    languages !== (profile.languages || []).join(", ");

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.authPatchMe({
        display_name: displayName,
        avatar_url: avatarUrl,
        languages: languages
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onSaved(next);
      setMsg("Saved.");
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Profile">
      <div className="border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        <div className="mb-3 flex items-center gap-3">
          <Avatar handle={profile.handle} url={avatarUrl} size={48} />
          <div>
            <div className="text-sm font-medium">@{profile.handle}</div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              Handle is permanent — pick a display name to change how it appears.
            </div>
          </div>
        </div>
        <Field label="Display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </Field>
        <Field label="Avatar URL (optional)">
          <input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </Field>
        <Field label="Languages (comma-separated)">
          <input
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
            placeholder="en, es"
            className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">
            Drives multilingual replies (rule-guide.MD §11).
          </p>
        </Field>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {msg ?? ""}
          </span>
          <button
            onClick={save}
            disabled={!dirty || busy}
            className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "…" : "Save profile"}
          </button>
        </div>
      </div>
    </Section>
  );
}

function PhoneForm({
  profile,
  onSaved,
}: {
  profile: UserProfile;
  onSaved: (p: UserProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const verified = profile.phone_verified_at != null;

  async function remove() {
    if (!confirm("Unlink your phone number?")) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.authPhoneRemove();
      // Re-fetch so verified-at clears too.
      const me = await api.authMe();
      onSaved(me);
      setMsg("Phone removed.");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Phone">
      <div className="border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        {verified && profile.phone_e164 ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-sm">
                <span className="truncate font-mono">{profile.phone_e164}</span>
                <span
                  className="rounded bg-emerald-100 px-1 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                  title="Verified via SMS"
                >
                  ✓ verified
                </span>
              </div>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-400">
                Bound to your account. Other people in your rooms can see it
                if you've shared it in your profile.
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                onClick={() => setOpen(true)}
                disabled={busy}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Replace
              </button>
              <button
                onClick={remove}
                disabled={busy}
                className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-neutral-600 dark:text-neutral-300">
              No phone on file. Add one to enable phone-based recovery
              and let friends in your rooms reach you.
            </div>
            <button
              onClick={() => setOpen(true)}
              className="shrink-0 rounded bg-neutral-900 px-3 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Add phone
            </button>
          </div>
        )}
        {msg && (
          <p className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            {msg}
          </p>
        )}
      </div>
      <PhoneVerifyModal
        open={open}
        onClose={() => setOpen(false)}
        onVerified={onSaved}
        initialPhone={profile.phone_e164 ?? undefined}
      />
    </Section>
  );
}

function PreferencesForm({
  profile,
  onSaved,
}: {
  profile: UserProfile;
  onSaved: (p: UserProfile) => void;
}) {
  const prefs = (profile.preferences ?? {}) as Record<string, unknown>;
  const [defaultTranslation, setDefaultTranslation] = useState<string>(
    (prefs.default_translation as string) ?? "King James Version",
  );
  const [defaultScope, setDefaultScope] = useState<"personal" | "group">(
    ((prefs.default_note_scope as string) === "group" ? "group" : "personal"),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.authPatchMe({
        preferences: {
          ...prefs,
          default_translation: defaultTranslation,
          default_note_scope: defaultScope,
        },
      });
      onSaved(next);
      setMsg("Saved.");
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Preferences">
      <div className="border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        <Field label="Default translation">
          <select
            value={defaultTranslation}
            onChange={(e) => setDefaultTranslation(e.target.value)}
            className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          >
            <option>King James Version</option>
            <option>Hebrew (WLC)</option>
            <option>Greek (TR)</option>
            <option>Arabic (SVD)</option>
          </select>
        </Field>
        <Field label="Default note scope">
          <select
            value={defaultScope}
            onChange={(e) =>
              setDefaultScope(e.target.value as "personal" | "group")
            }
            className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          >
            <option value="personal">Personal (private, agent invisible)</option>
            <option value="group">Group (shared, agent oversight)</option>
          </select>
        </Field>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {msg ?? ""}
          </span>
          <button
            onClick={save}
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "…" : "Save preferences"}
          </button>
        </div>
      </div>
    </Section>
  );
}

function PasswordForm() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.authChangePassword(current, next);
      setCurrent("");
      setNext("");
      setOpen(false);
      setMsg("Password changed.");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(
        m.startsWith("401")
          ? "Current password is incorrect."
          : m.startsWith("400")
            ? "New password must be 8+ characters."
            : `Error: ${m}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Password">
      <div className="border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Change password
          </button>
        ) : (
          <>
            <Field label="Current password">
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </Field>
            <Field label="New password (8+ chars)">
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                className="w-full rounded border border-neutral-200 bg-paper px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </Field>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {msg ?? ""}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setOpen(false);
                    setCurrent("");
                    setNext("");
                  }}
                  className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy || !current || next.length < 8}
                  className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  {busy ? "…" : "Change"}
                </button>
              </div>
            </div>
          </>
        )}
        {!open && msg && (
          <p className="mt-2 text-[11px] text-green-700 dark:text-green-300">
            {msg}
          </p>
        )}
      </div>
    </Section>
  );
}

function DangerSection({ onDeleted }: { onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Danger zone">
      <div className="px-3 py-3">
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
          >
            Delete account
          </button>
        ) : (
          <>
            <p className="mb-2 text-xs text-neutral-700 dark:text-neutral-300">
              This will sign you out everywhere and remove your account.
              Shared (group) notes you wrote in rooms stay — they're owned
              by the room, not by you.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Keep my account
              </button>
              <button
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.authDeleteMe();
                    onDeleted();
                  } catch {
                    // ignored — onDeleted will still happen on 401
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
                className="rounded bg-red-600 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-red-700"
              >
                {busy ? "…" : "Yes, delete forever"}
              </button>
            </div>
          </>
        )}
      </div>
    </Section>
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-2 block last:mb-0">
      <span className="mb-0.5 block text-[11px] text-neutral-600 dark:text-neutral-300">
        {label}
      </span>
      {children}
    </label>
  );
}

export function Avatar({
  handle,
  url,
  size = 32,
}: {
  handle: string;
  url?: string | null;
  size?: number;
}) {
  if (url && url.trim()) {
    return (
      <img
        src={url}
        alt={handle}
        style={{ width: size, height: size }}
        className="rounded-full object-cover"
        onError={(e) => {
          // Hide broken image; the initials fallback isn't rendered here
          // but a stale URL just becomes a transparent box. Good enough.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  // Initials avatar — deterministic background from handle.
  const initials = handle
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase() || "•";
  const palette = [
    "bg-amber-200 text-amber-900",
    "bg-sky-200 text-sky-900",
    "bg-violet-200 text-violet-900",
    "bg-emerald-200 text-emerald-900",
    "bg-rose-200 text-rose-900",
    "bg-fuchsia-200 text-fuchsia-900",
  ];
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  const tint = palette[h % palette.length];
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={`flex items-center justify-center rounded-full font-semibold ${tint}`}
    >
      {initials}
    </div>
  );
}

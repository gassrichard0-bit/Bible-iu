import { useEffect, useRef, useState } from "react";
import { JoinRoom } from "./shell/JoinRoom";
import { Login } from "./shell/Login";
import { MobileShell } from "./shell/MobileShell";
import { OfflineIndicator } from "./shell/OfflineIndicator";
import { PasswordGate } from "./shell/PasswordGate";
import { ResetPasswordSheet } from "./shell/ResetPasswordSheet";
import { SocialShell } from "./shell/SocialShell";
import { useIsDesktop } from "./lib/useMediaQuery";
import { applyTheme, readTheme, type Theme } from "./lib/theme";
import { ConfirmDialogHost } from "./lib/confirmDialog";
import {
  api,
  clearSessionToken,
  getSessionToken,
  setSessionExpiredHandler,
  setUnauthorizedHandler,
} from "./lib/api";
import {
  readSettings,
  settingsFromPreferences,
  settingsToPreferences,
  writeSettings,
  type Settings,
} from "./lib/settings";
import {
  maybeAutoEnablePush,
  refreshPushSubscriptionIfOptedIn,
} from "./lib/pushNotifications";
import {
  SW_UPDATE_EVENT,
  activateWaitingServiceWorker,
} from "./lib/registerServiceWorker";

type GateState = "checking" | "open" | "locked";
type AuthState =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "signed-in"; handle: string; userId: string };

export function App() {
  const isDesktop = useIsDesktop();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [gate, setGate] = useState<GateState>("checking");
  const [auth, setAuth] = useState<AuthState>({ phase: "checking" });
  const [settings, setSettingsState] = useState<Settings>(() => readSettings());
  // `?invite=<code>` in the URL switches the post-auth render to a Join
  // page. We hold the code in state so we can clear the URL after
  // joining without losing the intent.
  const [inviteCode, setInviteCode] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("invite");
  });
  // `?reset=<token>` in the URL opens the password-reset sheet over
  // whatever else is rendering. The link the backend sends from
  // /auth/forgot-password points here. Token is opaque to us — the
  // backend compares its SHA-256 against `password_reset_tokens`.
  const [resetToken, setResetToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("reset");
  });
  // After accepting an invite, signal SocialShell to open that room.
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  // Set when the recipient clicks "Sign in to join" from the JoinRoom
  // preview. While true, the auth UI takes over even though an invite
  // code is still in state. Cleared on successful sign-in (JoinRoom
  // re-renders with signedIn=true) or when the user cancels the invite.
  const [authForInvite, setAuthForInvite] = useState(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Debounced server sync — coalesces rapid toggles (e.g. flipping
  // a switch back and forth) into one PATCH. The hydration flag stops
  // the initial server-load from echoing right back to the server.
  const settingsHydratedRef = useRef(false);
  const patchTimerRef = useRef<number | null>(null);
  function setSettings(s: Settings) {
    writeSettings(s);
    setSettingsState(s);
    // Only sync once we've heard from the server at least once;
    // otherwise the initial local-only read would PATCH back the
    // unhydrated defaults and clobber server-side state.
    if (!settingsHydratedRef.current) return;
    if (patchTimerRef.current !== null) {
      window.clearTimeout(patchTimerRef.current);
    }
    patchTimerRef.current = window.setTimeout(() => {
      patchTimerRef.current = null;
      api
        .authPatchMe({ preferences: settingsToPreferences(s) })
        .catch(() => {
          // Server sync is best-effort. localStorage still has the
          // value, so nothing the user picked is lost.
        });
    }, 600);
  }

  // Register the global error handlers once.
  useEffect(() => {
    setUnauthorizedHandler(() => setGate("locked"));
    setSessionExpiredHandler(() => setAuth({ phase: "signed-out" }));
  }, []);

  // Probe the deployment gate every time `gate` transitions to
  // "checking". This covers the initial mount AND the case where the
  // PasswordGate finishes and resets gate to "checking" — without this
  // re-probe, the user is stuck on Loading after entering the password.
  useEffect(() => {
    if (gate !== "checking") return;
    api
      .bibleBooks()
      .then(() => setGate("open"))
      .catch((e: Error) => {
        if (e.message.startsWith("401")) setGate("locked");
        else setGate("open");
      });
  }, [gate]);

  // Once the deployment gate is open, check user session.
  useEffect(() => {
    if (gate !== "open") return;
    if (!getSessionToken()) {
      setAuth({ phase: "signed-out" });
      return;
    }
    api
      .authMe()
      .then((u) => {
        setAuth({ phase: "signed-in", handle: u.handle, userId: u.id });
        // Hydrate settings from server preferences. Defaults already
        // came from localStorage so missing keys keep the user's
        // local choice.
        setSettingsState((cur) => {
          const merged = settingsFromPreferences(cur, u.preferences);
          writeSettings(merged);
          return merged;
        });
        settingsHydratedRef.current = true;
        // Best-effort re-subscribe for push. Only runs if the user
        // already opted in once — we never re-prompt for permission
        // here. Failures are silent; Settings shows the real status.
        void refreshPushSubscriptionIfOptedIn();
      })
      .catch(() => {
        clearSessionToken();
        setAuth({ phase: "signed-out" });
      });
  }, [gate]);

  const toggleTheme = () =>
    setTheme((t) => (t === "dark" ? "light" : "dark"));

  function onSignedIn(handle: string) {
    // Fire the auto-enable BEFORE the awaited authMe — we want this
    // call to happen inside the transient user-activation window that
    // the sign-in button tap opened. iOS Safari refuses
    // `Notification.requestPermission()` once that window closes (~5s
    // after the gesture), so we can't wait for the auth round-trip.
    // Runs at most once per device (AUTO_TRIED flag in pushNotifications).
    void maybeAutoEnablePush();
    // We need the canonical user id (for "is this my comment?" checks
    // in social-notes), so re-fetch authMe rather than guessing from
    // the handle. Also hydrate settings here for the fresh sign-in
    // case (the gate effect above only runs on bootstrap).
    api
      .authMe()
      .then((u) => {
        setAuth({ phase: "signed-in", handle: u.handle, userId: u.id });
        setSettingsState((cur) => {
          const merged = settingsFromPreferences(cur, u.preferences);
          writeSettings(merged);
          return merged;
        });
        settingsHydratedRef.current = true;
      })
      .catch(() => {
        // Fall back to handle-only auth state. The user can still use
        // the app — they just can't delete their own comments.
        setAuth({ phase: "signed-in", handle, userId: "" });
      });
  }

  function signOut() {
    api.authLogout().catch(() => {});
    clearSessionToken();
    setAuth({ phase: "signed-out" });
    settingsHydratedRef.current = false;
  }

  function onDeleted() {
    // Account is already gone server-side — just drop local state.
    clearSessionToken();
    setAuth({ phase: "signed-out" });
    settingsHydratedRef.current = false;
  }

  // Check gate FIRST: the password gate render must not be blocked by
  // an in-flight auth probe. Previously a fresh visitor (no password,
  // no session) saw "Loading…" indefinitely because `auth.phase` was
  // still "checking" while gate had already flipped to "locked".
  if (gate === "checking") {
    return (
      <div className="grid h-full place-items-center bg-paper-soft text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        Loading…
      </div>
    );
  }
  if (gate === "locked") {
    return <PasswordGate onUnlock={() => setGate("checking")} />;
  }
  if (auth.phase === "checking") {
    return (
      <div className="grid h-full place-items-center bg-paper-soft text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        Loading…
      </div>
    );
  }
  // Invite landing — three states depending on auth + the
  // authForInvite flag the JoinRoom preview toggles when the
  // recipient clicks "Sign in to join".
  if (inviteCode) {
    // (a) Recipient is signed-in already → preview + Join button.
    if (auth.phase === "signed-in" && !authForInvite) {
      return (
        <JoinRoom
          code={inviteCode}
          signedIn
          onJoined={(roomId) => {
            setJoinedRoomId(roomId);
            setInviteCode(null);
            if (typeof window !== "undefined") {
              const u = new URL(window.location.href);
              u.searchParams.delete("invite");
              window.history.replaceState({}, "", u.toString());
            }
          }}
          onSignInNeeded={() => {}}
          onCancel={() => {
            setInviteCode(null);
            if (typeof window !== "undefined") {
              const u = new URL(window.location.href);
              u.searchParams.delete("invite");
              window.history.replaceState({}, "", u.toString());
            }
          }}
        />
      );
    }
    // (b) Recipient explicitly chose to sign in → render Login. After
    // success, onSignedIn flips auth.phase to signed-in and clears
    // authForInvite, so we fall back to branch (a) on next render.
    if (authForInvite) {
      return (
        <Login
          onSignedIn={(handle) => {
            setAuthForInvite(false);
            onSignedIn(handle);
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      );
    }
    // (c) Default: show the preview with a "Sign in to join" button.
    return (
      <JoinRoom
        code={inviteCode}
        signedIn={false}
        onJoined={(roomId) => {
          setJoinedRoomId(roomId);
          setInviteCode(null);
          if (typeof window !== "undefined") {
            const u = new URL(window.location.href);
            u.searchParams.delete("invite");
            window.history.replaceState({}, "", u.toString());
          }
        }}
        onSignInNeeded={() => setAuthForInvite(true)}
        onCancel={() => {
          setInviteCode(null);
          if (typeof window !== "undefined") {
            const u = new URL(window.location.href);
            u.searchParams.delete("invite");
            window.history.replaceState({}, "", u.toString());
          }
        }}
      />
    );
  }
  if (auth.phase === "signed-out") {
    return (
      <Login
        onSignedIn={onSignedIn}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }
  const Shell = isDesktop ? SocialShell : MobileShell;
  return (
    <>
      <Shell
        handle={auth.handle}
        selfUserId={auth.userId}
        onSignOut={signOut}
        onDeleted={onDeleted}
        theme={theme}
        onToggleTheme={toggleTheme}
        settings={settings}
        onChangeSettings={setSettings}
        pendingRoomId={joinedRoomId}
        onPendingRoomConsumed={() => setJoinedRoomId(null)}
      />
      <UpdateAvailableBanner />
      <OfflineIndicator />
      <ConfirmDialogHost />
      {resetToken && (
        <ResetPasswordSheet
          token={resetToken}
          onClose={() => {
            setResetToken(null);
            // Strip `?reset=` from the URL so a refresh doesn't
            // reopen the sheet for the same (now-spent) token.
            const url = new URL(window.location.href);
            url.searchParams.delete("reset");
            window.history.replaceState({}, "", url.toString());
          }}
          onReset={() => {
            // Drop the session state so the next render shows Login.
            setAuth({ phase: "signed-out" });
          }}
        />
      )}
    </>
  );
}

/** Toast that appears when the SW has a new build waiting. One tap →
 *  activates the waiting worker and reloads. Auto-dismisses if the
 *  user reloads the tab through any other route (the banner state
 *  doesn't persist across reloads). */
function UpdateAvailableBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onReady = () => setShow(true);
    window.addEventListener(SW_UPDATE_EVENT, onReady);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onReady);
  }, []);
  if (!show) return null;
  return (
    <div
      role="status"
      className="fixed left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50/95 px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-md dark:border-amber-700 dark:bg-amber-900/85"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 80px)",
      }}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-200 text-amber-900 dark:bg-amber-700/70 dark:text-amber-100">
        ↻
      </span>
      <span className="flex-1 text-[13px] text-amber-900 dark:text-amber-100">
        Update available — reload to get the latest version.
      </span>
      <button
        type="button"
        onClick={() => activateWaitingServiceWorker()}
        className="shrink-0 rounded-full bg-amber-500 px-3 py-1 text-[12px] font-semibold text-white shadow-[0_2px_6px_rgba(0,0,0,0.15)] hover:bg-amber-600"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Dismiss update prompt"
        className="shrink-0 rounded-full text-amber-700 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-800/40"
      >
        ✕
      </button>
    </div>
  );
}

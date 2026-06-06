import { useEffect, useRef, useState } from "react";
import { JoinRoom } from "./shell/JoinRoom";
import { Login } from "./shell/Login";
import { MobileShell } from "./shell/MobileShell";
import { PasswordGate } from "./shell/PasswordGate";
import { SocialShell } from "./shell/SocialShell";
import { useIsDesktop } from "./lib/useMediaQuery";
import { applyTheme, readTheme, type Theme } from "./lib/theme";
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
      })
      .catch(() => {
        clearSessionToken();
        setAuth({ phase: "signed-out" });
      });
  }, [gate]);

  const toggleTheme = () =>
    setTheme((t) => (t === "dark" ? "light" : "dark"));

  function onSignedIn(handle: string) {
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
  );
}

/**
 * Thin wrapper over Capacitor's Haptics plugin.
 *
 * Native iOS apps tick the Taptic Engine on every micro-interaction
 * (highlight, bookmark, complete-day, swipe-to-delete). Without it,
 * the PWA-style "tap → nothing → DOM change" feels conspicuously web.
 *
 * Each export is a single best-effort firing — failures are silent
 * (PWA browser, or user disabled haptics in iOS Settings) so we
 * never wrap callers in try/catch. The dynamic `import()` keeps the
 * plugin out of the PWA bundle for users who never install the iOS
 * app.
 */

type ImpactStyle = "LIGHT" | "MEDIUM" | "HEAVY";

let pluginPromise:
  | Promise<{
      Haptics: {
        impact: (opts: { style: ImpactStyle }) => Promise<void>;
        notification: (opts: {
          type: "SUCCESS" | "WARNING" | "ERROR";
        }) => Promise<void>;
        selectionStart: () => Promise<void>;
        selectionChanged: () => Promise<void>;
        selectionEnd: () => Promise<void>;
      };
    }>
  | null = null;

function load() {
  if (!pluginPromise) {
    pluginPromise = import("@capacitor/haptics").then((m) => ({
      Haptics: m.Haptics as never,
    }));
  }
  return pluginPromise;
}

/** Light tap. Use for granular state flips: highlight on/off,
 *  bookmark toggle, expanding a section. */
export async function hapticLight(): Promise<void> {
  try {
    const { Haptics } = await load();
    await Haptics.impact({ style: "LIGHT" });
  } catch {
    // No native bridge (PWA), no Taptic Engine, or user opted out.
  }
}

/** Medium tap. Use for confirmations the user explicitly committed
 *  to: completing a reading-plan day, sending a chat message,
 *  finalizing a verse selection. */
export async function hapticMedium(): Promise<void> {
  try {
    const { Haptics } = await load();
    await Haptics.impact({ style: "MEDIUM" });
  } catch {
    // ignore
  }
}

/** "Done" pattern. Use sparingly — completing a reading plan,
 *  finishing onboarding. */
export async function hapticSuccess(): Promise<void> {
  try {
    const { Haptics } = await load();
    await Haptics.notification({ type: "SUCCESS" });
  } catch {
    // ignore
  }
}

/** Failure pattern. Wrong password, queue drain failed, etc. */
export async function hapticError(): Promise<void> {
  try {
    const { Haptics } = await load();
    await Haptics.notification({ type: "ERROR" });
  } catch {
    // ignore
  }
}

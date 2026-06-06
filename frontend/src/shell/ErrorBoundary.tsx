/**
 * Top-level error boundary. Wraps the App so an unhandled render
 * error in any subtree (a bad note's HTML, a Yjs decode failure, a
 * malformed annotation, etc.) drops into a friendly fallback instead
 * of leaving the user staring at a blank screen.
 *
 * Sentry hook is intentionally plug-and-play: when
 * `import.meta.env.VITE_SENTRY_DSN` is set, the dynamic import wires
 * captureException without bloating the bundle when it isn't.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log so the dev console isn't silent.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
    // Forward to Sentry only if a DSN is configured. The dynamic
    // import means dev builds without Sentry don't ship the SDK.
    const dsn = import.meta.env.VITE_SENTRY_DSN;
    if (dsn) {
      // Dynamic import + `as unknown` so the bundle stays Sentry-free
      // when the package isn't installed. The user adds @sentry/browser
      // only when they're ready to wire real error tracking.
      // Wrapped in Function() so TypeScript doesn't try to resolve the
      // module spec at compile time — the package may not be installed.
      const dynamicImport = new Function(
        "spec",
        "return import(spec)",
      ) as (spec: string) => Promise<unknown>;
      void dynamicImport("@sentry/browser")
        .then((mod) => {
          const sentry = mod as { captureException?: (e: unknown) => void };
          sentry.captureException?.(error);
        })
        .catch(() => {
          // Sentry not installed — fall back to console only.
        });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid h-full place-items-center bg-paper-soft px-6 dark:bg-neutral-950">
        <div className="w-full max-w-sm rounded-[28px] border border-white/40 bg-paper/55 p-6 text-center shadow-[0_8px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.55)] backdrop-blur-2xl backdrop-saturate-200 dark:border-white/10 dark:bg-neutral-900/45 dark:shadow-[0_8px_28px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.10)]">
          <h1 className="mb-2 text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            Something went wrong
          </h1>
          <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
            Bible IU hit an unexpected error. Your notes and marks
            are stored locally and on the server — they're safe.
          </p>
          <details className="mb-4 rounded-lg bg-neutral-100/70 px-3 py-2 text-left text-[11px] text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-300">
            <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Details
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono">
              {error.message}
            </pre>
          </details>
          <div className="flex justify-center gap-2">
            <button
              onClick={this.reset}
              className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Try again
            </button>
            <button
              onClick={() => {
                if (typeof window !== "undefined") window.location.reload();
              }}
              className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

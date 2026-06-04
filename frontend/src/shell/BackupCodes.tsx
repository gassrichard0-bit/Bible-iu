/**
 * Backup codes section (lives inside the Settings/Profile modal).
 *
 * Shows current status (count remaining + when generated). The
 * "Generate" button replaces any existing batch with 10 fresh codes
 * and displays them ONCE in a confirmation dialog with copy/download
 * options. After that dialog closes, the plaintext codes are gone for
 * good — the server only keeps Argon2 hashes.
 */
import { useEffect, useState } from "react";
import { api, type BackupCodesStatus } from "../lib/api";

export function BackupCodesSection() {
  const [status, setStatus] = useState<BackupCodesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCodes, setPendingCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      setStatus(await api.authBackupCodesStatus());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function generate() {
    if (
      status &&
      status.remaining > 0 &&
      !confirm(
        `You still have ${status.remaining} unused codes. Generating a new batch will invalidate the old ones. Continue?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.authBackupCodesGenerate();
      setPendingCodes(r.codes);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Backup codes
      </h3>
      <div className="overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
        <div className="border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <p className="mb-2 text-[11px] text-neutral-600 dark:text-neutral-300">
            If you forget your password, you can use one of these single-use
            codes to set a new one. Generate a batch and store them
            somewhere safe (password manager, printed and filed).
          </p>
          {status && (
            <div className="mb-2 text-xs">
              {status.total === 0 ? (
                <span className="text-amber-700 dark:text-amber-300">
                  ⚠ No backup codes yet — you can&rsquo;t recover this
                  account if you forget your password.
                </span>
              ) : (
                <span className="text-neutral-600 dark:text-neutral-300">
                  <span className="font-semibold">
                    {status.remaining}
                  </span>{" "}
                  of {status.total} codes remaining
                  {status.last_generated_at && (
                    <>
                      {" "}
                      &middot; generated{" "}
                      {new Date(status.last_generated_at).toLocaleDateString()}
                    </>
                  )}
                </span>
              )}
            </div>
          )}
          {error && (
            <p className="mb-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <button
            onClick={generate}
            disabled={busy}
            className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {busy
              ? "Generating…"
              : status && status.total > 0
                ? "Regenerate codes"
                : "Generate codes"}
          </button>
        </div>
      </div>
      {pendingCodes && (
        <CodesRevealDialog
          codes={pendingCodes}
          onClose={() => setPendingCodes(null)}
        />
      )}
    </section>
  );
}

function CodesRevealDialog({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  const filename = `bible-iu-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`;

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function download() {
    const blob = new Blob([text + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md overflow-hidden rounded-lg border border-neutral-200 bg-paper shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Save your backup codes</h2>
        </header>
        <div className="px-4 py-3">
          <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            This is the only time these codes will be shown. After this
            dialog closes, the server only keeps hashed copies. Save them
            now.
          </p>
          <ul className="mb-3 rounded border border-neutral-200 bg-paper-soft p-3 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-950">
            {codes.map((c) => (
              <li key={c} className="leading-relaxed">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              <button
                onClick={copy}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {copied ? "✓ Copied" : "Copy all"}
              </button>
              <button
                onClick={download}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Download .txt
              </button>
              <button
                onClick={() => window.print()}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-paper-soft dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Print
              </button>
            </div>
            <button
              onClick={onClose}
              className="rounded bg-neutral-900 px-3 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              I&rsquo;ve saved them
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

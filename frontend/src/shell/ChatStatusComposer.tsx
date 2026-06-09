/**
 * "Post a status" modal. Two inputs: a single-line text body and an
 * optional image (re-encoded to webp by the backend). Posting hits
 * POST /rooms/{id}/statuses; the WS broadcast appends it everywhere
 * else live, so the parent doesn't need to refetch.
 */
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { BottomSheet } from "./BottomSheet";

interface Props {
  open: boolean;
  onClose: () => void;
  roomId: string;
  onPosted?: () => void;
}

export function ChatStatusComposer({ open, onClose, roomId, onPosted }: Props) {
  const [text, setText] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileToken, setFileToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function reset() {
    setText("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFileToken(null);
    setError(null);
  }

  async function attachImage(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { attachment_image_token } = await api.statusUploadImage(
        roomId,
        file,
      );
      setFileToken(attachment_image_token);
      // Local preview from the picked file — server's encoded version
      // is uploaded but we don't fetch it back just for preview.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));
    } catch (e) {
      setError((e as Error).message || "Image upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    const body = text.trim();
    if (!body && !fileToken) {
      setError("Add a message or a photo to post.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.statusCreate(roomId, body, fileToken ?? undefined);
      onPosted?.();
      reset();
      onClose();
    } catch (e) {
      setError((e as Error).message || "Couldn't post your status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Post a status"
    >
      <div className="flex flex-col gap-3 px-4 pb-5 pt-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's on your heart today?"
          maxLength={400}
          rows={3}
          className="w-full resize-none rounded-2xl border border-neutral-200 bg-paper px-3 py-2 text-[15px] outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-amber-700 dark:focus:ring-amber-800/40"
          aria-label="Status text"
        />
        {previewUrl && (
          <div className="relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <img
              src={previewUrl}
              alt="Selected status photo"
              className="block max-h-72 w-full object-contain bg-neutral-100 dark:bg-neutral-900"
            />
            <button
              type="button"
              onClick={() => {
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                setPreviewUrl(null);
                setFileToken(null);
              }}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white shadow"
              aria-label="Remove photo"
              title="Remove photo"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attachImage(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-paper px-3 py-1.5 text-[13px] font-semibold text-neutral-700 transition hover:bg-paper-soft disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            <span aria-hidden>📷</span>
            {previewUrl ? "Change photo" : "Add photo"}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || (!text.trim() && !fileToken)}
            className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-4 py-1.5 text-[13px] font-bold text-white shadow-sm transition hover:bg-amber-600 disabled:opacity-50"
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Statuses auto-expire after 24 hours.
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}

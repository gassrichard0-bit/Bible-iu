/**
 * WhatsApp-style avatar for a room row. No backend image storage
 * yet, so we deterministically pick a hue from the room id and stamp
 * the room's initials over a gradient. Looks like a group photo
 * placeholder without the upload plumbing.
 */
import { useMemo, useState } from "react";
import { API_BASE, getPassword, getSessionToken } from "../lib/api";

function hueFromId(id: string): number {
  // Cheap, stable hash. djb2 variant — we just need the value to be
  // the same for the same id across renders and reasonably spread out
  // across the colour wheel for a list of rooms.
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function initials(name: string): string {
  const parts = name
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "·";
  return parts.map((w) => w[0]!.toUpperCase()).join("");
}

/** Prefix server-relative URLs from `RoomOut.image_url` with `/api`
 *  AND append the deployment password + session token in the query
 *  string. Browser `<img>` loaders can't send custom headers, so the
 *  backend's image GET accepts auth via either header or query param. */
function withApiPrefix(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const apiPath = path.startsWith("/api") ? path : `/api${path}`;
  const base = `${API_BASE}${apiPath}`;
  // jsonFetch's auth handles cookies via headers; image src doesn't,
  // so duplicate the credentials into the URL.
  const sep = base.includes("?") ? "&" : "?";
  const auth: string[] = [];
  const pw = getPassword();
  const tok = getSessionToken();
  if (pw) auth.push(`password=${encodeURIComponent(pw)}`);
  if (tok) auth.push(`session=${encodeURIComponent(tok)}`);
  return auth.length ? `${base}${sep}${auth.join("&")}` : base;
}

export function RoomAvatar({
  id,
  name,
  type,
  imageUrl,
  size = 48,
  className = "",
}: {
  id: string;
  name: string;
  type: "group" | "direct";
  imageUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const hue = useMemo(() => hueFromId(id), [id]);
  const text = useMemo(() => initials(name), [name]);
  // Track image-load failures so we don't keep retrying a broken URL
  // every render. Falling back to the gradient also covers the moment
  // between upload and the next /rooms refresh.
  const [broken, setBroken] = useState(false);
  const resolved = withApiPrefix(imageUrl);
  // Direct chats lean blue-grey so the rail telegraphs "person, not
  // group" at a glance even before reading the name.
  const start = type === "direct"
    ? `hsl(220 18% 55%)`
    : `hsl(${hue} 60% 55%)`;
  const end = type === "direct"
    ? `hsl(220 22% 38%)`
    : `hsl(${(hue + 28) % 360} 68% 42%)`;
  // Initials fit the diameter — ~38% looked balanced after eyeballing
  // 36px / 44px / 48px.
  const fontSize = Math.round(size * 0.38);
  if (resolved && !broken) {
    return (
      <img
        src={resolved}
        width={size}
        height={size}
        alt=""
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${start}, ${end})`,
        fontSize,
      }}
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${className}`}
      aria-hidden
    >
      {text}
    </div>
  );
}

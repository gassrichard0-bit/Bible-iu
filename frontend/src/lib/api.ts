/** Thin HTTP client targeting the FastAPI backend through Vite's proxy. */

export type Decision = "pass" | "revise" | "refuse";

export interface CitationOut {
  source_id: string;
  verse_refs: string[];
  tradition: string | null;
  reliability: string | null;
  verification_result: "supported" | "inference" | "dropped";
}

export interface ClaimOut {
  text: string;
  kind: "scripture" | "original_language" | "commentary" | "inference" | "non_factual";
  citations: CitationOut[];
  contradicts_scripture: boolean;
}

export interface AgentNoteAppended {
  id: string;
  body: string;
  verse_anchor?: string | null;
}

export interface ReasoningResponse {
  decision: Decision;
  reasoning: string;
  answer: string;
  claims: ClaimOut[];
  dropped: ClaimOut[];
  revision_hints: string[];
  refusal_reason: string | null;
  note_appended?: AgentNoteAppended | null;
}

const PW_KEY = "bible-iu:password";
const SESSION_KEY = "bible-iu:session-token";

export function getPassword(): string {
  return localStorage.getItem(PW_KEY) ?? "";
}

export function setPassword(pw: string): void {
  localStorage.setItem(PW_KEY, pw);
}

export function clearPassword(): void {
  localStorage.removeItem(PW_KEY);
}

export function getSessionToken(): string {
  return localStorage.getItem(SESSION_KEY) ?? "";
}

export function setSessionToken(tok: string): void {
  localStorage.setItem(SESSION_KEY, tok);
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Listener notified when the server returns 401 (bad/missing password). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Listener notified when the session expires / is missing. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": getPassword(),
      "X-Session-Token": getSessionToken(),
      ...(init?.headers ?? {}),
    },
  });
  if (r.status === 401) {
    // 401 could be either the deployment gate OR a missing/expired
    // session. Inspect the body to disambiguate.
    let detail = "";
    try {
      const j = await r.clone().json();
      detail = j?.detail ?? "";
    } catch {
      // ignore
    }
    if (detail.toLowerCase().includes("password")) {
      clearPassword();
      onUnauthorized?.();
    } else {
      clearSessionToken();
      onSessionExpired?.();
    }
    throw new Error("401 Unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export interface BibleBookOut {
  code: string;
  name: string;
  chapters: number;
}

export interface BibleVerseOut {
  verse_id: string;
  book: string;
  chapter: number;
  verse: number;
  text: string;
  translation: string;
  license: string;
}

export interface BibleChapterOut {
  book: string;
  chapter: number;
  translation: string;
  verses: BibleVerseOut[];
}

export interface BibleVerseTranslation {
  name: string;
  text: string;
  direction: "ltr" | "rtl";
  license: string;
}

export interface BibleVerseMulti {
  verse_id: string;
  book: string;
  chapter: number;
  verse: number;
  translations: BibleVerseTranslation[];
}

/** Hebrew/Greek per-word study row. Surface form is the inflected
 *  word as it appears in the verse; lemma is its dictionary form;
 *  Strong's keys into the public Strong's lexicons; morphology is
 *  the OSHB/MorphGNT parse code. */
export interface ChatSearchHit {
  message_id: string;
  room_id: string;
  room_name: string | null;
  author_user_id: string | null;
  author_handle: string | null;
  body: string;
  created_at: string;
}

export interface NoteSearchHit {
  note_id: string;
  room_id: string;
  room_name: string | null;
  scope: "personal" | "group";
  body: string;
  verse_anchors: string[];
  by_agent: boolean;
  updated_at: string | null;
}

export interface BibleSearchHit {
  verse_id: string;
  book: string;
  chapter: number;
  verse: number;
  text: string;
  translation: string;
}

export interface AdvancedSearchHit extends BibleSearchHit {
  /** One-line model rationale for why this verse matches the user's
   *  fragment. Rendered as the secondary line under the verse text in
   *  the AI suggestions list. */
  rationale: string;
  /** "high" | "medium" | "low" — drives the badge color in the UI. */
  confidence: "high" | "medium" | "low";
}

/** Audit-log row from the agent's Provenance ledger. */
export interface ProvenanceRow {
  id: string;
  claim_id: string;
  session_id: string;
  verse_refs: string[];
  source_refs: string[];
  tradition: string | null;
  reliability: string | null;
  verification_result: string;
  kind: string;
  created_at: string;
}

export interface VerseTokenOut {
  position: number;
  surface_form: string;
  lemma: string;
  strongs: string | null;
  morphology: string | null;
}

export interface BibleChapterMulti {
  book: string;
  chapter: number;
  translations: string[];
  verses: BibleVerseMulti[];
}

export interface CrossRefOut {
  to_verse_id: string;
  relation_type: string;
  text: string | null;
}

export interface SessionResponse {
  token: string;
  handle: string;
  display_name: string;
  email?: string | null;
  email_verified_at?: string | null;
  expires_at: string;
}

export interface UserProfile {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  languages: string[];
  preferences: Record<string, unknown>;
  phone_e164: string | null;
  phone_verified_at: string | null;
  /** Optional — set via PATCH /auth/me. Used for password-reset
   *  email delivery. `email_verified_at` stays null until a future
   *  verification flow flips it. */
  email?: string | null;
  email_verified_at?: string | null;
}

export interface RoomOut {
  id: string;
  type: string;
  name: string | null;
  scripture_context?: { focused_verse?: string };
  /** Caller's role IN THIS ROOM ('admin' | 'member'). Populated by
   *  GET /rooms — lets the Profile UI flag rooms the user
   *  administrates without a second round-trip. */
  role?: "admin" | "member";
  /** Server-relative URL for the room avatar, including a cache-busting
   *  `?v=<token>` query. Null when no admin has uploaded one — UI
   *  falls back to the gradient/initials avatar. */
  image_url?: string | null;
  /** Admin-picked accent color key (one of the palette in
   *  `accentColors.ts`). Null = use the auto-derived color from the
   *  room id. */
  accent_color?: string | null;
  /** Chat messages newer than the caller's `last_read_at` from anyone
   *  but themselves. Zero when caught up. Drives the in-app badge. */
  unread_count?: number;
  /** Most-recent chat message in this room. Null when the room has
   *  no chats yet. `last_message_at` is ISO-8601 UTC. */
  last_message_body?: string | null;
  last_message_at?: string | null;
  last_message_author_handle?: string | null;
}

export interface InviteOut {
  code: string;
  room_id: string;
  created_by: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  revoked: boolean;
}

export interface InvitePreview {
  room_id: string;
  room_name: string | null;
  room_type: string;
  inviter_handle: string;
  inviter_display_name: string;
  expires_at: string | null;
  can_join: boolean;
  reason: string | null;
}

export type AnnotationKind =
  | "highlight"
  | "underline"
  | "double_underline"
  | "wavy"
  | "box"
  | "bold";
export type AnnotationColor = "yellow" | "green" | "blue" | "pink" | "orange";

export interface AnnotationOut {
  /** Stable id — needed for sub-verse delete (the same (verse, kind)
   *  pair can yield multiple rows). */
  id: string;
  verse_id: string;
  kind: AnnotationKind;
  color: AnnotationColor;
  /** null + null = applies to the whole verse (legacy v1 shape).
   *  Both set = [start, end) character range over the verse text. */
  start_offset?: number | null;
  end_offset?: number | null;
  updated_at: string;
}

export interface BookmarkOut {
  book: string;
  chapter: number;
  verse: number;
  updated_at: string;
}

export interface BackupCodesResponse {
  codes: string[];
  generated_at: string;
}

export interface BackupCodesStatus {
  total: number;
  remaining: number;
  last_generated_at: string | null;
}

export interface PhoneStartResponse {
  phone_e164: string;
  cooldown_until: string;
  /** Only present in dev mode (no Twilio creds) — UI can auto-fill the
   *  code instead of asking the user to read it off the server log. */
  dev_code: string | null;
}

export interface ProfilePatch {
  display_name?: string;
  avatar_url?: string;
  languages?: string[];
  preferences?: Record<string, unknown>;
  /** Pass "" to clear the email. Anything else is set verbatim (the
   *  backend lowercases + validates shape). */
  email?: string;
}

export const api = {
  health: () => jsonFetch<{ ok: boolean }>("/health"),
  authMe: () => jsonFetch<UserProfile>("/auth/me"),
  authPatchMe: (patch: ProfilePatch) =>
    jsonFetch<UserProfile>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  authChangePassword: (current_password: string, new_password: string) =>
    jsonFetch<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password, new_password }),
    }),
  authDeleteMe: () =>
    jsonFetch<{ ok: boolean }>("/auth/me", { method: "DELETE" }),
  authPhoneStart: (phone: string) =>
    jsonFetch<PhoneStartResponse>("/auth/phone/start", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),
  authPhoneVerify: (code: string) =>
    jsonFetch<UserProfile>("/auth/phone/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  authPhoneRemove: () =>
    jsonFetch<{ ok: boolean }>("/auth/phone", { method: "DELETE" }),
  authBackupCodesGenerate: () =>
    jsonFetch<BackupCodesResponse>("/auth/backup-codes/generate", {
      method: "POST",
    }),
  authBackupCodesStatus: () =>
    jsonFetch<BackupCodesStatus>("/auth/backup-codes/status"),
  authBookmarksList: () =>
    jsonFetch<BookmarkOut[]>("/auth/bookmarks"),
  authBookmarkSet: (book: string, chapter: number, verse: number) =>
    jsonFetch<BookmarkOut>(`/auth/bookmarks/${book}`, {
      method: "PUT",
      body: JSON.stringify({ chapter, verse }),
    }),
  authBookmarkRemove: (book: string) =>
    jsonFetch<{ ok: boolean }>(`/auth/bookmarks/${book}`, {
      method: "DELETE",
    }),
  authBookmarkRemoveAt: (book: string, chapter: number, verse: number) =>
    jsonFetch<{ ok: boolean }>(
      `/auth/bookmarks/${book}/${chapter}/${verse}`,
      { method: "DELETE" },
    ),
  authAnnotationsList: () =>
    jsonFetch<AnnotationOut[]>("/auth/annotations"),
  /** Whole-verse or sub-verse upsert. Pass start/end to mark a
   *  character range; omit them for the v1 whole-verse semantics. */
  authAnnotationSet: (
    verse_id: string,
    kind: AnnotationKind,
    color: AnnotationColor,
    range?: { start: number; end: number } | null,
  ) =>
    jsonFetch<AnnotationOut>(`/auth/annotations/${verse_id}/${kind}`, {
      method: "PUT",
      body: JSON.stringify(
        range
          ? { color, start_offset: range.start, end_offset: range.end }
          : { color },
      ),
    }),
  authAnnotationRemoveKind: (verse_id: string, kind: AnnotationKind) =>
    jsonFetch<{ ok: boolean }>(`/auth/annotations/${verse_id}/${kind}`, {
      method: "DELETE",
    }),
  authAnnotationRemoveById: (annotation_id: string) =>
    jsonFetch<{ ok: boolean }>(
      `/auth/annotations/by-id/${annotation_id}`,
      { method: "DELETE" },
    ),
  authAnnotationClear: (verse_id: string) =>
    jsonFetch<{ ok: boolean }>(`/auth/annotations/${verse_id}`, {
      method: "DELETE",
    }),
  authRecover: (handle: string, backup_code: string, new_password: string) =>
    jsonFetch<SessionResponse>("/auth/recover", {
      method: "POST",
      body: JSON.stringify({ handle, backup_code, new_password }),
    }),
  /** Request a password-reset email. Always succeeds on the wire (the
   *  backend returns 200 even for unknown addresses to prevent
   *  enumeration) — surface a generic "check your email" message in
   *  the UI. The link in the email expires in 30 minutes. */
  authForgotPassword: (email: string) =>
    jsonFetch<{ ok: boolean }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  /** Consume a reset token from the email link. On success the user's
   *  password is changed AND every existing session is invalidated;
   *  the caller has to sign in fresh with the new password. */
  authResetPassword: (token: string, new_password: string) =>
    jsonFetch<{ ok: boolean }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    }),
  authRegister: (
    handle: string,
    password: string,
    display_name?: string,
  ) =>
    jsonFetch<SessionResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ handle, password, display_name }),
    }),
  authLogin: (handle: string, password: string) =>
    jsonFetch<SessionResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ handle, password }),
    }),
  authLogout: () =>
    jsonFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  createRoom: (type: "group" | "direct", name?: string) =>
    jsonFetch<RoomOut>("/rooms", {
      method: "POST",
      body: JSON.stringify({ type, name }),
    }),
  listRooms: () => jsonFetch<RoomOut[]>("/rooms"),
  createInvite: (
    room_id: string,
    expires_in_days: number | null = 7,
    max_uses: number | null = null,
  ) =>
    jsonFetch<InviteOut>(`/rooms/${room_id}/invites`, {
      method: "POST",
      body: JSON.stringify({ expires_in_days, max_uses }),
    }),
  listInvites: (room_id: string) =>
    jsonFetch<InviteOut[]>(`/rooms/${room_id}/invites`),
  revokeInvite: (code: string) =>
    jsonFetch<{ ok: boolean }>(`/invites/${code}`, { method: "DELETE" }),
  previewInvite: (code: string) =>
    jsonFetch<InvitePreview>(`/invites/${code}/preview`),
  acceptInvite: (code: string) =>
    jsonFetch<RoomOut>(`/invites/${code}/accept`, { method: "POST" }),
  reason: (room_id: string, verse_ref: string, question: string) =>
    jsonFetch<ReasoningResponse>("/reason", {
      method: "POST",
      body: JSON.stringify({ room_id, verse_ref, question }),
    }),
  bibleBooks: () => jsonFetch<BibleBookOut[]>("/bible/books"),
  bibleChapter: (book: string, chapter: number, translation?: string) =>
    jsonFetch<BibleChapterOut>(
      `/bible/${book}/${chapter}` +
        (translation
          ? `?translation=${encodeURIComponent(translation)}`
          : ""),
    ),
  bibleChapterMulti: (
    book: string,
    chapter: number,
    translations: string[],
  ) =>
    jsonFetch<BibleChapterMulti>(
      `/bible/${book}/${chapter}/multi?translations=${encodeURIComponent(translations.join(","))}`,
    ),
  /** Hebrew/Greek per-word study data for one verse. Returns an
   *  empty array if the verse has no token rows. */
  bibleVerseTokens: (book: string, chapter: number, verse: number) =>
    jsonFetch<VerseTokenOut[]>(
      `/bible/${book}/${chapter}/${verse}/tokens`,
    ),
  /** Caller removes themselves from a group room. Admins must
   *  promote another admin first; direct rooms can't be left. */
  leaveRoom: (room_id: string) =>
    jsonFetch<{ ok: boolean }>(`/rooms/${room_id}/leave`, {
      method: "POST",
      body: "{}",
    }),
  /** Admin-only delete of a group room. Drops members, chat, notes,
   *  and all their derivatives. Direct rooms can't be deleted. */
  deleteRoom: (room_id: string) =>
    jsonFetch<{ ok: boolean }>(`/rooms/${room_id}`, { method: "DELETE" }),
  /** Upload an image to use inside a note body. Returns the serve
   *  URL the client embeds as `<img src=…>`. */
  noteUploadImage: async (room_id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/rooms/${room_id}/notes/image`, {
      method: "POST",
      headers: {
        "X-App-Password": getPassword(),
        "X-Session-Token": getSessionToken(),
      },
      body: fd,
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as { token: string; serve_url: string };
  },
  /** Most recent reasoning-engine audit-log rows. Used by the
   *  Settings → Advanced auditor when debug mode is on. */
  provenanceList: (limit = 50) =>
    jsonFetch<ProvenanceRow[]>(`/admin/provenance?limit=${limit}`),
  bibleSearch: (q: string, translation?: string, limit = 50) =>
    jsonFetch<BibleSearchHit[]>(
      `/bible/search?q=${encodeURIComponent(q)}` +
        (translation ? `&translation=${encodeURIComponent(translation)}` : "") +
        `&limit=${limit}`,
    ),
  bibleAdvancedSearch: (q: string, translation?: string) =>
    jsonFetch<AdvancedSearchHit[]>(`/bible/advanced_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, translation }),
    }),
  notesSearch: (
    q: string,
    opts?: { scope?: "personal" | "group"; limit?: number },
  ) =>
    jsonFetch<NoteSearchHit[]>(
      `/notes/search?q=${encodeURIComponent(q)}` +
        (opts?.scope ? `&scope=${encodeURIComponent(opts.scope)}` : "") +
        `&limit=${opts?.limit ?? 50}`,
    ),
  notesAll: (opts?: { scope?: "personal" | "group"; limit?: number }) =>
    jsonFetch<NoteSearchHit[]>(
      `/notes/all?limit=${opts?.limit ?? 200}` +
        (opts?.scope ? `&scope=${encodeURIComponent(opts.scope)}` : ""),
    ),
  chatSearch: (q: string, opts?: { roomId?: string; limit?: number }) =>
    jsonFetch<ChatSearchHit[]>(
      `/chat/search?q=${encodeURIComponent(q)}` +
        (opts?.roomId ? `&room_id=${encodeURIComponent(opts.roomId)}` : "") +
        `&limit=${opts?.limit ?? 50}`,
    ),
  readingPlansList: () =>
    jsonFetch<ReadingPlanSummary[]>("/reading-plans"),
  readingPlanEnroll: (plan_id: string) =>
    jsonFetch<ReadingPlanSummary>(`/reading-plans/${plan_id}/enroll`, {
      method: "POST",
      body: "{}",
    }),
  readingPlanLeave: (plan_id: string) =>
    jsonFetch<{ ok: boolean }>(`/reading-plans/${plan_id}/enroll`, {
      method: "DELETE",
    }),
  readingPlanToday: (plan_id: string) =>
    jsonFetch<ReadingPlanDayOut>(`/reading-plans/${plan_id}/today`),
  readingPlanComplete: (plan_id: string, day_index: number) =>
    jsonFetch<ReadingPlanDayOut>(
      `/reading-plans/${plan_id}/days/${day_index}/complete`,
      { method: "POST", body: "{}" },
    ),
  chatList: (room_id: string, limit = 100) =>
    jsonFetch<ChatMessageOut[]>(
      `/rooms/${room_id}/chat?limit=${limit}`,
    ),
  chatPost: (
    room_id: string,
    body: string,
    language?: string,
    reply_to_id?: string,
  ) =>
    jsonFetch<ChatMessageOut>(`/rooms/${room_id}/chat`, {
      method: "POST",
      body: JSON.stringify({ body, language, reply_to_id }),
    }),
  /** Admin-only toggle of a message's pinned state. Returns the
   *  updated message; the WS hub also re-broadcasts so other tabs
   *  refresh automatically. */
  chatPin: (room_id: string, message_id: string) =>
    jsonFetch<ChatMessageOut>(
      `/rooms/${room_id}/chat/${message_id}/pin`,
      { method: "POST", body: "{}" },
    ),
  chatReact: (room_id: string, message_id: string, emoji: string) =>
    jsonFetch<ChatMessageOut>(
      `/rooms/${room_id}/chat/${message_id}/react`,
      {
        method: "POST",
        body: JSON.stringify({ emoji }),
      },
    ),
  /** Delete one of your own chat messages. Backend verifies the
   *  caller is the author. Other tabs receive a `{_op: "delete",
   *  id}` envelope over the chat WS and drop the row locally. */
  chatDelete: (room_id: string, message_id: string) =>
    jsonFetch<void>(`/rooms/${room_id}/chat/${message_id}`, {
      method: "DELETE",
    }),
  chatPostImage: async (
    room_id: string,
    file: File,
    caption = "",
    reply_to_id = "",
  ) => {
    const form = new FormData();
    form.append("file", file);
    form.append("body", caption);
    if (reply_to_id) form.append("reply_to_id", reply_to_id);
    const headers: Record<string, string> = {};
    const pw = getPassword();
    if (pw) headers["X-App-Password"] = pw;
    const tok = getSessionToken();
    if (tok) headers["X-Session-Token"] = tok;
    const r = await fetch(`/api/rooms/${room_id}/chat/image`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return (await r.json()) as ChatMessageOut;
  },
  // ── Room statuses (24h "stories" panel above chat) ───────────
  statusList: (room_id: string) =>
    jsonFetch<StatusOut[]>(`/rooms/${room_id}/statuses`),
  statusCreate: (
    room_id: string,
    body: string,
    attachment_image_token?: string,
  ) =>
    jsonFetch<StatusOut>(`/rooms/${room_id}/statuses`, {
      method: "POST",
      body: JSON.stringify({
        body,
        attachment_image_token: attachment_image_token ?? null,
      }),
    }),
  statusDelete: (room_id: string, status_id: string) =>
    jsonFetch<void>(`/rooms/${room_id}/statuses/${status_id}`, {
      method: "DELETE",
    }),
  statusView: (room_id: string, status_id: string) =>
    jsonFetch<void>(`/rooms/${room_id}/statuses/${status_id}/view`, {
      method: "POST",
      body: "{}",
    }),
  statusUploadImage: async (room_id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = {};
    const pw = getPassword();
    if (pw) headers["X-App-Password"] = pw;
    const tok = getSessionToken();
    if (tok) headers["X-Session-Token"] = tok;
    const r = await fetch(`/api/rooms/${room_id}/statuses/image`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return (await r.json()) as { attachment_image_token: string };
  },
  bibleXrefs: (verse_id: string, limit = 25) =>
    jsonFetch<CrossRefOut[]>(
      `/bible/xrefs/${verse_id}?limit=${limit}`,
    ),
  noteRegisterGroup: (room_id: string, note_id: string) =>
    jsonFetch<{ ok: boolean }>(
      `/rooms/${room_id}/notes/${note_id}/register_group`,
      { method: "POST", body: "{}" },
    ),
  /** Author-only delete for a GROUP note. The server validates
   *  authorship from the shared Yjs doc and applies the delete on
   *  its side; the sync layer then broadcasts the removal to every
   *  connected client (including this one). Non-authors get 403. */
  noteDeleteGroup: (room_id: string, note_id: string) =>
    jsonFetch<{ ok: string }>(`/rooms/${room_id}/notes/${note_id}`, {
      method: "DELETE",
    }),
  roomMembers: (room_id: string) =>
    jsonFetch<RoomMemberOut[]>(`/rooms/${room_id}/members`),
  roomMemberPatch: (room_id: string, user_id: string, role: "admin" | "member") =>
    jsonFetch<RoomMemberOut>(`/rooms/${room_id}/members/${user_id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  roomMemberRemove: (room_id: string, user_id: string) =>
    jsonFetch<{ ok: boolean }>(`/rooms/${room_id}/members/${user_id}`, {
      method: "DELETE",
    }),
  roomAgentSettings: (room_id: string) =>
    jsonFetch<AgentSettingsOut>(`/rooms/${room_id}/agent_settings`),
  roomQuota: (room_id: string) =>
    jsonFetch<QuotaStatus>(`/rooms/${room_id}/quota`),
  roomImageUpload: async (room_id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    // jsonFetch sets Content-Type to application/json, which kills the
    // multipart boundary. Drop down to raw fetch here.
    const headers: Record<string, string> = {};
    const pw = getPassword();
    if (pw) headers["X-App-Password"] = pw;
    const tok = getSessionToken();
    if (tok) headers["X-Session-Token"] = tok;
    const r = await fetch(`/api/rooms/${room_id}/image`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return (await r.json()) as { image_url: string | null };
  },
  roomImageDelete: (room_id: string) =>
    jsonFetch<{ image_url: string | null }>(`/rooms/${room_id}/image`, {
      method: "DELETE",
    }),
  roomAccentPatch: (room_id: string, accent_color: string | null) =>
    jsonFetch<RoomOut>(`/rooms/${room_id}/accent`, {
      method: "PATCH",
      body: JSON.stringify({ accent_color }),
    }),
  /** Admin-only group rename. DMs are auto-named and reject this. */
  roomNamePatch: (room_id: string, name: string) =>
    jsonFetch<RoomOut>(`/rooms/${room_id}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  /** Tell the server which `@handle`s appear in a group note's body.
   *  Backend resolves to room members, dedupes per (note, user) via
   *  the unique constraint on note_mentions, and Web-Pushes each NEW
   *  mention. Safe to call on every save — repeats are no-ops. */
  noteMention: (room_id: string, note_id: string, handles: string[]) =>
    jsonFetch<{ sent: number }>(
      `/rooms/${room_id}/notes/${note_id}/mention`,
      {
        method: "POST",
        body: JSON.stringify({ handles }),
      },
    ),
  roomMarkRead: (room_id: string) =>
    jsonFetch<{ unread_count: number }>(`/rooms/${room_id}/read`, {
      method: "POST",
      body: "{}",
    }),
  dmOpen: (target_user_id: string) =>
    jsonFetch<RoomOut>(`/dm/${target_user_id}`, {
      method: "POST",
      body: "{}",
    }),
  userPublic: (user_id: string) =>
    jsonFetch<PublicUserView>(`/auth/users/${user_id}`),
  /** Pass `roomId` to scope the list to that room's members (matches
   *  the chat Contacts sheet expectation that it shows the current
   *  group, not every contact across every room). Omit for the
   *  full cross-room contact set. */
  contactsList: (roomId?: string) =>
    jsonFetch<ContactView[]>(
      roomId ? `/contacts?room_id=${encodeURIComponent(roomId)}` : `/contacts`,
    ),
  authImageUpload: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = {};
    const pw = getPassword();
    if (pw) headers["X-App-Password"] = pw;
    const tok = getSessionToken();
    if (tok) headers["X-Session-Token"] = tok;
    const r = await fetch(`/api/auth/me/image`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return (await r.json()) as { avatar_url: string | null };
  },
  authImageDelete: () =>
    jsonFetch<{ avatar_url: string | null }>(`/auth/me/image`, {
      method: "DELETE",
    }),
  roomAgentSettingsPatch: (room_id: string, settings: AgentSettingsOut) =>
    jsonFetch<AgentSettingsOut>(`/rooms/${room_id}/agent_settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  noteSocial: (room_id: string, note_id: string) =>
    jsonFetch<NoteSocialOut>(`/rooms/${room_id}/notes/${note_id}/social`),
  noteLikeToggle: (
    room_id: string,
    note_id: string,
    kind: NoteReactionKind = "heart",
  ) =>
    jsonFetch<NoteSocialOut>(
      `/rooms/${room_id}/notes/${note_id}/like?kind=${encodeURIComponent(kind)}`,
      { method: "POST" },
    ),
  noteCommentAdd: (room_id: string, note_id: string, body: string) =>
    jsonFetch<NoteSocialOut>(`/rooms/${room_id}/notes/${note_id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  noteCommentDelete: (room_id: string, note_id: string, comment_id: string) =>
    jsonFetch<NoteSocialOut>(
      `/rooms/${room_id}/notes/${note_id}/comments/${comment_id}`,
      { method: "DELETE" },
    ),
};

export interface QuotaStatus {
  /** Admin-set per-room daily cap. null = unlimited. */
  limit: number | null;
  /** Questions the caller has already used today in this room. */
  used: number;
  /** `limit - used` clamped to 0, or null when limit is null. */
  remaining: number | null;
}

export interface ReadingPlanSummary {
  id: string;
  name: string;
  summary: string;
  length_days: number;
  enrolled: boolean;
  current_day: number | null;
  completed_days: number;
  streak_days: number;
}

export interface ReadingPlanDayOut {
  plan_id: string;
  day_index: number;
  refs: string[];        // OSIS-style: "PSA.23", "JHN.3.16-21"
  completed: boolean;
}

export interface PublicUserView {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  languages: string[];
}

export interface ContactView {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

export interface StatusOut {
  id: string;
  room_id: string;
  author_user_id: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_url: string | null;
  body: string;
  /** Server-relative image URL (already includes `?v=token`).
   *  null when the status is text-only. */
  image_url: string | null;
  created_at: string;
  expires_at: string;
  /** How many distinct viewers (excluding the author) have seen it. */
  view_count: number;
  /** Has the calling user viewed this status? */
  viewer_has_viewed: boolean;
}

export interface ChatMessageOut {
  id: string;
  room_id: string;
  author_user_id: string | null;
  author_is_agent: boolean;
  body: string;
  language: string | null;
  author_handle: string | null;
  author_display_name: string | null;
  /** Resolved avatar URL (server-relative). Frontend prepends `/api`
   *  and appends the auth query params via `Avatar`'s prefix helper. */
  author_avatar_url: string | null;
  /** When set, the message has an image attachment. The URL is
   *  server-relative; render through the same withApiPrefix path as
   *  avatars so the deployment password + session token are appended. */
  attachment_image_url: string | null;
  /** When this message is a reply, the parent's id + hydrated
   *  preview snippets so the bubble can render the quoted block
   *  above the body. */
  reply_to_id: string | null;
  reply_to_body: string | null;
  reply_to_author_handle: string | null;
  reply_to_has_image: boolean;
  /** Aggregated reactions on this message. `mine` is true when the
   *  viewer has applied this emoji — drives the highlighted state on
   *  the reaction pill. Empty array when no reactions. */
  reactions: { emoji: string; count: number; mine: boolean }[];
  created_at: string | null;
  /** ISO timestamp when an admin pinned this message; null = not
   *  pinned. The chat panel sorts pinned messages to the top. */
  pinned_at: string | null;
}

export interface NoteCommentOut {
  id: string;
  note_id: string;
  /** Null when the original author has deleted their account — the
   *  comment body stays for room history, but the UI shows
   *  "(deleted user)" instead of a handle. */
  author_user_id: string | null;
  author_handle: string;
  author_display_name: string;
  body: string;
  created_at: string;
}

export interface NoteSocialOut {
  /** Heart count + my-heart flag — original reaction kind. */
  likes: number;
  liked_by_me: boolean;
  /** Thumbs-up count + my-thumb flag. Backend defaults these to
   *  0 / false so old clients see no thumbs (forward-compat). */
  thumbsups?: number;
  thumbsuped_by_me?: boolean;
  comments: NoteCommentOut[];
}

export type NoteReactionKind = "heart" | "thumbsup";

export interface RoomMemberOut {
  user_id: string;
  handle: string;
  display_name: string;
  role: "admin" | "member";
  joined_at: string;
}

export interface AgentSettingsOut {
  agent_enabled: boolean;
  allow_web_search: boolean;
  allow_external_links: boolean;
  bypass_citation_engine_allowed: boolean;
  max_questions_per_user_per_day: number | null;
}

/** Streaming reasoning over WebSocket. Events flow back via the supplied
 *  callbacks; the returned `close` cancels the connection.
 *
 *  Citations are NOT streamed individually — the citation engine verifies
 *  them all before the final `onResult` fires (citation-engine.MD §10).
 *  Only the model's chain-of-thought reasoning streams live.
 */
export interface ReasoningHistoryTurn {
  verse_ref: string;
  question: string;
  answer: string;
}

export function streamReason(
  body: {
    room_id: string;
    verse_ref: string;
    question: string;
    target_language?: string;
    history?: ReasoningHistoryTurn[];
    /** Off-by-default kill-switch. When true, the orchestrator skips
     *  the citation engine and rule layer (user-toggled in Settings,
     *  overriding rule-guide.MD §14 / citation-engine.MD §10). */
    bypass_citation_engine?: boolean;
    /** Caller's current zoom level. The backend retriever uses this
     *  to expand or narrow the scripture context. Deeper → narrower,
     *  wider → broader (markdown-style hierarchy). */
    scope_kind?: "verse" | "chapter" | "book" | "testament" | "bible";
    /** Which English translation the user is reading on the Bible
     *  page. Only affects the WORDING the agent quotes when citing
     *  verses so it matches what's on screen. Grounding always
     *  anchors to the original-language Hebrew/Greek anchor —
     *  independent of this field. Defaults to KJV server-side. */
    citation_translation?: string;
  },
  cb: {
    onStage?: (name: string, count: number | null) => void;
    onReasoningChunk?: (text: string) => void;
    onResult?: (r: ReasoningResponse) => void;
    onError?: (msg: string) => void;
    onClose?: () => void;
  },
): { close: () => void } {
  const pw = encodeURIComponent(getPassword());
  const tok = encodeURIComponent(getSessionToken());
  // Vite proxies /ws to the backend so this URL works in dev + prod.
  const url =
    (location.protocol === "https:" ? "wss:" : "ws:") +
    "//" +
    location.host +
    `/ws/reason?password=${pw}&session=${tok}`;
  const ws = new WebSocket(url);
  ws.onopen = () => ws.send(JSON.stringify(body));
  ws.onmessage = (e) => {
    let evt: any;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt.type === "stage") cb.onStage?.(evt.name, evt.count ?? null);
    else if (evt.type === "reasoning_chunk") cb.onReasoningChunk?.(evt.text);
    else if (evt.type === "result") {
      cb.onResult?.(evt as ReasoningResponse);
      ws.close();
    } else if (evt.type === "error") {
      cb.onError?.(evt.message ?? "stream error");
      ws.close();
    }
  };
  ws.onclose = () => cb.onClose?.();
  ws.onerror = () => cb.onError?.("websocket error");
  return { close: () => ws.close() };
}

/** OSIS book code → display name (e.g. "JHN" → "John"). Used for
 *  share-card labels + anywhere we need a human-readable book. */
export const OSIS_TO_BOOK_NAME: Record<string, string> = {
  GEN: "Genesis", EXO: "Exodus", LEV: "Leviticus", NUM: "Numbers",
  DEU: "Deuteronomy", JOS: "Joshua", JDG: "Judges", RUT: "Ruth",
  "1SA": "1 Samuel", "2SA": "2 Samuel",
  "1KI": "1 Kings", "2KI": "2 Kings",
  "1CH": "1 Chronicles", "2CH": "2 Chronicles",
  EZR: "Ezra", NEH: "Nehemiah", EST: "Esther",
  JOB: "Job", PSA: "Psalms", PRO: "Proverbs",
  ECC: "Ecclesiastes", SNG: "Song of Solomon",
  ISA: "Isaiah", JER: "Jeremiah", LAM: "Lamentations",
  EZK: "Ezekiel", DAN: "Daniel",
  HOS: "Hosea", JOL: "Joel", AMO: "Amos",
  OBA: "Obadiah", JON: "Jonah", MIC: "Micah",
  NAM: "Nahum", HAB: "Habakkuk", ZEP: "Zephaniah",
  HAG: "Haggai", ZEC: "Zechariah", MAL: "Malachi",
  MAT: "Matthew", MRK: "Mark", LUK: "Luke",
  JHN: "John", ACT: "Acts", ROM: "Romans",
  "1CO": "1 Corinthians", "2CO": "2 Corinthians",
  GAL: "Galatians", EPH: "Ephesians", PHP: "Philippians",
  COL: "Colossians",
  "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
  "1TI": "1 Timothy", "2TI": "2 Timothy",
  TIT: "Titus", PHM: "Philemon", HEB: "Hebrews",
  JAS: "James", "1PE": "1 Peter", "2PE": "2 Peter",
  "1JN": "1 John", "2JN": "2 John", "3JN": "3 John",
  JUD: "Jude", REV: "Revelation",
};


/** Parse "trans:KJV:JHN.3.16" or "JHN.3.16" → {book, chapter, verse}.
 *  Returns null when the id doesn't look like a verse reference. */
export function parseVerseRef(
  id: string,
): { book: string; chapter: number; verse: number; ref: string } | null {
  // Find the trailing verse_id (BOOK.CH.V).
  const m = id.match(/([A-Z0-9]+)\.(\d+)\.(\d+)\s*$/);
  if (!m) return null;
  return {
    book: m[1],
    chapter: Number(m[2]),
    verse: Number(m[3]),
    ref: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

/** Human book name (and common abbreviations) → OSIS code. */
export const BOOK_NAME_TO_OSIS: Record<string, string> = {
  genesis: "GEN", gen: "GEN",
  exodus: "EXO", exod: "EXO", exo: "EXO",
  leviticus: "LEV", lev: "LEV",
  numbers: "NUM", num: "NUM",
  deuteronomy: "DEU", deut: "DEU", deu: "DEU",
  joshua: "JOS", josh: "JOS", jos: "JOS",
  judges: "JDG", judg: "JDG", jdg: "JDG",
  ruth: "RUT", rut: "RUT",
  "1samuel": "1SA", "1sam": "1SA", "1sa": "1SA",
  "2samuel": "2SA", "2sam": "2SA", "2sa": "2SA",
  "1kings": "1KI", "1kgs": "1KI", "1ki": "1KI",
  "2kings": "2KI", "2kgs": "2KI", "2ki": "2KI",
  "1chronicles": "1CH", "1chron": "1CH", "1chr": "1CH", "1ch": "1CH",
  "2chronicles": "2CH", "2chron": "2CH", "2chr": "2CH", "2ch": "2CH",
  ezra: "EZR", ezr: "EZR",
  nehemiah: "NEH", neh: "NEH",
  esther: "EST", esth: "EST", est: "EST",
  job: "JOB",
  psalms: "PSA", psalm: "PSA", ps: "PSA", psa: "PSA",
  proverbs: "PRO", prov: "PRO", pro: "PRO",
  ecclesiastes: "ECC", eccl: "ECC", ecc: "ECC",
  songofsolomon: "SNG", song: "SNG", canticles: "SNG", sng: "SNG",
  isaiah: "ISA", isa: "ISA",
  jeremiah: "JER", jer: "JER",
  lamentations: "LAM", lam: "LAM",
  ezekiel: "EZK", ezek: "EZK", ezk: "EZK",
  daniel: "DAN", dan: "DAN",
  hosea: "HOS", hos: "HOS",
  joel: "JOL", jol: "JOL",
  amos: "AMO", amo: "AMO",
  obadiah: "OBA", obad: "OBA", oba: "OBA",
  jonah: "JON", jon: "JON",
  micah: "MIC", mic: "MIC",
  nahum: "NAM", nah: "NAM", nam: "NAM",
  habakkuk: "HAB", hab: "HAB",
  zephaniah: "ZEP", zeph: "ZEP", zep: "ZEP",
  haggai: "HAG", hag: "HAG",
  zechariah: "ZEC", zech: "ZEC", zec: "ZEC",
  malachi: "MAL", mal: "MAL",
  matthew: "MAT", matt: "MAT", mat: "MAT",
  mark: "MRK", mrk: "MRK",
  luke: "LUK", luk: "LUK",
  john: "JHN", jhn: "JHN",
  acts: "ACT", act: "ACT",
  romans: "ROM", rom: "ROM",
  "1corinthians": "1CO", "1cor": "1CO", "1co": "1CO",
  "2corinthians": "2CO", "2cor": "2CO", "2co": "2CO",
  galatians: "GAL", gal: "GAL",
  ephesians: "EPH", eph: "EPH",
  philippians: "PHP", phil: "PHP", php: "PHP",
  colossians: "COL", col: "COL",
  "1thessalonians": "1TH", "1thess": "1TH", "1th": "1TH",
  "2thessalonians": "2TH", "2thess": "2TH", "2th": "2TH",
  "1timothy": "1TI", "1tim": "1TI", "1ti": "1TI",
  "2timothy": "2TI", "2tim": "2TI", "2ti": "2TI",
  titus: "TIT", tit: "TIT",
  philemon: "PHM", phlm: "PHM", phm: "PHM",
  hebrews: "HEB", heb: "HEB",
  james: "JAS", jas: "JAS",
  "1peter": "1PE", "1pet": "1PE", "1pe": "1PE",
  "2peter": "2PE", "2pet": "2PE", "2pe": "2PE",
  "1john": "1JN", "1jn": "1JN",
  "2john": "2JN", "2jn": "2JN",
  "3john": "3JN", "3jn": "3JN",
  jude: "JUD", jud: "JUD",
  revelation: "REV", rev: "REV", apocalypse: "REV",
};

/** Resolve "Jeremiah 25:12" → "JER.25.12" or null. Tolerates leading
 *  numbers ("1 John 4:19"), spaces, dots, and common abbreviations. */
export function osisFromHuman(
  bookText: string,
  chapter: string | number,
  verse: string | number,
): string | null {
  const key = bookText.toLowerCase().replace(/[\s.]+/g, "");
  const osis = BOOK_NAME_TO_OSIS[key];
  if (!osis) return null;
  const ch = Number(chapter);
  const v = Number(verse);
  if (!ch || !v) return null;
  return `${osis}.${ch}.${v}`;
}

/** OSIS code → original-language Translation name. */
export function originalForBook(book: string): "Hebrew (WLC)" | "Greek (TR)" {
  // OT codes (first 39 of the canonical OSIS order).
  const OT = new Set([
    "GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA",
    "1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO",
    "ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO",
    "OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL",
  ]);
  return OT.has(book.toUpperCase()) ? "Hebrew (WLC)" : "Greek (TR)";
}

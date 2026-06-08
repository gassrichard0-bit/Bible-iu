/**
 * Web Speech API wrapper for read-aloud features.
 *
 * Why client-only: the browser's SpeechSynthesis runs on the device,
 * so there's no per-call cost, no privacy concern (the text never
 * leaves the page), and offline TTS just works on most modern OSes
 * (macOS, Windows, Android, iOS Safari 14.5+).
 *
 * Voice quality:
 *   The default voice picked by `getVoices()` is usually the
 *   stripped-down robot-y one. Modern OSes ship high-quality
 *   voices that aren't selected automatically — you have to ask
 *   for them by name. `pickBestVoice()` ranks the catalog so we
 *   land on a natural one (iOS Siri, macOS Premium/Enhanced,
 *   Android Google neural, Microsoft Natural) instead of the
 *   compact eSpeak-style fallback.
 *
 *   Per-platform iOS users get the cleanest result by installing
 *   one of the "Enhanced" voices in Settings → Accessibility →
 *   Spoken Content → Voices. We can't trigger that download, but
 *   if it's installed we'll find and use it.
 *
 * Voices load asynchronously on Chrome/Edge — the first
 * `getVoices()` call after page load often returns []. We
 * `await` the `voiceschanged` event before picking so the first
 * tap doesn't fall back to the robot voice.
 */

/** Substring markers that flag a "good" voice in its name. Ordered
 *  by quality, best first — first match wins in `pickBestVoice`. */
const QUALITY_HINTS: string[] = [
  // Apple's neural voices, iOS 16+ / macOS Ventura+
  "(Neural)",
  "Neural",
  // Apple's premium tier — distinct voice files downloaded by the OS
  "(Premium)",
  "Premium",
  // Apple's mid-tier enhanced voices, available since iOS 11 / macOS
  "(Enhanced)",
  "Enhanced",
  // Microsoft Edge's neural voices on Windows
  "Natural",
  // Apple's Siri voices on iOS / macOS — better than the default
  // "Compact" voices even when not marked Enhanced
  "Siri",
  // Google's chrome-shipped voices on Android + ChromeOS — way
  // better than the OS default
  "Google",
];

/** Default fallback voice names. When none of the quality hints
 *  match, prefer one of these by name — these are the named
 *  high-quality voices common across Apple devices that don't
 *  carry an explicit "(Enhanced)" suffix on every system. */
const PREFERRED_NAMES: string[] = [
  "Samantha", // US English, the default Siri voice on iOS
  "Daniel",   // UK English
  "Karen",    // AU English
  "Moira",    // Irish English
  "Tessa",    // South African English
  "Alex",     // macOS premium voice (rare on iOS)
];


function _voicesNow(synth: SpeechSynthesis): SpeechSynthesisVoice[] {
  // Some browsers (Chrome on first paint) return [] until the
  // `voiceschanged` event fires; callers above this layer wait
  // for that before tapping us.
  return synth.getVoices?.() ?? [];
}


let _voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;
function _readyVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve([]);
  if (_voicesReady) return _voicesReady;
  _voicesReady = new Promise((resolve) => {
    const immediate = _voicesNow(synth);
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }
    // Some browsers fire onvoiceschanged exactly once; others fire
    // it repeatedly. Either way we resolve on the first fire.
    const handler = () => {
      synth.removeEventListener?.("voiceschanged", handler);
      resolve(_voicesNow(synth));
    };
    synth.addEventListener?.("voiceschanged", handler);
    // Hard timeout so we don't hang forever on browsers that never
    // fire the event (some webviews).
    setTimeout(() => resolve(_voicesNow(synth)), 800);
  });
  return _voicesReady;
}


function pickBestVoice(
  voices: SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const langPrefix = language.slice(0, 2).toLowerCase();
  // Three-tier filter: exact-language-tag voices first (en-US for
  // en-US), then voices with the same primary subtag (en-GB for
  // en-US), then everything as a last resort.
  const exact = voices.filter((v) => v.lang === language);
  const sameLang = voices.filter(
    (v) => v.lang.slice(0, 2).toLowerCase() === langPrefix,
  );
  // Try each quality tier across the strictest matching language pool.
  for (const pool of [exact, sameLang, voices]) {
    if (pool.length === 0) continue;
    for (const hint of QUALITY_HINTS) {
      const match = pool.find((v) =>
        v.name.toLowerCase().includes(hint.toLowerCase()),
      );
      if (match) return match;
    }
    // No quality marker — try the named preferred voices.
    for (const name of PREFERRED_NAMES) {
      const match = pool.find((v) =>
        v.name.toLowerCase().startsWith(name.toLowerCase()),
      );
      if (match) return match;
    }
    // Prefer the OS's `default = true` voice within the pool.
    const dflt = pool.find((v) => v.default);
    if (dflt) return dflt;
    // Last resort within this pool — first one.
    return pool[0];
  }
  return null;
}


export interface SpeakHandle {
  stop: () => void;
}


/**
 * Simple Deepgram Aura playback. Fetches MP3 from the backend proxy
 * and plays via HTMLAudioElement — the same path that was working
 * before I started piling on primers / Web Audio / fallbacks. No
 * autoplay-block "fallbacks" because every layer of "safety" I
 * added just hid the actual playback further behind ceremony.
 * This is intentionally the simplest implementation that the user
 * confirmed worked when we first switched off the robot voice.
 */
/** Dispatch a diagnostic event the UI can listen to and render. Plain
 *  console.log isn't useful when iOS Safari Web Inspector isn't
 *  connected. */
function _ttsLog(stage: string, detail?: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("tts:diag", { detail: { stage, detail, at: Date.now() } }),
    );
    // eslint-disable-next-line no-console
    console.log("[tts]", stage, detail ?? "");
  } catch {
    // ignore
  }
}


export function speak(
  text: string,
  opts?: {
    language?: string;
    rate?: number;
    pitch?: number;
    voice?: string;
    onEnd?: () => void;
  },
): SpeakHandle | null {
  if (typeof window === "undefined") return null;
  const trimmed = stripForTTS(text);
  if (!trimmed) {
    _ttsLog("empty-after-strip");
    return null;
  }
  _ttsLog("speak-start", `${trimmed.length} chars`);
  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  let blobUrl: string | null = null;

  let stopBuffer: (() => void) | null = null;

  void (async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const password = _getPassword();
    if (password) headers["X-App-Password"] = password;
    _ttsLog("fetching", { hasPassword: !!password });
    let resp: Response;
    try {
      resp = await fetch("/api/tts/speak", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: trimmed,
          voice: opts?.voice ?? _readPreferredVoice(),
        }),
      });
    } catch (e) {
      _ttsLog("fetch-error", (e as Error).message);
      return;
    }
    _ttsLog("fetch-resp", `status ${resp.status}`);
    if (stopped) return;
    if (!resp.ok || resp.status === 204) {
      _ttsLog(resp.status === 204 ? "backend-returned-204" : "fetch-not-ok");
      return;
    }
    const buf = await resp.arrayBuffer();
    if (stopped) return;
    _ttsLog("got-mp3", `${buf.byteLength} bytes`);

    // Try AudioContext + BufferSource — the only autoplay-safe path
    // for audio fired outside a user gesture (e.g. agent answers in
    // useEffect). The context was resumed earlier by the primer on
    // the user's first interaction with the app.
    const audioBuffer = await decodeAudioBuffer(buf);
    if (stopped) return;
    if (audioBuffer) {
      _ttsLog("decoded", `${audioBuffer.duration.toFixed(1)}s`);
      const handle = await playAudioBuffer(audioBuffer, {
        rate: opts?.rate ?? 0.9,
        onEnd: () => {
          _ttsLog("buffer-ended");
          opts?.onEnd?.();
        },
      });
      if (handle) {
        _ttsLog("buffer-playing");
        stopBuffer = handle;
        return;
      }
      _ttsLog("buffer-play-failed-ctx-suspended");
    } else {
      _ttsLog("decode-failed");
    }

    // Fall through to HTMLAudioElement. This path requires a user
    // gesture on most browsers — useful for the Bible reader where
    // the user tapped a Play button, but agent auto-speak via this
    // path will hit NotAllowedError.
    blobUrl = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
    audio = new Audio(blobUrl);
    audio.playbackRate = opts?.rate ?? 0.9;
    audio.onended = () => {
      _ttsLog("audio-ended");
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
      opts?.onEnd?.();
    };
    audio.onerror = () => {
      _ttsLog("audio-error", audio?.error?.message);
    };
    try {
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => _ttsLog("play-started")).catch((e) => {
          _ttsLog(
            "play-rejected",
            (e as Error).name + ": " + (e as Error).message,
          );
        });
      } else {
        _ttsLog("play-no-promise");
      }
    } catch (e) {
      _ttsLog("play-threw", (e as Error).message);
    }
  })();

  return {
    stop: () => {
      stopped = true;
      stopBuffer?.();
      if (audio) {
        try {
          audio.pause();
        } catch {
          // best-effort
        }
        audio = null;
      }
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
        blobUrl = null;
      }
    },
  };
}


/** Look up the deployment password the rest of the app uses for
 *  authenticated requests. Mirrors `getPassword()` in lib/api but
 *  inlined here to avoid an import cycle with the TTS module. */
function _getPassword(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("bible-iu:password");
  } catch {
    return null;
  }
}


/** Pull the user's chosen Deepgram Aura voice from settings. Inlined
 *  reader to avoid an import cycle with lib/settings. */
function _readPreferredVoice(): string {
  if (typeof window === "undefined") return "aura-athena-en";
  try {
    const raw = window.localStorage.getItem("bible-iu:settings");
    if (!raw) return "aura-athena-en";
    const parsed = JSON.parse(raw) as { ttsVoice?: unknown };
    if (typeof parsed.ttsVoice === "string" && parsed.ttsVoice) {
      return parsed.ttsVoice;
    }
  } catch {
    // ignore
  }
  return "aura-athena-en";
}


/** Aura voices the UI picker offers — labels mirror Deepgram's
 *  marketing descriptions, sorted by gender then style. */
export const TTS_VOICES: { id: string; label: string; gender: "F" | "M" }[] = [
  { id: "aura-athena-en", label: "Athena · articulate, clear", gender: "F" },
  { id: "aura-luna-en", label: "Luna · warm, natural", gender: "F" },
  { id: "aura-stella-en", label: "Stella · cheerful", gender: "F" },
  { id: "aura-asteria-en", label: "Asteria · neutral", gender: "F" },
  { id: "aura-hera-en", label: "Hera · expressive", gender: "F" },
  { id: "aura-orion-en", label: "Orion · deep", gender: "M" },
  { id: "aura-arcas-en", label: "Arcas · moderate", gender: "M" },
  { id: "aura-perseus-en", label: "Perseus · energetic", gender: "M" },
];


/** Public wrapper around the Web Speech API. Use for auto-play
 *  scenarios (e.g. agent answers fired inside useEffect) where
 *  Deepgram's autoplay-blocked audio element would silently drop.
 *  Web Speech doesn't require a user gesture in most browsers. */
export function speakWebSpeech(
  text: string,
  opts?: { language?: string; rate?: number; pitch?: number; onEnd?: () => void },
): SpeakHandle | null {
  return _speakWebSpeech(stripForTTS(text), opts);
}


/** Web Speech fallback — the original implementation. */
function _speakWebSpeech(
  text: string,
  opts?: { language?: string; rate?: number; pitch?: number; onEnd?: () => void },
): SpeakHandle | null {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== "function") return null;
  const language = opts?.language ?? "en-US";
  try {
    synth.cancel();
  } catch {
    // some implementations throw before any utterance has run
  }
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = language;
  utt.rate = opts?.rate ?? 0.95;
  utt.pitch = opts?.pitch ?? 1;
  if (opts?.onEnd) utt.onend = () => opts.onEnd?.();
  void _readyVoices().then((voices) => {
    const v = pickBestVoice(voices, language);
    if (v) utt.voice = v;
    try {
      synth.speak(utt);
    } catch {
      // best-effort
    }
  });
  return {
    stop: () => {
      try {
        synth.cancel();
      } catch {
        // best-effort
      }
    },
  };
}


/** Kick the voice catalog so the first tap doesn't speak with the
 *  default voice while the list is still loading. Cheap and safe to
 *  call multiple times. */
export function warmupVoices(): void {
  if (typeof window === "undefined") return;
  void _readyVoices();
}


// Web Audio API context — the reliable autoplay path on iOS PWA.
// HTMLAudioElement.play() is blocked outside a user gesture even
// after a primer in standalone PWA mode; AudioContext + BufferSource
// is allowed once the context has been resumed during ANY prior user
// gesture. We resume the context on the first touch/click/keypress.

type AnyAudioContext = typeof AudioContext extends new (...args: any[]) => infer T
  ? T
  : never;

let _audioCtx: AnyAudioContext | null = null;
let _currentSource: AudioBufferSourceNode | null = null;

function _ensureAudioCtx(): AnyAudioContext | null {
  if (typeof window === "undefined") return null;
  if (_audioCtx) return _audioCtx;
  const Ctx =
    (window.AudioContext as unknown as typeof AudioContext) ||
    ((window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext as typeof AudioContext | undefined);
  if (!Ctx) return null;
  try {
    _audioCtx = new Ctx();
    return _audioCtx;
  } catch {
    return null;
  }
}

/** Decode an MP3 ArrayBuffer into an AudioBuffer using the shared
 *  AudioContext. Returns null if Web Audio is unavailable or the
 *  buffer can't be decoded. */
export async function decodeAudioBuffer(
  buf: ArrayBuffer,
): Promise<AudioBuffer | null> {
  const ctx = _ensureAudioCtx();
  if (!ctx) return null;
  try {
    return await ctx.decodeAudioData(buf.slice(0));
  } catch {
    return null;
  }
}

/** Play a decoded AudioBuffer. Returns null if the AudioContext is
 *  suspended and can't be resumed within 500ms (iOS PWA's strict
 *  autoplay block). */
export async function playAudioBuffer(
  buffer: AudioBuffer,
  opts?: { rate?: number; onEnd?: () => void },
): Promise<(() => void) | null> {
  const ctx = _ensureAudioCtx();
  if (!ctx) {
    _ttsLog("pab-no-ctx");
    return null;
  }
  _ttsLog("pab-ctx-state", ctx.state);
  // iOS Safari adds a non-standard "interrupted" state when the OS
  // audio session has been suspended (other audio app focused,
  // device locked, etc.). resume() works on both "suspended" and
  // "interrupted" but ONLY when called inside an active user gesture.
  const needsResume =
    ctx.state === "suspended" || (ctx.state as string) === "interrupted";
  if (needsResume) {
    try {
      const resumed = await Promise.race([
        ctx.resume().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
      ]);
      _ttsLog("pab-resume", `${resumed ? "ok" : "timeout"} → ${ctx.state}`);
    } catch (e) {
      _ttsLog("pab-resume-error", (e as Error).message);
    }
  }
  if (ctx.state !== "running") {
    _ttsLog("pab-not-running", ctx.state);
    return null;
  }
  // Stop any prior source — one-at-a-time playback.
  if (_currentSource) {
    try {
      _currentSource.stop();
    } catch {
      // ignore
    }
    _currentSource = null;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = opts?.rate ?? 1.0;
  src.connect(ctx.destination);
  src.onended = () => {
    if (_currentSource === src) _currentSource = null;
    opts?.onEnd?.();
  };
  try {
    src.start();
    _currentSource = src;
    _ttsLog("pab-started");
  } catch (e) {
    _ttsLog("pab-start-failed", (e as Error).message);
    return null;
  }
  return () => {
    try {
      src.stop();
    } catch {
      // ignore
    }
    if (_currentSource === src) _currentSource = null;
  };
}

/** Register a one-time global gesture listener that resumes the
 *  AudioContext + arms the silent oscillator. */
export function installAudioPrimer(): void {
  if (typeof window === "undefined") return;
  let installed = false;
  const handler = () => {
    if (installed) return;
    installed = true;
    armAudioSession();
    window.removeEventListener("pointerdown", handler, true);
    window.removeEventListener("touchstart", handler, true);
    window.removeEventListener("keydown", handler, true);
  };
  window.addEventListener("pointerdown", handler, true);
  window.addEventListener("touchstart", handler, true);
  window.addEventListener("keydown", handler, true);
}


// Persistent silent oscillator — the "audio session keeper" trick.
// Once started inside a user gesture, this near-silent tone keeps the
// AudioContext in the running state for the entire page lifetime, so
// subsequent BufferSource.start() calls from useEffect / network
// handlers play without hitting iOS PWA's autoplay block.
let _silentOsc: OscillatorNode | null = null;

/** Resume the AudioContext + start a persistent near-silent oscillator
 *  that keeps the audio session alive. Must be called inside a user
 *  gesture handler (a tap, the toggle change, etc.) so iOS Safari
 *  honors the resume(). Safe to call repeatedly — only arms once. */
export function armAudioSession(): void {
  const ctx = _ensureAudioCtx();
  if (!ctx) {
    _ttsLog("arm-no-ctx");
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => {
      _ttsLog("arm-resumed", ctx.state);
    }).catch((e) => {
      _ttsLog("arm-resume-err", (e as Error).message);
    });
  }
  if (_silentOsc) {
    _ttsLog("arm-already");
    return;
  }
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // 0.0005 = roughly inaudible to humans but loud enough that
    // iOS treats the audio session as active and won't interrupt
    // it after inactivity. Pure silence (gain = 0) makes iOS
    // suspend the context within seconds.
    gain.gain.value = 0.0005;
    // Use a sub-audible frequency so even if the gain isn't enough
    // to be inaudible at certain volumes, the user doesn't hear a
    // tone — they hear nothing at all.
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    _silentOsc = osc;
    _ttsLog("arm-osc-started");
  } catch (e) {
    _ttsLog("arm-osc-failed", (e as Error).message);
  }
}


/** True when the runtime exposes any speech-synthesis interface. */
export function ttsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined"
  );
}


/**
 * Clean text for natural-sounding TTS playback. Strips:
 *   - Hebrew block (U+0590–U+05FF) + Hebrew points
 *   - Greek block (U+0370–U+03FF) + Greek Extended (U+1F00–U+1FFF)
 *   - Arabic block (U+0600–U+06FF)
 *   - Inline citation markers like `[trans:KJV:GEN.1.1]`, `[note:abc]`
 *   - Stranded parentheses left after a transliteration drops
 *   - Multiple spaces, leading/trailing whitespace
 *
 * Athena (Deepgram Aura) and the OS Web Speech voices both stumble
 * over original-language script: they spell letters out one at a
 * time and rush through it. Stripping the script + the parens that
 * usually wrap it lets the English narration flow naturally. The
 * transliteration ("agape" before "(ἀγάπη)") stays since it's Latin.
 */
export function stripForTTS(text: string): string {
  if (!text) return "";
  return (
    text
      // Citation markers — `[trans:KJV:GEN.1.1]`, `[note:abc]`, etc.
      .replace(/\[[a-z_]+:[^\]\s][^\]]*\]/gi, "")
      // Non-Latin scripts that read aloud poorly.
      .replace(/[֐-׿؀-ۿͰ-Ͽἀ-῿]+/g, "")
      // Stranded "()" left where a script + its parens were stripped.
      .replace(/\(\s*\)/g, "")
      // Emoji + pictographic symbols (broad ranges). Voice engines
      // either ignore these or spell them out — neither is desirable.
      .replace(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu,
        "",
      )
      // Section / paragraph / dagger / footnote glyphs.
      .replace(/[§¶†‡•▸▾▴▪◦‣⁃]/g, "")
      // Markdown formatting marks. ** and * around text → just the text.
      // We do `**` first so `*` doesn't eat the inner asterisks.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      // Line-leading bullets that the model emits ("- item", "* item").
      .replace(/^[\s]*[-*]\s+/gm, "")
      // Bible references with colons read awkwardly ("one colon
      // sixteen"). Replace the colon with a comma so it lands as a
      // natural pause: "John 3:16" → "John 3, 16".
      .replace(/(\b\d+):(\d+)/g, "$1, $2")
      // Repeated punctuation: "!!!", "???", "—— —— ——" → single mark.
      .replace(/([!?.])\1+/g, "$1")
      .replace(/[-–—]{2,}/g, " — ")
      // Standalone ampersand reads as "ampersand"; "and" is cleaner.
      .replace(/\s&\s/g, " and ")
      // Collapse run-on whitespace produced by the strips above.
      .replace(/\s{2,}/g, " ")
      // Tidy " ," / " ." artifacts.
      .replace(/\s+([,.;:])/g, "$1")
      // Empty parens left after content was stripped.
      .replace(/\(\s*[,;.]?\s*\)/g, "")
      .trim()
  );
}


/** Handle returned by `speakSequence`. Lets the caller pause/resume
 *  the current utterance and stop the whole sequence at any time. */
export interface SequenceHandle {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Move to a specific index in the sequence. Useful when the
   *  caller wants to skip ahead. */
  goto: (index: number) => void;
  /** Current 0-based index into the items array. */
  current: () => number;
}


export interface SequenceItem {
  /** Stable identifier; passed back via `onAdvance` so the caller can
   *  highlight / focus the verse currently being read. */
  id: string;
  /** Text content to speak. */
  text: string;
}


/**
 * Speak a list of items in order, calling `onAdvance(index, item)`
 * just before each utterance fires. When the synthesizer finishes an
 * item, the next one starts automatically. When the last item ends,
 * `onEnd()` fires once.
 *
 * Designed for the Bible voice reader: pass a sequence of verses,
 * highlight the one being read via the advance callback, and chain
 * across chapters by calling `getMore()` in the onEnd handler if you
 * want to keep going.
 */
export function speakSequence(
  items: SequenceItem[],
  opts?: {
    language?: string;
    rate?: number;
    pitch?: number;
    voice?: string;
    onAdvance?: (index: number, item: SequenceItem) => void;
    onEnd?: () => void;
    startIndex?: number;
  },
): SequenceHandle | null {
  if (typeof window === "undefined") return null;
  if (items.length === 0) return null;

  let index = Math.max(0, Math.min(items.length - 1, opts?.startIndex ?? 0));
  let stopped = false;
  // ONE Audio element reused across the whole sequence. iOS Safari
  // grants playback permission to the specific HTMLAudioElement
  // tapped by the user — creating a NEW element per verse would lose
  // that permission and the sequence stalls after the first verse.
  // Reusing the same element + just swapping `src` for each verse
  // keeps autoplay alive for the rest of the chapter.
  const audio = new Audio();
  audio.preload = "auto";
  // 0.9 is enough to take the rush off without making Athena sound
  // syrupy — she's natively a brisk speaker. The caller can override
  // via opts.rate for short utterances (e.g. the one-shot agent
  // answer which fits the default cadence).
  audio.playbackRate = opts?.rate ?? 0.9;
  // Breath gap between verses so the listener can land each phrase
  // before the next one starts. Deepgram packs the audio tight — a
  // ~450ms gap matches how a human narrator would pace verse-by-verse.
  const VERSE_GAP_MS = 450;
  let currentBlobUrl: string | null = null;
  let webSpeechFallback: SpeakHandle | null = null;

  function cleanupBlob() {
    if (currentBlobUrl) {
      try {
        URL.revokeObjectURL(currentBlobUrl);
      } catch {
        // ignore
      }
      currentBlobUrl = null;
    }
  }

  function advance(i: number) {
    cleanupBlob();
    if (stopped) return;
    if (i >= items.length) {
      opts?.onEnd?.();
      return;
    }
    speakAt(i);
  }

  audio.onended = () => {
    if (stopped) return;
    // Wait a beat before the next verse so the cadence reads as
    // narration, not a teleprompter.
    window.setTimeout(() => {
      if (!stopped) advance(index + 1);
    }, VERSE_GAP_MS);
  };
  audio.onerror = () => {
    // Audio decoding failed for this verse — skip ahead rather than
    // stalling the sequence.
    if (stopped) return;
    advance(index + 1);
  };

  async function speakAt(i: number) {
    if (stopped) return;
    if (i >= items.length) {
      opts?.onEnd?.();
      return;
    }
    index = i;
    opts?.onAdvance?.(i, items[i]);
    const cleanText = stripForTTS(items[i].text);
    if (!cleanText) {
      // Nothing left to speak after cleanup (verse was pure Hebrew/Greek,
      // citation markers, etc.) — skip to the next item.
      advance(i + 1);
      return;
    }
    // Fetch this verse's audio from the Deepgram proxy.
    let resp: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const password = _getPassword();
      if (password) headers["X-App-Password"] = password;
      resp = await fetch("/api/tts/speak", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: cleanText,
          voice: opts?.voice ?? _readPreferredVoice(),
        }),
      });
    } catch {
      // Network failure — fall back to Web Speech for THIS verse, then
      // chain to the next.
      if (stopped) return;
      webSpeechFallback = _speakWebSpeech(cleanText, {
        language: opts?.language,
        rate: opts?.rate,
        pitch: opts?.pitch,
        onEnd: () => advance(i + 1),
      });
      return;
    }
    if (stopped) return;
    if (resp.status === 204 || !resp.ok) {
      // Key missing or backend failure — Web Speech this verse.
      webSpeechFallback = _speakWebSpeech(cleanText, {
        language: opts?.language,
        rate: opts?.rate,
        pitch: opts?.pitch,
        onEnd: () => advance(i + 1),
      });
      return;
    }
    const buf = await resp.arrayBuffer();
    if (stopped) return;
    const blob = new Blob([buf], { type: "audio/mpeg" });
    cleanupBlob();
    currentBlobUrl = URL.createObjectURL(blob);
    audio.src = currentBlobUrl;
    try {
      await audio.play();
    } catch {
      // play() rejected (autoplay block, etc.) — skip to next.
      if (!stopped) advance(i + 1);
    }
  }

  speakAt(index);

  return {
    // pause/resume can't reliably pause a streaming Audio element on
    // iOS, so they just stop. Caller (BibleView) saves the resume
    // verse index and re-creates the sequence on the next play.
    pause: () => {
      stopped = true;
      try {
        audio.pause();
      } catch {
        // ignore
      }
      webSpeechFallback?.stop();
      cleanupBlob();
    },
    resume: () => {
      // No-op (see pause comment).
    },
    stop: () => {
      stopped = true;
      try {
        audio.pause();
      } catch {
        // ignore
      }
      webSpeechFallback?.stop();
      cleanupBlob();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // best-effort
      }
    },
    goto: (i: number) => {
      if (i < 0 || i >= items.length) return;
      speakAt(i);
    },
    current: () => index,
  };
}

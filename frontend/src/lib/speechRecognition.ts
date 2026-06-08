/**
 * Browser SpeechRecognition wrapper — the local, free counterpart to
 * `tts.ts`. Runs on-device via the OS's speech recognition engine on
 * Chrome (desktop + Android) and Safari (iOS 14.5+ / macOS). The
 * captured transcript is plain text; no audio leaves the device.
 *
 * Falls back to `null` from `start()` when the API isn't available
 * — the caller surfaces a small "voice not supported on this
 * browser" hint instead of throwing.
 *
 * Why not Whisper: client-side OS recognition is good enough for
 * questions / chat dictation and avoids a 200MB+ model download.
 * If we ever need transcript quality good enough for sermons or
 * long-form notes, swap in @xenova/transformers Whisper or a
 * server-side Whisper endpoint.
 */
export interface SpeechSession {
  stop: () => void;
}

export interface SpeechHandlers {
  /** Called every time the recognizer emits a (partial or final)
   *  transcript chunk. `isFinal` distinguishes the live preview from
   *  the committed text. Final chunks are concatenated by the caller. */
  onResult: (transcript: string, isFinal: boolean) => void;
  /** Called when the recognizer stops, either because the user
   *  tapped "stop" or the browser auto-stopped after silence. */
  onEnd?: () => void;
  /** Called with the browser's error code string ("not-allowed",
   *  "no-speech", etc.) so the UI can show a relevant message. */
  onError?: (code: string) => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    [index: number]: { transcript: string; confidence: number };
    length: number;
  }>;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  // The unprefixed name lands on Safari first; webkit prefix
  // covers older Chrome / Edge. Both share the same interface.
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

/** Start a recognition session. Returns a `{ stop }` handle or null
 *  when the browser doesn't support it. Caller is responsible for
 *  stopping; sessions also auto-end on silence per browser default. */
export function startSpeech(
  language: string,
  handlers: SpeechHandlers,
): SpeechSession | null {
  const Ctor = getCtor();
  if (!Ctor) return null;
  const recog = new Ctor();
  recog.lang = language;
  // Continuous = keep listening across pauses; the user explicitly
  // taps stop. interimResults gives a live preview that the UI can
  // render as the user speaks.
  recog.continuous = true;
  recog.interimResults = true;
  recog.maxAlternatives = 1;
  recog.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const t = result[0]?.transcript ?? "";
      if (!t) continue;
      handlers.onResult(t, !!result.isFinal);
    }
  };
  recog.onerror = (event) => {
    handlers.onError?.(event.error);
  };
  recog.onend = () => {
    handlers.onEnd?.();
  };
  try {
    recog.start();
  } catch {
    return null;
  }
  return {
    stop: () => {
      try {
        recog.stop();
      } catch {
        // best-effort
      }
    },
  };
}

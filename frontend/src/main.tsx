import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { registerServiceWorker } from "./lib/registerServiceWorker";
import { warmupVoices, installAudioPrimer } from "./lib/tts";
import { warmOfflineCache } from "./lib/warmCache";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

registerServiceWorker();
// Kick the TTS voice catalog so the first read-aloud tap can
// land on a high-quality voice (Siri / Premium / Neural / etc.)
// instead of falling back to the compact robot voice while the
// list is still loading.
warmupVoices();
// Listen for the first user gesture and unlock the shared TTS Audio
// element. iOS Safari (especially in standalone PWA mode) blocks
// `audio.play()` outside a gesture; one priming play during the
// first tap grants permission for every subsequent auto-speak.
installAudioPrimer();
// Pre-fetch the read-only personal endpoints in the background so an
// offline launch later finds Marks, Bookmarks, Notes, and the
// translation picker populated even if the user only ever opened the
// Bible reader online. Runs once per hour per session.
setTimeout(() => {
  void warmOfflineCache();
}, 3000);
window.addEventListener("online", () => {
  void warmOfflineCache();
});

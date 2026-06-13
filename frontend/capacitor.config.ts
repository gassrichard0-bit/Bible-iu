// App Store release config — bundled build, no external URL dependency
// Switch in when submitting to App Store:
//   cp capacitor.config.store.ts capacitor.config.ts && npm run build && npx cap sync ios
import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.gassrichard.bibleiu",
  appName: "Bible IU",
  webDir: "dist",
  ios: {
    // "never" makes the WKWebView extend edge-to-edge — no white bars
    // above the notch / below the home indicator. CSS handles safe
    // areas via env(safe-area-inset-*).
    contentInset: "never",
    // Dark grey behind the WebView so any frame the web layer hasn't
    // painted (e.g. during scroll bounce, splash transition) blends
    // with the app's dark theme instead of flashing white.
    backgroundColor: "#171717",
    preferredContentMode: "mobile",
    allowsLinkPreview: true,
    scrollEnabled: true,
  },
  plugins: {
    // Routes fetch + XHR through native networking on iOS so requests
    // from `capacitor://localhost` to `https://bible.access-term.com`
    // bypass WKWebView's custom-scheme CORS restrictions (which throw
    // "the string did not match the expected pattern").
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: "#171717",
      androidSplashResourceName: "splash",
      androidScaleType: "centerCrop",
    },
  },
};

export default config;

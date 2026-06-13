// App Store release config — bundled build, no external URL dependency
// Switch in when submitting to App Store:
//   cp capacitor.config.store.ts capacitor.config.ts && npm run build && npx cap sync ios
import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.gassrichard.bibleiu",
  appName: "Bible IU",
  webDir: "dist",
  ios: {
    contentInset: "never",
    backgroundColor: "#171717",
    preferredContentMode: "mobile",
    allowsLinkPreview: true,
    scrollEnabled: true,
  },
  plugins: {
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

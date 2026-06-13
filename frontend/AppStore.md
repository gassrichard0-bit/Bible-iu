# Bible IU — App Store submission checklist

Everything Apple needs in App Store Connect, in submission order.
Fill in the **TODO** lines before clicking *Submit for Review*.

---

## 1. App identity

| Field | Value |
|---|---|
| Bundle ID | `com.gassrichard.bibleiu` |
| App name (App Store) | **Bible IU** |
| Subtitle (30 chars) | TODO — *e.g. "Study Scripture together"* |
| Primary category | Reference |
| Secondary category | Lifestyle |
| Age rating | 4+ (no objectionable content) |
| Pricing | Free |

## 2. App description (4 000 chars max)

> **Bible IU** is a clean, modern Bible reader and small-group study companion. Read scripture in 50+ translations — including KJV, NKJV, NIV, and a dozen languages — and bring your group along with shared notes, chat, and an AI study assistant.
>
> **Features**
> - 50+ Bible translations including King James, New King James, New International, Russian Synodal, Reina-Valera, Bíblia Livre, 和合本, 개역한글, and more.
> - KJV with inline Strong's numbers + lexicon definitions — tap any verse to see the original Greek or Hebrew alongside the English.
> - Highlights, underlines, bookmarks, and free-form notes — sync across all your devices.
> - Group rooms with chat, shared notes, and @-mention notifications.
> - AI study assistant with citation-bound answers — every claim links back to its scripture or commentary source.
> - Reading plans with daily reminders.
> - Works offline once you've opened a chapter.

(Adjust as needed — current copy is a starting point.)

## 3. Keywords (100 chars total, comma-separated)

```
bible,scripture,study,kjv,nkjv,niv,strong's,greek,hebrew,notes,group,christian,verse
```

## 4. URLs

| Field | Value |
|---|---|
| Support URL | TODO — *publish a page at https://bible.access-term.com/support* |
| Marketing URL (optional) | https://bible.access-term.com/ |
| Privacy policy URL (required) | TODO — *publish at https://bible.access-term.com/privacy* |

## 5. Privacy

Already declared via `frontend/ios/App/App/PrivacyInfo.xcprivacy`. Apple still asks the same questions in App Store Connect's privacy questionnaire — answer:

- **Do you collect data?** Yes.
- **Linked to user?** Yes (handle, email if provided, notes, bookmarks, highlights, chat messages).
- **Used for tracking?** No.
- **Used for advertising?** No.
- **Third-party SDKs that collect data?** None. (Capacitor and API.Bible are first-party server calls — none of them embed advertising SDKs.)

## 6. Screenshots required

Apple requires the highest-resolution screenshots; smaller-display screenshots are auto-scaled from these.

| Display | Dimensions (portrait) | How many | What to show |
|---|---|---|---|
| **iPhone 17 Pro Max (6.9″)** | 1320×2868 | 3–10 | Genesis 1 in KJV, dropdown open showing translations, Notes page with a group note, Chat thread, Strong's panel open on John 3:16, Marks page with bookmarks |
| **iPhone 15 Pro Max (6.7″, legacy required)** | 1290×2796 | 3–10 | Same as above, captured on the 6.7" sim |
| **iPad Pro 13″** | 2064×2752 | 3–10 | Optional but recommended if you ship the iPad version |

Capture via Xcode → Simulator → File → Save Screen. Drop them into `frontend/AppStore/screenshots/{iphone17pm, iphone15pm}/01-*.png`, etc.

## 7. App Review Information (notes to Apple's reviewer)

```
Test account:
  handle: appreview
  password: AppReview2026!

The app loads scripture from a single Mac server (Richard Gass's home Mac)
exposed via cloudflared tunnel at https://bible.access-term.com. Reviewers
will see the same content as end users. No special build steps required.

Licensed translations:
  - NKJV (Thomas Nelson) and NIV (Biblica) are accessed under our paid
    API.Bible Starter Plan license. Attribution strings are rendered as
    a footer on every chapter view containing licensed text.
  - All other 50+ translations are public domain or released under
    free-license terms — attribution is rendered in the same footer.

If you need anything else: gassrichard@gmail.com
```

## 8. Build & upload

```bash
# Switch to the App Store config (no live URL)
cp capacitor.config.store.ts capacitor.config.ts
npm run build
npx cap sync ios

# Open + archive
open ios/App/App.xcworkspace 2>/dev/null || open ios/App/App.xcodeproj
# Product > Archive > Distribute App > App Store Connect > Upload

# After uploading, restore the dev/TestFlight config
git checkout -- capacitor.config.ts
```

## 9. Known Apple rejection patterns we already handle

- **Account deletion**: app already exposes `DELETE /auth/me` and the Settings → "Delete account" button. ✓
- **Sign in via Apple**: not currently offered — Apple requires it if any other third-party auth is offered. We only offer email/password, so we're exempt. ✓
- **Wrapper-around-website**: the App Store binary uses bundled `dist/` (no `server.url`). Capacitor classifies it as a hybrid native app. ✓
- **Restoration of purchases**: not applicable (free, no IAP).
- **Web view content licensing**: NKJV/NIV attribution rendered + listed in reviewer notes above. ✓

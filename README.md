# The Collector

A personal art & collectible appraisal tool. You give it a photo or a link; the black box
returns a projected value range with a stated confidence band, a short `why`, and the recorded
auction sales behind it.

This repository is a two-part monorepo:

```
thecollector/
  server/   Node 20+ ESM · Express · better-sqlite3   (synchronous, no queues)
  app/      Expo (React Native) · landing + reader chat
```

Non-goals: no app-store / Play upload, no BullMQ / Redis / Caddy / Docker, no licensed data
feeds, no Discover feed, no accounts, no cloud deploy. Local personal build only.

---

## Backend

### Quick start

```bash
cd server
npm install
npm run ingest     # pulls realized auction sales from Artsy into SQLite
npm start          # http://localhost:3000
```

`GET /health` → `{ "ok": true }`.

`npm run ingest` writes `server/data/comps.db` (git-ignored). It fetches the default artists
(`andy-warhol`, `pablo-picasso`, `banksy`, `keith-haring`, `joan-miro`, `marc-chagall`,
`yayoi-kusama`) from the unauthenticated Artsy internal GraphQL endpoint
`https://metaphysics-production.artsy.net/v2`, keeps only lots with a realized price, and prints
the resulting row count. Requests are sequential and pages are retried; a failing artist keeps
whatever was already fetched.

`npm run ingest:all` walks the whole catalog and queues every artist with a signal (`auctionResults`,
`shows` or `articles`), not only those with auction sales. After the auction pass it runs the
resumable momentum ingest, which stores one latest snapshot per artist in `artist_signals`
(follows, exhibitions, gallery tiers, press, 90-day follower growth). The queue and the discovery
cursor checkpoint to SQLite, so an interrupted run resumes and a done artist is not fetched twice.

### `POST /appraise`

Request:

```json
{
  "imageBase64": "…",            // optional
  "mimeType": "image/jpeg",      // optional
  "imageUrl": "https://…",       // optional
  "note": "…",                   // optional
  "hints": {                     // optional
    "artist": "…", "title": "…", "year": "…",
    "country": "…", "size": "…", "medium": "…"
  }
}
```

Result (`status` is `priced`, `needs_details`, or `refused`):

```json
{
  "status": "priced",
  "identity": { "artist": "…", "title": "…", "medium": "…", "dimensions": "…",
                 "year": "…", "country": "…", "edition": null,
                 "method": "catalog|vision", "match_confidence": 0.9 },
  "value": { "low": 90000, "high": 110000, "currency": "USD", "as_of": "2026-10-04" },
  "confidence": { "level": "medium", "coverage": 0.6, "basis": ["…"] },
  "provenance": [ { "kind": "auction_sale", "ref": "…" } ],
  "sources": [],
  "similar": [ { "title": "…", "price": 12345, "currency": "USD", "…": "…" } ]
}
```

- No identity and no vision key → `needs_details` with
  `missing_fields: ["artist","year","country","size","medium"]`.
- Resubmitting those as `hints` → `priced` (or `refused`), with a numeric `low`/`high` and a
  stated `coverage`.
- Empty comps database → `refused`; the server never invents a value.

### Estimator and calibration

- `parseAreaCm2` prefers a stated cm measurement and only converts inches when no cm exists.
- Medium is bucketed into `print`, `photograph`, `sculpture`, `painting`, `work_on_paper`, `other`.
- Edition gate: two or more prior sales sharing artist + normalized title + **medium class**
  (generic titles such as "Untitled" are skipped) → recency-weighted median of those sales in log
  space. The medium class is part of the key, so a painting never binds to same-title prints.
- Otherwise a hedonic least-squares fit of `log10(price)` on artist intercepts, `log10(area)`,
  medium dummies and creation year; an unmatched artist is pooled over the artists rather than
  pinned to one intercept. Unknown artist names are matched diacritic-insensitively
  (`Joan Miro` = `Joan Miró`).
- Recent sales outweigh old ones throughout: every sale carries an exponential recency weight
  (six-year half-life, floored at 0.05) used in the fit, the artist level and the comparable-sales
  spread. A sale from 130 years ago can no longer pull the estimate or the range.
- A sale-year trend is fit on the fitted model's residuals and projected forward to the newest
  recorded sale, clamped at ±5%/year. This keeps the estimate on the recent market rather than the
  whole history.
- The displayed range is the recency-weighted spread of the prediction's own comparable sales,
  then **hard-capped at ±10%** of the central estimate. The `why` states the cap and the capped
  range's empirical held-out coverage.
- No data provider is named in the reply: `sources` is empty and each `provenance` row carries the
  sale facts without a `source` field.
- An artist with **no auction record** is priced from artist momentum instead of refused. The
  central value is the pooled hedonic level scaled by a momentum multiplier (neutral at score 50,
  clamped to 0.5x–2x); the range is the calibrated band capped at ±10%. Momentum is a deterministic
  weighted sum of exhibition (0.40), gallery (0.25), press (0.20) and social (0.15) sub-scores,
  each capped to 0..100 and never decreasing in its inputs. It is read from the cached
  `artist_signals` table, so the appraisal path never fetches it live; the basis names the four
  contributions and prints `coverage: unavailable`, since there is no held-out ground truth yet.
- `npm test` reports empirical coverage at 50/60/80/90 and the capped-range coverage on both a
  synthetic sample and, when present, the ingested database.

On the synthetic sample the capped ±10% range covered **21.3%** of held-out sales; the wider
50/80/90 coverage is printed by `npm test` for both the synthetic sample and, when present, the
local ingest.

### `POST /chat`

A free-form text message from the chat log, answered conversationally about pricing, paintings and
art. It never runs the image path and never returns a fresh estimate.

Request: `{ "message": "What offer should I put down?", "identity": {…}, "value": {…},
"confidence": {…}, "history": [ { "role": "user"|"assistant", "text": "…" } ] }`

Result: `{ "status": "answered", "answer": "…", "source": "model"|"grounded" }`. With
`OPENROUTER_API_KEY` set it asks a text model; unset (or on failure) it returns a grounded answer
built from the current appraisal. Overridable: `CHAT_MODEL`, `CHAT_API_URL`, `CHAT_TIMEOUT_MS`.

### Optional vision

Set `OPENROUTER_API_KEY` (or `VISION_API_KEY`) and `/appraise` will ask a multimodal model to
identify the work before pricing. Unset, the request still succeeds and returns `needs_details`.
Overridable: `VISION_MODEL`, `VISION_API_URL`, `VISION_TIMEOUT_MS`.

### Tests

```bash
cd server && npm test      # node --test, valuation + API
```

---

## App (Expo)

One vertical, two-page flow with no navigation library: the **landing** and the **reader**. There
is no Discover or Saved tab and no default note box; the five extra fields are chat prompt chips
that appear only after an unidentified request.

```bash
cd app
npm install
npx expo start
```

- The app talks to the **Backend URL** field, opened from the API pill on the landing. It defaults
  to `EXPO_PUBLIC_API_URL` when the bundle is built, else `http://172.93.111.86:3000` (this box on
  its LAN). Edit the field in-app to point anywhere — e.g. `http://100.97.62.62:3000` (this box's
  Tailscale address, reachable from a phone on cellular) or `http://localhost:3000` for a tunnel.
- The server listens on all interfaces (`0.0.0.0:3000`), so the same backend answers on localhost,
  the LAN address and the Tailscale address.
- Landing: three edge-to-edge panels — Link top-left, Album top-right, Camera the bottom half.
  Link expands a URL field while album and camera stay reachable; Album and Camera use
  `expo-image-picker`. Choosing a source moves down into the reader, not sideways.
- Reader: the chosen photo fills the screen and a bottom sheet two thirds high holds the chat.
  An added photo or filled field calls `POST /appraise` and renders the result in the chat:
  identification, the value range with confidence, basis and as-of, identified origin and
  provenance, and similar sales; an unidentified piece asks for the fields the server lists as
  missing (artist, year, country, size, medium) as chips with a free-text answer. A free-form
  message goes to `POST /chat` instead and is answered in the log. On Android the reading sheet is
  lifted above the software keyboard and the chat scrolls to the newest line.

### Emulator runbook (this machine)

```bash
export ANDROID_HOME=/home/lunchbox/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH

emulator -avd se_api35 -no-snapshot -no-audio -no-window -gpu swiftshader_indirect &
adb wait-for-device

cd server && npm install && npm run ingest && npm start &
cd app && npm install
npx expo run:android                    # or: npx expo prebuild -p android && ./android/gradlew assembleDebug
```

The default backend (`http://172.93.111.86:3000`) is the host's LAN address, which the emulator
reaches directly. If you set the field to `http://localhost:3000` instead, run
`adb reverse tcp:3000 tcp:3000` first.

### Testing on a phone

The release APK already points at the box's LAN address. Put the phone on the same Wi-Fi and open
the app; if the phone is on cellular, edit **Backend URL** to the box's Tailscale address
(`http://100.97.62.62:3000`) and make sure Tailscale is up on the phone. No rebuild needed either
way.

### Release APK

The Android project is generated by `expo prebuild` (git-ignored). The release build is signed
with the generated debug keystore and `usesCleartextTraffic` is enabled so the standalone APK can
reach the local backend:

```bash
cd app
npx expo prebuild -p android --clean
cd android && ./gradlew assembleRelease
# → app/android/app/build/outputs/apk/release/app-release.apk
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Releases are tagged with the plain app version — `vX.Y.Z`, for example `v1.1.0`, with no
`-emulator` suffix — and attach `app-release.apk`. This is for personal testing only and is not
uploaded to any store.

### Branding / assets

Obsidian Refined: background `#111111`, text `#f5f1e8`, brass `#d7af5f`, 3px radii. The mark is a
gilded picture-frame corner with a small price tag. Sources live in `app/assets/src/*.svg`;
rendered PNGs are checked in. Regenerate with:

```bash
cd app
rsvg-convert -w 1024 -h 1024 assets/src/icon.svg          -o assets/icon.png
rsvg-convert -w 1024 -h 1024 assets/src/adaptive-icon.svg -o assets/adaptive-icon.png
rsvg-convert -w 512  -h 512  assets/src/mark.svg          -o assets/splash-icon.png
rsvg-convert -w 1284 -h 2778 assets/src/splash.svg        -o assets/splash.png
rsvg-convert -w 48   -h 48   assets/src/icon.svg          -o assets/favicon.png
```

---

## Data source

Artsy's internal GraphQL endpoint, unauthenticated, contacted sequentially. This is a local
personal build; the data is not redistributed.

Momentum signals are Artsy's own artist metadata (`counts` plus the artist's shows connection),
stored locally in `artist_signals` with a `source` field and the raw counts kept for audit. The
shows connection is fetched best-effort: a schema change degrades the signal to counts instead of
failing the ingest. Because press and social redistribution terms are not settled, this source is
flagged for legal review before any non-local use.

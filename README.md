# The Collector

A personal art & collectible appraisal tool. You give it a photo or a link; the black box
returns a projected value range with a stated confidence band, a short `why`, and the recorded
auction sales behind it.

This repository is a two-part monorepo:

```
thecollector/
  server/   Node 20+ ESM · Express · better-sqlite3   (synchronous, no queues)
  app/      Expo (React Native) · two screens          (Input, Value)
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

`npm run ingest:all` ingests every artist that has auction results, not just the seven defaults;
it is the same command as `node src/ingest.js --all`. It pages through the Artsy artist catalog
by `SORTABLE_ID_ASC`, queues each artist whose `counts.auctionResults` is non-zero, then fetches
that artist's realized sales with no per-artist page cap (the quick mode still caps at 40 pages,
and warns if it has to stop while more results remain). Progress is checkpointed in the same
SQLite file under `server/data/` (`ingest_state` holds the catalog cursor; `ingest_artists` is the
queue of queued/done/failed artists), so an interrupted run resumes where it stopped and skips
artists already done; rows are written per artist and de-duplicated by `(artist_slug,
internal_id)`, so re-running is safe. A discovery page that fails after its retries ends the run
cleanly for a later resume; a failing artist is logged and does not abort the run, and artists
that failed are retried on the next run. Around 54,000 of the catalog's ≈318,000 artists carry
results, so a complete first pass is a long background job (roughly tens of hours); run it in
chunks, since each `--all` invocation resumes. The default `npm run ingest` is unchanged.

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
                 "year": "…", "country": "…", "provenance": "…", "edition": null,
                 "method": "catalog|vision", "match_confidence": 0.9 },
  "value": { "low": 30000, "high": 890000, "currency": "USD", "as_of": "2026-10-04" },
  "confidence": { "level": "medium", "coverage": 0.8, "basis": ["…"] },
  "provenance": [ { "source": "Artsy auction results", "kind": "auction_sale", "ref": "…" } ],
  "sources": ["Artsy auction results"],
  "similar": [ { "title": "…", "price": 12345, "currency": "USD", "…": "…" } ]
}
```

- An image plus a configured vision key → the identification layer runs first and fills artist,
  title, medium, dimensions, year, country and a short provenance. Any `hints` the user supplied
  win on conflict.
- `needs_details` only after identification fails, and `missing_fields` lists only what is still
  missing — a partial result asks for the rest, e.g. `["artist","year","size","medium"]` when
  only the country was found.
- Any usable signal (artist, title, medium, dimensions or year) is priced with, so a photo the
  vision model can identify never forces the user to retype fields they do not have.
- Empty comps database → `refused`; the server never invents a value.

### Estimator and calibration

- `parseAreaCm2` prefers a stated cm measurement and only converts inches when no cm exists.
- Medium is bucketed into `print`, `photograph`, `sculpture`, `painting`, `work_on_paper`, `other`.
- Edition gate: two or more prior sales sharing artist + normalized title (generic titles such as
  "Untitled" are skipped) → median of those sales in log space.
- Otherwise a hedonic least-squares fit of `log10(price)` on artist intercepts, `log10(area)`,
  medium dummies and creation year; an unmatched artist is pooled over the artists rather than
  pinned to one intercept. Unknown artist names are matched diacritic-insensitively
  (`Joan Miro` = `Joan Miró`).
- The band is the quantiles of held-out log residuals, so it is calibrated rather than assumed.
- `npm test` reports empirical coverage at 50/80/90 on both a synthetic sample and, when present,
  the ingested database.

On this machine's ingest (21,970 realized sales, 7 artists) the held-out coverage was
**51.3% / 80.4% / 90.4%** at nominal 50/80/90, with a 80% band of ≈ ×5.4 either side.

### Optional vision

Set `OPENROUTER_API_KEY` (or `VISION_API_KEY`) and `/appraise` will ask a multimodal model to
identify the work before pricing, returning `country` (origin) and a one-sentence `provenance`
alongside the catalogue fields. The model is consulted whenever an image is sent and a key is
set, even with hints, and the user's own hints always override its answer. Unset, the request
still succeeds and returns `needs_details`. `VISION_MODEL` defaults to
`google/gemini-3.5-flash`; `VISION_API_URL` and `VISION_TIMEOUT_MS` are also overridable.

### Tests

```bash
cd server && npm test      # node --test, valuation + API
```

---

## App (Expo)

Two screens, no navigation library: **Input** and **Value**. There is no Discover or Saved tab and
no default note box; the five extra fields only appear after an unidentified request.

```bash
cd app
npm install
npx expo start
```

- The app talks to the **Backend URL** field on the Input screen. It defaults to
  `EXPO_PUBLIC_API_URL` when the bundle is built, else `http://172.93.111.86:3000` (this box on its
  LAN). Edit the field in-app to point anywhere — e.g. `http://100.97.62.62:3000` (this box's
  Tailscale address, reachable from a phone on cellular) or `http://localhost:3000` for a tunnel.
- The server listens on all interfaces (`0.0.0.0:3000`), so the same backend answers on localhost,
  the LAN address and the Tailscale address.
- Input: `Photo | Link` toggle; Photo uses `expo-image-picker` (camera + library); Link is a URL
  field; one primary **Appraise** button. Loading and backend-unreachable states are shown.
- Value: large value range, confidence level + coverage, `Why this value`, `Identified` fields
  (country shown as `Origin`), a `Provenance` note when the identifier returned one, `Similar
  items`, and a back button.

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

This is for personal emulator testing only; it is not uploaded to any store.

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

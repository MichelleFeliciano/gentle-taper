# Gentle Taper

A private, calm caffeine-taper tracker that works as an installable phone app (PWA). No accounts, no build step,
no tracking: your data lives on your phone.

**Live app:** https://michellefeliciano.github.io/gentle-taper/

## What it does

| Area | Features |
|---|---|
| **Plan** | Start from a daily mg amount (or let the app learn it over 3 days), a length in days, a gradual schedule you can edit day by day, pause/resume, re-spread, restart. History is never lost. |
| **Today** | A target in mg, one-tap drink logging with an editable drink list (favorites, any type/container), a day log, water tally, "last caffeine at" time, a 6-symptom check-in (0–3) with notes. |
| **Progress** | Caffeine vs. target chart, symptom trends, weekly summary, streaks, milestones. |
| **Gentle prompts** | Suggests holding or pausing when symptoms are rough, handles a "bumpy day", celebrates milestones, notices if caffeine creeps back after finishing. |
| **Reminders** | Real push notifications at a chosen time (skipped once you've logged), optional evening follow-up, on-device fallback, calendar file. |
| **Your data** | One-file export (with a format and app version inside), an import that shows what it will add *before* saving and then merges without overwriting, daily on-device safety copies, an encrypted cloud backup restored with a recovery code, a last-backup date and a nudge, a storage warning. |
| **Mistakes** | Undo / Redo, a History list, an Undo pop-up after every delete, Recently deleted (30 days) with Restore, confirmation before anything permanent. |
| **Finding things** | Search across everything, a Help page, a welcome card, a Settings check (what is on/off), empty screens with a next step. |
| **Updates** | Version number and date in Settings, an "Update now" banner that appears by itself, What's new for every version. |
| **Privacy** | Optional PIN or password lock (a screen lock; see Privacy below). |
| **Look** | Botanical vines, soft sage/mint/lavender palette, light/dark (follows the phone, or choose), three text sizes, large tap targets, works offline and says when it is offline. |

## Project layout

```
index.html            page shell (head setup, tab bar, mount points)
styles.css            all styling; colors are CSS variables with a light and a dark set
app.js                the whole app: state, views, events, push, cloud backup (heavily commented)
sw.js                 service worker: offline cache, update flow (new version waits, then "Update now"), push notifications
CHANGELOG.md          dated list of changes per version (kept in step with CHANGES in app.js by a test)
tests/                automated tests (node:test + jsdom) that run the real app; `npm test`
.github/workflows/    CI: run the tests, deploy to GitHub Pages only if they pass
manifest.webmanifest  install info (name, icons, home-screen shortcuts). JSON can't hold comments, so see below.
icons/                app icons (192 and 512 px)
worker/               Cloudflare Worker: push reminders + encrypted backup storage (see worker/README.md)
```

`manifest.webmanifest`: `start_url`/`scope` keep the app on its own page; `display: standalone` hides the browser bar;
`shortcuts` add long-press actions ("Log a coffee" opens `./?quick=coffee`, handled by `handleLaunchParams()` in `app.js`).

## How the app works

* **One state object.** Everything the user owns is the object `S` in `app.js`, saved as JSON in `localStorage`.
  The exact shape is documented at the top of `app.js`.
* **Render from state.** `render()` rebuilds the visible tab as an HTML string from `S`. Clicks and edits are handled by
  three delegated listeners on `document` (`click`, `input`, `change`); buttons say what they do with `data-act`.
* **Dates** are local `YYYY-MM-DD` strings. A day is "logged" once `S.logs[date]` exists. Today's unfinished day never
  completes a baseline or earns a milestone.
* **Drinks** are a user-editable list (`S.settings.presets`). Logging stores a snapshot (`name`, `mg`, …) per day, keyed by
  drink and caffeine amount, so editing a drink later never changes past or already-logged amounts.
* **History is frozen.** `S.hist` records the target that applied on each past day; reshaping the plan only affects the future.
* **Migrations.** `S.v` is the data version. `migrate()` upgrades old saved data in place (v1 cans → v2 mg → v3 drinks).
  Anything `save()` touches must be initialised when `migrate()` runs at start-up (use hoisted `function` declarations).
* **Safety.** All user text is passed through `esc()` before going into HTML. Destructive actions take a safety copy first.

## Privacy and security

| Where | What is stored | Readable by the service? |
|---|---|---|
| Your phone | Everything | – |
| Reminder service (Cloudflare KV) | Push subscription, reminder time(s), time zone, dates of "logged / checked in" | Yes, but contains no drink or symptom data |
| Cloud backup (Cloudflare KV) | An AES-GCM encrypted copy of your data under an ID derived from your recovery code | **No.** The key never leaves your phone |

The recovery code is 25 random characters (125 bits). Lose both the phone and the code and the backup cannot be opened.
The reminder service only accepts calls from the app's own origin and only contacts real browser push services.

The lock is a screen lock only: it hides the app from someone holding an unlocked phone. Only a salted PBKDF2 hash of the
PIN/password is stored. It does not encrypt the data kept in the browser, and forgetting it means erasing this phone's copy
(then restoring from an export or the cloud recovery code).

## Run it locally

```bash
python -m http.server 8123      # then open http://localhost:8123
```

Service workers cache aggressively: while developing, unregister the worker (DevTools → Application) or bump `CACHE` in `sw.js`.

## Tests

```bash
npm install     # once: installs jsdom, which the tests use to run the real page
npm test
```

The tests load `index.html` and `app.js` into a simulated browser and click real buttons. They cover export/import and merging,
undo/redo/trash, search, help, the lock, update banners, offline/storage notices, migrations from old data, and a sweep of every
screen in many situations. Release checks make sure `VERSION` (app.js), the cache name (sw.js) and `CHANGELOG.md` agree.

## Deploy

* **App:** static files on GitHub Pages, published by `.github/workflows/deploy.yml`. Every push to `main` runs the tests first;
  if any fails, nothing is deployed. Installed copies notice the new version, show an "Update now" banner and reload into it.
  **To release:** bump `VERSION` in `app.js` and `CACHE` in `sw.js` (same number), add an entry to `CHANGES` in `app.js` and to
  `CHANGELOG.md` (a test fails if they disagree), then push.
* **Worker:** see `worker/README.md` (`wrangler deploy`; the private VAPID key is a Worker secret and is never committed).

## Conventions

* Comments explain *why*, and every function has a short description. Keep `app.js` sections in order:
  constants & state → dates → plan logic → ui state → decoration → helpers → safety copies → views → charts → events → push →
  cloud backup → local reminders → theme → boot.
* No runtime dependencies and no build step on purpose: the app should stay easy to read, host and trust. (`jsdom` is used only by the tests.)

## Not medical advice

Gentle Taper is a tracking tool. Stopping caffeine can cause headaches, fatigue and low mood. If symptoms are severe, don't
ease, or you have a heart condition or take medication, please talk with a doctor or pharmacist.

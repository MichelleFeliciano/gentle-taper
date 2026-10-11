# Gentle Taper push reminders (Cloudflare Worker)

A tiny service that sends a daily push notification at your reminder time, even when the app is closed.

**What it stores:** the browser's push subscription, your reminder time, your time zone, and the dates of the last reminder / last check-in. No drink, symptom or health data ever leaves your phone.

**How it works:** the app registers with `/subscribe`; a cron trigger runs every 5 minutes, finds reminders that are due in each person's local time, and sends a payload-less push signed with VAPID keys. The app's service worker (`sw.js`) shows the notification. `/done` lets the app say "already checked in today" so that day's reminder is skipped.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create SUBS          # copy the id into wrangler.toml
npx wrangler secret put VAPID_PRIVATE_JWK      # paste the private key JWK (kept out of git)
npx wrangler deploy
```

Then set `PUSH_URL` in `app.js` to the deployed `*.workers.dev` URL.

The VAPID public key in `wrangler.toml` and `app.js` is public by design. The private key must never be committed.

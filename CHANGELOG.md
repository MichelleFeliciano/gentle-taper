# Changelog

Newest first. The version number is the same one shown in Settings and in the service worker's cache name
(`gentle-taper-v<N>` in `sw.js`); `VERSION` and `CHANGES` in `app.js` say the same thing as this file, and a test keeps them in step.
To release: bump `VERSION` in `app.js`, `CACHE` in `sw.js`, add an entry to `CHANGES` in `app.js` and here, then push.

## 19 — 2026-10-26

- Updates: a banner tells you when a new version is ready, with an Update now button. Settings shows the version, its date and what changed.
- Your data: Import now checks the file first and shows what it would add, then merges without overwriting anything. Exports carry a version number.
- Undo and Redo, a History list, an Undo button after deletes, and a Recently deleted list with Restore.
- Search across everything, a Help page, a welcome card, and a Settings check that lists what is on or off.
- Text size setting, an offline notice, a storage warning, and an optional PIN or password lock.
- Tests now run on GitHub before every deploy, and a failing test stops the deploy.

## 18 — 2026-10-11

- Colour, contrast and focus-outline fixes; wide-screen vines; landscape safe-area padding.
- Earlier versions: the taper plan, drink logging and favourites, symptoms, reminders, push notifications, encrypted cloud backup and dark mode.

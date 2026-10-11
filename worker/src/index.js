// Gentle Taper — daily push reminder service (Cloudflare Worker + KV + cron).
//
// Two jobs:
//  1. Daily push reminders. Stored: the browser push subscription, reminder time(s), time zone, and the
//     dates of the last reminder / last log / last check-in. No drink or symptom data. Pushes carry no payload.
//  2. Encrypted cloud backup. The app encrypts everything on the phone (AES-GCM, key derived from a recovery
//     code only the user holds) and uploads the ciphertext under an ID derived from that same code.
//     This service never sees the code, the key, or readable data. The last 3 versions are kept.

const ORIGINS = ['https://michellefeliciano.github.io', 'http://localhost:8123'];
// Only real browser push services are allowed, so this can't be used to make the Worker call arbitrary URLs.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const TTL_SECONDS = 90 * 24 * 3600; // subscriptions expire unless the app re-registers (it does on each daily open)
const SEND_WINDOW_MIN = 30;         // send up to 30 min late if a cron run is missed
const MIN_GAP_MIN = 120;            // the evening follow-up must be at least this long after the main reminder
const BACKUP_MAX = 1500000;         // characters of ciphertext per backup
const BACKUP_TTL = 400 * 24 * 3600; // a backup that is never refreshed expires after ~13 months
const GEN_GAP_MS = 20 * 3600 * 1000; // rotate to a new "previous version" at most once per ~day

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function keyId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(endpoint));
  return 's:' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const validEndpoint = e => {
  try { const u = new URL(e); return u.protocol === 'https:' && e.length < 1000 && PUSH_HOSTS.some(r => r.test(u.hostname)); } catch { return false; }
};
const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch { return false; } };
const validTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const validBackupId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id);
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

function corsHeaders(origin) {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...(origin ? corsHeaders(origin) : {}) } });

// Current local date (YYYY-MM-DD) and minutes-since-midnight in a timezone.
function localParts(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// Which reminder, if any, is due right now? Pure, so it's easy to reason about.
//  main: skipped once the user has logged anything today (touched) or saved the check-in (done)
//  eve : optional follow-up, sent unless today's check-in is saved
export function dueKind(rec, now = new Date()) {
  const { date, minutes } = localParts(rec.tz, now);
  if (rec.done === date) return null;
  const inWindow = hhmm => { const t = toMin(hhmm); return minutes >= t && minutes < t + SEND_WINDOW_MIN; };
  if (rec.last !== date && rec.touched !== date && inWindow(rec.time)) return 'main';
  if (rec.evening && rec.lastEve !== date && Math.abs(toMin(rec.evening) - toMin(rec.time)) >= MIN_GAP_MIN && inWindow(rec.evening)) return 'eve';
  return null;
}

async function vapidAuth(env, endpoint) {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendPush(env, endpoint) {
  return fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, endpoint), TTL: '3600', Urgency: 'normal', 'Content-Length': '0' } });
}

async function runCron(env, now = new Date()) {
  let cursor, sent = 0, removed = 0;
  do {
    const page = await env.SUBS.list({ cursor, limit: 1000, prefix: 's:' });
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, 'json');
      const kind = rec && dueKind(rec, now);
      if (!kind) continue;
      try {
        const res = await sendPush(env, rec.endpoint);
        if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k.name); removed++; }
        else if (res.ok) { if (kind === 'main') rec.last = localParts(rec.tz, now).date; else rec.lastEve = localParts(rec.tz, now).date; await env.SUBS.put(k.name, JSON.stringify(rec), { expirationTtl: TTL_SECONDS }); sent++; }
        else console.log('push failed', res.status);
      } catch (e) { console.log('push error', String(e)); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { sent, removed };
}

async function handle(req, env) {
  const url = new URL(req.url), origin = req.headers.get('Origin');
  if (url.pathname === '/health') return json({ ok: true }, 200);
  if (!ORIGINS.includes(origin)) return json({ error: 'forbidden' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json({ error: 'method' }, 405, origin);
  const raw = await req.text();
  if (raw.length > (url.pathname === '/backup/put' ? BACKUP_MAX + 200 : 4000)) return json({ error: 'too large' }, 413, origin);
  let body; try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400, origin); }

  if (url.pathname === '/subscribe') {
    const sub = body.subscription;
    if (!sub || !validEndpoint(sub.endpoint)) return json({ error: 'bad endpoint' }, 400, origin);
    if (!validTime(body.time) || !validTz(body.tz) || (body.evening && !validTime(body.evening))) return json({ error: 'bad time or timezone' }, 400, origin);
    const id = await keyId(sub.endpoint), prev = await env.SUBS.get(id, 'json');
    const rec = { endpoint: sub.endpoint, time: body.time, tz: body.tz, evening: body.evening || '',
      last: prev?.last || '', lastEve: prev?.lastEve || '', done: prev?.done || '', touched: prev?.touched || '' };
    await env.SUBS.put(id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
    return json({ ok: true }, 200, origin);
  }
  if (url.pathname === '/unsubscribe') {
    if (!validEndpoint(body.endpoint)) return json({ error: 'bad endpoint' }, 400, origin);
    await env.SUBS.delete(await keyId(body.endpoint));
    return json({ ok: true }, 200, origin);
  }
  if (url.pathname === '/done') { // the user already checked in today, so skip today's reminder
    if (!validEndpoint(body.endpoint) || !validDate(body.date)) return json({ error: 'bad request' }, 400, origin);
    const id = await keyId(body.endpoint), rec = await env.SUBS.get(id, 'json');
    if (rec) { rec.done = body.date; await env.SUBS.put(id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS }); }
    return json({ ok: true }, 200, origin);
  }
  if (url.pathname === '/touch') { // the user logged something today, so skip the main reminder
    if (!validEndpoint(body.endpoint) || !validDate(body.date)) return json({ error: 'bad request' }, 400, origin);
    const id = await keyId(body.endpoint), rec = await env.SUBS.get(id, 'json');
    if (rec) { rec.touched = body.date; await env.SUBS.put(id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS }); }
    return json({ ok: true }, 200, origin);
  }
  if (url.pathname === '/backup/put') {
    if (!validBackupId(body.id) || typeof body.blob !== 'string' || body.blob.length > BACKUP_MAX) return json({ error: 'bad backup' }, 400, origin);
    const k = g => `b:${body.id}:${g}`, now = Date.now(), cur = await env.SUBS.get(k(0), 'json');
    if (cur && now - cur.ts < 15000) return json({ error: 'slow down' }, 429, origin);
    if (cur && now - cur.ts >= GEN_GAP_MS) { // keep up to 3 versions so one bad upload can't destroy a good copy
      const g1 = await env.SUBS.get(k(1));
      if (g1) await env.SUBS.put(k(2), g1, { expirationTtl: BACKUP_TTL });
      await env.SUBS.put(k(1), JSON.stringify(cur), { expirationTtl: BACKUP_TTL });
    }
    await env.SUBS.put(k(0), JSON.stringify({ ts: now, blob: body.blob }), { expirationTtl: BACKUP_TTL });
    return json({ ok: true, ts: now }, 200, origin);
  }
  if (url.pathname === '/backup/get') {
    if (!validBackupId(body.id)) return json({ error: 'bad backup' }, 400, origin);
    const gen = [0, 1, 2].includes(body.gen) ? body.gen : 0, k = g => `b:${body.id}:${g}`;
    const all = await Promise.all([0, 1, 2].map(g => env.SUBS.get(k(g), 'json')));
    if (!all[gen]) return json({ error: 'not found' }, 404, origin);
    return json({ ok: true, ts: all[gen].ts, blob: all[gen].blob, gens: all.map(x => x ? x.ts : null) }, 200, origin);
  }
  if (url.pathname === '/backup/delete') {
    if (!validBackupId(body.id)) return json({ error: 'bad backup' }, 400, origin);
    await Promise.all([0, 1, 2].map(g => env.SUBS.delete(`b:${body.id}:${g}`)));
    return json({ ok: true }, 200, origin);
  }
  if (url.pathname === '/test') { // "Send a test" button: push right now (once a minute at most)
    if (!validEndpoint(body.endpoint)) return json({ error: 'bad endpoint' }, 400, origin);
    const id = await keyId(body.endpoint), rec = await env.SUBS.get(id, 'json');
    if (!rec) return json({ error: 'not subscribed' }, 404, origin);
    if (rec.lastTest && Date.now() - rec.lastTest < 60000) return json({ error: 'slow down' }, 429, origin);
    rec.lastTest = Date.now(); await env.SUBS.put(id, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
    const res = await sendPush(env, rec.endpoint);
    return json({ ok: res.ok, status: res.status }, 200, origin);
  }
  return json({ error: 'not found' }, 404, origin);
}

export default {
  fetch: (req, env) => handle(req, env).catch(() => { const o = req.headers.get('Origin'); return json({ error: 'server error' }, 500, ORIGINS.includes(o) ? o : undefined); }),
  scheduled: (event, env, ctx) => ctx.waitUntil(runCron(env, new Date(event.scheduledTime))),
};

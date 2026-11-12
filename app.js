import { CONFIG } from './config.js';
import { LocalStore, SupabaseStore, friendlyError, newId } from './store.js';
import {
  ageLabel, monthsLabel, effectiveAge, totalSleepFor, planDay, rhythm,
  isNightSleep, summarize, nightWakings, overlapMin,
} from './sleepdata.js';

const VERSION = '2.0.0';
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const sheet = $('#sheet');
const state = {
  store: null, family: null, sleeps: [], authMode: 'login',
  push: { status: 'unknown' }, members: null, reportDays: 14, patternDays: 14,
};

const TAGS = [
  ['zahnen', 'Zahnt'], ['krank', 'Krank'], ['unruhig', 'Unruhig'], ['gefuettert', 'Beim Füttern'],
  ['kinderwagen', 'Kinderwagen'], ['trage', 'Trage'], ['auto', 'Auto'], ['unterwegs', 'Unterwegs'],
];
const tagLabel = k => (TAGS.find(t => t[0] === k) || [k, k])[1];

/* ===================== Hilfsfunktionen ===================== */
const MIN = 6e4, DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDur = min => {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${pad(m)} min` : `${m} min`;
};
const fmtDurShort = min => {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${pad(m)}` : `${m} min`;
};
const hNum = min => (min / 60).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtHours = min => hNum(min) + ' h';
const aboutText = min => {
  if (min < 55) return `${Math.max(5, Math.round(min / 5) * 5)} Minuten`;
  const q = Math.round(min / 15) / 4, h = Math.floor(q), f = q - h;
  const frac = f === 0.25 ? '¼' : f === 0.5 ? '½' : f === 0.75 ? '¾' : '';
  if (h === 0) return `${frac === '½' ? 'einer halben' : 'einer dreiviertel'} Stunde`;
  return `${h}${frac} ${h === 1 && !frac ? 'Stunde' : 'Stunden'}`;
};
const toInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayISO = () => toInput(new Date()).slice(0, 10);
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = d => Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayLabel = d => {
  const diff = dayDiff(d);
  if (diff === 0) return 'Heute';
  if (diff === -1) return 'Gestern';
  if (diff === -2) return 'Vorgestern';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' }).replace(',', '');
};
const shortDay = d => d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' }).replace(',', '').replace('.', '');
const fmtDate = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
const endOf = (s, now = new Date()) => (s.end_at ? new Date(s.end_at) : now);
const durMin = (s, now = new Date()) => (endOf(s, now) - new Date(s.start_at)) / MIN;
const isNight = s => isNightSleep(s, new Date(), undefined, state.family);
const cloud = () => state.store?.mode === 'cloud';
const name = () => esc(state.family?.child_name || 'euer Kind');
const ls = {
  get(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
};
const pct = (t, from, span) => Math.min(100, Math.max(0, ((t - from) / span) * 100));

/* ===================== Icons ===================== */
const I = {
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z"/>',
  list: '<path d="M4 6h10M4 12h16M4 18h7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chev: '<path d="M6 3l5 5-5 5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  steth: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
};
const svg = (k, cls = '', style = '') => `<svg viewBox="0 0 24 24" class="${cls}" style="${style}" aria-hidden="true">${I[k]}</svg>`;
const chev = () => `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true">${I.chev}</svg>`;
const LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true"><mask id="hm"><rect width="100" height="100" fill="#fff"></rect><circle cx="62" cy="40" r="27" fill="#000"></circle></mask><circle cx="46" cy="55" r="30" fill="var(--logo)" mask="url(#hm)"></circle><path d="M75 15 Q76.6 22.4 84 24 Q76.6 25.6 75 33 Q73.4 25.6 66 24 Q73.4 22.4 75 15Z" fill="var(--star)"></path><path d="M86 43 Q86.9 47.1 91 48 Q86.9 48.9 86 53 Q85.1 48.9 81 48 Q85.1 47.1 86 43Z" fill="var(--star)"></path></svg>';
const BIGMOON = LOGO.replace('id="hm"', 'id="bm"').replace('url(#hm)', 'url(#bm)').replace('<svg ', '<svg class="moon" ');

/* ===================== Rückmeldungen ===================== */
function toast(msg, { error = false, action = null, ms = 3200 } = {}) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.setAttribute('role', error ? 'alert' : 'status');
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); run(action.fn); });
    t.appendChild(b); ms = 6000;
  }
  (sheet.open ? sheet : document.body).appendChild(t);
  setTimeout(() => t.remove(), ms);
}
async function run(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(friendlyError(e), { error: true }); }
}
async function refresh() {
  state.sleeps = await state.store.listSleeps();
  render();
}

/* ===================== Design ===================== */
function getTheme() { return ls.get('schlummi.theme', 'auto'); }
function effTheme() {
  const t = getTheme();
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const h = new Date().getHours();
  return dark ? (ls.get('schlummi.dim', true) && (h >= 20 || h < 7) ? 'dim' : 'dark') : 'light';
}
function applyTheme(t) {
  if (t) ls.set('schlummi.theme', t);
  const eff = effTheme();
  document.documentElement.dataset.theme = eff;
  $('meta[name=theme-color]')?.setAttribute('content', { light: '#F6F3EC', dark: '#0E1430', dim: '#07091A' }[eff]);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

/* ===================== Navigation ===================== */
function route() {
  const h = (location.hash || '#jetzt').slice(1);
  const [tab, sub] = h.split('-');
  return { tab: ['jetzt', 'verlauf', 'einstellungen'].includes(tab) ? tab : 'jetzt', sub: sub || '' };
}
function go(hash) {
  if (location.hash === '#' + hash) render();
  else location.hash = hash;
}
window.addEventListener('hashchange', () => {
  if (!state.family) return;
  render(); window.scrollTo(0, 0);
  const r = route();
  if (r.tab === 'einstellungen') run(async () => { await Promise.all([loadPush(), loadMembers()]); if (route().tab === 'einstellungen') render(); });
});

/* ===================== Push ===================== */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  && (location.protocol === 'https:' || location.hostname === 'localhost');
function b64ToBytes(b64) {
  const p = '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
const PUSH_DEFAULTS = { remind: true, lead_min: 10, partner: true, quiet: true, quiet_start: '20:00', quiet_end: '07:00' };
const pushPrefs = r => ({
  remind: r.remind, lead_min: r.lead_min, partner: r.partner, quiet: r.quiet ?? true,
  quiet_start: String(r.quiet_start || '20:00').slice(0, 5), quiet_end: String(r.quiet_end || '07:00').slice(0, 5),
});
async function loadPush() {
  const p = state.push;
  if (!cloud() || !CONFIG.VAPID_PUBLIC_KEY) { p.status = 'nocloud'; return; }
  if (!pushSupported()) { p.status = isIOS && !isStandalone ? 'ios-install' : 'unsupported'; return; }
  if (Notification.permission === 'denied') { p.status = 'denied'; return; }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  p.sub = sub || null;
  p.row = sub ? await state.store.getPush(sub.endpoint) : null;
  p.status = p.row ? 'on' : 'off';
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { state.push.status = perm === 'denied' ? 'denied' : 'off'; return; }
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: b64ToBytes(CONFIG.VAPID_PUBLIC_KEY),
  });
  state.push.sub = sub;
  state.push.row = await state.store.savePush(sub, PUSH_DEFAULTS);
  state.push.status = 'on';
  toast('Erinnerungen sind an');
}
async function disablePush() {
  const { sub } = state.push;
  if (sub) { await state.store.deletePush(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  state.push = { status: 'off' };
}
async function loadMembers() {
  if (cloud() && state.family) state.members = await state.store.listMembers();
}

/* ===================== Gerüst ===================== */
function ageText(f = state.family, now = new Date()) {
  const a = effectiveAge(f, now);
  return a.corrected ? `${ageLabel(f.birthdate, now)} (korr. ${monthsLabel(a.months)})` : ageLabel(f.birthdate, now);
}
function shortAge(f = state.family) {
  const a = effectiveAge(f), m = Math.floor(a.chrono);
  return m < 2 ? ageLabel(f.birthdate) : m < 24 ? `${m} Mon.` : `${Math.floor(m / 12)} J.`;
}

function render() {
  if (!state.family) return;
  applyTheme();
  const r = route();
  const now = new Date();
  const plan = r.tab === 'jetzt' ? planDay(state.family, state.sleeps, now) : null;
  const pending = state.store.pendingCount();
  const views = { jetzt: () => viewNow(plan, now), verlauf: viewHistory, einstellungen: viewSettings };
  app.classList.toggle('has-dock', r.tab === 'jetzt');
  app.innerHTML = `
    <header class="top">
      <div class="brand">${LOGO}Schlummi</div>
      <div class="kid"><span class="av">${esc(state.family.child_name.slice(0, 1).toUpperCase())}</span><b>${name()}</b> ${esc(shortAge())}</div>
    </header>
    ${pending ? `<p class="sync-note" role="status">Offline – ${pending} ${pending === 1 ? 'Änderung wird' : 'Änderungen werden'} nachgeholt</p>` : ''}
    <main>${views[r.tab]()}</main>
    ${r.tab === 'jetzt' ? dock(plan) : ''}
    <nav class="tabs" aria-label="Bereiche">
      ${tab('jetzt', 'Jetzt', 'moon', r.tab)}${tab('verlauf', 'Verlauf', 'list', r.tab)}${tab('einstellungen', 'Einstellungen', 'gear', r.tab)}
    </nav>`;
}
const tab = (id, label, icon, cur) => `<a class="tab ${cur === id ? 'on' : ''}" href="#${id}" ${cur === id ? 'aria-current="page"' : ''} style="text-decoration:none">
  <span class="pill">${svg(icon)}</span>${label}</a>`;
const subHead = (title, back) => `<div class="sub-head"><a class="back" href="#${back}">${svg('back')}Zurück</a></div><h1>${title}</h1>`;

/* ===================== Jetzt ===================== */
function viewNow(plan, now) {
  if (plan.kind === 'sleeping') return viewSleeping(plan, now);
  const w = plan.r.window;
  let hero = '', extra = '';
  switch (plan.kind) {
    case 'none':
      hero = `<p class="label">Willkommen</p><p class="big num" style="font-size:40px">Bereit</p>
        <p class="sub">Starte den ersten Schlaf – ab dann gibt es Vorschläge.</p>`;
      break;
    case 'stale':
      hero = `<p class="label">Letzter Eintrag</p><p class="big num" style="font-size:40px">${dayLabel(plan.lastEnd)}, ${fmtTime(plan.lastEnd)}</p>`;
      extra = `<section class="card"><h2>Wie war die Nacht?</h2>
        <p class="cap" style="margin:6px 0 12px">Die letzte Nacht ist noch nicht erfasst.</p>
        <button class="btn secondary" data-act="add-night">Nacht nachtragen</button></section>`;
      break;
    case 'night':
      hero = `<p class="label">Nachts wach seit ${fmtTime(plan.lastEnd)}</p><p class="big num">${fmtDur(plan.awake)}</p>
        <p class="sub">Ruhig halten, wenig Licht.${plan.r.months < 12 ? ' Nächtliches Füttern ist in diesem Alter normal.' : ''}</p>`;
      break;
    case 'newborn':
      hero = `<p class="label">Wach seit ${fmtTime(plan.lastEnd)}</p><p class="big num">${fmtDur(plan.awake)}</p>
        <p class="sub">Kurze Wachphasen sind jetzt normal – oft ${fmtDurShort(w.min)}–${fmtDurShort(w.max)}. Achte auf Müdigkeitszeichen und füttere nach Bedarf.</p>`;
      break;
    default:
      hero = `<p class="label">Wach seit ${fmtTime(plan.lastEnd)}</p><p class="big num">${fmtDur(plan.awake)}</p>`;
      extra = nextCard(plan, now);
  }
  return `<section class="hero">${hero}</section>
    ${safeSleepCard()}
    ${extra}
    ${plan.kind === 'night' ? todayCard(plan, now, true) : todayCard(plan, now)}
    ${plan.kind === 'night' ? '' : weekCard(now)}`;
}

function nextCard(plan, now) {
  const n = plan.next, r = plan.r;
  const what = n.type === 'bedtime' ? 'Schlafenszeit'
    : plan.extraNap ? 'Noch ein Schläfchen?'
    : r.naps > 1 ? `${plan.napsDone + 1}. Schläfchen` : 'Schläfchen';
  const why = plan.status === 'early' ? `in etwa ${aboutText((n.from - now) / MIN)} – achte auf Müdigkeitszeichen`
    : plan.status === 'now' ? `Guter Zeitpunkt, wenn ${name()} müde wirkt.`
    : 'Etwas später als sonst – das ist okay.';
  const src = r.learned ? `<p class="cap" style="margin-top:8px">Nach ${name()}s Muster der letzten 14 Tage.</p>` : '';
  return `<section class="card">
    <div class="next">
      <span class="ic">${svg(n.type === 'bedtime' ? 'moon' : 'cloud', '', `stroke:var(--${n.type === 'bedtime' ? 'night' : 'nap'})`)}</span>
      <div><p class="cap">Nächster Schlaf · ${what}</p>
        <p class="when num">etwa ${fmtTime(n.from)} – ${fmtTime(n.to)}</p>
        <p class="why">${why}</p></div>
    </div>
    ${plan.longDay ? `<p class="cap" style="margin-top:10px">Bis zur Schlafenszeit ist es lang – ein kurzes Schläfchen kann helfen.</p>` : ''}
    ${src}
  </section>`;
}

function stripHtml(day0, now, planSeg) {
  const span = DAY, from = day0.getTime(), to = from + span;
  const segs = state.sleeps.filter(s => endOf(s, now) > day0 && new Date(s.start_at).getTime() < to).map(s => {
    const a = Math.max(Date.parse(s.start_at), from), b = Math.min(endOf(s, now).getTime(), to);
    return `<i class="seg ${isNight(s) ? 'night' : 'nap'}" style="left:${pct(a, from, span)}%;width:${pct(b, from, span) - pct(a, from, span)}%"></i>`;
  }).join('');
  const plan = planSeg && planSeg.from.getTime() < to
    ? `<i class="seg plan" style="left:${pct(planSeg.from.getTime(), from, span)}%;width:${pct(Math.min(planSeg.to.getTime(), to), from, span) - pct(planSeg.from.getTime(), from, span)}%"></i>` : '';
  const nowl = now.getTime() < to ? `<i class="nowline" style="left:${pct(now.getTime(), from, span)}%"></i>` : '';
  return `<div class="strip" role="img" aria-label="Schlaf heute als Zeitleiste">${segs}${plan}${nowl}</div>
    <div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>`;
}

function todayCard(plan, now, compact = false) {
  const day0 = startOfDay(now);
  const list = state.sleeps.filter(s => endOf(s, now) > day0).sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  const planSeg = plan.next && !compact ? plan.next : null;
  const planRow = planSeg ? `<li><div class="plan-row"><span class="dot plan"></span>
    <span class="t2">${planSeg.type === 'bedtime' ? 'Schlafenszeit' : 'Schläfchen'}<span class="k">Vorschlag, etwa ${fmtTime(planSeg.from)} – ${fmtTime(planSeg.to)}</span></span><span></span><span></span></div></li>` : '';
  const last24 = summarize(state.sleeps, new Date(+now - DAY), now, now, undefined, state.family);
  return `<section class="card">
    <div class="card-h"><h2>Heute</h2>${compact ? `<span class="cap">${fmtHours(last24.total)} in 24 h</span>` : '<button class="link" data-act="add">+ Nachtragen</button>'}</div>
    ${stripHtml(day0, now, planSeg)}
    ${compact ? '' : `<ul class="entries">${planRow}${list.map(entryRow).join('') || '<li><p class="empty">Noch keine Einträge heute.</p></li>'}</ul>`}
  </section>`;
}

function entryRow(s) {
  const st = new Date(s.start_at), en = s.end_at ? new Date(s.end_at) : null;
  const night = isNight(s);
  const prefix = dayDiff(st) === -1 && en && dayDiff(en) === 0 ? 'gestern ' : '';
  const tags = (s.tags || []).map(t => `<span class="tag">${esc(tagLabel(t))}</span>`).join('');
  return `<li><button class="entry" data-act="edit" data-id="${esc(s.id)}">
    <span class="dot ${night ? 'night' : 'nap'}"></span>
    <span>${night ? 'Nacht' : 'Schläfchen'}<span class="k">${prefix}${fmtTime(st)} – ${en ? fmtTime(en) : 'läuft'}</span></span>
    <span class="dur">${fmtDurShort(durMin(s))}</span>${chev()}
    ${tags || s.note ? `<span class="tags">${tags}${s.note ? `<span class="cap">${esc(s.note)}</span>` : ''}</span>` : ''}
  </button></li>`;
}

function avgDays(n, now = new Date()) {
  const days = [];
  for (let i = 1; i <= n; i++) {
    const d = addDays(startOfDay(now), -i);
    const s = summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family);
    if (s.total > 0) days.push(s);
  }
  if (days.length < 3) return null;
  const avg = k => days.reduce((a, s) => a + s[k], 0) / days.length;
  return { total: avg('total'), night: avg('night'), nap: avg('nap'), naps: avg('naps'), n: days.length };
}

function weekCard(now) {
  const wk = avgDays(7, now);
  if (!wk) return '';
  const rec = totalSleepFor(effectiveAge(state.family, now).months);
  const max = (rec.normalMax || rec.max) + 2;
  return `<section class="card">
    <div class="card-h"><h2>Letzte 7 Tage</h2><a class="link" href="#verlauf">Verlauf ›</a></div>
    <div class="stats">
      <div><span class="cap">Ø pro Tag</span><b>${fmtHours(wk.total)}</b></div>
      <div><span class="cap">Ø Nacht</span><b>${fmtHours(wk.night)}</b></div>
      <div><span class="cap">Ø Tag</span><b>${fmtHours(wk.nap)}</b></div>
    </div>
    <div class="range" role="img" aria-label="Durchschnitt im Vergleich zum Richtwert"><i class="band" style="left:${(rec.min / max) * 100}%;width:${((rec.max - rec.min) / max) * 100}%"></i><i class="mk" style="left:${Math.min(100, (wk.total / 60 / max) * 100)}%"></i></div>
    <p class="cap">Richtwert in diesem Alter: ${rec.min}–${rec.max} h pro Tag <button class="link" data-act="info" data-topic="richtwert" aria-label="Mehr zum Richtwert">ⓘ</button></p>
  </section>`;
}

function safeSleepCard() {
  if (ls.get('schlummi.safeSleepSeen', false)) return '';
  return `<section class="card"><h2>Sicher schlafen</h2>
    <p class="cap" style="margin:6px 0 12px">Rückenlage, eigenes Bett im Elternschlafzimmer, Schlafsack statt Decke, keine Kissen oder Kuscheltiere im Bett, rauchfrei, etwa 18 °C.</p>
    <button class="btn secondary small" data-act="safe-seen">Verstanden</button></section>`;
}

function viewSleeping(plan, now) {
  const s = plan.running;
  return `<section class="sleepview">
      ${BIGMOON}
      <p class="label">${plan.night ? 'Nachtschlaf' : 'Schläfchen'}</p>
      <p class="big num">${fmtDur(plan.mins)}</p>
      <p class="sub">eingeschlafen um ${fmtTime(new Date(s.start_at))} · <button data-act="edit-start" data-id="${esc(s.id)}">ändern</button></p>
      ${plan.wakeAt && !plan.forgotten ? `<p class="pillrow">${svg('sun', '', 'width:18px;height:18px;fill:none;stroke:var(--star);stroke-width:1.8')}Übliche Aufwachzeit <b>etwa ${fmtTime(plan.wakeAt)}</b></p>` : ''}
    </section>
    ${plan.forgotten ? `<div class="notice" role="status"><b>Läuft schon ${fmtDur(plan.mins)}.</b> Vergessen zu stoppen?
      <button class="link" data-act="edit" data-id="${esc(s.id)}">Aufwachzeit eintragen</button></div>` : ''}
    ${todayCard(plan, now, true)}`;
}

function dock(plan) {
  let btn;
  if (plan.kind === 'sleeping') btn = `<button class="btn wake" data-act="stop">${svg('sun', '', 'fill:none;stroke:currentColor;stroke-width:2')}Aufgewacht</button>`;
  else if (plan.kind === 'night') btn = `<button class="btn primary" data-act="start" data-kind="night">${svg('moon', '', 'fill:currentColor')}Wieder eingeschlafen</button>`;
  else btn = `<button class="btn primary" data-act="start">${svg('moon', '', 'fill:currentColor')}Schlaf starten</button>`;
  return `<div class="dock"><div class="dock-in">${btn}</div></div>`;
}

/* ===================== Verlauf ===================== */
function viewHistory() {
  const sub = route().sub || 'muster';
  const segs = [['muster', 'Muster'], ['zahlen', 'Zahlen'], ['bericht', 'Bericht']];
  const body = { muster: viewPattern, zahlen: viewNumbers, bericht: viewReport }[sub] || viewPattern;
  return `<h1>Verlauf</h1>
    <div class="segctl no-print" role="tablist">${segs.map(([k, l]) => `<button role="tab" class="${sub === k ? 'on' : ''}" aria-selected="${sub === k}" data-act="go" data-to="verlauf-${k}">${l}</button>`).join('')}</div>
    ${body()}`;
}

function patternFacts() {
  const r = rhythm(state.family, new Date(), state.sleeps);
  const L = r.learned;
  if (r.newborn) return `<section class="card"><h2>Muster</h2><p class="cap" style="margin-top:6px">In den ersten Monaten gibt es noch keinen festen Rhythmus. Schlummi zeigt Muster ab etwa 3 Monaten.</p></section>`;
  if (!L) return `<section class="card"><h2>${name()}s Muster</h2><p class="cap" style="margin-top:6px">Sobald etwa eine Woche erfasst ist, erkennt Schlummi ${name()}s Rhythmus und passt die Vorschläge daran an.</p></section>`;
  const napAt = L.firstWW != null && L.wake ? (() => { const [h, m] = L.wake.split(':').map(Number); const t = h * 60 + m + L.firstWW; return `${pad(Math.floor(t / 60) % 24)}:${pad(Math.round(t % 60))}`; })() : null;
  const trend = L.trend === 'fewer' ? `Seit einigen Tagen meist ${L.naps} Schläfchen am Tag, vorher öfter mehr – ein typischer Übergang.`
    : L.trend === 'more' ? `Zuletzt öfter ${L.naps} Schläfchen am Tag als vorher.`
    : `Meist ${L.naps} Schläfchen am Tag.`;
  return `<section class="card">
    <div class="card-h"><h2>${name()}s Muster</h2><span class="cap">letzte 14 Tage</span></div>
    <div class="facts">
      <div><small>Aufwachen</small><b>etwa ${L.wake}</b></div>
      <div><small>Schlafenszeit</small><b>etwa ${L.bed}</b></div>
      ${napAt ? `<div><small>Erstes Schläfchen</small><b>etwa ${napAt}</b></div>` : ''}
      ${L.napLen ? `<div><small>Schläfchenlänge</small><b>${fmtDurShort(L.napLen)}</b></div>` : ''}
      ${L.firstWW ? `<div><small>Wach bis zum Schläfchen</small><b>${fmtDurShort(L.firstWW)}</b></div>` : ''}
      ${L.lastWW ? `<div><small>Wach bis zur Schlafenszeit</small><b>${fmtDurShort(L.lastWW)}</b></div>` : ''}
    </div>
    <div class="obs">${svg('spark')}<p class="cap">${trend} Die Vorschläge auf dem Startbildschirm richten sich nach diesem Muster.</p></div>
  </section>`;
}

function patternRows(n) {
  const now = new Date();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(startOfDay(now), -i);
    const from = addDays(day, -1); from.setHours(18, 0, 0, 0);
    const to = new Date(day); to.setHours(18, 0, 0, 0);
    const f = from.getTime(), span = to - from;
    let total = 0, segs = '', marks = '';
    for (const s of state.sleeps) {
      const m = overlapMin(s, from, to, now);
      if (!m) continue;
      total += m;
      const a = Math.max(Date.parse(s.start_at), f), b = Math.min(endOf(s, now).getTime(), +to);
      segs += `<i class="seg ${isNight(s) ? 'night' : 'nap'}" style="left:${pct(a, f, span)}%;width:${pct(b, f, span) - pct(a, f, span)}%"></i>`;
      if ((s.tags && s.tags.length) || s.note) marks += `<i class="mark" style="left:${pct(a, f, span) + 1}%"></i>`;
    }
    const we = [0, 6].includes(day.getDay());
    rows.push(`<button class="prow" data-act="day" data-day="${toInput(day).slice(0, 10)}" aria-label="${dayLabel(day)}: ${fmtHours(total)} Schlaf, Details öffnen">
      <span class="d ${we ? 'we' : ''}">${i === 0 ? 'Heute' : shortDay(day)}</span>
      <span class="ptrack"><i class="gl" style="left:25%"></i><i class="gl" style="left:50%"></i><i class="gl" style="left:75%"></i>${segs}${marks}</span>
      <span class="v">${total ? hNum(total) : '–'}</span></button>`);
  }
  return rows.join('');
}

function viewPattern() {
  const n = state.patternDays;
  const s = avgDays(14);
  return `${patternFacts()}
    ${s ? `<div class="stats" style="margin-bottom:12px">
      <div><span class="cap">Ø pro Tag</span><b>${fmtHours(s.total)}</b></div>
      <div><span class="cap">Ø Nacht</span><b>${fmtHours(s.night)}</b></div>
      <div><span class="cap">Ø Tag</span><b>${fmtHours(s.nap)}</b></div></div>` : ''}
    <section class="card">
      <div class="card-h"><h2>Letzte ${n} Tage</h2><span class="cap">18 bis 18 Uhr · Std.</span></div>
      <div class="paxis"><span></span><span class="lab"><span style="left:0%">18</span><span style="left:25%">0</span><span style="left:50%">6</span><span style="left:75%">12</span><span style="left:100%">18</span></span><span></span></div>
      ${patternRows(n)}
      <p class="legend"><span><i class="dot night"></i>Nacht</span><span><i class="dot nap"></i>Tag</span><span><i class="dot" style="background:var(--text);width:6px;height:6px"></i>Notiz</span></p>
      ${n < 56 ? `<button class="text-btn" data-act="more-days" style="margin-top:6px">Mehr Tage anzeigen</button>` : ''}
    </section>
    <p class="hint">Tippe auf einen Tag, um Einträge zu sehen oder zu ändern.</p>`;
}

function medianClock(dates, evening) {
  if (!dates.length) return '–';
  const v = dates.map(d => { let h = d.getHours() + d.getMinutes() / 60; if (evening && h < 12) h += 24; return h; }).sort((a, b) => a - b);
  const m = v[Math.floor(v.length / 2)] % 24;
  let hh = Math.floor(m), mm = Math.round((m % 1) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return `${pad(hh)}:${pad(mm)}`;
}

function viewNumbers() {
  const now = new Date();
  const rec = totalSleepFor(effectiveAge(state.family, now).months);
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), i - 6));
  const sums = days.map(d => summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family));
  const scale = Math.max(rec.max + 2, ...sums.map(s => s.total / 60));
  const bars = days.map((d, i) => {
    const s = sums[i], today = i === 6;
    return `<div class="ccol"><div class="stack ${today ? 'today' : ''}" title="${fmtHours(s.total)}">
        <div class="s nap" style="height:${(s.nap / 60 / scale) * 100}%"></div><div class="s night" style="height:${(s.night / 60 / scale) * 100}%"></div></div>
      <span class="val">${s.total ? hNum(s.total) : '–'}</span><span class="lbl">${today ? 'bisher' : d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')}</span></div>`;
  }).join('');
  const since = Date.now() - 14 * DAY;
  const nights = state.sleeps.filter(s => s.end_at && isNight(s) && Date.parse(s.start_at) > since && durMin(s) >= 240);
  const naps = state.sleeps.filter(s => s.end_at && !isNight(s) && Date.parse(s.start_at) > since);
  const napLens = naps.map(s => durMin(s)).sort((a, b) => a - b);
  const avg14 = avgDays(14);
  const list = Array.from({ length: 14 }, (_, i) => addDays(startOfDay(now), -i)).map(d => {
    const s = summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family);
    return `<li><button class="entry" data-act="day" data-day="${toInput(d).slice(0, 10)}" style="grid-template-columns:1fr auto 16px">
      <span>${dayLabel(d)}<span class="k">${s.naps} Schläfchen</span></span>
      <span class="dur">${s.total ? (dayDiff(d) === 0 ? 'bisher ' : '') + fmtHours(s.total) : '–'}</span>${chev()}</button></li>`;
  }).join('');
  return `<section class="card">
      <div class="card-h"><h2>7 Tage</h2><span class="cap">pro Kalendertag</span></div>
      <div class="chart"><div class="recband" style="bottom:${(rec.min / scale) * 100}%;height:${((rec.max - rec.min) / scale) * 100}%"><span>Richtwert ${rec.min}–${rec.max} h</span></div>${bars}</div>
      <p class="legend"><span><i class="dot night"></i>Nacht</span><span><i class="dot nap"></i>Tag</span></p>
    </section>
    <div class="facts" style="margin:0 0 12px">
      <div><small>Ø Einschlafen abends</small><b>${medianClock(nights.map(s => new Date(s.start_at)), true)}</b></div>
      <div><small>Ø Aufwachen</small><b>${medianClock(nights.map(s => new Date(s.end_at)), false)}</b></div>
      <div><small>Ø Schläfchenlänge</small><b>${napLens.length ? fmtDurShort(napLens[Math.floor(napLens.length / 2)]) : '–'}</b></div>
      <div><small>Ø Schläfchen pro Tag</small><b>${avg14 ? avg14.naps.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–'}</b></div>
    </div>
    <section class="card"><div class="card-h"><h2>Tage</h2><button class="link" data-act="add">+ Nachtragen</button></div><ul class="entries">${list}</ul></section>`;
}

function viewReport() {
  const now = new Date();
  const n = state.reportDays;
  const f = state.family;
  const rec = totalSleepFor(effectiveAge(f, now).months);
  const days = Array.from({ length: n }, (_, i) => addDays(startOfDay(now), -n + i));
  const rows = days.map(d => {
    const s = summarize(state.sleeps, d, addDays(d, 1), now, undefined, f);
    const morning = state.sleeps.find(x => x.end_at && isNight(x) && startOfDay(new Date(x.end_at)).getTime() === d.getTime());
    return { d, ...s, wakings: morning ? nightWakings(state.sleeps, new Date(morning.end_at), now, undefined, f) : null };
  });
  const withData = rows.filter(r => r.total > 0);
  const avg = k => withData.length ? withData.reduce((a, r) => a + (r[k] || 0), 0) / withData.length : 0;
  const wk = withData.filter(r => r.wakings != null);
  const avgW = wk.length ? wk.reduce((a, r) => a + r.wakings, 0) / wk.length : null;
  const inRange = state.sleeps.filter(s => Date.parse(s.start_at) >= days[0].getTime());
  const tagCount = {};
  inRange.forEach(s => (s.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const notes = inRange.filter(s => s.note && !/^\d+ Pause/.test(s.note)).slice(0, 20);
  return `<section class="card report">
    <div class="card-h"><h2>Schlafbericht</h2>
      <div class="mini-seg no-print">${[7, 14, 28].map(k => `<button class="${n === k ? 'on' : ''}" data-act="report-days" data-days="${k}">${k} T.</button>`).join('')}</div></div>
    <p><b>${name()}</b>, geboren ${fmtDate(new Date(f.birthdate + 'T00:00:00'))} · ${esc(ageText())}</p>
    <p class="cap">Zeitraum ${fmtDate(days[0])} – ${fmtDate(days.at(-1))} · ${withData.length} von ${n} Tagen mit Einträgen</p>
    <div class="kpis">
      <div><span class="cap">Ø Gesamt</span><b>${fmtHours(avg('total'))}</b></div>
      <div><span class="cap">Ø Nacht</span><b>${fmtHours(avg('night'))}</b></div>
      <div><span class="cap">Ø Tag</span><b>${fmtHours(avg('nap'))}</b></div>
      <div><span class="cap">Ø Schläfchen</span><b>${avg('naps').toLocaleString('de-DE', { maximumFractionDigits: 1 })}</b></div>
      <div><span class="cap">Ø Unterbrechungen nachts</span><b>${avgW == null ? '–' : avgW.toLocaleString('de-DE', { maximumFractionDigits: 1 })}</b></div>
      <div><span class="cap">Richtwert</span><b>${rec.min}–${rec.max} h</b></div>
    </div>
    <table class="rtable"><thead><tr><th>Datum</th><th>Gesamt</th><th>Nacht</th><th>Tag</th><th>Schläf&shy;chen</th><th>Unter&shy;brech.</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r.d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${r.d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</td>
        <td>${r.total ? hNum(r.total) : '–'}</td><td>${r.total ? hNum(r.night) : '–'}</td><td>${r.total ? hNum(r.nap) : '–'}</td>
        <td>${r.total ? r.naps : '–'}</td><td>${r.wakings ?? '–'}</td></tr>`).join('')}</tbody></table>
    ${Object.keys(tagCount).length ? `<p class="cap"><b>Markierungen:</b> ${Object.entries(tagCount).map(([k, v]) => `${esc(tagLabel(k))} (${v}×)`).join(', ')}</p>` : ''}
    ${notes.length ? `<p class="cap" style="margin-top:8px"><b>Notizen:</b></p><ul class="notes">${notes.map(s => `<li>${dayLabel(new Date(s.start_at))} ${fmtTime(new Date(s.start_at))}: ${esc(s.note)}</li>`).join('')}</ul>` : ''}
    <p class="cap" style="margin-top:8px">Angaben in Stunden, selbst erfasst mit Schlummi. Unterbrechungen zählen nur erfasste Wachphasen in der Nacht.</p>
    <div class="no-print" style="margin-top:14px"><button class="btn primary small" data-act="print">Drucken oder als PDF sichern</button></div>
  </section>`;
}

/* ===================== Einstellungen ===================== */
function viewSettings() {
  const sub = route().sub;
  const pages = { kind: setKind, rhythmus: setRhythm, erinnerungen: setPush, familie: setFamily, konto: setAccount, darstellung: setLook, daten: setData, sicher: () => setInfo('sicher'), richtwerte: () => setInfo('richtwerte'), arzt: () => setInfo('arzt') };
  if (pages[sub]) return pages[sub]();
  const f = state.family;
  const r = rhythm(f, new Date(), state.sleeps);
  const pushVal = { on: 'An', off: 'Aus', denied: 'blockiert', 'ios-install': 'einrichten', unsupported: 'nicht möglich', nocloud: '–' }[state.push.status] || '';
  const row = (to, icon, title, val = '') => `<a class="row" href="#einstellungen-${to}" style="color:inherit;text-decoration:none"><span class="ico">${svg(icon)}</span><span>${title}</span><span class="val">${val}</span>${chev()}</a>`;
  return `<h1>Einstellungen</h1>
    <div class="group"><a class="profile" href="#einstellungen-kind" style="color:inherit;text-decoration:none"><span class="av">${esc(f.child_name.slice(0, 1).toUpperCase())}</span>
      <span><b>${name()}</b><span class="cap">${esc(ageText())} · geboren ${new Date(f.birthdate + 'T00:00:00').toLocaleDateString('de-DE')}</span></span>${chev()}</a></div>
    <p class="gtitle">Schlaf</p>
    <div class="group">
      ${row('rhythmus', 'clock', 'Tagesrhythmus', `${r.naps} Schläfchen<br>${r.waketime || '–'} / ${r.bedtime || '–'}`)}
      ${row('erinnerungen', 'bell', 'Erinnerungen', pushVal)}
    </div>
    ${cloud() ? `<p class="gtitle">Familie</p><div class="group">
      ${row('familie', 'users', 'Gemeinsam nutzen', state.members ? `${state.members.length} ${state.members.length === 1 ? 'Person' : 'Personen'}` : '')}
      ${row('konto', 'user', 'Konto', 'angemeldet')}</div>` : ''}
    <p class="gtitle">App</p>
    <div class="group">
      ${row('darstellung', 'contrast', 'Darstellung', { auto: 'Automatisch', light: 'Hell', dark: 'Dunkel' }[getTheme()] + (ls.get('schlummi.dim', true) ? '<br>nachts gedimmt' : ''))}
      ${row('daten', 'box', 'Daten & Sicherung')}
    </div>
    <p class="gtitle">Wissen</p>
    <div class="group">
      ${row('sicher', 'shield', 'Sicher schlafen')}
      ${row('richtwerte', 'book', 'Über die Richtwerte')}
      ${row('arzt', 'steth', 'Wann zur Kinderarztpraxis?')}
    </div>
    <p class="foot">Schlummi ${VERSION} · <a href="datenschutz.html">Datenschutz</a> · <a href="impressum.html">Impressum</a></p>`;
}

function setKind() {
  const f = state.family;
  const a = effectiveAge(f);
  return `${subHead('Kind', 'einstellungen')}
    <div class="group">
      <label class="field wide"><span class="cap">Name</span><input data-set="child_name" value="${esc(f.child_name)}" maxlength="60" autocomplete="off"></label>
      <label class="field"><span>Geburtsdatum</span><input type="date" data-set="birthdate" value="${esc(f.birthdate)}" max="${todayISO()}"></label>
      <label class="field"><span>Errechneter Termin<small>optional, für Frühgeborene</small></span><input type="date" data-set="due_date" value="${esc(f.due_date || '')}"></label>
    </div>
    <p class="hint">${a.corrected ? `Kam ${a.weeksEarly} Wochen vor dem Termin – alle Richtwerte gelten bis zum 2. Geburtstag nach dem korrigierten Alter (jetzt ${monthsLabel(a.months)}).` : 'Kam euer Kind mehr als zwei Wochen vor dem Termin, richtet Schlummi die Richtwerte bis zum 2. Geburtstag nach dem korrigierten Alter aus.'}</p>`;
}

function setRhythm() {
  const f = state.family;
  const r = rhythm(f, new Date(), state.sleeps);
  const L = r.learned;
  const timeField = (key, label, learnedVal) => {
    const fixed = !!f[key];
    const small = fixed ? 'fest eingestellt' : L && learnedVal ? `aus euren Daten: etwa ${learnedVal}` : 'noch zu wenig Daten';
    return `<div class="field fcol"><span>${label}<small>${small}</small></span>
      <span class="ctl">
        <span class="mini-seg"><button class="${fixed ? '' : 'on'}" data-act="time-mode" data-key="${key}" data-mode="auto">Auto</button><button class="${fixed ? 'on' : ''}" data-act="time-mode" data-key="${key}" data-mode="fix" data-default="${learnedVal || (key === 'bedtime' ? '19:30' : '07:00')}">Fest</button></span>
        ${fixed ? `<input type="time" data-set="${key}" value="${esc(String(f[key]).slice(0, 5))}">` : ''}
      </span></div>`;
  };
  const opts = []; for (let m = 30; m <= 360; m += 15) opts.push(m);
  return `${subHead('Tagesrhythmus', 'einstellungen')}
    <div class="group">
      <label class="field"><span>Schläfchen pro Tag</span><select data-set="naps_per_day">
        <option value="">${L ? `Auto (${L.naps})` : `Auto (${r.napRow.label})`}</option>
        ${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${f.naps_per_day === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${timeField('waketime', 'Aufwachen morgens', L?.wake)}
      ${timeField('bedtime', 'Schlafenszeit abends', L?.bed)}
      <label class="field"><span>Wachzeit vor dem Schläfchen</span><select data-set="wake_window">
        <option value="">${L?.firstWW ? `Auto (${fmtDurShort(L.firstWW)})` : 'Auto (nach Alter)'}</option>
        ${opts.map(m => `<option value="${m}" ${Number(f.wake_window) === m ? 'selected' : ''}>etwa ${fmtDurShort(m)}</option>`).join('')}</select></label>
    </div>
    <p class="hint">„Auto“ lernt aus euren letzten 14 Tagen – das trifft meist am besten. Eine feste Zeit nutzt Schlummi als Ziel. Änderungen werden sofort gespeichert.</p>`;
}

function setPush() {
  const p = state.push;
  let body;
  switch (p.status) {
    case 'nocloud': body = '<p class="hint">Erinnerungen gibt es, wenn ihr Schlummi mit Konto gemeinsam nutzt.</p>'; break;
    case 'ios-install': body = '<div class="card"><p>Auf iPhone und iPad: Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Dann Schlummi vom Home-Bildschirm starten und hier einschalten.</p></div>'; break;
    case 'unsupported': body = '<div class="card"><p>Dieser Browser kann keine Erinnerungen anzeigen. Auf Android klappt es mit Chrome, auf dem iPhone mit Schlummi auf dem Home-Bildschirm.</p></div>'; break;
    case 'denied': body = '<div class="card"><p>Erinnerungen sind blockiert. Erlaube Mitteilungen in den Einstellungen des Handys bzw. Browsers für Schlummi.</p></div>'; break;
    case 'on': {
      const r = pushPrefs(p.row);
      body = `<div class="group">
        <label class="field"><span>Vor dem nächsten Schlaf erinnern</span><input type="checkbox" class="switch" data-push="remind" ${r.remind ? 'checked' : ''}></label>
        <label class="field"><span>Vorlauf</span><select data-push="lead_min">${[0, 5, 10, 15, 20, 30].map(m => `<option value="${m}" ${r.lead_min === m ? 'selected' : ''}>${m ? m + ' min vorher' : 'zu Beginn'}</option>`).join('')}</select></label>
        <label class="field"><span>Melden, wenn ${name()} einschläft oder aufwacht<small>nur Einträge der anderen</small></span><input type="checkbox" class="switch" data-push="partner" ${r.partner ? 'checked' : ''}></label>
        <label class="field"><span>Nachtruhe für diese Meldungen</span><input type="checkbox" class="switch" data-push="quiet" ${r.quiet ? 'checked' : ''}></label>
        ${r.quiet ? `<label class="field"><span>von</span><input type="time" data-push="quiet_start" value="${r.quiet_start}"></label>
        <label class="field"><span>bis</span><input type="time" data-push="quiet_end" value="${r.quiet_end}"></label>` : ''}
      </div><p class="hint">Gilt für dieses Gerät.</p>
      <div class="group danger-zone"><button class="danger-btn" data-act="push-off">Auf diesem Gerät ausschalten</button></div>`;
      break;
    }
    case 'off': body = `<div class="card"><p>Sanfte Erinnerung kurz vor dem nächsten Schlaf und eine Meldung, wenn ${name()} einschläft oder aufwacht – nachts standardmäßig stumm.</p>
      <button class="btn primary small" style="margin-top:12px" data-act="push-on">Erinnerungen einschalten</button></div>`; break;
    default: body = '<p class="hint">Prüfe …</p>';
  }
  return `${subHead('Erinnerungen', 'einstellungen')}${body}`;
}

function setFamily() {
  const f = state.family, members = state.members;
  const me = members?.find(m => m.is_me), owner = me?.role === 'owner';
  const exp = f.invite_expires_at ? new Date(f.invite_expires_at) : null;
  return `${subHead('Gemeinsam nutzen', 'einstellungen')}
    <p class="gtitle" style="margin-top:0">Mitglieder</p>
    <div class="group">${members ? `<ul class="members">${members.map(m => `<li><span>${esc(m.email)}${m.is_me ? ' <span class="cap">(du)</span>' : ''}${m.role === 'owner' ? ' <span class="tag">Verwaltung</span>' : ''}</span>
      ${owner && !m.is_me ? `<button class="text-btn" style="color:var(--danger)" data-act="remove-member" data-id="${esc(m.user_id)}">Entfernen</button>` : ''}</li>`).join('')}</ul>` : '<p class="field">Lade …</p>'}</div>
    <p class="gtitle">Einladen</p>
    <div class="card">
      <p class="cap">Einladungscode für den anderen Elternteil – gültig bis ${exp ? exp.toLocaleDateString('de-DE') : '–'}, nur einmal verwendbar:</p>
      <p class="code">${esc(String(f.invite_code || '').replace(/(.{5})/, '$1 '))}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn secondary small" data-act="share-code">Teilen</button>
        <button class="btn secondary small" data-act="rotate-code">Neuer Code</button></div>
    </div>
    <div class="group danger-zone">
      <button class="danger-btn" data-act="leave-family">Familie verlassen</button>
      ${owner ? '<button class="danger-btn" data-act="delete-family">Familie und alle Daten löschen</button>' : ''}
    </div>`;
}

function setAccount() {
  return `${subHead('Konto', 'einstellungen')}
    <div class="group"><div class="field"><span>E-Mail</span><span class="cap" style="overflow-wrap:anywhere">${esc(state.store.user?.email)}</span></div></div>
    <p class="gtitle">Passwort ändern</p>
    <form class="card form" data-form="newpw-settings">
      <label>Neues Passwort<input type="password" name="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn secondary small">Passwort speichern</button>
    </form>
    <div class="group" style="margin-top:12px"><button class="danger-btn" style="color:var(--link)" data-act="logout">Abmelden</button></div>
    <div class="group danger-zone"><button class="danger-btn" data-act="delete-account">Konto löschen</button></div>`;
}

function setLook() {
  return `${subHead('Darstellung', 'einstellungen')}
    <div class="segctl">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) =>
      `<button class="${getTheme() === k ? 'on' : ''}" data-act="theme" data-theme="${k}">${l}</button>`).join('')}</div>
    <div class="group"><label class="field"><span>Nachts gedimmt<small>20–7 Uhr, im dunklen Design</small></span><input type="checkbox" class="switch" data-pref="dim" ${ls.get('schlummi.dim', true) ? 'checked' : ''}></label></div>`;
}

function setData() {
  return `${subHead('Daten & Sicherung', 'einstellungen')}
    <div class="group">
      <button class="row" data-act="export-json"><span class="ico">${svg('box')}</span><span>Sicherung herunterladen<small class="cap" style="display:block">JSON, zum späteren Import</small></span><span></span>${chev()}</button>
      <button class="row" data-act="export-csv"><span class="ico">${svg('list')}</span><span>Tabelle herunterladen<small class="cap" style="display:block">CSV für Excel</small></span><span></span>${chev()}</button>
      <label class="row" style="cursor:pointer"><span class="ico">${svg('right')}</span><span>Sicherung importieren</span><span></span>${chev()}<input type="file" accept="application/json,.json" data-import hidden></label>
    </div>
    <p class="hint">${cloud() ? 'Eure Einträge liegen geschützt auf dem Server in Frankfurt (EU) und zusätzlich zwischengespeichert auf diesem Gerät.' : 'Die Einträge liegen nur auf diesem Gerät – mach ab und zu eine Sicherung.'}</p>
    ${cloud() ? '' : '<div class="group danger-zone"><button class="danger-btn" data-act="wipe-local">Alle Daten auf diesem Gerät löschen</button></div>'}`;
}

const INFO = {
  sicher: ['Sicher schlafen', `<p>Rückenlage zum Schlafen, eigenes Bett im Elternschlafzimmer, Schlafsack statt Decke, keine Kissen, Nestchen oder Kuscheltiere im Bett, rauchfreie Umgebung, Raumtemperatur etwa 18 °C, nicht überwärmen. Stillen und ein Schnuller zum Einschlafen können schützen.</p><p class="cap">AWMF-Leitlinie 063-002 „Prävention des plötzlichen Säuglingstods“ (2022).</p>`],
  richtwerte: ['Über die Richtwerte', `<p>Die Angaben zum Gesamtschlaf stammen von Fachgesellschaften: American Academy of Sleep Medicine (ab 4 Monaten) und National Sleep Foundation (0–3 Monate). Sie beschreiben, was für die meisten Kinder regelmäßig gut ist – einzelne Tage dürfen abweichen. Gerade Neugeborene schlafen sehr unterschiedlich.</p><p>Wachzeiten und Schläfchen-Vorschläge sind Erfahrungswerte. Sobald genug Einträge da sind, lernt Schlummi aus eurem eigenen Rhythmus. Achte vor allem auf dein Kind: Müdigkeitszeichen wie Gähnen, Augenreiben oder Wegschauen sind verlässlicher als jede Uhr. Bei Frühgeborenen gilt bis zum 2. Geburtstag das korrigierte Alter.</p><p class="cap">Quellen: Paruthi et al. 2016 (AASM); Hirshkowitz et al. 2015 (NSF); Galland et al. 2012; Iglowstein et al. 2003; Weissbluth 1995.</p>`],
  arzt: ['Wann zur Kinderarztpraxis?', `<p>Sprich mit eurer Kinderarztpraxis, wenn dein Kind regelmäßig laut schnarcht oder Atempausen hat, auffällig schläfrig oder schwer weckbar ist, sich der Schlaf zusammen mit Krankheitszeichen plötzlich stark verändert oder es anhaltend untröstlich schreit. Auch wenn ihr als Eltern sehr erschöpft seid, gibt es Hilfe – zum Beispiel über Schreiambulanzen und die Frühen Hilfen.</p><p class="cap">Schlummi ersetzt keine ärztliche Beratung.</p>`],
};
function setInfo(k) { return `${subHead(INFO[k][0], 'einstellungen')}<div class="card prose">${INFO[k][1]}</div>`; }

/* ===================== Anmeldung & Einrichtung ===================== */
function viewAuth() {
  const m = state.authMode;
  const head = `<div class="hero-c"><img src="icon.svg" class="appicon" alt=""><h1>Schlummi</h1><p class="cap">Schlaf-Tagebuch für die ganze Familie</p></div>`;
  let form;
  if (m === 'reset') form = `<form class="card form" data-form="reset"><p>Wir schicken dir einen Link für ein neues Passwort.</p>
      <label>E-Mail<input name="email" type="email" required autocomplete="email"></label>
      <button class="btn primary">Link senden</button>
      <button type="button" class="text-btn" data-act="authmode" data-mode="login">Zurück zur Anmeldung</button></form>`;
  else if (m === 'newpw') form = `<form class="card form" data-form="newpw"><p>Bitte wähle ein neues Passwort.</p>
      <label>Neues Passwort<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary">Speichern</button></form>`;
  else {
    const login = m === 'login';
    form = `<form class="card form" data-form="auth">
      <label>E-Mail<input name="email" type="email" required autocomplete="email"></label>
      <label>Passwort${login ? '' : ' <span class="cap">(mindestens 8 Zeichen)</span>'}<input name="password" type="password" required minlength="${login ? 6 : 8}" autocomplete="${login ? 'current-password' : 'new-password'}"></label>
      ${login ? '' : `<label class="check"><input type="checkbox" name="consent" required> <span>Ich habe die <a href="datenschutz.html" target="_blank" rel="noopener">Datenschutzhinweise</a> gelesen und bin einverstanden, dass die Schlafdaten meines Kindes dafür gespeichert werden.</span></label>`}
      <button class="btn primary">${login ? 'Anmelden' : 'Konto erstellen'}</button>
      <button type="button" class="text-btn" data-act="authmode" data-mode="${login ? 'signup' : 'login'}">${login ? 'Noch kein Konto? Registrieren' : 'Schon ein Konto? Anmelden'}</button>
      ${login ? '<button type="button" class="text-btn" data-act="authmode" data-mode="reset">Passwort vergessen?</button>' : ''}</form>`;
  }
  app.classList.remove('has-dock');
  app.innerHTML = `<div class="onboard">${head}${form}<p class="foot"><a href="datenschutz.html">Datenschutz</a> · <a href="impressum.html">Impressum</a></p></div>`;
}

function viewSetup() {
  app.classList.remove('has-dock');
  app.innerHTML = `<div class="onboard">
    <div class="hero-c"><img src="icon.svg" class="appicon" alt=""><h1>Willkommen</h1><p class="cap">Erzähl kurz von eurem Kind.</p></div>
    <form class="card form" data-form="setup">
      <label>Name<input name="child_name" required maxlength="60" placeholder="z. B. Emma"></label>
      <label>Geburtsdatum<input name="birthdate" type="date" required max="${todayISO()}"></label>
      <label>Errechneter Termin <span class="cap">(optional, für Frühgeborene)</span><input name="due_date" type="date"></label>
      <button class="btn primary">Los geht’s</button>
    </form>
    ${cloud() ? `<form class="card form" data-form="join"><p class="cap">Oder einer Familie beitreten, die Schlummi schon nutzt:</p>
      <label>Einladungscode<input name="code" required autocapitalize="characters" autocomplete="off" placeholder="ABCDE 12345"></label>
      <button class="btn secondary">Beitreten</button></form>
      <p class="center"><button class="text-btn" data-act="logout">Abmelden</button></p>` : ''}
  </div>`;
}

/* ===================== Bottom-Sheets ===================== */
function openSheet(html) {
  sheet.innerHTML = `<div class="grip" aria-hidden="true"></div>${html}`;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => { ed = null; render(); });
const sheetHead = title => `<div class="sheet-h"><h2>${title}</h2><button class="x" data-act="close" aria-label="Schließen">${svg('x')}</button></div>`;

function openInfo(topic) {
  if (topic === 'richtwert') {
    const rec = totalSleepFor(effectiveAge(state.family).months);
    openSheet(`${sheetHead('Richtwert')}<div class="prose">
      <p>${rec.orientation ? `Neugeborene schlafen sehr unterschiedlich – etwa ${rec.normalMin} bis ${rec.normalMax} Stunden können normal sein. Orientierung: ${rec.min}–${rec.max} h (${rec.source}).` : `In diesem Alter schlafen die meisten Kinder ${rec.min}–${rec.max} Stunden pro Tag inklusive Schläfchen (${rec.source}).`}</p>
      <p>Gemeint ist der regelmäßige Schlaf – einzelne Tage schwanken. Der Punkt zeigt euren Durchschnitt der letzten 7 Tage.</p>
      <p class="cap">Quellen: Paruthi et al. 2016 (AASM); Hirshkowitz et al. 2015 (NSF).</p></div>`);
  }
}

function openDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  const list = state.sleeps.filter(s => endOf(s) > d && Date.parse(s.start_at) < addDays(d, 1).getTime())
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const sum = summarize(state.sleeps, d, addDays(d, 1), new Date(), undefined, state.family);
  const title = dayDiff(d) >= -1 ? dayLabel(d) : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  openSheet(`${sheetHead(title)}
    <p class="cap">${fmtHours(sum.total)} Schlaf am Kalendertag · ${sum.naps} Schläfchen</p>
    <ul class="entries">${list.map(entryRow).join('') || '<li><p class="empty">Keine Einträge.</p></li>'}</ul>
    <button class="btn secondary small" style="margin-top:12px" data-act="add-on" data-day="${iso}">+ Eintrag für diesen Tag</button>`);
}

/* ---------- Zeit-Editor mit Drehrad ---------- */
let ed = null;
const ITEM = 44;

function openEditor({ sleep = null, preset = null, mode = null } = {}) {
  const now = new Date();
  const s = sleep || preset || {};
  const start = s.start_at ? new Date(s.start_at) : new Date(+now - 60 * MIN);
  const running = sleep ? !sleep.end_at : false;
  let end = s.end_at ? new Date(s.end_at) : running ? null : new Date(Math.min(+start + 45 * MIN, +now));
  if (end && end > now) end = now;
  ed = {
    id: sleep?.id || null, mode: mode || (sleep ? 'edit' : 'new'),
    start, end, running, kind: s.kind || null, tags: new Set(s.tags || []), note: s.note || '',
    open: mode === 'start' || !sleep ? 'start' : null, more: !!((s.tags && s.tags.length) || s.note),
  };
  renderEditor();
}

function edTitle() {
  if (ed.mode === 'start') return 'Einschlafzeit ändern';
  if (ed.mode === 'new') return 'Schlaf nachtragen';
  const night = isNightSleep({ start_at: ed.start.toISOString(), end_at: ed.end?.toISOString() || null, kind: ed.kind }, new Date(), undefined, state.family);
  return night ? 'Nacht bearbeiten' : 'Schläfchen bearbeiten';
}

function dayPick(which, d) {
  return `<div class="daypick" role="group" aria-label="Tag">
    <button type="button" data-act="ed-day" data-which="${which}" data-d="-1" aria-label="Einen Tag früher">${svg('left')}</button>
    <span>${dayLabel(d)}</span>
    <button type="button" data-act="ed-day" data-which="${which}" data-d="1" aria-label="Einen Tag später" ${dayDiff(d) >= 0 ? 'disabled' : ''}>${svg('right')}</button></div>`;
}

function wheelHtml(which, d) {
  const col = (unit, max, val) => `<div class="wcol" tabindex="0" role="spinbutton" aria-label="${unit === 'h' ? 'Stunde' : 'Minute'}" aria-valuemin="0" aria-valuemax="${max - 1}" aria-valuenow="${val}" data-which="${which}" data-unit="${unit}">
    <div class="wpad"></div>${Array.from({ length: max }, (_, i) => `<div class="wi ${i === val ? 'sel' : ''}" data-v="${i}">${pad(i)}</div>`).join('')}<div class="wpad"></div></div>`;
  return `<div class="wheel" data-wheel="${which}"><div class="hl"></div>${col('h', 24, d.getHours())}<span class="colon">:</span>${col('m', 60, d.getMinutes())}</div>`;
}

function tblock(which) {
  const d = which === 'start' ? ed.start : (ed.running ? null : ed.end);
  const label = which === 'start' ? 'Eingeschlafen' : 'Aufgewacht';
  const open = ed.open === which && d;
  return `<div class="tblock" data-block="${which}">
    <div class="head">
      <div><span class="lbl">${label}</span>
        <button type="button" class="tval ${open ? 'open' : ''} ${d ? '' : 'unset'}" data-act="ed-toggle" data-which="${which}" aria-expanded="${!!open}">${d ? fmtTime(d) : 'schläft noch'}</button></div>
      ${d ? dayPick(which, d) : ''}
    </div>
    ${open ? wheelHtml(which, d) : ''}
    ${which === 'end' && ed.mode === 'edit' ? `<div class="tools"><label><input type="checkbox" class="switch" data-ed="running" ${ed.running ? 'checked' : ''}> Schläft noch</label>${ed.running ? '' : '<button type="button" class="text-btn" data-act="ed-now">Jetzt</button>'}</div>` : ''}
    ${which === 'end' && ed.mode === 'new' ? `<div class="tools"><span></span><button type="button" class="text-btn" data-act="ed-now">Jetzt</button></div>` : ''}
  </div>`;
}

function renderEditor() {
  const showDur = ed.mode !== 'start' && ed.end && !ed.running;
  openSheet(`${sheetHead(edTitle())}
    <form data-form="edit" novalidate>
      ${tblock('start')}
      ${ed.mode === 'start' ? '' : tblock('end')}
      ${showDur ? `<p class="durline" data-dur>Dauer <b>${fmtDur((ed.end - ed.start) / MIN)}</b></p>` : ''}
      ${ed.mode === 'start' ? '<p class="hint">Am Rad drehen oder auf eine Zahl tippen.</p>' : `
      <div class="kindrow"><span class="cap">Art</span><span class="mini-seg">${[['', 'Automatisch'], ['nap', 'Tag'], ['night', 'Nacht']].map(([k, l]) =>
        `<button type="button" class="${(ed.kind || '') === k ? 'on' : ''}" data-act="ed-kind" data-kind="${k}">${l}</button>`).join('')}</span></div>
      ${ed.more ? `<div class="tagpick">${TAGS.map(([k, l]) => `<label class="tagbox"><input type="checkbox" data-ed-tag="${k}" ${ed.tags.has(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <input class="note-in" data-ed="note" maxlength="200" value="${esc(ed.note)}" placeholder="Notiz, z. B. schwer eingeschlafen" aria-label="Notiz">`
        : '<button type="button" class="more-toggle" data-act="ed-more">+ Markierung oder Notiz</button>'}`}
      <p class="form-error" role="alert" hidden></p>
      <div class="foot-actions">
        <button class="btn primary">Speichern</button>
        ${ed.mode === 'edit' ? '<button type="button" class="text-btn" data-act="ed-delete">Eintrag löschen</button>' : ''}
      </div>
    </form>`);
  initWheels();
}

function initWheels() {
  sheet.querySelectorAll('.wcol').forEach(col => {
    const sel = col.querySelector('.wi.sel');
    if (sel) col.scrollTop = Number(sel.dataset.v) * ITEM;
    let t;
    col.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(() => wheelSettle(col), 90); }, { passive: true });
    col.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        col.scrollTo({ top: col.scrollTop + (e.key === 'ArrowDown' ? ITEM : -ITEM), behavior: 'smooth' });
      }
    });
  });
}

function wheelSettle(col) {
  if (!ed || !col.isConnected) return;
  const max = col.dataset.unit === 'h' ? 23 : 59;
  const v = Math.min(max, Math.max(0, Math.round(col.scrollTop / ITEM)));
  col.querySelectorAll('.wi').forEach(el => el.classList.toggle('sel', Number(el.dataset.v) === v));
  col.setAttribute('aria-valuenow', v);
  const which = col.dataset.which;
  const base = which === 'start' ? ed.start : ed.end;
  if (!base) return;
  const d = new Date(base);
  if (col.dataset.unit === 'h') d.setHours(v); else d.setMinutes(v);
  if (+d === +base) return;
  setEdTime(which, d, false);
}

// Tag wird automatisch angepasst: Einschlafen nicht in der Zukunft, Aufwachen nach dem Einschlafen
function setEdTime(which, d, dayChanged) {
  const now = new Date();
  if (which === 'start') {
    if (!dayChanged) {
      // nächstgelegener Zeitpunkt vor dem Aufwachen (bzw. vor jetzt, wenn der Schlaf noch läuft)
      const limit = ed.end && !ed.running ? ed.end : new Date(+now + MIN);
      while (d >= limit) d = addDays(d, -1);
      while (addDays(d, 1) < limit) d = addDays(d, 1);
    }
    ed.start = d;
    if (ed.end && !ed.running) {
      while (ed.end <= ed.start) ed.end = addDays(ed.end, 1);
      while (ed.end - ed.start > DAY) ed.end = addDays(ed.end, -1);
    }
  } else {
    if (!dayChanged) {
      while (d <= ed.start) d = addDays(d, 1);
      while (d - ed.start > DAY) d = addDays(d, -1);
    }
    ed.end = d;
  }
  updateEditorTexts();
}

function updateEditorTexts() {
  for (const which of ['start', 'end']) {
    const block = sheet.querySelector(`[data-block="${which}"]`);
    const d = which === 'start' ? ed.start : ed.end;
    if (!block || !d || (which === 'end' && ed.running)) continue;
    block.querySelector('.tval').textContent = fmtTime(d);
    const dp = block.querySelector('.daypick span');
    if (dp) dp.textContent = dayLabel(d);
    const next = block.querySelector('.daypick [data-d="1"]');
    if (next) next.disabled = dayDiff(d) >= 0;
  }
  const dur = sheet.querySelector('[data-dur] b');
  if (dur && ed.end) dur.textContent = fmtDur((ed.end - ed.start) / MIN);
  const err = sheet.querySelector('.form-error');
  if (err) err.hidden = true;
}

function edError(msg) {
  const el = sheet.querySelector('.form-error');
  el.textContent = msg; el.hidden = false;
}

async function saveEditor() {
  const now = new Date(Date.now() + MIN);
  const start = ed.start, end = ed.running ? null : ed.end;
  if (start > now || (end && end > now)) return edError('Zeiten dürfen nicht in der Zukunft liegen.');
  if (end && end <= start) return edError('Die Aufwachzeit muss nach der Einschlafzeit liegen.');
  if (end && end - start > 36 * 3600e3) return edError('Ein Eintrag darf höchstens 36 Stunden lang sein.');
  if (!end && state.sleeps.some(s => !s.end_at && s.id !== ed.id)) return edError('Es läuft bereits ein anderer Schlaf.');
  const clash = state.sleeps.find(s => s.id !== ed.id && overlapMin(s, start, end || new Date()) > 1);
  if (clash) return edError(`Überschneidet sich mit ${fmtTime(new Date(clash.start_at))} – ${clash.end_at ? fmtTime(new Date(clash.end_at)) : 'läuft'} (${dayLabel(new Date(clash.start_at))}).`);
  const patch = { start_at: start.toISOString() };
  if (ed.mode !== 'start') Object.assign(patch, { end_at: end ? end.toISOString() : null, kind: ed.kind || null, tags: [...ed.tags], note: ed.note.trim() || null });
  if (ed.id) await state.store.updateSleep(ed.id, patch);
  else await state.store.addSleep(patch);
  closeSheet();
  toast('Gespeichert');
}

/* ===================== Aktionen ===================== */
async function startSleep(kind) {
  if (state.sleeps.some(s => !s.end_at)) return;
  const row = await state.store.addSleep({ start_at: new Date().toISOString(), kind: kind || null });
  navigator.vibrate?.(30);
  toast('Schlaf gestartet', { action: { label: 'Rückgängig', fn: () => state.store.deleteSleep(row.id) } });
}
async function stopSleep() {
  const r = state.sleeps.find(s => !s.end_at);
  if (!r) return;
  const end = new Date(Math.max(Date.now(), Date.parse(r.start_at) + MIN));
  const ok = await state.store.stopSleep(r.id, end.toISOString());
  navigator.vibrate?.(30);
  if (!ok) { toast('Dieser Schlaf wurde schon auf dem anderen Gerät beendet.'); await refresh(); return; }
  toast(`${fmtDur((end - new Date(r.start_at)) / MIN)} geschlafen`, {
    action: { label: 'Zeit ändern', fn: () => openEditor({ sleep: state.sleeps.find(s => s.id === r.id) || { ...r, end_at: end.toISOString() } }) },
  });
}
function download(fname, text, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: fname });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function csv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...state.sleeps].reverse().map(s => [
    toInput(new Date(s.start_at)).replace('T', ' '), s.end_at ? toInput(new Date(s.end_at)).replace('T', ' ') : '',
    s.end_at ? Math.round(durMin(s)) : '', isNight(s) ? 'Nacht' : 'Tag', (s.tags || []).map(tagLabel).join(', '), s.note || '',
  ].map(q).join(';'));
  return '﻿' + [['Start', 'Ende', 'Dauer (min)', 'Art', 'Markierungen', 'Notiz'].map(q).join(';'), ...lines].join('\r\n');
}
async function saveFamily(patch, msg = 'Gespeichert') {
  state.family = await state.store.saveFamily(patch);
  toast(msg);
}
function confirmTwice(el, label) {
  if (el.dataset.confirm) return true;
  el.dataset.confirm = '1'; el.dataset.label = el.textContent; el.textContent = label;
  setTimeout(() => { if (el.isConnected) { delete el.dataset.confirm; el.textContent = el.dataset.label; } }, 5000);
  return false;
}

document.addEventListener('click', e => {
  const wi = e.target.closest('.wi');
  if (wi) { wi.parentElement.scrollTo({ top: Number(wi.dataset.v) * ITEM, behavior: 'smooth' }); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act, store = state.store;
  switch (a) {
    case 'go': go(el.dataset.to); break;
    case 'start': run(() => startSleep(el.dataset.kind)); break;
    case 'stop': run(stopSleep); break;
    case 'edit': openEditor({ sleep: state.sleeps.find(s => s.id === el.dataset.id) }); break;
    case 'edit-start': openEditor({ sleep: state.sleeps.find(s => s.id === el.dataset.id), mode: 'start' }); break;
    case 'add': openEditor(); break;
    case 'add-on': {
      const d = new Date(el.dataset.day + 'T12:00:00');
      const end = d > new Date() ? new Date() : d;
      openEditor({ preset: { start_at: new Date(+end - 45 * MIN).toISOString(), end_at: end.toISOString() } });
      break;
    }
    case 'add-night': {
      const y = addDays(startOfDay(new Date()), -1);
      const r = rhythm(state.family, new Date(), state.sleeps);
      const [bh, bm] = (r.bedtime || '19:30').split(':').map(Number), [wh, wm] = (r.waketime || '06:30').split(':').map(Number);
      const st = new Date(y); st.setHours(bh, bm);
      const en = startOfDay(new Date()); en.setHours(wh, wm);
      openEditor({ preset: { start_at: st.toISOString(), end_at: (en > new Date() ? new Date() : en).toISOString(), kind: 'night' } });
      break;
    }
    case 'day': openDay(el.dataset.day); break;
    case 'more-days': state.patternDays = Math.min(56, state.patternDays + 14); render(); break;
    case 'close': closeSheet(); break;
    case 'info': openInfo(el.dataset.topic); break;
    case 'reload': location.reload(); break;
    case 'safe-seen': ls.set('schlummi.safeSleepSeen', true); render(); break;
    case 'theme': applyTheme(el.dataset.theme); render(); break;
    case 'report-days': state.reportDays = Number(el.dataset.days); render(); break;
    case 'print': try { window.print(); } catch { toast('Drucken ist hier nicht möglich.'); } break;
    case 'authmode': state.authMode = el.dataset.mode; viewAuth(); break;
    case 'logout': run(async () => { await disablePush().catch(() => {}); await store.signOut(); state.family = null; state.authMode = 'login'; viewAuth(); }); break;
    case 'push-on': run(async () => { el.disabled = true; try { await enablePush(); } finally { render(); } }); break;
    case 'push-off': run(async () => { await disablePush(); render(); toast('Erinnerungen aus'); }); break;
    case 'time-mode': run(async () => {
      const v = el.dataset.mode === 'fix' ? el.dataset.default : null;
      await saveFamily({ [el.dataset.key]: v }, v ? 'Feste Zeit eingestellt' : 'Automatisch aus euren Daten');
      render();
    }); break;
    case 'export-json':
      download(`schlummi-${todayISO()}.json`, JSON.stringify({ app: 'schlummi', version: 2, family: { ...state.family, invite_code: undefined }, sleeps: state.sleeps }, null, 2), 'application/json');
      break;
    case 'export-csv': download(`schlummi-${todayISO()}.csv`, csv(), 'text/csv'); break;
    case 'wipe-local':
      if (!confirmTwice(el, 'Wirklich alles löschen?')) break;
      run(async () => { await store.wipe(); state.family = null; state.sleeps = []; viewSetup(); });
      break;
    case 'share-code': run(async () => {
      const text = `Tritt unserer Familie in Schlummi bei. Einladungscode: ${state.family.invite_code}\n${location.origin + location.pathname}`;
      if (navigator.share) await navigator.share({ title: 'Schlummi-Einladung', text }).catch(() => {});
      else { await navigator.clipboard.writeText(text); toast('Einladung kopiert'); }
    }); break;
    case 'rotate-code': run(async () => { state.family = await store.rotateInvite(); render(); toast('Neuer Code – der alte gilt nicht mehr'); }); break;
    case 'remove-member':
      if (!confirmTwice(el, 'Wirklich entfernen?')) break;
      run(async () => { await store.removeMember(el.dataset.id); await store.loadFamily(); state.family = store.family; await loadMembers(); render(); toast('Entfernt, Einladungscode erneuert'); });
      break;
    case 'leave-family':
      if (!confirmTwice(el, 'Wirklich verlassen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.leaveFamily(); state.family = null; state.sleeps = []; viewSetup(); });
      break;
    case 'delete-family':
      if (!confirmTwice(el, 'Alles endgültig löschen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.deleteFamily(); state.family = null; state.sleeps = []; viewSetup(); toast('Familie und alle Einträge gelöscht'); });
      break;
    case 'delete-account':
      if (!confirmTwice(el, 'Konto endgültig löschen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.deleteAccount(); state.family = null; state.authMode = 'login'; viewAuth(); toast('Dein Konto wurde gelöscht'); });
      break;
    // Editor
    case 'ed-toggle': {
      const which = el.dataset.which;
      if (which === 'end' && (ed.running || !ed.end)) { ed.running = false; ed.end = new Date(); }
      ed.open = ed.open === which ? null : which;
      renderEditor();
      break;
    }
    case 'ed-day': {
      const which = el.dataset.which;
      const d = addDays(which === 'start' ? ed.start : ed.end, Number(el.dataset.d));
      setEdTime(which, d, true);
      break;
    }
    case 'ed-now': ed.running = false; ed.end = new Date(); if (ed.end <= ed.start) ed.start = new Date(+ed.end - 30 * MIN); renderEditor(); break;
    case 'ed-kind': ed.kind = el.dataset.kind || null; renderEditor(); break;
    case 'ed-more': ed.more = true; renderEditor(); break;
    case 'ed-delete': {
      if (!confirmTwice(el, 'Wirklich löschen?')) break;
      const row = state.sleeps.find(s => s.id === ed.id);
      run(async () => {
        await store.deleteSleep(ed.id); closeSheet();
        toast('Eintrag gelöscht', { action: { label: 'Rückgängig', fn: () => store.addSleep({ ...row, id: newId() }) } });
      });
      break;
    }
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.pref === 'dim') { ls.set('schlummi.dim', t.checked); applyTheme(); return; }
  if (t.dataset.ed === 'running') { ed.running = t.checked; if (!t.checked && !ed.end) ed.end = new Date(); ed.open = null; renderEditor(); return; }
  if (t.dataset.edTag) { t.checked ? ed.tags.add(t.dataset.edTag) : ed.tags.delete(t.dataset.edTag); return; }
  if (t.dataset.set) {
    const key = t.dataset.set;
    let v = t.value;
    run(async () => {
      if (key === 'child_name') { v = v.trim(); if (!v) throw new Error('Bitte einen Namen eingeben.'); }
      if (key === 'birthdate' && (!v || v > todayISO())) throw new Error('Das Geburtsdatum liegt in der Zukunft.');
      if (key === 'due_date' && v) {
        const diff = (new Date(v) - new Date(state.family.birthdate)) / DAY;
        if (diff < -30 || diff > 140) throw new Error('Der errechnete Termin passt nicht zum Geburtsdatum.');
      }
      if (['naps_per_day', 'wake_window'].includes(key)) v = v === '' ? null : Number(v);
      if (['due_date', 'bedtime', 'waketime'].includes(key) && !v) v = null;
      await saveFamily({ [key]: v });
      if (key !== 'child_name') render();
    });
    return;
  }
  const pref = t.dataset.push;
  if (pref && state.push.row) {
    const prefs = pushPrefs(state.push.row);
    prefs[pref] = t.type === 'checkbox' ? t.checked : t.type === 'time' ? t.value : Number(t.value);
    run(async () => { state.push.row = await state.store.savePush(state.push.sub, prefs); toast('Gespeichert'); if (pref === 'quiet') render(); });
    return;
  }
  if (t.hasAttribute('data-import') && t.files[0]) {
    run(async () => {
      let data;
      try { data = JSON.parse(await t.files[0].text()); } catch { throw new Error('Die Datei ist keine gültige Schlummi-Sicherung.'); }
      const rows = (Array.isArray(data?.sleeps) ? data.sleeps : []).filter(s => s && !isNaN(Date.parse(s.start_at)) && (!s.end_at || !isNaN(Date.parse(s.end_at))));
      const n = await state.store.importSleeps(rows);
      toast(n ? `${n} Einträge importiert` : 'Keine neuen Einträge gefunden');
      t.value = '';
    });
  }
});
document.addEventListener('input', e => { if (e.target.dataset.ed === 'note' && ed) ed.note = e.target.value; });

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'edit') { saveEditor().catch(err => { console.error(err); edError(friendlyError(err)); }); return; }
  const fd = Object.fromEntries(new FormData(form));
  const store = state.store;
  run(async () => {
    if (kind === 'auth') {
      const res = state.authMode === 'login' ? await store.signIn(fd.email.trim(), fd.password) : await store.signUp(fd.email.trim(), fd.password);
      if (res.needsConfirm) { state.authMode = 'login'; viewAuth(); toast('Fast geschafft: Bitte bestätige den Link in der E-Mail und melde dich dann hier an.', { ms: 9000 }); return; }
      await afterInit(res);
    } else if (kind === 'reset') {
      await store.resetPassword(fd.email.trim());
      toast('Wenn es ein Konto gibt, ist der Link unterwegs.', { ms: 6000 });
      state.authMode = 'login'; viewAuth();
    } else if (kind === 'newpw' || kind === 'newpw-settings') {
      if (fd.password.length < 8) throw new Error('Das Passwort ist zu kurz oder zu einfach (mindestens 8 Zeichen).');
      await store.updatePassword(fd.password);
      toast('Neues Passwort gespeichert');
      if (kind === 'newpw') await afterInit(await store.init()); else form.reset();
    } else if (kind === 'setup') {
      if (fd.birthdate > todayISO()) throw new Error('Das Geburtsdatum liegt in der Zukunft.');
      state.family = await store.createFamily(fd.child_name.trim(), fd.birthdate);
      if (fd.due_date) state.family = await store.saveFamily({ due_date: fd.due_date });
      location.hash = 'jetzt';
      await refresh();
    } else if (kind === 'join') {
      state.family = await store.joinFamily(fd.code);
      toast('Willkommen in der Familie!');
      await refresh();
    }
  });
});

/* ===================== Uhr ===================== */
let lastMinute = -1;
setInterval(() => {
  const m = new Date().getMinutes();
  if (m === lastMinute) return;
  lastMinute = m;
  if (state.family && !sheet.open && !document.activeElement?.matches('input, select, textarea') && route().sub !== 'bericht') render();
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.family && !sheet.open) run(refresh); });
window.addEventListener('online', () => { if (state.family) run(refresh); });
window.addEventListener('offline', () => { if (state.family) render(); });

/* ===================== Start ===================== */
async function afterInit(res) {
  if (res.needsAuth) return viewAuth();
  state.family = res.family;
  if (!state.family) return viewSetup();
  await refresh();
  if (route().tab === 'einstellungen') run(async () => { await Promise.all([loadPush(), loadMembers()]); render(); });
}
async function boot() {
  state.store = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY ? new SupabaseStore(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY) : new LocalStore();
  state.store.onChange(() => { if (!sheet.open) run(refresh); else state.store.listSleeps().then(s => { state.sleeps = s; }).catch(() => {}); });
  if (cloud()) state.store.onRecovery = () => { state.authMode = 'newpw'; viewAuth(); };
  try { await afterInit(await state.store.init()); }
  catch (e) {
    console.error(e);
    app.innerHTML = `<div class="onboard"><div class="hero-c"><img src="icon.svg" class="appicon" alt=""><h1>Schlummi</h1></div>
      <section class="card"><p>${esc(friendlyError(e))}</p><button class="btn primary" style="margin-top:12px" data-act="reload">Erneut versuchen</button></section></div>`;
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();

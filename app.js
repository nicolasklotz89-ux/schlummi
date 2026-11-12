import { CONFIG } from './config.js';
import { LocalStore, SupabaseStore, friendlyError, newId } from './store.js';
import {
  ageLabel, monthsLabel, effectiveAge, wakeWindowFor, napsFor, totalSleepFor, planDay, rhythm,
  isNightSleep, summarize, nightWakings, overlapMin,
} from './sleepdata.js';

const VERSION = '1.0.0';
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const dlg = $('#edit');
const state = {
  store: null, family: null, sleeps: [], view: 'home', authMode: 'login',
  push: { status: 'unknown' }, members: null, reportDays: 7,
};

const TAGS = [
  ['zahnen', 'Zahnt'], ['krank', 'Krank'], ['unruhig', 'Unruhig'], ['gefuettert', 'Beim Füttern'],
  ['kinderwagen', 'Kinderwagen'], ['trage', 'Trage'], ['auto', 'Auto'], ['unterwegs', 'Unterwegs'],
];
const tagLabel = k => (TAGS.find(t => t[0] === k) || [k, k])[1];

/* ---------- Hilfsfunktionen ---------- */
const pad = n => String(n).padStart(2, '0');
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDur = min => {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
const hNum = min => (min / 60).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtHours = min => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' h';
const fmtTimer = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const fmtDate = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
const toInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayISO = () => toInput(new Date()).slice(0, 10);
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayLabel = d => {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5);
  if (diff === 0) return 'Heute';
  if (diff === -1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
};
const endOf = (s, now = new Date()) => (s.end_at ? new Date(s.end_at) : now);
const durMin = (s, now = new Date()) => (endOf(s, now) - new Date(s.start_at)) / 6e4;
const isNight = s => isNightSleep(s, new Date(), undefined, state.family);
const cloud = () => state.store?.mode === 'cloud';
const ls = {
  get(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
};

/* ---------- Rückmeldungen ---------- */
function toast(msg, { error = false, action = null, ms = 3500 } = {}) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.setAttribute('role', error ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); run(action.fn); });
    t.appendChild(b);
    ms = 6000;
  }
  (dlg.open ? dlg : document.body).appendChild(t); // im Dialog sichtbar
  setTimeout(() => t.remove(), ms);
}
async function run(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(friendlyError(e), { error: true }); }
}
async function refresh() {
  state.sleeps = await state.store.listSleeps();
  render();
}

/* ---------- Design: hell/dunkel/auto + nachts gedimmt ---------- */
function getTheme() { return ls.get('schlummi.theme', 'auto'); }
function isDark() {
  const t = getTheme();
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme(t = getTheme()) {
  ls.set('schlummi.theme', t);
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const h = new Date().getHours();
  const dim = ls.get('schlummi.dim', true) && isDark() && (h >= 20 || h < 7);
  document.documentElement.classList.toggle('dim', dim);
  $('meta[name=theme-color]')?.setAttribute('content', isDark() ? '#141b3a' : '#f5f3ee');
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

/* ---------- Push ---------- */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  && (location.protocol === 'https:' || location.hostname === 'localhost');
function b64ToBytes(b64) {
  const p = '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
const PUSH_DEFAULTS = { remind: true, lead_min: 10, partner: true, quiet: true, quiet_start: '20:00', quiet_end: '07:00' };
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
  toast('Benachrichtigungen sind an');
}
async function disablePush() {
  const { sub } = state.push;
  if (sub) { await state.store.deletePush(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  state.push = { status: 'off' };
}
const pushPrefs = r => ({
  remind: r.remind, lead_min: r.lead_min, partner: r.partner,
  quiet: r.quiet ?? true, quiet_start: String(r.quiet_start || '20:00').slice(0, 5), quiet_end: String(r.quiet_end || '07:00').slice(0, 5),
});

/* ---------- Gerüst ---------- */
const ICONS = {
  home: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  history: '<path d="M5 19V11M12 19V5M19 19v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
};
const LOGO = '<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><mask id="hm"><rect width="100" height="100" fill="#fff"></rect><circle cx="62" cy="40" r="27" fill="#000"></circle></mask><circle cx="46" cy="55" r="30" fill="var(--logo)" mask="url(#hm)"></circle><path d="M75 15 Q76.6 22.4 84 24 Q76.6 25.6 75 33 Q73.4 25.6 66 24 Q73.4 22.4 75 15Z" fill="var(--star)"></path><path d="M86 43 Q86.9 47.1 91 48 Q86.9 48.9 86 53 Q85.1 48.9 81 48 Q85.1 47.1 86 43Z" fill="var(--star)"></path></svg>';

function ageText(f = state.family, now = new Date()) {
  const a = effectiveAge(f, now);
  return a.corrected ? `${ageLabel(f.birthdate, now)} (korr. ${monthsLabel(a.months)})` : ageLabel(f.birthdate, now);
}

function render() {
  if (!state.family) return;
  applyTheme();
  const views = { home: viewHome, history: viewHistory, report: viewReport, settings: viewSettings };
  const pending = state.store.pendingCount();
  app.innerHTML = `
    <header class="top">
      <div class="brand">${LOGO}Schlummi</div>
      <div class="child">${esc(state.family.child_name)} · ${esc(ageText())}</div>
    </header>
    ${pending ? `<p class="sync-note" role="status">Offline – ${pending} ${pending === 1 ? 'Änderung wird' : 'Änderungen werden'} nachgeholt</p>` : ''}
    <main>${views[state.view]()}</main>
    <nav class="tabs" aria-label="Bereiche">
      ${tab('home', 'Jetzt')}${tab('history', 'Verlauf')}${tab('settings', 'Einstellungen')}
    </nav>`;
  tick();
}
const tab = (id, label) => {
  const active = state.view === id || (id === 'history' && state.view === 'report');
  return `<button class="tab ${active ? 'active' : ''}" data-action="view" data-view="${id}" ${active ? 'aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span></button>`;
};

/* ---------- Startseite ---------- */
function viewHome() {
  const now = new Date();
  const plan = planDay(state.family, state.sleeps, now);
  const todayList = state.sleeps.filter(s => endOf(s, now) > startOfDay(now));
  return `
    ${plan.kind === 'sleeping' ? statusSleeping(plan) : statusAwake(plan, now)}
    ${safeSleepCard()}
    ${planCard(plan)}
    ${statsCard(now)}
    <section class="card">
      <div class="card-head"><h2>Heute</h2><button class="link" data-action="add">+ Nachtragen</button></div>
      ${todayList.length ? `<ul class="entries">${todayList.map(entryRow).join('')}</ul>` : '<p class="muted">Noch keine Einträge heute.</p>'}
    </section>`;
}

function statusSleeping(plan) {
  const s = plan.running;
  const quick = [5, 10, 15].map(m => `<button type="button" data-action="stop-ago" data-min="${m}">vor ${m} min</button>`).join('');
  return `
    <section class="card status sleeping">
      <p class="eyebrow">${plan.night ? 'Nachtschlaf' : 'Schläft'} seit ${fmtTime(new Date(s.start_at))}</p>
      <p class="timer" data-timer="${esc(s.start_at)}">${fmtTimer(Date.now() - Date.parse(s.start_at))}</p>
      ${plan.forgotten ? `<div class="notice" role="alert"><b>Läuft schon ${fmtDur(plan.mins)}.</b> Vergessen zu stoppen?
        <button class="link" data-action="edit" data-id="${esc(s.id)}">Aufwachzeit eintragen</button></div>` : ''}
      ${plan.wakeAt && !plan.forgotten ? `<p class="hint">Übliche Aufwachzeit (eure Einstellung): ${fmtTime(plan.wakeAt)}</p>` : ''}
      <button class="primary wake" data-action="stop">Aufgewacht</button>
      <div class="chips quick" aria-label="Aufgewacht vor">${quick}</div>
      <button class="link" data-action="edit" data-id="${esc(s.id)}">Startzeit anpassen</button>
    </section>`;
}

function statusAwake(plan, now) {
  const w = plan.r.window;
  const windowText = `${fmtDur(w.min)} – ${fmtDur(w.max)}`;
  let body;
  switch (plan.kind) {
    case 'none':
      body = `<p class="eyebrow">Bereit</p>
        <p class="hint">Typische Wachzeit ${w.custom ? '(eure Einstellung)' : 'in diesem Alter (Erfahrungswert)'}: etwa ${windowText}.
        Starte den nächsten Schlaf, dann gibt es Vorschläge.</p>`;
      break;
    case 'stale':
      body = `<p class="eyebrow">Kein aktueller Eintrag</p>
        <p class="hint">Der letzte Eintrag endete ${dayLabel(plan.lastEnd).toLowerCase()} um ${fmtTime(plan.lastEnd)}. Trag die Nacht nach oder starte einfach neu.</p>
        <button class="secondary" data-action="add-night">Nacht nachtragen</button>`;
      break;
    case 'newborn':
      body = `<p class="eyebrow">Wach seit ${fmtDur(plan.awake)} <span class="muted">(seit ${fmtTime(plan.lastEnd)})</span></p>
        <p class="hint">In diesem Alter ist kurzes Wachsein normal – oft etwa ${windowText}. Achte auf Müdigkeitszeichen und füttere nach Bedarf. Einen festen Rhythmus gibt es noch nicht.</p>`;
      break;
    case 'night':
      body = `<p class="eyebrow">Nachts wach seit ${fmtDur(plan.awake)}</p>
        <p class="suggest">Nachtschlaf fortsetzen</p>
        <p class="hint">Ruhig halten, wenig Licht. Nächtliches Füttern ist in den ersten Monaten normal.</p>`;
      break;
    default: {
      const n = plan.next, r = plan.r;
      const what = n.type === 'bedtime' ? 'Schlafenszeit'
        : plan.extraNap ? 'Noch ein Schläfchen?'
        : r.napsCustom ? `Schläfchen ${plan.napsDone + 1} von ${r.naps}` : `Schläfchen ${plan.napsDone + 1}`;
      const msg = plan.status === 'early' ? `voraussichtlich in etwa ${fmtDur((n.from - now) / 6e4)}`
        : plan.status === 'now' ? 'Guter Zeitpunkt, wenn dein Kind müde wirkt (Gähnen, Augenreiben, Wegschauen).'
        : 'Etwas später als üblich – das ist okay. Achte einfach auf Müdigkeitszeichen.';
      body = `<p class="eyebrow">Wach seit ${fmtDur(plan.awake)} <span class="muted">(seit ${fmtTime(plan.lastEnd)})</span></p>
        <p class="suggest">${what}<br><b>etwa ${fmtTime(n.from)} – ${fmtTime(n.to)}</b></p>
        <p class="hint ${plan.status}">${msg}</p>
        ${plan.longDay ? '<p class="hint small">Bis zur Schlafenszeit ist es lang – ein kurzes Schläfchen kann helfen.</p>' : ''}`;
    }
  }
  const quick = [5, 10, 15].map(m => `<button type="button" data-action="start-ago" data-min="${m}">vor ${m} min</button>`).join('');
  return `
    <section class="card status awake">
      ${body}
      <button class="primary" data-action="start">Schlaf starten</button>
      <div class="chips quick" aria-label="Eingeschlafen vor">${quick}</div>
    </section>`;
}

function planCard(plan) {
  if (!plan.upcoming || plan.upcoming.length < 2) return '';
  return `<section class="card">
    <div class="card-head"><h2>Tagesplan</h2><span class="muted small">Prognose, passt sich an</span></div>
    <ul class="plan">${plan.upcoming.map(u => `<li>
      <span class="dot ${u.type === 'bedtime' ? 'night' : 'nap'}"></span>
      <span>${u.type === 'bedtime' ? 'Schlafenszeit' : 'Schläfchen'}</span>
      <b>etwa ${fmtTime(u.at)}${u.until ? ' – ' + fmtTime(u.until) : ''}</b></li>`).join('')}</ul>
    ${plan.r.napLenPersonal ? '<p class="muted small">Schläfchenlänge aus euren Einträgen der letzten 14 Tage.</p>' : ''}
  </section>`;
}

function safeSleepCard() {
  if (ls.get('schlummi.safeSleepSeen', false)) return '';
  return `<section class="card info">
    <h2>Sicher schlafen</h2>
    <p>Rückenlage, eigenes Bett im Elternschlafzimmer, Schlafsack statt Decke, keine Kissen oder Kuscheltiere im Bett, rauchfreie Umgebung, etwa 18 °C.</p>
    <p class="muted small">Empfehlung der AWMF-Leitlinie zur Vorbeugung des plötzlichen Säuglingstods.</p>
    <button class="secondary" data-action="safe-seen">Verstanden</button>
  </section>`;
}

function weekStats(now = new Date()) {
  const days = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(startOfDay(now), -i);
    const s = summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family);
    if (s.total > 0) days.push(s);
  }
  if (days.length < 3) return null;
  const avg = k => days.reduce((a, s) => a + s[k], 0) / days.length;
  return { total: avg('total'), night: avg('night'), nap: avg('nap'), naps: avg('naps'), n: days.length };
}

function statsCard(now) {
  const age = effectiveAge(state.family, now);
  const rec = totalSleepFor(age.months);
  const last24 = summarize(state.sleeps, new Date(+now - 864e5), now, now, undefined, state.family);
  const today = summarize(state.sleeps, startOfDay(now), now, now, undefined, state.family);
  const wk = weekStats(now);
  const lastNightEnd = state.sleeps.find(s => s.end_at && isNight(s) && now - new Date(s.end_at) < 20 * 3600e3);
  const wakings = lastNightEnd ? nightWakings(state.sleeps, new Date(lastNightEnd.end_at), now, undefined, state.family) : null;
  const scaleMax = (rec.normalMax || rec.max) + 1;
  const bandL = (rec.min / scaleMax) * 100, bandW = ((rec.max - rec.min) / scaleMax) * 100;
  const shown = wk ? wk.total : null;
  const recText = rec.orientation
    ? `Neugeborene schlafen sehr unterschiedlich – etwa ${rec.normalMin} bis ${rec.normalMax} Stunden können normal sein. Orientierung: ${rec.min}–${rec.max} h (${rec.source}).`
    : `Üblicher Bereich in diesem Alter: <b>${rec.min}–${rec.max} h</b> pro Tag inkl. Schläfchen (${rec.source}). Gemeint ist der regelmäßige Schlaf – einzelne Tage schwanken.`;
  return `<section class="card">
    <div class="card-head"><h2>Schlaf</h2><span class="big">${fmtHours(last24.total)}</span></div>
    <p class="muted small" style="margin-top:-6px">in den letzten 24 Stunden</p>
    ${shown != null ? `
      <div class="meter" role="img" aria-label="Durchschnitt der letzten Tage im Vergleich zum üblichen Bereich">
        <div class="band" style="left:${bandL}%;width:${bandW}%"></div>
        <div class="fill" style="width:${Math.min(100, (shown / 60 / scaleMax) * 100)}%"></div>
      </div>
      <p class="small">Durchschnitt der letzten ${wk.n} Tage: <b>${fmtHours(wk.total)}</b></p>` : '<p class="muted small" style="margin-top:10px">Den Durchschnitt zeigen wir, sobald ein paar Tage erfasst sind.</p>'}
    <p class="muted small">${recText}</p>
    <div class="split">
      <div><span class="dot night"></span>Nacht<br><b>${fmtDur(last24.night)}</b></div>
      <div><span class="dot nap"></span>Tag<br><b>${fmtDur(last24.nap)}</b></div>
      <div><span class="dot"></span>Schläfchen heute<br><b>${today.naps}</b></div>
    </div>
    ${wakings != null ? `<p class="muted small" style="margin-top:10px">Letzte Nacht ${wakings === 0 ? 'durchgeschlafen (erfasst)' : `${wakings}× aufgewacht`}.</p>` : ''}
  </section>`;
}

function entryRow(s) {
  const st = new Date(s.start_at);
  const tags = (s.tags || []).map(t => `<span class="tag">${esc(tagLabel(t))}</span>`).join('');
  return `<li><button class="entry" data-action="edit" data-id="${esc(s.id)}">
    <span class="dot ${isNight(s) ? 'night' : 'nap'}"></span>
    <span class="when">${fmtTime(st)} – ${s.end_at ? fmtTime(new Date(s.end_at)) : 'läuft'}</span>
    <span class="dur">${fmtDur(durMin(s))}</span>
    ${tags || s.note ? `<span class="note">${tags}${s.note ? ' ' + esc(s.note) : ''}</span>` : ''}
  </button></li>`;
}

/* ---------- Verlauf ---------- */
function viewHistory() {
  const now = new Date();
  const rec = totalSleepFor(effectiveAge(state.family, now).months);
  const today = startOfDay(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const sums = days.map(d => summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family));
  const scale = Math.max(rec.max + 2, ...sums.map(s => s.total / 60));
  const full = sums.slice(0, 6).filter(s => s.total > 0);
  const avg = full.length ? full.reduce((a, s) => a + s.total, 0) / full.length : 0;
  const bars = days.map((d, i) => {
    const s = sums[i];
    return `<div class="col">
      <div class="stack" title="${fmtDur(s.total)}">
        <div class="seg nap" style="height:${(s.nap / 60 / scale) * 100}%"></div>
        <div class="seg night" style="height:${(s.night / 60 / scale) * 100}%"></div>
      </div>
      <span class="val">${s.total ? (s.total / 60).toFixed(1).replace('.', ',') : '–'}</span>
      <span class="lbl">${d.toLocaleDateString('de-DE', { weekday: 'short' })}</span>
    </div>`;
  }).join('');
  const groups = {};
  for (const s of state.sleeps) (groups[startOfDay(new Date(s.start_at)).toISOString()] ||= []).push(s);
  const list = Object.keys(groups).sort().reverse().slice(0, 30).map(k => {
    const d = new Date(k);
    const sum = summarize(state.sleeps, d, addDays(d, 1), now, undefined, state.family);
    return `<section class="card">
      <div class="card-head"><h2>${dayLabel(d)}</h2><span class="muted small">${fmtDur(sum.total)} am Kalendertag</span></div>
      <ul class="entries">${groups[k].map(entryRow).join('')}</ul></section>`;
  }).join('');
  return `
    <section class="card">
      <div class="card-head"><h2>7 Tage</h2><span class="muted small">Ø ${full.length ? fmtHours(avg) : '–'} pro Tag</span></div>
      <div class="chart">
        <div class="recband" style="bottom:${(rec.min / scale) * 100}%;height:${((rec.max - rec.min) / scale) * 100}%"><span>${rec.min}–${rec.max} h</span></div>
        ${bars}
      </div>
      <p class="legend small"><span class="dot night"></span>Nacht <span class="dot nap"></span>Tag <span class="swatch"></span>Üblicher Bereich</p>
      <p class="muted small">Pro Kalendertag (0–24 Uhr). Der Durchschnitt nutzt die letzten 6 vollständigen Tage.</p>
    </section>
    <div class="btnrow between">
      <button class="secondary" data-action="view" data-view="report">Bericht für die Kinderarztpraxis</button>
      <button class="link" data-action="add">+ Nachtragen</button>
    </div>
    ${list || '<p class="muted center">Noch keine Einträge.</p>'}`;
}

/* ---------- Bericht ---------- */
function viewReport() {
  const now = new Date();
  const n = state.reportDays;
  const f = state.family;
  const age = effectiveAge(f, now);
  const rec = totalSleepFor(age.months);
  const days = Array.from({ length: n }, (_, i) => addDays(startOfDay(now), -n + i));
  const rows = days.map(d => {
    const s = summarize(state.sleeps, d, addDays(d, 1), now, undefined, f);
    const morningSleep = state.sleeps.find(x => x.end_at && isNight(x) && startOfDay(new Date(x.end_at)).getTime() === d.getTime());
    const wk = morningSleep ? nightWakings(state.sleeps, new Date(morningSleep.end_at), now, undefined, f) : null;
    return { d, ...s, wakings: wk };
  });
  const withData = rows.filter(r => r.total > 0);
  const avg = k => withData.length ? withData.reduce((a, r) => a + (r[k] || 0), 0) / withData.length : 0;
  const wkRows = withData.filter(r => r.wakings != null);
  const avgWakings = wkRows.length ? wkRows.reduce((a, r) => a + r.wakings, 0) / wkRows.length : null;
  const inRange = state.sleeps.filter(s => Date.parse(s.start_at) >= days[0].getTime());
  const tagCount = {};
  inRange.forEach(s => (s.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const notes = inRange.filter(s => s.note).slice(0, 20);
  return `
    <section class="card report">
      <div class="card-head"><h2>Schlafbericht</h2>
        <div class="seg-ctl two no-print">${[7, 14].map(k => `<button class="${n === k ? 'on' : ''}" data-action="report-days" data-days="${k}">${k} Tage</button>`).join('')}</div>
      </div>
      <p><b>${esc(f.child_name)}</b>, geboren ${fmtDate(new Date(f.birthdate + 'T00:00:00'))} · ${esc(ageText())}</p>
      <p class="muted small">Zeitraum ${fmtDate(days[0])} – ${fmtDate(addDays(days.at(-1), 0))} · ${withData.length} von ${n} Tagen mit Einträgen</p>
      <div class="kpis">
        <div><span class="muted small">Ø Gesamtschlaf</span><b>${fmtHours(avg('total'))}</b></div>
        <div><span class="muted small">Ø Nacht</span><b>${fmtHours(avg('night'))}</b></div>
        <div><span class="muted small">Ø Tag</span><b>${fmtHours(avg('nap'))}</b></div>
        <div><span class="muted small">Ø Schläfchen</span><b>${avg('naps').toLocaleString('de-DE', { maximumFractionDigits: 1 })}</b></div>
        <div><span class="muted small">Ø nächtl. Aufwachen</span><b>${avgWakings == null ? '–' : avgWakings.toLocaleString('de-DE', { maximumFractionDigits: 1 })}</b></div>
        <div><span class="muted small">Üblicher Bereich</span><b>${rec.min}–${rec.max} h</b></div>
      </div>
      <table class="rtable">
        <thead><tr><th>Datum</th><th>Gesamt</th><th>Nacht</th><th>Tag</th><th>Schläf&shy;chen</th><th>Auf&shy;wachen</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r.d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${r.d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</td>
          <td>${r.total ? hNum(r.total) : '–'}</td><td>${r.total ? hNum(r.night) : '–'}</td><td>${r.total ? hNum(r.nap) : '–'}</td>
          <td>${r.total ? r.naps : '–'}</td><td>${r.wakings ?? '–'}</td></tr>`).join('')}</tbody>
      </table>
      ${Object.keys(tagCount).length ? `<p class="small"><b>Markierungen:</b> ${Object.entries(tagCount).map(([k, v]) => `${esc(tagLabel(k))} (${v}×)`).join(', ')}</p>` : ''}
      ${notes.length ? `<p class="small"><b>Notizen:</b></p><ul class="small notes">${notes.map(s => `<li>${dayLabel(new Date(s.start_at))} ${fmtTime(new Date(s.start_at))}: ${esc(s.note)}</li>`).join('')}</ul>` : ''}
      <p class="muted small">Angaben in Stunden. Selbst erfasste Daten aus der App Schlummi. Lücken entstehen, wenn Einträge fehlen. Nacht = Schlafphasen am Abend und in der Nacht.</p>
      <div class="btnrow no-print">
        <button class="primary small" data-action="print">Drucken oder als PDF sichern</button>
        <button class="secondary" data-action="view" data-view="history">Zurück</button>
      </div>
    </section>`;
}

/* ---------- Einstellungen ---------- */
function viewSettings() {
  const f = state.family;
  return `
    <section class="card">
      <h2>Kind</h2>
      <form data-form="family" class="form">
        <label>Name<input name="child_name" required maxlength="60" value="${esc(f.child_name)}"></label>
        <label>Geburtsdatum<input name="birthdate" type="date" required max="${todayISO()}" value="${esc(f.birthdate)}"></label>
        <label>Errechneter Geburtstermin <span class="muted small">(optional, für Frühgeborene)</span>
          <input name="due_date" type="date" value="${esc(f.due_date || '')}"></label>
        <p class="muted small">Kam euer Kind mehr als zwei Wochen vor dem Termin, richtet Schlummi alle Richtwerte bis zum 2. Geburtstag nach dem korrigierten Alter aus.</p>
        <button class="secondary">Speichern</button>
      </form>
    </section>
    ${rhythmCard()}
    ${pushCard()}
    ${cloud() ? familyCard() : ''}
    <section class="card">
      <h2>Darstellung</h2>
      <div class="seg-ctl">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) =>
        `<button class="${getTheme() === k ? 'on' : ''}" data-action="theme" data-theme="${k}">${l}</button>`).join('')}</div>
      <label class="toggle">Nachts gedimmt (20–7 Uhr, im dunklen Design)
        <input type="checkbox" data-pref="dim" ${ls.get('schlummi.dim', true) ? 'checked' : ''}></label>
    </section>
    <section class="card">
      <h2>Daten</h2>
      <div class="btnrow">
        <button class="secondary" data-action="export-json">Sicherung (JSON)</button>
        <button class="secondary" data-action="export-csv">Tabelle (CSV)</button>
        <label class="secondary filebtn">Importieren<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      </div>
      <p class="muted small">${cloud() ? 'Eure Einträge liegen geschützt auf dem Server (EU, Frankfurt) und zusätzlich zwischengespeichert auf diesem Gerät.' : 'Die Einträge liegen nur auf diesem Gerät. Mach ab und zu eine Sicherung.'}</p>
      ${cloud() ? '' : '<button class="danger" data-action="wipe-local">Alle Daten auf diesem Gerät löschen</button>'}
    </section>
    ${cloud() ? accountCard() : ''}
    ${infoCard()}
    <p class="muted small center">Schlummi ${VERSION} · <a href="datenschutz.html">Datenschutz</a> · <a href="impressum.html">Impressum</a></p>`;
}

function rhythmFields(f) {
  const r = f.birthdate ? rhythm(f) : null;
  const autoNaps = r ? `Automatisch (${r.napRow.label})` : 'Automatisch nach Alter';
  const autoWw = r ? `Automatisch (${fmtDur(r.ageWindow.min)}–${fmtDur(r.ageWindow.max)})` : 'Automatisch nach Alter';
  const opts = [];
  for (let m = 30; m <= 360; m += 15) opts.push(m);
  return `
    <label class="toggle">Schläfchen pro Tag
      <select name="naps_per_day"><option value="">${autoNaps}</option>
        ${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${f.naps_per_day === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="toggle">Aufwachen morgens<input type="time" name="waketime" value="${esc(String(f.waketime || '').slice(0, 5))}"></label>
    <label class="toggle">Schlafenszeit abends<input type="time" name="bedtime" value="${esc(String(f.bedtime || '').slice(0, 5))}"></label>
    <label class="toggle">Wachzeit
      <select name="wake_window"><option value="">${autoWw}</option>
        ${opts.map(m => `<option value="${m}" ${Number(f.wake_window) === m ? 'selected' : ''}>etwa ${fmtDur(m)}</option>`).join('')}</select></label>`;
}
function rhythmCard() {
  return `<section class="card">
    <h2>Tagesrhythmus</h2>
    <p class="muted small" style="margin-top:6px">„Automatisch“ nutzt Erfahrungswerte fürs Alter. Passt der Plan nicht zu eurem Kind, stellt Wachzeit und Schläfchen selbst ein – euer Kind ist der beste Maßstab. Mit Schlafenszeit verteilt Schlummi die Schläfchen passend bis zum Abend.</p>
    <form data-form="rhythm" class="form" style="margin-top:6px">${rhythmFields(state.family)}<button class="secondary">Speichern</button></form>
  </section>`;
}
function rhythmFromForm(fd) {
  const num = v => (v === '' || v == null ? null : Number(v));
  return { naps_per_day: num(fd.naps_per_day), wake_window: num(fd.wake_window), bedtime: fd.bedtime || null, waketime: fd.waketime || null };
}

function pushCard() {
  const p = state.push;
  const name = esc(state.family.child_name);
  let body;
  switch (p.status) {
    case 'nocloud': body = '<p class="muted">Benachrichtigungen gibt es, wenn ihr Schlummi gemeinsam mit Konto nutzt.</p>'; break;
    case 'ios-install': body = '<p class="muted">Auf iPhone und iPad: Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Dann Schlummi vom Home-Bildschirm starten und hier aktivieren.</p>'; break;
    case 'unsupported': body = '<p class="muted">Dieser Browser unterstützt keine Benachrichtigungen. Auf Android klappt es mit Chrome, auf dem iPhone mit Schlummi auf dem Home-Bildschirm.</p>'; break;
    case 'denied': body = '<p class="muted">Benachrichtigungen sind blockiert. Erlaube sie in den Einstellungen des Handys bzw. Browsers für Schlummi.</p>'; break;
    case 'on': {
      const r = pushPrefs(p.row);
      body = `<div class="push-box">
        <label class="toggle">Erinnerung vor dem nächsten Schlaf<input type="checkbox" data-push-pref="remind" ${r.remind ? 'checked' : ''}></label>
        <label class="toggle">Vorlauf<select data-push-pref="lead_min">${[0, 5, 10, 15, 20, 30].map(m =>
          `<option value="${m}" ${r.lead_min === m ? 'selected' : ''}>${m ? m + ' min vorher' : 'zu Beginn'}</option>`).join('')}</select></label>
        <label class="toggle">Melden, wenn ${name} einschläft oder aufwacht<input type="checkbox" data-push-pref="partner" ${r.partner ? 'checked' : ''}></label>
        <label class="toggle">Nachtruhe für diese Meldungen<input type="checkbox" data-push-pref="quiet" ${r.quiet ? 'checked' : ''}></label>
        ${r.quiet ? `<div class="timerow"><label>von<input type="time" data-push-pref="quiet_start" value="${r.quiet_start}"></label>
          <label>bis<input type="time" data-push-pref="quiet_end" value="${r.quiet_end}"></label></div>` : ''}
        <p class="muted small">Gilt für dieses Gerät. Eigene Einträge lösen bei dir keine Meldung aus.</p>
        <button class="secondary" data-action="push-off">Auf diesem Gerät ausschalten</button></div>`;
      break;
    }
    case 'off': body = `<p class="muted">Sanfte Erinnerung kurz vor dem nächsten Schlaf und eine Meldung, wenn ${name} einschläft oder aufwacht – nachts standardmäßig stumm.</p>
      <button class="primary small" style="margin-top:12px" data-action="push-on">Benachrichtigungen aktivieren</button>`; break;
    default: body = '<p class="muted">Prüfe …</p>';
  }
  return `<section class="card"><h2>Benachrichtigungen</h2>${body}</section>`;
}

function familyCard() {
  const f = state.family;
  const members = state.members;
  const me = members?.find(m => m.is_me);
  const owner = me?.role === 'owner';
  const exp = f.invite_expires_at ? new Date(f.invite_expires_at) : null;
  return `<section class="card">
    <h2>Familie</h2>
    ${members ? `<ul class="members">${members.map(m => `<li>
      <span>${esc(m.email)}${m.is_me ? ' <span class="muted">(du)</span>' : ''}${m.role === 'owner' ? ' <span class="tag">Verwaltung</span>' : ''}</span>
      ${owner && !m.is_me ? `<button class="link danger-text" data-action="remove-member" data-id="${esc(m.user_id)}">Entfernen</button>` : ''}
    </li>`).join('')}</ul>` : '<p class="muted">Lade Mitglieder …</p>'}
    <p style="margin-top:12px">Einladungscode für den anderen Elternteil:</p>
    <p class="code" aria-label="Einladungscode">${esc(String(f.invite_code || '').replace(/(.{5})/, '$1 '))}</p>
    <p class="muted small">Gültig bis ${exp ? exp.toLocaleDateString('de-DE') : '–'} und nur einmal verwendbar. Die andere Person registriert sich in Schlummi und gibt den Code ein.</p>
    <div class="btnrow">
      <button class="secondary" data-action="share-code">Code teilen</button>
      <button class="secondary" data-action="rotate-code">Neuen Code erzeugen</button>
    </div>
    <div class="btnrow" style="margin-top:14px">
      <button class="danger" data-action="leave-family">Familie verlassen</button>
      ${owner ? '<button class="danger" data-action="delete-family">Familie und alle Daten löschen</button>' : ''}
    </div>
  </section>`;
}

function accountCard() {
  return `<section class="card">
    <h2>Konto</h2>
    <p>Angemeldet als <b>${esc(state.store.user?.email)}</b></p>
    <form data-form="newpw-settings" class="form" style="margin-top:10px">
      <label>Neues Passwort<input type="password" name="password" minlength="8" autocomplete="new-password" required></label>
      <button class="secondary">Passwort ändern</button>
    </form>
    <div class="btnrow" style="margin-top:14px">
      <button class="secondary" data-action="logout">Abmelden</button>
      <button class="danger" data-action="delete-account">Konto löschen</button>
    </div>
  </section>`;
}

function infoCard() {
  return `<section class="card">
    <h2>Wissenswertes</h2>
    <details class="more"><summary>Über die Richtwerte</summary>
      <p>Die Angaben zum Gesamtschlaf stammen von Fachgesellschaften: American Academy of Sleep Medicine (ab 4 Monaten) und National Sleep Foundation (0–3 Monate). Sie beschreiben, was für die meisten Kinder regelmäßig gut ist – einzelne Tage dürfen abweichen. Gerade Neugeborene schlafen sehr unterschiedlich.</p>
      <p>Wachzeiten und Schläfchen-Vorschläge sind Erfahrungswerte, keine wissenschaftlich geprüften Normen. Achte vor allem auf dein Kind: Müdigkeitszeichen sind verlässlicher als jede Uhr. Bei Frühgeborenen gilt bis zum 2. Geburtstag das korrigierte Alter.</p>
      <p class="muted small">Quellen: Paruthi et al. 2016 (AASM); Hirshkowitz et al. 2015 (NSF); Galland et al. 2012; Iglowstein et al. 2003; Weissbluth 1995.</p>
    </details>
    <details class="more"><summary>Sicher schlafen</summary>
      <p>Rückenlage zum Schlafen, eigenes Bett im Elternschlafzimmer, Schlafsack statt Decke, keine Kissen, Nestchen oder Kuscheltiere im Bett, rauchfreie Umgebung, Raumtemperatur etwa 18 °C, nicht überwärmen. Stillen und ein Schnuller zum Einschlafen können schützen.</p>
      <p class="muted small">AWMF-Leitlinie 063-002 „Prävention des plötzlichen Säuglingstods“ (2022).</p>
    </details>
    <details class="more"><summary>Wann zur Kinderarztpraxis?</summary>
      <p>Sprich mit eurer Kinderarztpraxis, wenn dein Kind regelmäßig laut schnarcht oder Atempausen hat, auffällig schläfrig oder schwer weckbar ist, sich der Schlaf zusammen mit Krankheitszeichen plötzlich stark verändert oder es anhaltend untröstlich schreit. Auch wenn ihr als Eltern sehr erschöpft seid, gibt es Hilfe – zum Beispiel über Schreiambulanzen und die Frühen Hilfen.</p>
      <p class="muted small">Schlummi ersetzt keine ärztliche Beratung.</p>
    </details>
  </section>`;
}

/* ---------- Anmeldung, Einrichtung ---------- */
function viewAuth() {
  const m = state.authMode;
  const head = `<div class="hero"><img src="icon.svg" class="appicon" alt=""><h1>Schlummi</h1><p class="muted">Schlaf-Tagebuch für die ganze Familie</p></div>`;
  let form;
  if (m === 'reset') {
    form = `<form class="card form" data-form="reset">
      <p>Wir schicken dir einen Link, mit dem du ein neues Passwort setzen kannst.</p>
      <label>E-Mail<input name="email" type="email" required autocomplete="email"></label>
      <button class="primary">Link senden</button>
      <button type="button" class="link" data-action="authmode" data-mode="login">Zurück zur Anmeldung</button></form>`;
  } else if (m === 'newpw') {
    form = `<form class="card form" data-form="newpw">
      <p>Bitte wähle ein neues Passwort.</p>
      <label>Neues Passwort<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="primary">Speichern</button></form>`;
  } else {
    const login = m === 'login';
    form = `<form class="card form" data-form="auth">
      <label>E-Mail<input name="email" type="email" required autocomplete="email"></label>
      <label>Passwort${login ? '' : ' <span class="muted small">(mindestens 8 Zeichen)</span>'}
        <input name="password" type="password" required minlength="${login ? 6 : 8}" autocomplete="${login ? 'current-password' : 'new-password'}"></label>
      ${login ? '' : `<label class="check"><input type="checkbox" name="consent" required> Ich habe die <a href="datenschutz.html" target="_blank" rel="noopener">Datenschutzhinweise</a> gelesen und bin einverstanden, dass die Schlafdaten meines Kindes dafür gespeichert werden.</label>`}
      <button class="primary">${login ? 'Anmelden' : 'Konto erstellen'}</button>
      <button type="button" class="link" data-action="authmode" data-mode="${login ? 'signup' : 'login'}">${login ? 'Noch kein Konto? Registrieren' : 'Schon ein Konto? Anmelden'}</button>
      ${login ? '<button type="button" class="link" data-action="authmode" data-mode="reset">Passwort vergessen?</button>' : ''}
    </form>`;
  }
  app.innerHTML = `<div class="onboard">${head}${form}
    <p class="muted small center"><a href="datenschutz.html">Datenschutz</a> · <a href="impressum.html">Impressum</a></p></div>`;
}

function viewSetup() {
  app.innerHTML = `
    <div class="onboard">
      <div class="hero"><img src="icon.svg" class="appicon" alt=""><h1>Willkommen</h1><p class="muted">Erzähl kurz von eurem Kind.</p></div>
      <form class="card form" data-form="setup">
        <label>Name<input name="child_name" required maxlength="60" placeholder="z. B. Emma"></label>
        <label>Geburtsdatum<input name="birthdate" type="date" required max="${todayISO()}"></label>
        <label>Errechneter Geburtstermin <span class="muted small">(optional, für Frühgeborene)</span><input name="due_date" type="date"></label>
        <details class="more"><summary>Tagesrhythmus festlegen (optional)</summary>${rhythmFields({})}</details>
        <button class="primary">Los geht's</button>
      </form>
      ${cloud() ? `<form class="card form" data-form="join">
        <p class="muted">Oder einer Familie beitreten, die schon Schlummi nutzt:</p>
        <label>Einladungscode<input name="code" required autocapitalize="characters" autocomplete="off" placeholder="ABCDE 12345"></label>
        <button class="secondary">Beitreten</button>
      </form>
      <p class="center"><button class="link" data-action="logout">Abmelden</button></p>` : ''}
    </div>`;
}

/* ---------- Bearbeiten-Dialog ---------- */
function openEdit(sleep, preset) {
  const isNew = !sleep;
  const now = new Date();
  const s = sleep || preset || { start_at: new Date(+now - 60 * 6e4).toISOString(), end_at: now.toISOString(), note: '', tags: [], kind: null };
  const tags = new Set(s.tags || []);
  dlg.innerHTML = `
    <form method="dialog" class="form" data-form="edit" data-id="${isNew ? '' : esc(s.id)}">
      <h2>${isNew ? 'Schlaf nachtragen' : 'Schlaf bearbeiten'}</h2>
      <label>Eingeschlafen<input type="datetime-local" name="start" required value="${toInput(new Date(s.start_at))}"></label>
      <div class="chips" data-for="start"><button type="button" data-shift="-15">−15</button><button type="button" data-shift="-5">−5</button>
        <button type="button" data-shift="5">+5</button><button type="button" data-shift="15">+15</button></div>
      <label>Aufgewacht ${!isNew && !s.end_at ? '<span class="muted small">(leer = schläft noch)</span>' : ''}
        <input type="datetime-local" name="end" ${isNew ? 'required' : ''} value="${s.end_at ? toInput(new Date(s.end_at)) : ''}"></label>
      <div class="chips" data-for="end"><button type="button" data-shift="-15">−15</button><button type="button" data-shift="-5">−5</button>
        <button type="button" data-shift="5">+5</button><button type="button" data-now>Jetzt</button></div>
      <label class="toggle">Art<select name="kind">
        <option value="" ${!s.kind ? 'selected' : ''}>Automatisch</option>
        <option value="nap" ${s.kind === 'nap' ? 'selected' : ''}>Tagschlaf</option>
        <option value="night" ${s.kind === 'night' ? 'selected' : ''}>Nachtschlaf</option></select></label>
      <fieldset class="tagpick"><legend class="small muted">Markierungen</legend>
        ${TAGS.map(([k, l]) => `<label class="tagbox"><input type="checkbox" name="tag" value="${k}" ${tags.has(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </fieldset>
      <label>Notiz<input name="note" maxlength="200" value="${esc(s.note || '')}" placeholder="z. B. schwer eingeschlafen"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="btnrow">
        ${isNew ? '' : '<button type="button" class="danger" data-action="delete">Löschen</button>'}
        <span class="spacer"></span>
        <button type="button" class="secondary" data-action="close">Abbrechen</button>
        <button class="primary small">Speichern</button>
      </div>
    </form>`;
  dlg.showModal();
}
function formError(form, msg) {
  const el = $('.form-error', form);
  el.textContent = msg; el.hidden = !msg;
}

/* ---------- Aktionen ---------- */
async function startSleep(minAgo = 0) {
  if (state.sleeps.some(s => !s.end_at)) return;
  const row = await state.store.addSleep({ start_at: new Date(Date.now() - minAgo * 6e4).toISOString() });
  navigator.vibrate?.(30);
  toast(minAgo ? `Schlaf ab ${fmtTime(new Date(row.start_at))} gestartet` : 'Schlaf gestartet', {
    action: { label: 'Rückgängig', fn: () => state.store.deleteSleep(row.id) },
  });
}
async function stopSleep(minAgo = 0) {
  const r = state.sleeps.find(s => !s.end_at);
  if (!r) return;
  const end = new Date(Math.max(Date.now() - minAgo * 6e4, Date.parse(r.start_at) + 6e4));
  const ok = await state.store.stopSleep(r.id, end.toISOString());
  navigator.vibrate?.(30);
  if (!ok) { toast('Dieser Schlaf wurde schon auf dem anderen Gerät beendet.'); await refresh(); return; }
  toast(`Aufgewacht um ${fmtTime(end)} – ${fmtDur((end - new Date(r.start_at)) / 6e4)} geschlafen`, {
    action: { label: 'Rückgängig', fn: () => state.store.updateSleep(r.id, { end_at: null }) },
  });
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function csv() {
  const head = ['Start', 'Ende', 'Dauer (min)', 'Art', 'Markierungen', 'Notiz'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...state.sleeps].reverse().map(s => [
    toInput(new Date(s.start_at)).replace('T', ' '), s.end_at ? toInput(new Date(s.end_at)).replace('T', ' ') : '',
    s.end_at ? Math.round(durMin(s)) : '', isNight(s) ? 'Nacht' : 'Tag', (s.tags || []).map(tagLabel).join(', '), s.note || '',
  ].map(q).join(';'));
  return '﻿' + [head.map(q).join(';'), ...lines].join('\r\n');
}
async function loadMembers() {
  if (!cloud() || !state.family) return;
  state.members = await state.store.listMembers();
}

document.addEventListener('click', e => {
  const shift = e.target.closest('[data-shift],[data-now]');
  if (shift) {
    const input = shift.parentElement.previousElementSibling.querySelector('input');
    if (shift.hasAttribute('data-now')) { input.value = toInput(new Date()); return; }
    const base = input.value ? new Date(input.value) : new Date();
    input.value = toInput(new Date(+base + Number(shift.dataset.shift) * 6e4));
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.action;
  const store = state.store;
  const confirmTwice = (label) => {
    if (el.dataset.confirm) return true;
    el.dataset.confirm = '1'; el.dataset.label = el.textContent; el.textContent = label;
    setTimeout(() => { if (el.isConnected) { delete el.dataset.confirm; el.textContent = el.dataset.label; } }, 5000);
    return false;
  };
  switch (a) {
    case 'view':
      state.view = el.dataset.view; render(); window.scrollTo(0, 0);
      if (state.view === 'settings') run(async () => { await Promise.all([loadPush(), loadMembers()]); if (state.view === 'settings') render(); });
      break;
    case 'start': run(() => startSleep(0)); break;
    case 'start-ago': run(() => startSleep(Number(el.dataset.min))); break;
    case 'stop': run(() => stopSleep(0)); break;
    case 'stop-ago': run(() => stopSleep(Number(el.dataset.min))); break;
    case 'edit': openEdit(state.sleeps.find(s => s.id === el.dataset.id)); break;
    case 'add': openEdit(null); break;
    case 'add-night': {
      const y = addDays(startOfDay(new Date()), -1);
      const bt = state.family.bedtime || '19:30', wt = state.family.waketime || '06:30';
      const [bh, bm] = bt.split(':').map(Number), [wh, wm] = wt.split(':').map(Number);
      const st = new Date(y); st.setHours(bh, bm);
      const en = startOfDay(new Date()); en.setHours(wh, wm);
      openEdit(null, { start_at: st.toISOString(), end_at: (en > new Date() ? new Date() : en).toISOString(), kind: 'night', tags: [] });
      break;
    }
    case 'close': dlg.close(); break;
    case 'reload': location.reload(); break;
    case 'delete': {
      const id = $('form', dlg).dataset.id;
      if (!confirmTwice('Wirklich löschen?')) break;
      const row = state.sleeps.find(s => s.id === id);
      run(async () => {
        await store.deleteSleep(id); dlg.close();
        toast('Eintrag gelöscht', { action: { label: 'Rückgängig', fn: () => store.addSleep({ ...row, id: newId() }) } });
      });
      break;
    }
    case 'safe-seen': ls.set('schlummi.safeSleepSeen', true); render(); break;
    case 'theme': applyTheme(el.dataset.theme); render(); break;
    case 'report-days': state.reportDays = Number(el.dataset.days); render(); break;
    case 'print': try { window.print(); } catch { toast('Drucken ist hier nicht möglich.'); } break;
    case 'authmode': state.authMode = el.dataset.mode; viewAuth(); break;
    case 'logout': run(async () => { await disablePush().catch(() => {}); await store.signOut(); state.family = null; state.authMode = 'login'; viewAuth(); }); break;
    case 'push-on': run(async () => { el.disabled = true; try { await enablePush(); } finally { render(); } }); break;
    case 'push-off': run(async () => { await disablePush(); render(); toast('Benachrichtigungen aus'); }); break;
    case 'export-json':
      download(`schlummi-${todayISO()}.json`, JSON.stringify({ app: 'schlummi', version: 2, family: { ...state.family, invite_code: undefined }, sleeps: state.sleeps }, null, 2), 'application/json');
      break;
    case 'export-csv': download(`schlummi-${todayISO()}.csv`, csv(), 'text/csv'); break;
    case 'wipe-local':
      if (!confirmTwice('Wirklich alles löschen?')) break;
      run(async () => { await store.wipe(); state.family = null; state.sleeps = []; viewSetup(); });
      break;
    case 'share-code': run(async () => {
      const text = `Tritt unserer Familie in Schlummi bei. Einladungscode: ${state.family.invite_code}\n${location.origin + location.pathname}`;
      if (navigator.share) { await navigator.share({ title: 'Schlummi-Einladung', text }).catch(() => {}); }
      else { await navigator.clipboard.writeText(text); toast('Einladung kopiert'); }
    }); break;
    case 'rotate-code': run(async () => { state.family = await store.rotateInvite(); render(); toast('Neuer Code erzeugt – der alte gilt nicht mehr'); }); break;
    case 'remove-member':
      if (!confirmTwice('Wirklich entfernen?')) break;
      run(async () => { await store.removeMember(el.dataset.id); await store.loadFamily(); state.family = store.family; await loadMembers(); render(); toast('Mitglied entfernt, Einladungscode erneuert'); });
      break;
    case 'leave-family':
      if (!confirmTwice('Wirklich verlassen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.leaveFamily(); state.family = null; state.sleeps = []; viewSetup(); });
      break;
    case 'delete-family':
      if (!confirmTwice('Alles endgültig löschen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.deleteFamily(); state.family = null; state.sleeps = []; viewSetup(); toast('Familie und alle Einträge gelöscht'); });
      break;
    case 'delete-account':
      if (!confirmTwice('Konto endgültig löschen?')) break;
      run(async () => { await disablePush().catch(() => {}); await store.deleteAccount(); state.family = null; state.authMode = 'login'; viewAuth(); toast('Dein Konto wurde gelöscht'); });
      break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.pref === 'dim') { ls.set('schlummi.dim', t.checked); applyTheme(); return; }
  const pref = t.dataset.pushPref;
  if (pref && state.push.row) {
    const prefs = pushPrefs(state.push.row);
    prefs[pref] = t.type === 'checkbox' ? t.checked : t.type === 'time' ? t.value : Number(t.value);
    run(async () => { state.push.row = await state.store.savePush(state.push.sub, prefs); if (pref === 'quiet') render(); });
    return;
  }
  if (t.dataset.action === 'import' && t.files[0]) {
    run(async () => {
      let data;
      try { data = JSON.parse(await t.files[0].text()); } catch { throw new Error('Die Datei ist keine gültige Schlummi-Sicherung.'); }
      const rows = (Array.isArray(data?.sleeps) ? data.sleeps : []).filter(s => s && !isNaN(Date.parse(s.start_at)) && (!s.end_at || !isNaN(Date.parse(s.end_at))));
      const n = await state.store.importSleeps(rows);
      toast(n ? `${n} Einträge importiert` : 'Keine neuen Einträge gefunden (schon vorhanden)');
      t.value = '';
    });
  }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const store = state.store;
  const kind = form.dataset.form;
  const validateKid = (birthdate, due) => {
    if (birthdate > todayISO()) throw new Error('Das Geburtsdatum liegt in der Zukunft.');
    if (due) {
      const diff = (new Date(due) - new Date(birthdate)) / 864e5;
      if (diff < -30 || diff > 140) throw new Error('Der errechnete Termin passt nicht zum Geburtsdatum.');
    }
  };
  const go = async () => {
    if (kind === 'auth') {
      const res = state.authMode === 'login' ? await store.signIn(fd.email.trim(), fd.password) : await store.signUp(fd.email.trim(), fd.password);
      if (res.needsConfirm) {
        state.authMode = 'login'; viewAuth();
        toast('Fast geschafft: Bitte bestätige den Link in der E-Mail und melde dich dann hier an.', { ms: 9000 });
        return;
      }
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
      validateKid(fd.birthdate, fd.due_date);
      state.family = await store.createFamily(fd.child_name.trim(), fd.birthdate);
      const extra = { ...rhythmFromForm(fd), due_date: fd.due_date || null };
      if (Object.values(extra).some(v => v != null)) state.family = await store.saveFamily(extra);
      await refresh();
    } else if (kind === 'join') {
      state.family = await store.joinFamily(fd.code);
      toast('Willkommen in der Familie!');
      await refresh();
    } else if (kind === 'family') {
      validateKid(fd.birthdate, fd.due_date);
      state.family = await store.saveFamily({ child_name: fd.child_name.trim(), birthdate: fd.birthdate, due_date: fd.due_date || null });
      toast('Gespeichert'); render();
    } else if (kind === 'rhythm') {
      state.family = await store.saveFamily(rhythmFromForm(fd));
      toast('Tagesrhythmus gespeichert'); render();
    } else if (kind === 'edit') {
      const start = new Date(fd.start);
      const end = fd.end ? new Date(fd.end) : null;
      const id = form.dataset.id;
      const soon = new Date(Date.now() + 6e4);
      if (isNaN(start)) return formError(form, 'Bitte eine Einschlafzeit angeben.');
      if (end && end <= start) return formError(form, 'Die Aufwachzeit muss nach der Einschlafzeit liegen.');
      if (start > soon || (end && end > soon)) return formError(form, 'Zeiten dürfen nicht in der Zukunft liegen.');
      if (end && end - start > 36 * 3600e3) return formError(form, 'Ein Eintrag darf höchstens 36 Stunden lang sein.');
      if (!end && state.sleeps.some(s => !s.end_at && s.id !== id)) return formError(form, 'Es läuft bereits ein anderer Schlaf.');
      const probe = { start_at: start.toISOString(), end_at: (end || new Date()).toISOString() };
      const clash = state.sleeps.find(s => s.id !== id && overlapMin(s, new Date(probe.start_at), new Date(probe.end_at)) > 1);
      if (clash) return formError(form, `Überschneidet sich mit ${fmtTime(new Date(clash.start_at))} – ${clash.end_at ? fmtTime(new Date(clash.end_at)) : 'läuft'} (${dayLabel(new Date(clash.start_at))}).`);
      const patch = {
        start_at: start.toISOString(), end_at: end ? end.toISOString() : null, note: fd.note.trim() || null,
        kind: fd.kind || null, tags: [...form.querySelectorAll('input[name=tag]:checked')].map(i => i.value),
      };
      if (id) await store.updateSleep(id, patch); else await store.addSleep(patch);
      dlg.close();
    }
  };
  if (kind === 'edit') {
    go().catch(err => { console.error(err); formError(form, friendlyError(err)); });
  } else run(go);
});

/* ---------- Live-Uhr ---------- */
let lastMinute = -1;
function tick() {
  const t = $('[data-timer]');
  if (t) t.textContent = fmtTimer(Date.now() - Date.parse(t.dataset.timer));
}
setInterval(() => {
  tick();
  const m = new Date().getMinutes();
  if (m !== lastMinute) {
    lastMinute = m;
    if (state.family && !dlg.open && !document.activeElement?.matches('input, select, textarea') && state.view !== 'report') render();
  }
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.family) run(refresh); });
window.addEventListener('online', () => { if (state.family) run(refresh); });
window.addEventListener('offline', () => { if (state.family) render(); });

/* ---------- Start ---------- */
async function afterInit(res) {
  if (res.needsAuth) return viewAuth();
  state.family = res.family;
  if (!state.family) return viewSetup();
  await refresh();
}

async function boot() {
  state.store = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY
    ? new SupabaseStore(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY)
    : new LocalStore();
  state.store.onChange(() => run(refresh));
  if (cloud()) state.store.onRecovery = () => { state.authMode = 'newpw'; viewAuth(); };
  try { await afterInit(await state.store.init()); }
  catch (e) {
    console.error(e);
    app.innerHTML = `<div class="onboard"><div class="hero"><img src="icon.svg" class="appicon" alt=""><h1>Schlummi</h1></div>
      <section class="card"><p>${esc(friendlyError(e))}</p><button class="primary" style="margin-top:12px" data-action="reload">Erneut versuchen</button></section></div>`;
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();

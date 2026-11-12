// Richtwerte und Tagesplanung – reines JavaScript ohne Abhängigkeiten.
// Wird von der App UND der Push-Funktion (Supabase Edge Function) genutzt.
//
// Quellen
//   Gesamtschlaf: AASM (Paruthi et al. 2016) ab 4 Monaten; NSF (Hirshkowitz et al. 2015) für 0–3 Monate.
//   Schläfchen-Anzahl und -Dauer: Galland et al. 2012, Iglowstein et al. 2003, Weissbluth 1995.
//   Wachzeiten ("Wachfenster"): Erfahrungswerte aus der Praxis – keine Studienlage. Deshalb weich formuliert.
//   Frühgeborene: Richtwerte nach korrigiertem Alter bis 24 Monate (pädiatrische Praxis).

/* ---------- Richtwerte ---------- */

// Stützpunkte für Wachzeiten [Monate (korrigiert), min, max in Minuten] – dazwischen linear interpoliert (keine Sprünge)
const WAKE_ANCHORS = [
  [0, 35, 60], [1, 50, 80], [2, 60, 90], [3, 75, 120], [4, 90, 150], [5, 120, 165],
  [6, 120, 180], [8, 150, 195], [10, 165, 225], [12, 180, 240], [15, 210, 300],
  [18, 270, 330], [24, 300, 360], [36, 300, 420], [60, 360, 720],
];

// Schläfchen pro Tag [bis Monate (exklusiv), Anzeige, Standard, typische Dauer in Minuten]
export const NAP_TABLE = [
  { maxM: 1,   label: '4–8', naps: 5, napLen: 45 },
  { maxM: 3,   label: '4–6', naps: 4, napLen: 45 },
  { maxM: 4.5, label: '3–5', naps: 4, napLen: 50 },
  { maxM: 8,   label: '3 (2–4)', naps: 3, napLen: 60 },
  { maxM: 15,  label: '2', naps: 2, napLen: 75 },
  { maxM: 24,  label: '1–2', naps: 1, napLen: 120 },
  { maxM: 36,  label: '1', naps: 1, napLen: 110 },
  { maxM: 999, label: '0–1', naps: 0, napLen: 90 },
];

export const TOTAL_SLEEP = [
  { maxM: 4,   min: 14, max: 17, normalMin: 11, normalMax: 19, source: 'NSF', orientation: true },
  { maxM: 12,  min: 12, max: 16, source: 'AASM' },
  { maxM: 36,  min: 11, max: 14, source: 'AASM' },
  { maxM: 72,  min: 10, max: 13, source: 'AASM' },
  { maxM: 156, min: 9,  max: 12, source: 'AASM' },
  { maxM: 999, min: 8,  max: 10, source: 'AASM' },
];

export const NEWBORN_MONTHS = 3; // bis hierhin (korrigiert): kein Tagesplan, nur Orientierung

/* ---------- Alter ---------- */

const DAY = 864e5, MIN = 6e4;

function monthsBetween(fromISO, now) {
  const b = new Date(fromISO + 'T00:00:00');
  let m = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  const anchor = new Date(b); anchor.setMonth(b.getMonth() + m);
  if (anchor > now) { m -= 1; anchor.setMonth(anchor.getMonth() - 1); }
  const next = new Date(anchor); next.setMonth(anchor.getMonth() + 1);
  return m + (now - anchor) / (next - anchor);
}

export function ageInMonths(birthdate, now = new Date()) {
  return Math.max(0, monthsBetween(birthdate, now));
}

// Effektives Alter für Richtwerte: korrigiert bei Frühgeborenen (ET > 2 Wochen nach Geburt) bis 24 Monate
export function effectiveAge(family, now = new Date()) {
  const chrono = ageInMonths(family.birthdate, now);
  const due = family.due_date;
  if (due && chrono < 24) {
    const diffDays = (new Date(due + 'T00:00:00') - new Date(family.birthdate + 'T00:00:00')) / DAY;
    if (diffDays >= 14) {
      const corrected = Math.max(0, monthsBetween(due, now));
      return { months: corrected, chrono, corrected: true, weeksEarly: Math.round(diffDays / 7) };
    }
  }
  return { months: chrono, chrono, corrected: false, weeksEarly: 0 };
}

export function monthsLabel(m) {
  if (m < 2) { const w = Math.floor(m * 4.345); return w <= 1 ? (w === 1 ? '1 Woche' : 'unter 1 Woche') : `${w} Wochen`; }
  const mm = Math.floor(m);
  if (mm < 24) return `${mm} Monate`;
  const y = Math.floor(mm / 12), rm = mm % 12;
  return `${y} Jahre${rm ? ` ${rm} Mon.` : ''}`;
}

export function ageLabel(birthdate, now = new Date()) {
  const days = Math.floor((now - new Date(birthdate + 'T00:00:00')) / DAY);
  if (days < 0) return 'noch nicht geboren';
  if (days < 7) return days === 1 ? '1 Tag' : `${days} Tage`;
  return monthsLabel(ageInMonths(birthdate, now));
}

/* ---------- Richtwerte nach Alter ---------- */

export function wakeWindowFor(months) {
  const a = WAKE_ANCHORS;
  if (months <= a[0][0]) return { min: a[0][1], max: a[0][2] };
  for (let i = 1; i < a.length; i++) {
    if (months <= a[i][0]) {
      const [m0, lo0, hi0] = a[i - 1], [m1, lo1, hi1] = a[i];
      const t = (months - m0) / (m1 - m0);
      const r5 = v => Math.round(v / 5) * 5;
      return { min: r5(lo0 + t * (lo1 - lo0)), max: r5(hi0 + t * (hi1 - hi0)) };
    }
  }
  const last = a[a.length - 1];
  return { min: last[1], max: last[2] };
}

export const napsFor = months => NAP_TABLE.find(r => months < r.maxM) ?? NAP_TABLE[NAP_TABLE.length - 1];

export function totalSleepFor(months) {
  return TOTAL_SLEEP.find(r => months < r.maxM) ?? TOTAL_SLEEP[TOTAL_SLEEP.length - 1];
}

/* ---------- Zeit in einer Zeitzone (tz leer = Gerätezeit) ---------- */

function tzOffsetMin(date, tz) {
  if (!tz) return -date.getTimezoneOffset();
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = t => Number(p.find(x => x.type === t).value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - date.getTime()) / MIN);
}
export function safeTz(tz) {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'Europe/Berlin'; }
}
export function localHour(date, tz) {
  const d = new Date(date.getTime() + tzOffsetMin(date, tz) * MIN);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
// Gleicher Kalendertag wie ref (in tz), Uhrzeit "HH:MM"
export function atClock(ref, hhmm, tz) {
  const d = new Date(ref.getTime() + tzOffsetMin(ref, tz) * MIN);
  const [h, m] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  let t = guess - tzOffsetMin(new Date(guess), tz) * MIN;
  const back = tzOffsetMin(new Date(t), tz); // Zeitumstellung: zweite Korrektur
  t = guess - back * MIN;
  return new Date(t);
}
const clock = t => (t ? String(t).slice(0, 5) : null);
const hoursOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h + m / 60; };
const inRange = (h, start, end) => (start <= end ? h >= start && h < end : h >= start || h < end);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const round5 = d => new Date(Math.round(d.getTime() / (5 * MIN)) * 5 * MIN);

/* ---------- Rhythmus der Familie ---------- */

const sleepEnd = (s, now) => (s.end_at ? new Date(s.end_at) : now);
const durMin = (s, now) => (sleepEnd(s, now) - new Date(s.start_at)) / MIN;

// Nachtfenster für die Einordnung von Einträgen
function nightBounds(family) {
  const bed = clock(family?.bedtime), wake = clock(family?.waketime);
  const start = bed ? (hoursOf(bed) - 1.5 + 24) % 24 : 18;
  const end = wake ? clamp(hoursOf(wake) - 1, 4, 8) : 5;
  return { start, end };
}

export function isNightSleep(s, now = new Date(), tz, family) {
  if (s.kind === 'night') return true;
  if (s.kind === 'nap') return false;
  const { start, end } = nightBounds(family);
  const h = localHour(new Date(s.start_at), tz);
  if (inRange(h, start, end)) return true;
  // sehr lange Schlafphase, die nachmittags/abends beginnt (z. B. frühe Bettzeit ohne Einstellung)
  return s.end_at != null && durMin(s, now) >= 240 && inRange(h, 15, 8);
}

// Median der eigenen Schläfchen (letzte 14 Tage), sonst Alterswert
export function personalNapLen(family, sleeps, now, tz, fallback) {
  const since = now.getTime() - 14 * DAY;
  const lens = sleeps
    .filter(s => s.end_at && Date.parse(s.start_at) > since && !isNightSleep(s, now, tz, family))
    .map(s => durMin(s, now)).filter(m => m >= 10 && m <= 240).sort((a, b) => a - b);
  if (lens.length < 4) return { napLen: fallback, personal: false };
  const mid = Math.floor(lens.length / 2);
  const med = lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
  return { napLen: Math.round(clamp(med, 20, 180)), personal: true };
}


// Gewichteter Median (neuere Tage zählen mehr)
function wmedian(pairs) {
  const a = pairs.filter(p => isFinite(p[0])).sort((x, y) => x[0] - y[0]);
  const total = a.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of a) { acc += w; if (acc >= total / 2) return v; }
  return a.length ? a[a.length - 1][0] : NaN;
}
const toClock = h => { h = ((h % 24) + 24) % 24; const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/**
 * Persönliches Muster aus den letzten 14 Tagen (ab 5 vollständigen Tagen).
 * firstWW: Wachzeit vom Aufwachen bis zum 1. Schläfchen, lastWW: letztes Schläfchen bis Nachtschlaf,
 * napLen, naps (typische Anzahl der letzten 7 Tage), bed/wake (typische Uhrzeiten), trend ('fewer'|'more'|null).
 */
export function learnPattern(family, sleeps, now = new Date(), tz) {
  const isN = s => isNightSleep(s, now, tz, family) && s.end_at && durMin(s, now) >= 240;
  const ended = sleeps.filter(s => s.end_at).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const nights = ended.filter(isN);
  const since = now.getTime() - 14 * DAY;
  const days = [];
  for (const n of nights) {
    const wake = new Date(n.end_at);
    if (wake.getTime() < since || wake > now) continue;
    const next = nights.find(m => Date.parse(m.start_at) > wake.getTime() && Date.parse(m.start_at) < wake.getTime() + 18 * 3600e3);
    const limit = next ? Date.parse(next.start_at) : wake.getTime() + 16 * 3600e3;
    const naps = ended.filter(s => !isNightSleep(s, now, tz, family) && Date.parse(s.start_at) > wake.getTime() && Date.parse(s.start_at) < limit);
    const age = (now - wake) / DAY;
    const w = Math.pow(0.85, age);
    const bedH = next ? localHour(new Date(next.start_at), tz) : NaN;
    days.push({
      w, age, complete: !!next,
      wakeH: localHour(wake, tz),
      bedH: bedH < 12 ? bedH + 24 : bedH,
      firstWW: naps.length ? (Date.parse(naps[0].start_at) - wake) / MIN : NaN,
      lastWW: naps.length && next ? (Date.parse(next.start_at) - Date.parse(naps[naps.length - 1].end_at)) / MIN : NaN,
      napCount: naps.length,
      napLens: naps.map(x => durMin(x, now)),
    });
  }
  const complete = days.filter(d => d.complete);
  if (complete.length < 5) return null;
  const recent = complete.filter(d => d.age <= 7), older = complete.filter(d => d.age > 7);
  const mean = a => a.reduce((t, d) => t + d.napCount, 0) / a.length;
  const napsRecent = recent.length ? mean(recent) : mean(complete);
  let trend = null;
  if (recent.length >= 3 && older.length >= 3) {
    const diff = napsRecent - mean(older);
    trend = diff <= -0.4 ? 'fewer' : diff >= 0.4 ? 'more' : null;
  }
  const napLens = days.flatMap(d => d.napLens.map(l => [l, d.w])).filter(p => p[0] >= 10 && p[0] <= 240);
  const firstWW = wmedian(days.map(d => [d.firstWW, d.w]));
  const lastWW = wmedian(complete.map(d => [d.lastWW, d.w]));
  return {
    days: complete.length,
    firstWW: isFinite(firstWW) ? Math.round(firstWW) : null,
    lastWW: isFinite(lastWW) ? Math.round(lastWW) : null,
    napLen: napLens.length >= 3 ? Math.round(clamp(wmedian(napLens), 20, 180)) : null,
    naps: Math.round(napsRecent),
    napsAvg: napsRecent,
    trend,
    bed: toClock(wmedian(complete.map(d => [d.bedH, d.w]))),
    wake: toClock(wmedian(days.map(d => [d.wakeH, d.w]))),
  };
}

export function rhythm(family, now = new Date(), sleeps = [], tz) {
  const age = effectiveAge(family, now);
  const months = age.months;
  const ageW = wakeWindowFor(months);
  const napRow = napsFor(months);
  const ww = family.wake_window ? Number(family.wake_window) : null;
  const nl = personalNapLen(family, sleeps, now, tz, napRow.napLen);
  const learned = months >= NEWBORN_MONTHS && sleeps.length ? learnPattern(family, sleeps, now, tz) : null;
  return {
    months, age, napRow, learned,
    ageWindow: ageW,
    window: ww ? { min: ww - 20, max: ww + 20, custom: true } : { ...ageW, custom: false },
    naps: family.naps_per_day ?? (learned ? learned.naps : napRow.naps),
    napsCustom: family.naps_per_day != null,
    napLen: learned?.napLen ?? nl.napLen, napLenPersonal: !!learned?.napLen || nl.personal,
    bedtime: clock(family.bedtime) ?? learned?.bed ?? null,
    bedtimeLearned: !family.bedtime && !!learned,
    waketime: clock(family.waketime) ?? learned?.wake ?? null,
    newborn: months < NEWBORN_MONTHS,
  };
}

/* ---------- Tagesplan ---------- */

/**
 * Ergebnis.kind:
 *   'sleeping'  – Schlaf läuft (forgotten = läuft auffällig lange)
 *   'none'      – noch keine Einträge
 *   'stale'     – letzter Eintrag zu alt / Nacht nicht erfasst
 *   'newborn'   – Neugeborenes: nur Orientierung, kein Plan
 *   'night'     – nachts wach
 *   'nap' | 'bedtime' – nächster Schlaf; status 'early' | 'now' | 'late'
 */
export function planDay(family, sleeps, now = new Date(), tzIn) {
  const tz = safeTz(tzIn);
  const r = rhythm(family, now, sleeps, tz);
  const night = s => isNightSleep(s, now, tz, family);

  const running = sleeps.find(s => !s.end_at);
  if (running) {
    const isNight = night(running);
    const mins = durMin(running, now);
    const forgotten = isNight ? mins > 14 * 60 : mins > Math.max(240, r.napLen * 3);
    let wakeAt = null;
    if (isNight && r.waketime) {
      wakeAt = atClock(now, r.waketime, tz);
      if (wakeAt <= new Date(running.start_at)) wakeAt = new Date(wakeAt.getTime() + DAY);
    }
    return { kind: 'sleeping', r, running, night: isNight, wakeAt, forgotten, mins };
  }

  const ended = sleeps.filter(s => s.end_at).sort((a, b) => Date.parse(b.end_at) - Date.parse(a.end_at));
  const last = ended[0];
  if (!last) return { kind: 'none', r };
  const lastEnd = new Date(last.end_at);
  const awake = (now - lastEnd) / MIN;

  // Zwischen letztem Aufwachen und jetzt lag 3 Uhr nachts ohne erfassten Schlaf → Nacht fehlt
  let t3 = atClock(lastEnd, '03:00', tz);
  if (t3 <= lastEnd) t3 = new Date(t3.getTime() + DAY);
  if (awake > 16 * 60 || (t3 < now && awake > 4 * 60)) return { kind: 'stale', r, last, lastEnd, awake };

  if (r.newborn) return { kind: 'newborn', r, last, lastEnd, awake };

  // Nachts wach? (letzter Schlaf war Nachtschlaf und es ist noch Nacht)
  const nowH = localHour(now, tz);
  const nightNowStart = r.bedtime ? hoursOf(r.bedtime) : 19;
  const nightNowEnd = r.waketime ? Math.max(4.5, hoursOf(r.waketime)) : 6;
  if (night(last) && inRange(nowH, nightNowStart, nightNowEnd)) {
    return { kind: 'night', r, last, lastEnd, awake };
  }

  // Tagesbeginn: Ende des letzten Nachtschlafs (innerhalb 16 h), sonst 4 Uhr heute
  const lastNight = ended.find(s => night(s) && now - new Date(s.end_at) < 16 * 3600e3);
  let dayStart = lastNight ? new Date(lastNight.end_at) : atClock(now, '04:00', tz);
  if (dayStart > now) dayStart = new Date(dayStart.getTime() - DAY);
  const napsDone = ended.filter(s => new Date(s.start_at) >= dayStart && !night(s)).length;
  const w = r.window;
  let next, upcoming = [], longDay = false, extraNap = false;

  if (r.bedtime) {
    let B = atClock(dayStart, r.bedtime, tz);
    if (B.getTime() <= dayStart.getTime() + 3 * 3600e3) B = new Date(B.getTime() + DAY); // Bettzeit nach Mitternacht
    const remNaps = Math.max(0, r.naps - napsDone);
    const untilBed = (B - lastEnd) / MIN;
    let win = remNaps ? (untilBed - remNaps * r.napLen) / (remNaps + 1) : untilBed;
    win = clamp(win, w.min * 0.85, w.max * 1.15);
    // Erstes Schläfchen nach eurem persönlichen Muster (wenn keine feste Wachzeit eingestellt ist)
    if (r.learned?.firstWW && !w.custom && napsDone === 0 && remNaps) {
      win = Math.min(r.learned.firstWW, untilBed - remNaps * r.napLen - 60);
      win = Math.max(win, w.min * 0.6);
    }
    const napAt = new Date(lastEnd.getTime() + win * MIN);
    if (remNaps && napAt.getTime() + 45 * MIN < B.getTime()) {
      next = { type: 'nap', target: napAt };
      let t = lastEnd.getTime();
      for (let i = 0; i < remNaps; i++) {
        const at = t + win * MIN;
        if (at + 45 * MIN >= B.getTime()) break;
        upcoming.push({ type: 'nap', at: round5(new Date(at)), until: round5(new Date(at + r.napLen * MIN)) });
        t = at + r.napLen * MIN;
      }
      const lastGap = (B.getTime() - t) / MIN;
      longDay = lastGap > w.max * 1.3;
    } else {
      next = { type: 'bedtime', target: B };
      longDay = untilBed > w.max * 1.3;
    }
    upcoming.push({ type: 'bedtime', at: B });
  } else {
    const target = new Date(lastEnd.getTime() + ((w.min + w.max) / 2) * MIN);
    const h = localHour(target, tz);
    const isBed = (h >= 18 || h < 4) || (napsDone >= r.naps && h >= 15);
    extraNap = !isBed && napsDone >= r.naps;
    next = { type: isBed ? 'bedtime' : 'nap', target };
  }
  next.from = round5(new Date(next.target.getTime() - 30 * MIN));
  next.to = round5(new Date(next.target.getTime() + 30 * MIN));
  if (next.from < lastEnd) next.from = round5(lastEnd);
  const status = now < next.from ? 'early' : now <= next.to ? 'now' : 'late';
  return { kind: next.type, status, r, last, lastEnd, awake, napsDone, next, upcoming, longDay, extraNap, dayStart };
}

/* ---------- Auswertung ---------- */

export function overlapMin(s, from, to, now = new Date()) {
  const a = Math.max(Date.parse(s.start_at), from.getTime());
  const b = Math.min(sleepEnd(s, now).getTime(), to.getTime());
  return Math.max(0, (b - a) / MIN);
}

export function summarize(sleeps, from, to, now = new Date(), tz, family) {
  let total = 0, night = 0, nap = 0, naps = 0;
  for (const s of sleeps) {
    const m = overlapMin(s, from, to, now);
    if (!m) continue;
    total += m;
    if (isNightSleep(s, now, tz, family)) night += m;
    else { nap += m; if (new Date(s.start_at) >= from) naps++; }
  }
  return { total, night, nap, naps };
}

// Nächtliches Aufwachen: Lücken zwischen Nachtschlaf-Abschnitten, die in der Nacht vor `morning` beginnen
export function nightWakings(sleeps, morning, now = new Date(), tz, family) {
  const from = new Date(morning.getTime() - 18 * 3600e3), to = new Date(morning.getTime() + 6 * 3600e3);
  const parts = sleeps.filter(s => s.end_at && isNightSleep(s, now, tz, family)
      && Date.parse(s.start_at) >= from.getTime() && Date.parse(s.start_at) < to.getTime())
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  return Math.max(0, parts.length - 1);
}

// Tests für die Planungslogik. Ausführen: node --test tests/
// Läuft in Europe/Berlin (siehe package.json "test"-Skript) und prüft zusätzlich die Server-Sicht (UTC + tz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDay, effectiveAge, wakeWindowFor, napsFor, isNightSleep, summarize, nightWakings, atClock, localHour,
} from '../sleepdata.js';

const TZ = 'Europe/Berlin';
// lokale Berliner Zeit → Date (unabhängig von der Prozess-Zeitzone)
const L = (s) => atClock(new Date(s.slice(0, 10) + 'T12:00:00Z'), s.slice(11, 16), TZ);
const sl = (a, b, extra = {}) => ({ id: a, start_at: L(a).toISOString(), end_at: b ? L(b).toISOString() : null, ...extra });
const hm = (d) => { const h = localHour(d, TZ); return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`; };

const baby7 = { birthdate: '2026-04-10', naps_per_day: 2, bedtime: '19:30', waketime: '06:30' };

test('Aufwachen nach 23 Uhr ist Nachtwachen, nicht "Schlafenszeit verpasst"', () => {
  const p = planDay(baby7, [sl('2026-11-11T19:30', '2026-11-11T23:30')], L('2026-11-11T23:45'), TZ);
  assert.equal(p.kind, 'night');
});

test('Frühes Aufwachen (04:20) – um 07:30 wird normal geplant', () => {
  const sleeps = [sl('2026-11-11T19:30', '2026-11-12T04:20')];
  assert.equal(planDay(baby7, sleeps, L('2026-11-12T04:40'), TZ).kind, 'night');
  const p = planDay(baby7, sleeps, L('2026-11-12T07:30'), TZ);
  assert.equal(p.kind, 'nap');
  assert.equal(p.napsDone, 0);
});

test('Normaler Tag: zwei Schläfchen, dann Schlafenszeit', () => {
  const night = sl('2026-11-11T19:20', '2026-11-12T06:40');
  let p = planDay(baby7, [night], L('2026-11-12T07:00'), TZ);
  assert.equal(p.kind, 'nap');
  assert.equal(p.upcoming.filter(u => u.type === 'nap').length, 2);
  assert.equal(hm(p.upcoming.at(-1).at), '19:30');
  p = planDay(baby7, [night, sl('2026-11-12T09:40', '2026-11-12T10:50'), sl('2026-11-12T14:00', '2026-11-12T15:20')], L('2026-11-12T15:30'), TZ);
  assert.equal(p.kind, 'bedtime');
  assert.ok(['early', 'now', 'late'].includes(p.status));
});

test('Status ist nie "überfällig" (nur early/now/late)', () => {
  const p = planDay(baby7, [sl('2026-11-12T06:00', '2026-11-12T06:30')], L('2026-11-12T13:00'), TZ);
  assert.notEqual(p.status, 'over');
});

test('Bettzeit nach Mitternacht (00:30) wird für den kommenden Abend geplant', () => {
  const fam = { ...baby7, bedtime: '00:30', waketime: '09:00' };
  const p = planDay(fam, [sl('2026-11-12T00:40', '2026-11-12T09:10')], L('2026-11-12T10:00'), TZ);
  assert.equal(p.kind, 'nap');
  const bed = p.upcoming.at(-1).at;
  assert.ok(bed > L('2026-11-12T10:00'));
  assert.equal(hm(bed), '00:30');
});

test('Frühchen: korrigiertes Alter', () => {
  const fam = { birthdate: '2026-04-10', due_date: '2026-05-22' };
  const a = effectiveAge(fam, new Date('2026-11-12T12:00:00Z'));
  assert.equal(a.corrected, true);
  assert.equal(a.weeksEarly, 6);
  assert.ok(a.months > 5.5 && a.months < 6, `korrigiert ${a.months}`);
  assert.ok(a.chrono > 7 && a.chrono < 7.2);
  // Nach 24 Monaten keine Korrektur mehr
  assert.equal(effectiveAge(fam, new Date('2028-06-01T12:00:00Z')).corrected, false);
  // ET weniger als 2 Wochen später: keine Korrektur
  assert.equal(effectiveAge({ birthdate: '2026-04-10', due_date: '2026-04-15' }, new Date('2026-11-12')).corrected, false);
});

test('Neugeborene bekommen keinen Tagesplan', () => {
  const fam = { birthdate: '2026-10-01', bedtime: '19:00' };
  const p = planDay(fam, [sl('2026-11-12T08:00', '2026-11-12T09:00')], L('2026-11-12T09:30'), TZ);
  assert.equal(p.kind, 'newborn');
});

test('Nicht erfasste Nacht → "stale" statt riesiger Wachzeit', () => {
  const p = planDay(baby7, [sl('2026-11-11T17:00', '2026-11-11T18:20')], L('2026-11-12T07:00'), TZ);
  assert.equal(p.kind, 'stale');
});

test('Vergessenes Stoppen wird erkannt', () => {
  const nap = planDay(baby7, [sl('2026-11-12T09:00', null)], L('2026-11-12T15:00'), TZ);
  assert.equal(nap.forgotten, true);
  const nightOk = planDay(baby7, [sl('2026-11-11T19:30', null)], L('2026-11-12T06:00'), TZ);
  assert.equal(nightOk.forgotten, false);
  const nightLong = planDay(baby7, [sl('2026-11-11T19:30', null)], L('2026-11-12T11:00'), TZ);
  assert.equal(nightLong.forgotten, true);
});

test('Schläfchen-Anzahl nach Literatur', () => {
  assert.equal(napsFor(6.5).naps, 3);
  assert.equal(napsFor(10).naps, 2);
  assert.equal(napsFor(13).naps, 2);
  assert.equal(napsFor(16).naps, 1);
});

test('Wachzeiten ohne Sprung an Altersgrenzen', () => {
  for (let m = 0.5; m < 40; m += 0.25) {
    const a = wakeWindowFor(m - 0.05), b = wakeWindowFor(m + 0.05);
    assert.ok(Math.abs(a.min - b.min) <= 5 && Math.abs(a.max - b.max) <= 8, `Sprung bei ${m}`);
  }
});

test('Nachtschlaf-Erkennung: kurze Nachtabschnitte und frühe Bettzeit', () => {
  const now = L('2026-11-12T12:00');
  assert.equal(isNightSleep(sl('2026-11-11T23:00', '2026-11-12T00:30'), now, TZ, {}), true);
  assert.equal(isNightSleep(sl('2026-11-11T17:40', '2026-11-12T05:40'), now, TZ, {}), true);
  assert.equal(isNightSleep(sl('2026-11-12T13:00', '2026-11-12T14:30'), now, TZ, {}), false);
  assert.equal(isNightSleep(sl('2026-11-12T13:00', '2026-11-12T14:30', { kind: 'night' }), now, TZ, {}), true);
  // mit Bettzeit 19:30 ist ein Schläfchen um 17:00 Tagschlaf
  assert.equal(isNightSleep(sl('2026-11-11T17:00', '2026-11-11T17:40'), now, TZ, baby7), false);
});

test('Ohne Bettzeit: zusätzliches Schläfchen wird markiert statt "2 von 1"', () => {
  const fam = { birthdate: '2025-06-01', naps_per_day: 1 };
  const sleeps = [sl('2026-11-11T19:00', '2026-11-12T06:30'), sl('2026-11-12T08:00', '2026-11-12T08:30')];
  const p = planDay(fam, sleeps, L('2026-11-12T09:00'), TZ);
  assert.equal(p.napsDone, 1);
  assert.equal(p.extraNap, true);
});

test('Server (UTC) und Gerät (Berlin) planen identisch', () => {
  const sleeps = [sl('2026-11-11T19:20', '2026-11-12T06:40')];
  const p = planDay(baby7, sleeps, L('2026-11-12T07:00'), TZ);
  assert.equal(p.next.from.toISOString(), planDay(baby7, sleeps, L('2026-11-12T07:00'), 'Europe/Berlin').next.from.toISOString());
  assert.equal(hm(p.upcoming.at(-1).at), '19:30');
});

test('Zeitumstellung (25.10.2026): Bettzeit bleibt 19:30 Ortszeit', () => {
  const sleeps = [sl('2026-10-24T19:30', '2026-10-25T06:30')];
  const p = planDay(baby7, sleeps, L('2026-10-25T07:00'), TZ);
  assert.equal(hm(p.upcoming.at(-1).at), '19:30');
});

test('Ungültige Zeitzone bringt die Planung nicht zum Absturz', () => {
  assert.doesNotThrow(() => planDay(baby7, [sl('2026-11-12T06:00', '2026-11-12T06:30')], new Date(), 'Mars/Olympus'));
});

test('Statistik: Nacht/Tag und nächtliches Aufwachen', () => {
  const sleeps = [sl('2026-11-11T19:30', '2026-11-12T01:00'), sl('2026-11-12T01:20', '2026-11-12T04:00'),
    sl('2026-11-12T04:30', '2026-11-12T06:30'), sl('2026-11-12T09:30', '2026-11-12T10:30')];
  const now = L('2026-11-12T12:00');
  const s = summarize(sleeps, L('2026-11-12T00:00'), L('2026-11-13T00:00'), now, TZ, baby7);
  assert.equal(s.nap, 60);
  assert.equal(s.naps, 1);
  assert.equal(nightWakings(sleeps, L('2026-11-12T06:30'), now, TZ, baby7), 2);
});

test('Persönliches Muster wird aus 14 Tagen gelernt', async () => {
  const { learnPattern } = await import('../sleepdata.js');
  const fam = { birthdate: '2025-08-14' };
  const sleeps = [];
  for (let d = 1; d <= 10; d++) {
    const day = new Date(Date.UTC(2026, 10, 12 - d));
    const iso = day.toISOString().slice(0, 10);
    const prev = new Date(day.getTime() - 864e5).toISOString().slice(0, 10);
    sleeps.push(sl(`${prev}T20:10`, `${iso}T07:00`));
    sleeps.push(sl(`${iso}T12:15`, `${iso}T13:35`));
  }
  sleeps.push(sl('2026-11-11T20:10', '2026-11-12T07:00'));
  const p = learnPattern(fam, sleeps, L('2026-11-12T08:00'), TZ);
  assert.ok(p, 'Muster erkannt');
  assert.equal(p.naps, 1);
  assert.equal(p.firstWW, 315);
  assert.equal(p.napLen, 80);
  assert.equal(p.bed, '20:10');
  assert.equal(p.wake, '07:00');
  const plan = planDay(fam, sleeps, L('2026-11-12T08:00'), TZ);
  assert.equal(plan.kind, 'nap');
  assert.equal(hm(plan.next.target), '12:15');
  assert.equal(hm(plan.upcoming.at(-1).at), '20:10');
});

// Datenhaltung: LocalStore (nur dieses Gerät) oder SupabaseStore (geteilt, Live-Sync, offline-fähig).

const LS = {
  family: 'schlummi.family',
  sleeps: 'schlummi.sleeps',
  cache: fid => `schlummi.cache.${fid}`,
  queue: fid => `schlummi.queue.${fid}`,
};
const mem = {};
function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : (key in mem ? mem[key] : fallback); }
  catch { return key in mem ? mem[key] : fallback; }
}
function safeSet(key, value) {
  mem[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher nicht verfügbar */ }
}
function safeDel(key) { delete mem[key]; try { localStorage.removeItem(key); } catch { /* egal */ } }

export const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
const byStartDesc = (a, b) => Date.parse(b.start_at) - Date.parse(a.start_at);
const FAMILY_FIELDS = ['child_name', 'birthdate', 'due_date', 'naps_per_day', 'bedtime', 'waketime', 'wake_window'];
const SLEEP_FIELDS = ['start_at', 'end_at', 'note', 'kind', 'tags'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

// Verständliche deutsche Fehlermeldungen
export function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (e?.code === '23505' || /sleeps_one_running/.test(msg)) return 'Es läuft bereits ein Schlaf – vermutlich gerade auf dem anderen Handy gestartet.';
  if (/sleeps_end_after_start/.test(msg)) return 'Die Aufwachzeit muss nach der Einschlafzeit liegen.';
  if (/sleeps_max_len/.test(msg)) return 'Ein Eintrag darf höchstens 36 Stunden lang sein.';
  if (/Invalid login credentials/i.test(msg)) return 'E-Mail oder Passwort stimmt nicht.';
  if (/Email not confirmed/i.test(msg)) return 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Mail).';
  if (/User already registered/i.test(msg)) return 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.';
  if (/Password should be/i.test(msg)) return 'Das Passwort ist zu kurz oder zu einfach (mindestens 8 Zeichen).';
  if (/rate limit|too many/i.test(msg)) return 'Zu viele Versuche – bitte später erneut probieren.';
  if (/JWT expired|session/i.test(msg)) return 'Deine Anmeldung ist abgelaufen – bitte neu anmelden.';
  if (isNetworkError(e)) return 'Keine Verbindung – Änderungen werden nachgeholt, sobald du wieder online bist.';
  // eigene deutsche Meldungen aus der Datenbank direkt anzeigen
  if (/^(Du |Nur |Nicht |Keine |Zu viele|Höchstens|Mitglied|Ungültig|Einladungscode|Dieses Gerät|Das Geburtsdatum|Es läuft)/.test(msg)) return msg;
  return 'Etwas ist schiefgelaufen. Bitte versuch es noch einmal.';
}
function isNetworkError(e) {
  const msg = String(e?.message || e || '');
  return (typeof navigator !== 'undefined' && navigator.onLine === false)
    || /Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(msg);
}

/* ===================== Lokal (ein Gerät) ===================== */
export class LocalStore {
  mode = 'local';
  constructor() {
    this.listeners = new Set();
    this.family = safeGet(LS.family, null);
    this.sleeps = safeGet(LS.sleeps, []);
  }
  async init() { return { needsAuth: false, family: this.family }; }
  onChange(cb) { this.listeners.add(cb); }
  emit() { safeSet(LS.sleeps, this.sleeps); this.listeners.forEach(f => f()); }
  pendingCount() { return 0; }
  async createFamily(child_name, birthdate) { return this.saveFamily({ child_name, birthdate }); }
  async saveFamily(patch) {
    this.family = { ...(this.family || {}), ...pick(patch, FAMILY_FIELDS) };
    safeSet(LS.family, this.family);
    return this.family;
  }
  async listSleeps() { return [...this.sleeps].sort(byStartDesc); }
  async addSleep(s) {
    if (!s.end_at && this.sleeps.some(x => !x.end_at)) throw new Error('Es läuft bereits ein Schlaf.');
    const row = { id: newId(), end_at: null, note: null, kind: null, tags: [], ...pick(s, ['id', ...SLEEP_FIELDS]) };
    this.sleeps.push(row); this.emit(); return row;
  }
  async updateSleep(id, patch) {
    const r = this.sleeps.find(x => x.id === id);
    if (r) Object.assign(r, pick(patch, SLEEP_FIELDS));
    this.emit();
  }
  async stopSleep(id, end_at) {
    const r = this.sleeps.find(x => x.id === id);
    if (!r || r.end_at) { this.emit(); return false; }
    r.end_at = end_at; this.emit(); return true;
  }
  async deleteSleep(id) { this.sleeps = this.sleeps.filter(x => x.id !== id); this.emit(); }
  async importSleeps(rows) {
    const starts = new Set(this.sleeps.map(s => s.start_at));
    let n = 0;
    for (const r of rows) {
      if (!r.end_at || starts.has(r.start_at)) continue;
      this.sleeps.push({ id: newId(), note: null, kind: null, tags: [], ...pick(r, SLEEP_FIELDS) });
      starts.add(r.start_at); n++;
    }
    this.emit(); return n;
  }
  async wipe() {
    safeDel(LS.family); safeDel(LS.sleeps);
    this.family = null; this.sleeps = [];
  }
}

/* ===================== Supabase (geteilt) ===================== */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.supabase?.createClient) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Failed to fetch library'));
    document.head.appendChild(s);
  });
}

export class SupabaseStore {
  mode = 'cloud';
  constructor(url, key) {
    this.url = url; this.key = key; this.listeners = new Set();
    this.cache = []; this.queue = []; this.onRecovery = null;
    window.addEventListener('online', () => this.flush().catch(() => {}));
  }

  async init() {
    if (!this.sb) {
      await loadScript('vendor/supabase-2.119.0.js');
      this.sb = window.supabase.createClient(this.url, this.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      this.sb.auth.onAuthStateChange(event => {
        if (event === 'PASSWORD_RECOVERY' && this.onRecovery) this.onRecovery();
      });
    }
    const { data: { session } } = await this.sb.auth.getSession();
    this.user = session?.user ?? null;
    if (!this.user) return { needsAuth: true };
    await this.loadFamily();
    return { needsAuth: false, family: this.family };
  }
  onChange(cb) { this.listeners.add(cb); }
  emit() { this.listeners.forEach(f => f()); }
  check({ data, error }) { if (error) throw error; return data; }

  /* --- Anmeldung --- */
  async signIn(email, password) {
    this.check(await this.sb.auth.signInWithPassword({ email, password }));
    return this.init();
  }
  async signUp(email, password) {
    const data = this.check(await this.sb.auth.signUp({
      email, password, options: { emailRedirectTo: location.origin + location.pathname },
    }));
    return data.session ? this.init() : { needsConfirm: true };
  }
  async resetPassword(email) {
    this.check(await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
  }
  async updatePassword(password) { this.check(await this.sb.auth.updateUser({ password })); }
  async signOut() {
    if (this.channel) { await this.sb.removeChannel(this.channel); this.channel = null; }
    await this.sb.auth.signOut();
    this.user = null; this.family = null; this.cache = []; this.queue = [];
  }

  /* --- Familie --- */
  async loadFamily() {
    try {
      this.family = this.check(await this.sb.from('families').select('*').order('created_at').limit(1).maybeSingle());
      if (this.family) safeSet('schlummi.lastFamily', this.family);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      this.family = safeGet('schlummi.lastFamily', null); // offline: letzte bekannte Familie
    }
    if (this.family) this.attach();
    return this.family;
  }
  attach() {
    this.cache = safeGet(LS.cache(this.family.id), []);
    this.queue = safeGet(LS.queue(this.family.id), []);
    this.subscribe();
    this.flush().catch(() => {});
  }
  async createFamily(child_name, birthdate) {
    this.family = this.check(await this.sb.rpc('create_family', { p_child_name: child_name, p_birthdate: birthdate }));
    this.attach(); return this.family;
  }
  async joinFamily(code) {
    const fam = this.check(await this.sb.rpc('join_family', { p_code: code.trim() }));
    if (!fam || !fam.id) throw new Error('Einladungscode ungültig oder abgelaufen.');
    this.family = fam;
    this.attach(); return this.family;
  }
  async saveFamily(patch) {
    this.family = this.check(await this.sb.from('families').update(pick(patch, FAMILY_FIELDS))
      .eq('id', this.family.id).select().single());
    safeSet('schlummi.lastFamily', this.family);
    return this.family;
  }
  async rotateInvite() {
    this.family = this.check(await this.sb.rpc('rotate_invite_code'));
    return this.family;
  }
  async listMembers() { return this.check(await this.sb.rpc('list_family_members')); }
  async removeMember(userId) { this.check(await this.sb.rpc('remove_family_member', { p_user: userId })); }
  async leaveFamily() {
    this.check(await this.sb.rpc('remove_family_member', { p_user: this.user.id }));
    this.forgetFamily();
  }
  async deleteFamily() { this.check(await this.sb.rpc('delete_family')); this.forgetFamily(); }
  async deleteAccount() {
    this.check(await this.sb.rpc('delete_my_account'));
    this.forgetFamily();
    await this.sb.auth.signOut().catch(() => {});
    this.user = null;
  }
  forgetFamily() {
    if (this.family) { safeDel(LS.cache(this.family.id)); safeDel(LS.queue(this.family.id)); }
    safeDel('schlummi.lastFamily');
    if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
    this.family = null; this.cache = []; this.queue = [];
  }

  /* --- Live-Sync --- */
  subscribe() {
    if (this.channel) return;
    const fid = this.family.id;
    this.channel = this.sb.channel('sleeps-' + fid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sleeps', filter: `family_id=eq.${fid}` }, () => this.emit())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sleeps', filter: `family_id=eq.${fid}` }, () => this.emit())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'sleeps' }, p => {
        if (this.cache.some(s => s.id === p.old?.id)) this.emit();
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setTimeout(() => { if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; this.subscribe(); } }, 5000);
        }
      });
  }

  /* --- Offline-Warteschlange --- */
  pendingCount() { return this.queue.length; }
  saveLocal() {
    if (!this.family) return;
    safeSet(LS.cache(this.family.id), this.cache);
    safeSet(LS.queue(this.family.id), this.queue);
  }
  applyLocal(op) {
    if (op.op === 'insert') { if (!this.cache.some(s => s.id === op.row.id)) this.cache.push({ ...op.row }); }
    else if (op.op === 'update' || op.op === 'stop') {
      const r = this.cache.find(s => s.id === op.id);
      if (r && !(op.op === 'stop' && r.end_at)) Object.assign(r, op.patch);
    } else if (op.op === 'delete') this.cache = this.cache.filter(s => s.id !== op.id);
  }
  async runOp(op) {
    if (op.op === 'insert') {
      this.check(await this.sb.from('sleeps').insert({ ...op.row, family_id: this.family.id }));
      return true;
    }
    if (op.op === 'update') { this.check(await this.sb.from('sleeps').update(op.patch).eq('id', op.id)); return true; }
    if (op.op === 'stop') {
      const rows = this.check(await this.sb.from('sleeps').update(op.patch).eq('id', op.id).is('end_at', null).select('id'));
      return rows.length > 0;
    }
    if (op.op === 'delete') { this.check(await this.sb.from('sleeps').delete().eq('id', op.id)); return true; }
    return true;
  }
  async enqueueOrRun(op) {
    this.applyLocal(op);
    if (this.queue.length === 0) {
      try {
        const ok = await this.runOp(op);
        this.saveLocal(); this.emit();
        return ok;
      } catch (e) {
        if (!isNetworkError(e)) { await this.refreshFromServer().catch(() => {}); this.emit(); throw e; }
      }
    }
    this.queue.push(op); this.saveLocal(); this.emit();
    return true;
  }
  async flush() {
    if (this.flushing || !this.family || !this.queue.length) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        try { await this.runOp(this.queue[0]); }
        catch (e) {
          if (isNetworkError(e)) break;
          this.lastSyncError = friendlyError(e); // Konflikt: Änderung verwerfen, Serverstand gilt
        }
        this.queue.shift(); this.saveLocal();
      }
    } finally { this.flushing = false; }
    if (!this.queue.length) { await this.refreshFromServer().catch(() => {}); this.emit(); }
  }
  async refreshFromServer(days = 120) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const rows = this.check(await this.sb.from('sleeps').select('*')
      .eq('family_id', this.family.id)
      .or(`start_at.gte.${since},end_at.is.null`)
      .order('start_at', { ascending: false }));
    this.cache = rows;
    for (const op of this.queue) this.applyLocal(op);
    this.saveLocal();
    return this.cache;
  }

  /* --- Schlafeinträge --- */
  async listSleeps() {
    if (!this.queue.length) {
      try { await this.refreshFromServer(); } catch (e) { if (!isNetworkError(e)) throw e; }
    } else this.flush().catch(() => {});
    return [...this.cache].sort(byStartDesc);
  }
  async addSleep(s) {
    if (!s.end_at && this.cache.some(x => !x.end_at)) throw new Error('Es läuft bereits ein Schlaf.');
    const row = { id: newId(), end_at: null, note: null, kind: null, tags: [], ...pick(s, ['id', ...SLEEP_FIELDS]) };
    await this.enqueueOrRun({ op: 'insert', row });
    return row;
  }
  async updateSleep(id, patch) { await this.enqueueOrRun({ op: 'update', id, patch: pick(patch, SLEEP_FIELDS) }); }
  async stopSleep(id, end_at) { return this.enqueueOrRun({ op: 'stop', id, patch: { end_at } }); }
  async deleteSleep(id) { await this.enqueueOrRun({ op: 'delete', id }); }
  async importSleeps(rows) {
    const starts = new Set(this.cache.map(s => s.start_at.slice(0, 16)));
    const clean = rows.filter(r => r.start_at && r.end_at && !starts.has(String(r.start_at).slice(0, 16)))
      .slice(0, 5000)
      .map(r => ({ id: newId(), family_id: this.family.id, ...pick(r, SLEEP_FIELDS), tags: Array.isArray(r.tags) ? r.tags : [] }));
    for (let i = 0; i < clean.length; i += 500) this.check(await this.sb.from('sleeps').insert(clean.slice(i, i + 500)));
    await this.refreshFromServer(); this.emit();
    return clean.length;
  }

  /* --- Push-Abos (eins pro Gerät) --- */
  async getPush(endpoint) {
    return this.check(await this.sb.from('push_subscriptions').select('*').eq('endpoint', endpoint).maybeSingle());
  }
  async savePush(sub, prefs) {
    const j = sub.toJSON();
    return this.check(await this.sb.rpc('save_push_subscription', {
      p_family_id: this.family.id, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
      p_remind: prefs.remind, p_lead_min: prefs.lead_min, p_partner: prefs.partner,
      p_quiet: prefs.quiet, p_quiet_start: prefs.quiet_start, p_quiet_end: prefs.quiet_end,
    }));
  }
  async deletePush(endpoint) {
    this.check(await this.sb.from('push_subscriptions').delete().eq('endpoint', endpoint));
  }
}

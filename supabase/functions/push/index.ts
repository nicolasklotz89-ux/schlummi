// Schlummi – Push-Benachrichtigungen (Supabase Edge Function, verify_jwt = false, geschützt per x-cron-secret)
// type "tick":  jede Minute per pg_cron – sanfte Erinnerung vor dem nächsten Schlaf
// type "sleep": per Trigger – Meldung an die anderen Familienmitglieder bei Einschlafen/Aufwachen (mit Nachtruhe)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { planDay, safeTz, localHour } from "./sleepdata.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Sub = {
  id: string; user_id: string; family_id: string; endpoint: string; p256dh: string; auth: string; tz: string;
  remind: boolean; lead_min: number; partner: boolean; quiet: boolean; quiet_start: string; quiet_end: string;
};

let cfg: Record<string, string> | null = null;
let cfgAt = 0;
async function config() {
  if (cfg && Date.now() - cfgAt < 10 * 60e3) return cfg;
  const { data, error } = await db.rpc("get_push_config");
  if (error) throw error;
  cfg = Object.fromEntries((data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  cfgAt = Date.now();
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  return cfg;
}

function sameSecret(a: string | null, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: safeTz(tz) || "Europe/Berlin" }).format(d);
const dur = (min: number) => {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
const hours = (t: string) => { const [h, m] = String(t).split(":").map(Number); return h + (m || 0) / 60; };
function inQuiet(sub: Sub, now: Date) {
  if (!sub.quiet) return false;
  const h = localHour(now, safeTz(sub.tz) || "Europe/Berlin");
  const s = hours(sub.quiet_start || "20:00"), e = hours(sub.quiet_end || "07:00");
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

async function send(sub: Sub, payload: Record<string, string>) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 900, urgency: "normal", timeout: 5000 },
    );
    return true;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", sub.id);
    else console.error("push failed", sub.id, code, (e as Error).message);
    return false;
  }
}

// begrenzte Parallelität
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const x = queue.shift()!;
      try { await fn(x); } catch (e) { console.error("item failed", e); }
    }
  }));
}

async function onSleep(body: { event: "start" | "stop"; sleep_id: string; actor: string | null }) {
  const { data: s } = await db.from("sleeps").select("id, family_id, start_at, end_at, families(child_name)")
    .eq("id", body.sleep_id).maybeSingle();
  if (!s) return 0;
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("family_id", s.family_id).eq("partner", true);
  // deno-lint-ignore no-explicit-any
  const name = (s as any).families?.child_name ?? "Euer Kind";
  const start = new Date(s.start_at);
  const now = new Date();
  let sent = 0;
  await pool((subs ?? []) as Sub[], 10, async (sub) => {
    if (body.actor && sub.user_id === body.actor) return;
    if (inQuiet(sub, now)) return;
    const payload = body.event === "start"
      ? { title: `${name} schläft 🌙`, body: `Eingeschlafen um ${fmt(start, sub.tz)}`, tag: "status" }
      : {
        title: `${name} ist wach ☀️`,
        body: `${dur((new Date(s.end_at!).getTime() - start.getTime()) / 6e4)} geschlafen (${fmt(start, sub.tz)} – ${fmt(new Date(s.end_at!), sub.tz)})`,
        tag: "status",
      };
    if (await send(sub, payload)) sent++;
  });
  return sent;
}

async function onTick() {
  const now = new Date();
  const { data, error } = await db.rpc("reminder_candidates");
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const families = (data ?? []) as { family: any; subs: Sub[] | null; sleeps: any[] | null }[];
  let sent = 0;
  await pool(families, 10, async ({ family, subs, sleeps }) => {
    if (!subs?.length || !sleeps?.length) return;
    for (const sub of subs) {
      try {
        const plan = planDay(family, sleeps, now, sub.tz);
        if (plan.kind !== "nap" && plan.kind !== "bedtime") continue;
        const n = plan.next;
        if (now >= n.to) continue;
        if (now < new Date(n.from.getTime() - sub.lead_min * 6e4)) continue;
        const { data: ins } = await db.from("push_log")
          .upsert({ subscription_id: sub.id, sleep_id: plan.last.id, kind: "remind" },
            { onConflict: "subscription_id,sleep_id,kind", ignoreDuplicates: true })
          .select();
        if (!ins?.length) continue; // schon erinnert
        const payload = n.type === "bedtime"
          ? { title: `Bald Schlafenszeit für ${family.child_name}`, body: `Etwa ${fmt(n.from, sub.tz)} – ${fmt(n.to, sub.tz)} · achte auf Müdigkeitszeichen`, tag: "remind" }
          : { title: `Bald Zeit für ein Schläfchen?`, body: `${family.child_name} ist seit ${fmt(plan.lastEnd, sub.tz)} wach · etwa ${fmt(n.from, sub.tz)} – ${fmt(n.to, sub.tz)}`, tag: "remind" };
        if (await send(sub, payload)) sent++;
        else await db.from("push_log").delete().match({ subscription_id: sub.id, sleep_id: plan.last.id, kind: "remind" }); // nächster Versuch
      } catch (e) {
        console.error("sub failed", sub.id, e);
      }
    }
  });
  return sent;
}

Deno.serve(async (req) => {
  let c: Record<string, string>;
  try { c = await config(); } catch (e) { console.error("config", e); return Response.json({ ok: false }, { status: 500 }); }
  if (!sameSecret(req.headers.get("x-cron-secret"), c.cron_secret)) return new Response("unauthorized", { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const sent = body.type === "sleep" ? await onSleep(body) : await onTick();
    return Response.json({ ok: true, sent });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false }, { status: 500 });
  }
});

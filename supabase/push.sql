-- Schlummi: Push-Benachrichtigungen (nach schema.sql ausführen)
-- Platzhalter __VAPID_PUBLIC__, __VAPID_PRIVATE__, __CRON_SECRET__, __PROJECT_REF__ werden beim Einrichten ersetzt.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  family_id uuid not null references public.families(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  tz text not null default 'Europe/Berlin',
  remind boolean not null default true,
  lead_min int not null default 10 check (lead_min between 0 and 60),
  partner boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_family_idx on public.push_subscriptions(family_id);
create index if not exists push_subs_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_own_select" on public.push_subscriptions;
create policy "push_own_select" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "push_own_delete" on public.push_subscriptions;
create policy "push_own_delete" on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- Protokoll gesendeter Erinnerungen (nur Service-Role, keine Policies)
create table if not exists public.push_log (
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  sleep_id uuid not null references public.sleeps(id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (subscription_id, sleep_id, kind)
);
create index if not exists push_log_sleep_idx on public.push_log(sleep_id);
alter table public.push_log enable row level security;

-- Abo speichern/aktualisieren (ein Gerät = ein Endpoint)
create or replace function public.save_push_subscription(
  p_family_id uuid, p_endpoint text, p_p256dh text, p_auth text, p_tz text,
  p_remind boolean, p_lead_min int, p_partner boolean)
returns public.push_subscriptions language plpgsql security definer set search_path = '' as $$
declare r public.push_subscriptions;
begin
  if not public.is_family_member(p_family_id) then raise exception 'Keine Berechtigung'; end if;
  insert into public.push_subscriptions as s (user_id, family_id, endpoint, p256dh, auth, tz, remind, lead_min, partner)
  values (auth.uid(), p_family_id, p_endpoint, p_p256dh, p_auth, coalesce(p_tz, 'Europe/Berlin'), p_remind, p_lead_min, p_partner)
  on conflict (endpoint) do update set
    user_id = excluded.user_id, family_id = excluded.family_id, p256dh = excluded.p256dh, auth = excluded.auth,
    tz = excluded.tz, remind = excluded.remind, lead_min = excluded.lead_min, partner = excluded.partner
  returning * into r;
  return r;
end $$;
revoke execute on function public.save_push_subscription(uuid, text, text, text, text, boolean, int, boolean) from public, anon;
grant execute on function public.save_push_subscription(uuid, text, text, text, text, boolean, int, boolean) to authenticated;

-- Geheime Einstellungen (VAPID-Schlüssel, Cron-Secret) – für Clients unsichtbar
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_config (key text primary key, value text not null);
insert into private.app_config (key, value) values
  ('vapid_public', '__VAPID_PUBLIC__'),
  ('vapid_private', '__VAPID_PRIVATE__'),
  ('vapid_subject', 'mailto:schlummi@example.com'),
  ('cron_secret', '__CRON_SECRET__'),
  ('push_url', 'https://__PROJECT_REF__.supabase.co/functions/v1/push')
on conflict (key) do update set value = excluded.value;

create or replace function public.get_push_config() returns table (key text, value text)
language sql stable security definer set search_path = '' as $$
  select key, value from private.app_config;
$$;
revoke execute on function public.get_push_config() from public, anon, authenticated;
grant execute on function public.get_push_config() to service_role;

-- Sofortmeldung bei Einschlafen/Aufwachen
create or replace function private.notify_sleep_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare evt text;
begin
  if tg_op = 'INSERT' and new.end_at is null then evt := 'start';
  elsif tg_op = 'UPDATE' and old.end_at is null and new.end_at is not null then evt := 'stop';
  else return new;
  end if;
  perform net.http_post(
    url := (select value from private.app_config where key = 'push_url'),
    body := jsonb_build_object('type', 'sleep', 'event', evt, 'sleep_id', new.id, 'actor', auth.uid()),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from private.app_config where key = 'cron_secret'))
  );
  return new;
exception when others then
  return new; -- Push darf das Speichern nie verhindern
end $$;
drop trigger if exists sleeps_notify on public.sleeps;
create trigger sleeps_notify after insert or update of end_at on public.sleeps
  for each row execute function private.notify_sleep_change();

-- Erinnerungen: jede Minute prüfen
select cron.unschedule(jobid) from cron.job where jobname = 'schlummi-tick';
select cron.schedule('schlummi-tick', '* * * * *', $cron$
  select net.http_post(
    url := (select value from private.app_config where key = 'push_url'),
    body := '{"type":"tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from private.app_config where key = 'cron_secret'))
  );
$cron$);

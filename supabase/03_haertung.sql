-- Schlummi: Härtung und Erweiterung (nach schema.sql und push.sql ausführen)
-- Einladungscode 50 Bit + Ablauf + Rate-Limit, Rollen, Mitglieder verwalten, Löschen,
-- Spaltenrechte, Push-Validierung, Ruhezeiten, Tags/Art, Geburtstermin.

-- ===== Spalten =====
alter table public.families
  add column if not exists due_date date,
  add column if not exists invite_expires_at timestamptz not null default now() + interval '7 days';
alter table public.families drop constraint if exists families_due_date_check;
alter table public.families add constraint families_due_date_check
  check (due_date is null or (due_date between birthdate - 30 and birthdate + 140));
alter table public.families drop constraint if exists families_birthdate_check;
alter table public.families add constraint families_birthdate_check check (birthdate >= date '2000-01-01');
create or replace function private.check_family() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.birthdate > current_date + 1 then raise exception 'Das Geburtsdatum liegt in der Zukunft.'; end if;
  return new;
end $$;
drop trigger if exists families_check on public.families;
create trigger families_check before insert or update of birthdate on public.families
  for each row execute function private.check_family();

alter table public.family_members
  add column if not exists role text not null default 'member' check (role in ('owner', 'member'));

alter table public.sleeps
  add column if not exists kind text check (kind in ('night', 'nap')),
  add column if not exists tags text[] not null default '{}';
alter table public.sleeps drop constraint if exists sleeps_tags_check;
alter table public.sleeps add constraint sleeps_tags_check
  check (cardinality(tags) <= 8 and array_to_string(tags, '') ~ '^[a-z_]*$');
alter table public.sleeps drop constraint if exists sleeps_max_len;
alter table public.sleeps add constraint sleeps_max_len
  check (end_at is null or end_at - start_at <= interval '36 hours');
alter table public.sleeps drop constraint if exists sleeps_start_sane;
alter table public.sleeps add constraint sleeps_start_sane check (start_at > timestamptz '2000-01-01');

alter table public.push_subscriptions
  add column if not exists quiet boolean not null default true,
  add column if not exists quiet_start time not null default '20:00',
  add column if not exists quiet_end time not null default '07:00';
alter table public.push_subscriptions drop constraint if exists push_tz_len;
alter table public.push_subscriptions add constraint push_tz_len check (char_length(tz) <= 64);

-- ===== Einladungscode: 10 Zeichen Crockford-Base32 (~50 Bit), 7 Tage gültig =====
create or replace function private.new_invite_code() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (get_byte(b, i) % 32) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(10) as b) x, generate_series(0, 9) i;
$$;
alter table public.families alter column invite_code set default private.new_invite_code();
update public.families set invite_code = private.new_invite_code(), invite_expires_at = now() + interval '7 days'
  where char_length(invite_code) < 10;

create table if not exists private.join_attempts (
  user_id uuid not null, at timestamptz not null default now()
);
create index if not exists join_attempts_user_at on private.join_attempts (user_id, at);

-- ===== Familie anlegen / beitreten (eine Familie pro Konto) =====
create or replace function public.create_family(p_child_name text, p_birthdate date)
returns public.families language plpgsql security definer set search_path = '' as $$
declare f public.families;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.family_members where user_id = auth.uid()) then
    raise exception 'Du gehörst schon zu einer Familie.';
  end if;
  insert into public.families (child_name, birthdate) values (trim(p_child_name), p_birthdate) returning * into f;
  insert into public.family_members (family_id, user_id, role) values (f.id, auth.uid(), 'owner');
  return f;
end $$;

create or replace function public.join_family(p_code text)
returns public.families language plpgsql security definer set search_path = '' as $$
declare f public.families; n int; code text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select count(*) into n from private.join_attempts where user_id = auth.uid() and at > now() - interval '1 hour';
  if n >= 10 then raise exception 'Zu viele Versuche – bitte in einer Stunde erneut probieren.'; end if;
  insert into private.join_attempts (user_id) values (auth.uid());
  delete from private.join_attempts where at < now() - interval '1 day';

  if exists (select 1 from public.family_members where user_id = auth.uid()) then
    raise exception 'Du gehörst schon zu einer Familie.';
  end if;
  code := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  code := translate(code, 'OIL', '011');
  select * into f from public.families where invite_code = code and invite_expires_at > now();
  -- kein raise: sonst würde der Fehlversuch mit zurückgerollt und das Rate-Limit wirkungslos
  if f.id is null then return null; end if;

  insert into public.family_members (family_id, user_id, role) values (f.id, auth.uid(), 'member')
    on conflict do nothing;
  update public.families set invite_code = private.new_invite_code(), invite_expires_at = now() + interval '7 days'
    where id = f.id returning * into f;
  return f;
end $$;

create or replace function public.rotate_invite_code()
returns public.families language plpgsql security definer set search_path = '' as $$
declare f public.families; fid uuid;
begin
  select family_id into fid from public.family_members where user_id = auth.uid() limit 1;
  if fid is null then raise exception 'Keine Familie'; end if;
  update public.families set invite_code = private.new_invite_code(), invite_expires_at = now() + interval '7 days'
    where id = fid returning * into f;
  return f;
end $$;

-- ===== Mitglieder =====
create or replace function public.list_family_members()
returns table (user_id uuid, email text, role text, joined_at timestamptz, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, m.role, m.created_at, m.user_id = auth.uid()
  from public.family_members m join auth.users u on u.id = m.user_id
  where m.family_id = (select family_id from public.family_members where user_id = auth.uid() limit 1)
  order by m.created_at;
$$;

-- Mitglied entfernen (nur Verwalter:in) oder selbst austreten; letzte Person → Familie wird gelöscht
create or replace function public.remove_family_member(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare fid uuid; my_role text; target_role text;
begin
  select family_id, role into fid, my_role from public.family_members where user_id = auth.uid() limit 1;
  if fid is null then raise exception 'Keine Familie'; end if;
  select role into target_role from public.family_members where family_id = fid and user_id = p_user;
  if target_role is null then raise exception 'Mitglied nicht gefunden'; end if;
  if p_user <> auth.uid() and my_role <> 'owner' then raise exception 'Nur die Verwaltung kann Mitglieder entfernen.'; end if;

  delete from public.family_members where family_id = fid and user_id = p_user;
  delete from public.push_subscriptions where family_id = fid and user_id = p_user;
  if not exists (select 1 from public.family_members where family_id = fid) then
    delete from public.families where id = fid;
    return;
  end if;
  if target_role = 'owner' and not exists (select 1 from public.family_members where family_id = fid and role = 'owner') then
    update public.family_members set role = 'owner'
      where family_id = fid and user_id = (select user_id from public.family_members where family_id = fid order by created_at limit 1);
  end if;
  update public.families set invite_code = private.new_invite_code(), invite_expires_at = now() + interval '7 days' where id = fid;
end $$;

-- Ganze Familie mit allen Daten löschen (nur Verwalter:in)
create or replace function public.delete_family()
returns void language plpgsql security definer set search_path = '' as $$
declare fid uuid;
begin
  select family_id into fid from public.family_members where user_id = auth.uid() and role = 'owner' limit 1;
  if fid is null then raise exception 'Nur die Verwaltung kann die Familie löschen.'; end if;
  delete from public.families where id = fid;
end $$;

-- Eigenes Konto löschen (DSGVO Art. 17)
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  for fid in select family_id from public.family_members where user_id = auth.uid() loop
    perform public.remove_family_member(auth.uid());
  end loop;
  delete from public.push_subscriptions where user_id = auth.uid();
  delete from private.join_attempts where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end $$;

-- ===== Push-Abo: Validierung, Limit, kein Kapern fremder Abos =====
drop function if exists public.save_push_subscription(uuid, text, text, text, text, boolean, int, boolean);
create or replace function public.save_push_subscription(
  p_family_id uuid, p_endpoint text, p_p256dh text, p_auth text, p_tz text,
  p_remind boolean, p_lead_min int, p_partner boolean,
  p_quiet boolean default true, p_quiet_start time default '20:00', p_quiet_end time default '07:00')
returns public.push_subscriptions language plpgsql security definer set search_path = '' as $$
declare r public.push_subscriptions; tz text := p_tz;
begin
  if not public.is_family_member(p_family_id) then raise exception 'Keine Berechtigung'; end if;
  if tz is null or char_length(tz) > 64 or not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then
    tz := 'Europe/Berlin';
  end if;
  if p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or char_length(p_endpoint) > 1000 or char_length(p_p256dh) > 200 or char_length(p_auth) > 100 then
    raise exception 'Ungültiges Push-Abo';
  end if;
  if p_lead_min is null or p_lead_min not between 0 and 60 then raise exception 'Ungültiger Vorlauf'; end if;
  if (select count(*) from public.push_subscriptions where user_id = auth.uid() and endpoint <> p_endpoint) >= 5 then
    raise exception 'Höchstens 5 Geräte pro Konto';
  end if;

  insert into public.push_subscriptions as s
    (user_id, family_id, endpoint, p256dh, auth, tz, remind, lead_min, partner, quiet, quiet_start, quiet_end)
  values (auth.uid(), p_family_id, p_endpoint, p_p256dh, p_auth, tz, p_remind, p_lead_min, p_partner,
          coalesce(p_quiet, true), coalesce(p_quiet_start, '20:00'), coalesce(p_quiet_end, '07:00'))
  on conflict (endpoint) do update set
    user_id = excluded.user_id, family_id = excluded.family_id, p256dh = excluded.p256dh, auth = excluded.auth,
    tz = excluded.tz, remind = excluded.remind, lead_min = excluded.lead_min, partner = excluded.partner,
    quiet = excluded.quiet, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end
  -- nur das eigene Abo oder bei Besitznachweis (gleiche Geräteschlüssel) übernehmen
  where s.user_id = auth.uid() or (s.p256dh = excluded.p256dh and s.auth = excluded.auth)
  returning * into r;
  if r.id is null then raise exception 'Dieses Gerät ist mit einem anderen Konto verknüpft.'; end if;
  return r;
end $$;

-- ===== Kandidaten für Erinnerungen (eine Abfrage statt N+1, nur für die Push-Funktion) =====
create or replace function public.reminder_candidates()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'family', to_jsonb(f) - 'invite_code' - 'invite_expires_at',
    'subs', (select jsonb_agg(to_jsonb(s)) from public.push_subscriptions s where s.family_id = f.id and s.remind),
    'sleeps', (select jsonb_agg(jsonb_build_object('id', z.id, 'start_at', z.start_at, 'end_at', z.end_at, 'kind', z.kind))
               from public.sleeps z where z.family_id = f.id and z.start_at > now() - interval '15 days')
  )), '[]'::jsonb)
  from public.families f
  where exists (select 1 from public.push_subscriptions s where s.family_id = f.id and s.remind)
    and not exists (select 1 from public.sleeps z where z.family_id = f.id and z.end_at is null)
    and exists (select 1 from public.sleeps z where z.family_id = f.id and z.end_at > now() - interval '16 hours');
$$;

-- ===== created_by / created_at erzwingen =====
create or replace function private.force_sleep_meta() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists sleeps_force_meta on public.sleeps;
create trigger sleeps_force_meta before insert on public.sleeps
  for each row execute function private.force_sleep_meta();

-- ===== Rechte =====
revoke all on all tables in schema public from anon;
revoke update on public.families from authenticated;
grant update (child_name, birthdate, due_date, naps_per_day, bedtime, waketime, wake_window) on public.families to authenticated;
revoke insert, update on public.sleeps from authenticated;
grant insert (id, family_id, start_at, end_at, note, kind, tags) on public.sleeps to authenticated;
grant update (start_at, end_at, note, kind, tags) on public.sleeps to authenticated;
revoke insert, update on public.push_subscriptions from authenticated;
revoke insert, update, delete on public.family_members from authenticated;
alter table private.app_config enable row level security;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.create_family(text, date)', 'public.join_family(text)', 'public.rotate_invite_code()',
    'public.list_family_members()', 'public.remove_family_member(uuid)', 'public.delete_family()',
    'public.delete_my_account()',
    'public.save_push_subscription(uuid, text, text, text, text, boolean, int, boolean, boolean, time, time)']
  loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
revoke execute on function public.reminder_candidates() from public, anon, authenticated;
grant execute on function public.reminder_candidates() to service_role;

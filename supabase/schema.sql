-- Schlummi: Familien, Mitglieder, Schlafeinträge – mit Row Level Security.

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  child_name text not null check (char_length(child_name) between 1 and 60),
  birthdate date not null,
  invite_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index if not exists family_members_user_idx on public.family_members(user_id);

create table if not exists public.sleeps (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz,
  note text check (char_length(note) <= 200),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleeps_end_after_start check (end_at is null or end_at > start_at)
);
create index if not exists sleeps_family_start_idx on public.sleeps(family_id, start_at desc);
create index if not exists sleeps_created_by_idx on public.sleeps(created_by);
-- höchstens ein laufender Schlaf pro Familie
create unique index if not exists sleeps_one_running on public.sleeps(family_id) where end_at is null;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists sleeps_touch on public.sleeps;
create trigger sleeps_touch before update on public.sleeps
  for each row execute function public.touch_updated_at();

-- Mitgliedschaft prüfen (security definer, damit RLS nicht rekursiv wird)
create or replace function public.is_family_member(fid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members
                 where family_id = fid and user_id = (select auth.uid()));
$$;

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.sleeps enable row level security;

drop policy if exists "families_select" on public.families;
create policy "families_select" on public.families for select to authenticated
  using ((select public.is_family_member(id)));
drop policy if exists "families_update" on public.families;
create policy "families_update" on public.families for update to authenticated
  using ((select public.is_family_member(id))) with check ((select public.is_family_member(id)));

drop policy if exists "members_select" on public.family_members;
create policy "members_select" on public.family_members for select to authenticated
  using ((select public.is_family_member(family_id)));

drop policy if exists "sleeps_all" on public.sleeps;
create policy "sleeps_all" on public.sleeps for all to authenticated
  using ((select public.is_family_member(family_id)))
  with check ((select public.is_family_member(family_id)));

-- Familie anlegen (legt den Ersteller als Mitglied an)
create or replace function public.create_family(p_child_name text, p_birthdate date)
returns public.families language plpgsql security definer set search_path = '' as $$
declare f public.families;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  insert into public.families (child_name, birthdate) values (trim(p_child_name), p_birthdate) returning * into f;
  insert into public.family_members (family_id, user_id) values (f.id, auth.uid());
  return f;
end $$;

-- Mit Einladungscode beitreten
create or replace function public.join_family(p_code text)
returns public.families language plpgsql security definer set search_path = '' as $$
declare f public.families;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select * into f from public.families where invite_code = upper(trim(p_code));
  if f.id is null then raise exception 'Einladungscode nicht gefunden'; end if;
  insert into public.family_members (family_id, user_id) values (f.id, auth.uid())
    on conflict do nothing;
  return f;
end $$;

revoke execute on function public.create_family(text, date) from public, anon;
revoke execute on function public.join_family(text) from public, anon;
revoke execute on function public.is_family_member(uuid) from public, anon;
grant execute on function public.create_family(text, date) to authenticated;
grant execute on function public.join_family(text) to authenticated;
grant execute on function public.is_family_member(uuid) to authenticated;

-- Live-Sync
do $$ begin
  alter publication supabase_realtime add table public.sleeps;
exception when duplicate_object then null; end $$;

-- Schlummi: Einschlafdauer pro Familie (Minuten vom Hinlegen bis zum Einschlafen)
alter table public.families add column if not exists settle_min smallint not null default 15
  check (settle_min between 0 and 60);
grant update (settle_min) on public.families to authenticated;

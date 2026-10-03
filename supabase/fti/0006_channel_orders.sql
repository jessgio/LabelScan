-- FTI only. Do not apply this to the Aeris label-scan project.
-- Shopee and TikTok exports accumulate. The same order in a newer file
-- replaces the older ship-by time. Lazada is reserved and not counted yet.

create table if not exists public.channel_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  channel text not null check (channel in ('shopee', 'tiktok', 'lazada')),
  filename text not null check (char_length(filename) between 1 and 300),
  row_count integer not null check (row_count >= 0),
  uploaded_at timestamptz not null default now()
);

create table if not exists public.channel_orders (
  file_id uuid not null references public.channel_files (id) on delete cascade,
  channel text not null check (channel in ('shopee', 'tiktok', 'lazada')),
  order_key text not null check (char_length(order_key) between 1 and 200),
  resi_key text check (resi_key is null or char_length(resi_key) between 1 and 200),
  due_at timestamptz not null,
  uploaded_at timestamptz not null,
  primary key (file_id, order_key)
);

create index if not exists channel_orders_latest_idx
  on public.channel_orders (channel, order_key, uploaded_at desc);

create index if not exists channel_orders_due_idx
  on public.channel_orders (due_at);

create index if not exists channel_files_uploaded_idx
  on public.channel_files (uploaded_at desc);

alter table public.channel_files enable row level security;
alter table public.channel_files force row level security;
alter table public.channel_orders enable row level security;
alter table public.channel_orders force row level security;

revoke all on public.channel_files from public, anon;
revoke all on public.channel_orders from public, anon;
grant select, delete on public.channel_files to authenticated, service_role;
grant select on public.channel_orders to authenticated, service_role;

drop policy if exists "Company members can read channel files" on public.channel_files;
drop policy if exists "Company members can delete channel files" on public.channel_files;
drop policy if exists "Company members can read channel orders" on public.channel_orders;

create policy "Company members can read channel files"
  on public.channel_files for select to authenticated
  using ((select private.can_use_picklists()));

create policy "Company members can delete channel files"
  on public.channel_files for delete to authenticated
  using ((select private.can_use_picklists()));

create policy "Company members can read channel orders"
  on public.channel_orders for select to authenticated
  using ((select private.can_use_picklists()));

create or replace function private.add_channel_orders(
  p_channel text,
  p_filename text,
  p_orders jsonb
)
returns table (id uuid, row_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := pg_catalog.gen_random_uuid();
  v_at timestamptz := pg_catalog.clock_timestamp();
  v_name text;
  v_count integer := 0;
begin
  if not private.can_use_picklists() then
    raise exception 'Not allowed';
  end if;
  if p_channel not in ('shopee', 'tiktok') then
    raise exception 'This channel is not counted yet';
  end if;
  if pg_catalog.jsonb_typeof(p_orders) is distinct from 'array' then
    raise exception 'Channel orders must be a list';
  end if;
  if pg_catalog.jsonb_array_length(p_orders) > 20000 then
    raise exception 'This export has too many orders';
  end if;

  v_name := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_filename, '')), '^.*[/\\]', '');
  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 300 then
    raise exception 'Invalid file name';
  end if;

  insert into public.channel_files (id, user_id, channel, filename, row_count, uploaded_at)
  values (v_id, auth.uid(), p_channel, v_name, 0, v_at);

  insert into public.channel_orders (file_id, channel, order_key, resi_key, due_at, uploaded_at)
  select
    v_id,
    p_channel,
    deduped.order_key,
    deduped.resi_key,
    deduped.due_at,
    v_at
  from (
    select distinct on (raw.order_key)
      raw.order_key,
      case
        when raw.resi_key is null then null
        when pg_catalog.char_length(raw.resi_key) between 6 and 200
          and raw.resi_key !~ '\s'
          and raw.resi_key ~ '\d'
        then raw.resi_key
        else null
      end as resi_key,
      raw.due_at
    from (
      select
        pg_catalog.upper(pg_catalog.btrim(e.elem ->> 'order_number')) as order_key,
        nullif(pg_catalog.upper(pg_catalog.btrim(e.elem ->> 'resi')), '') as resi_key,
        (e.elem ->> 'due_at')::timestamptz as due_at,
        e.ord
      from pg_catalog.jsonb_array_elements(p_orders) with ordinality as e(elem, ord)
    ) raw
    where pg_catalog.char_length(raw.order_key) between 6 and 200
      and raw.order_key !~ '\s'
      and raw.order_key ~ '\d'
      and raw.due_at is not null
    order by raw.order_key, raw.ord desc
  ) deduped;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'No orders with a ship-by time were found';
  end if;

  update public.channel_files
  set row_count = v_count
  where channel_files.id = v_id;

  return query select v_id, v_count;
end;
$$;

revoke all on function private.add_channel_orders(text, text, jsonb) from public, anon;
grant execute on function private.add_channel_orders(text, text, jsonb) to authenticated, service_role;

create or replace function public.add_channel_orders(
  p_channel text,
  p_filename text,
  p_orders jsonb
)
returns table (id uuid, row_count integer)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.add_channel_orders(p_channel, p_filename, p_orders);
$$;

revoke all on function public.add_channel_orders(text, text, jsonb) from public, anon;
grant execute on function public.add_channel_orders(text, text, jsonb) to authenticated, service_role;

-- Due orders are those whose ship-by time falls in the selected warehouse range.
-- A scan of the resi, the order number, or the Jubelio-cleaned order body fulfills it.
-- Other day counts orders scanned in the range whose ship-by time is outside it.
create or replace function public.get_channel_progress(
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  due_orders bigint,
  scanned_orders bigint,
  remaining_orders bigint,
  other_day_orders bigint,
  overdue_orders bigint,
  shopee_due bigint,
  shopee_scanned bigint,
  tiktok_due bigint,
  tiktok_scanned bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (o.channel, o.order_key)
      o.channel,
      o.order_key,
      o.resi_key,
      o.due_at
    from public.channel_orders o
    order by o.channel, o.order_key, o.uploaded_at desc
  ),
  all_keys as (
    select distinct pg_catalog.upper(pg_catalog.btrim(s.label)) as key
    from public.scans s
    where pg_catalog.btrim(coalesce(s.label, '')) <> ''
  ),
  all_bodies as (
    select distinct coalesce(
      private.order_body(s.label),
      case
        when pg_catalog.char_length(pg_catalog.upper(pg_catalog.btrim(s.label))) >= 8
        then pg_catalog.upper(pg_catalog.btrim(s.label))
      end
    ) as body
    from public.scans s
    where pg_catalog.btrim(coalesce(s.label, '')) <> ''
  ),
  range_keys as (
    select distinct pg_catalog.upper(pg_catalog.btrim(s.label)) as key
    from public.scans s
    where p_start is not null
      and p_end is not null
      and s.scanned_at >= p_start
      and s.scanned_at <= p_end
      and pg_catalog.btrim(coalesce(s.label, '')) <> ''
  ),
  range_bodies as (
    select distinct coalesce(
      private.order_body(s.label),
      case
        when pg_catalog.char_length(pg_catalog.upper(pg_catalog.btrim(s.label))) >= 8
        then pg_catalog.upper(pg_catalog.btrim(s.label))
      end
    ) as body
    from public.scans s
    where p_start is not null
      and p_end is not null
      and s.scanned_at >= p_start
      and s.scanned_at <= p_end
      and pg_catalog.btrim(coalesce(s.label, '')) <> ''
  ),
  flagged as (
    select
      l.channel,
      l.order_key,
      l.due_at,
      (
        l.order_key in (select all_keys.key from all_keys)
        or (
          l.resi_key is not null
          and l.resi_key in (select all_keys.key from all_keys)
        )
        or l.order_key in (select all_bodies.body from all_bodies where body is not null)
      ) as scanned,
      (
        l.order_key in (select range_keys.key from range_keys)
        or (
          l.resi_key is not null
          and l.resi_key in (select range_keys.key from range_keys)
        )
        or l.order_key in (select range_bodies.body from range_bodies where body is not null)
      ) as scanned_in_range,
      (
        p_start is not null
        and p_end is not null
        and l.due_at >= p_start
        and l.due_at <= p_end
      ) as due_in_range
    from latest l
  )
  select
    count(*) filter (where flagged.due_in_range)::bigint,
    count(*) filter (where flagged.due_in_range and flagged.scanned)::bigint,
    count(*) filter (where flagged.due_in_range and not flagged.scanned)::bigint,
    count(*) filter (where flagged.scanned_in_range and not flagged.due_in_range)::bigint,
    count(*) filter (where flagged.due_at < p_start and not flagged.scanned)::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'shopee')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.scanned and flagged.channel = 'shopee')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'tiktok')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.scanned and flagged.channel = 'tiktok')::bigint
  from flagged;
$$;

revoke all on function public.get_channel_progress(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_channel_progress(timestamptz, timestamptz)
  to authenticated, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'channel_files'
  ) then
    alter publication supabase_realtime add table public.channel_files;
  end if;
end $$;

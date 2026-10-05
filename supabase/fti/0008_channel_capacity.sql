-- FTI only. Do not apply this to the Aeris label-scan project.
-- Files accumulate. The newest copy of an order number wins, and an order
-- that drops out of a later To Ship export stays from the earlier file.
-- Instant and same-day are stored on the order. Lazada uses Promised Shipping Time.

alter table public.channel_orders
  add column if not exists shipping_speed text not null default 'regular';

alter table public.channel_orders
  drop constraint if exists channel_orders_shipping_speed_check;

alter table public.channel_orders
  add constraint channel_orders_shipping_speed_check
  check (shipping_speed in ('instant', 'regular'));

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
  if p_channel not in ('shopee', 'tiktok', 'lazada') then
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

  insert into public.channel_orders (
    file_id, channel, order_key, resi_key, due_at, shipping_speed, uploaded_at
  )
  select
    v_id,
    p_channel,
    deduped.order_key,
    deduped.resi_key,
    deduped.due_at,
    deduped.shipping_speed,
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
      raw.due_at,
      raw.shipping_speed
    from (
      select
        pg_catalog.upper(pg_catalog.btrim(e.elem ->> 'order_number')) as order_key,
        nullif(pg_catalog.upper(pg_catalog.btrim(e.elem ->> 'resi')), '') as resi_key,
        (e.elem ->> 'due_at')::timestamptz as due_at,
        case
          when pg_catalog.lower(pg_catalog.btrim(coalesce(e.elem ->> 'shipping_speed', ''))) = 'instant'
          then 'instant'
          else 'regular'
        end as shipping_speed,
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

drop function if exists public.get_channel_progress(timestamptz, timestamptz);

create function public.get_channel_progress(
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
  tiktok_scanned bigint,
  tokopedia_scanned bigint,
  lazada_due bigint,
  lazada_scanned bigint,
  shopee_instant bigint,
  shopee_regular bigint,
  tiktok_instant bigint,
  tiktok_regular bigint
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
      o.due_at,
      o.shipping_speed
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
      l.shipping_speed,
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
  ),
  tokopedia as (
    select e.order_suffix as id
    from public.picklist_entries e
    where e.order_key ~ '^TP-.+-89690$'
      and e.order_suffix is not null
      and p_start is not null
      and p_end is not null
      and (
        e.resi_key in (select range_keys.key from range_keys)
        or e.order_key in (select range_keys.key from range_keys)
        or e.order_suffix in (select range_bodies.body from range_bodies where body is not null)
      )
    union
    select private.order_body(k.key) as id
    from range_keys k
    where k.key ~ '^TP-.+-89690$'
      and private.order_body(k.key) is not null
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
    count(*) filter (where flagged.due_in_range and flagged.scanned and flagged.channel = 'tiktok')::bigint,
    (select count(*)::bigint from tokopedia),
    count(*) filter (where flagged.due_in_range and flagged.channel = 'lazada')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.scanned and flagged.channel = 'lazada')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'shopee' and flagged.shipping_speed = 'instant')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'shopee' and flagged.shipping_speed = 'regular')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'tiktok' and flagged.shipping_speed = 'instant')::bigint,
    count(*) filter (where flagged.due_in_range and flagged.channel = 'tiktok' and flagged.shipping_speed = 'regular')::bigint
  from flagged;
$$;

revoke all on function public.get_channel_progress(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_channel_progress(timestamptz, timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';

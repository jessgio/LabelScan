-- FTI only. Do not apply this to the Aeris label-scan project.
-- Jubelio order numbers identify the marketplace: SP- Shopee, TT- and TP-
-- TikTok (Tokopedia is the same upload), LZ- Lazada.

drop function if exists public.get_order_progress(timestamptz, timestamptz);

create function public.get_order_progress(
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  total_orders bigint,
  scanned_orders bigint,
  remaining_orders bigint,
  shopee_orders bigint,
  tiktok_orders bigint,
  lazada_orders bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with day_rows as (
    select e.order_key, e.resi_key, e.order_suffix
    from public.picklist_entries e
    join public.picklist_files f on f.id = e.file_id
    where p_start is not null
      and p_end is not null
      and f.uploaded_at >= p_start
      and f.uploaded_at <= p_end
  ),
  scan_keys as (
    select distinct pg_catalog.upper(pg_catalog.btrim(s.label)) as key
    from public.scans s
    where p_start is not null
      and p_end is not null
      and s.scanned_at >= p_start
      and s.scanned_at <= p_end
      and pg_catalog.btrim(coalesce(s.label, '')) <> ''
  ),
  scan_bodies as (
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
  totals as (
    select
      count(distinct d.order_key)::bigint as total_orders,
      count(distinct d.order_key) filter (
        where d.resi_key in (select scan_keys.key from scan_keys)
          or d.order_key in (select scan_keys.key from scan_keys)
          or (
            d.order_suffix is not null
            and d.order_suffix in (select scan_bodies.body from scan_bodies where body is not null)
          )
      )::bigint as scanned_orders,
      count(distinct d.order_key) filter (where d.order_key ~ '^SP-')::bigint as shopee_orders,
      count(distinct d.order_key) filter (where d.order_key ~ '^(TT|TP)-')::bigint as tiktok_orders,
      count(distinct d.order_key) filter (where d.order_key ~ '^LZ-')::bigint as lazada_orders
    from day_rows d
  )
  select
    totals.total_orders,
    totals.scanned_orders,
    case
      when totals.total_orders > totals.scanned_orders
      then totals.total_orders - totals.scanned_orders
      else 0::bigint
    end,
    totals.shopee_orders,
    totals.tiktok_orders,
    totals.lazada_orders
  from totals;
$$;

revoke all on function public.get_order_progress(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_order_progress(timestamptz, timestamptz)
  to authenticated, service_role;

create or replace function public.picklist_marketplace_counts(p_file_ids uuid[])
returns table (
  file_id uuid,
  shopee_count bigint,
  tiktok_count bigint,
  lazada_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.file_id,
    count(distinct e.order_key) filter (where e.order_key ~ '^SP-')::bigint,
    count(distinct e.order_key) filter (where e.order_key ~ '^(TT|TP)-')::bigint,
    count(distinct e.order_key) filter (where e.order_key ~ '^LZ-')::bigint
  from public.picklist_entries e
  where e.file_id = any (coalesce(p_file_ids, array[]::uuid[]))
  group by e.file_id;
$$;

revoke all on function public.picklist_marketplace_counts(uuid[]) from public, anon;
grant execute on function public.picklist_marketplace_counts(uuid[])
  to authenticated, service_role;

create or replace function public.channel_marketplace_counts()
returns table (
  shopee_orders bigint,
  tiktok_orders bigint,
  lazada_orders bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (o.channel, o.order_key)
      o.channel
    from public.channel_orders o
    order by o.channel, o.order_key, o.uploaded_at desc
  )
  select
    count(*) filter (where latest.channel = 'shopee')::bigint,
    count(*) filter (where latest.channel = 'tiktok')::bigint,
    count(*) filter (where latest.channel = 'lazada')::bigint
  from latest;
$$;

revoke all on function public.channel_marketplace_counts() from public, anon;
grant execute on function public.channel_marketplace_counts()
  to authenticated, service_role;

notify pgrst, 'reload schema';

-- FTI only. Do not apply this to the Aeris label-scan project.
-- Tokopedia has no seller export yet. Jubelio numbers are TP-…-89690.
-- Count a distinct order when that full number is scanned, or when the
-- picklist resi, full order, or cleaned body is scanned. A shared resi
-- stays in the TikTok total as well.

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
  tokopedia_scanned bigint
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
    (select count(*)::bigint from tokopedia)
  from flagged;
$$;

revoke all on function public.get_channel_progress(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_channel_progress(timestamptz, timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';

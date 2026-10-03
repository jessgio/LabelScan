-- FTI only. Do not apply this to the Aeris label-scan project.
-- Progress counts each Jubelio order number once, even when several
-- picklist files repeat it. A scan of the resi, the full order, or the
-- order body marks that order scanned.

create or replace function public.get_order_progress(
  p_start timestamptz,
  p_end timestamptz
)
returns table (total_orders bigint, scanned_orders bigint, remaining_orders bigint)
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
      )::bigint as scanned_orders
    from day_rows d
  )
  select
    totals.total_orders,
    totals.scanned_orders,
    case
      when totals.total_orders > totals.scanned_orders
      then totals.total_orders - totals.scanned_orders
      else 0::bigint
    end
  from totals;
$$;

revoke all on function public.get_order_progress(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_order_progress(timestamptz, timestamptz)
  to authenticated, service_role;

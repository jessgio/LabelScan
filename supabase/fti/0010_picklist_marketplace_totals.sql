-- FTI only. Do not apply this to the Aeris label-scan project.
-- Unique Jubelio orders still kept from every picklist. TT- and TP- are TikTok.

create or replace function public.picklist_marketplace_totals()
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
  select
    count(distinct e.order_key) filter (where e.order_key ~ '^SP-')::bigint,
    count(distinct e.order_key) filter (where e.order_key ~ '^(TT|TP)-')::bigint,
    count(distinct e.order_key) filter (where e.order_key ~ '^LZ-')::bigint
  from public.picklist_entries e;
$$;

revoke all on function public.picklist_marketplace_totals() from public, anon;
grant execute on function public.picklist_marketplace_totals()
  to authenticated, service_role;

notify pgrst, 'reload schema';

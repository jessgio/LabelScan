-- Performance + aggregation support for the scans table.
-- The table grows unbounded (a barcode is inserted on every scan), so every
-- read path must be index-backed and aggregates must run in the database.

-- Trigram search support for ILIKE '%term%'.
create extension if not exists pg_trgm;

-- Date-range filtering + ordering (the default "scans for today" view).
create index if not exists idx_scans_scanned_at on public.scans (scanned_at desc);

-- Exact-label lookups for the per-scan duplicate check.
create index if not exists idx_scans_label on public.scans (label);

-- Fast ILIKE '%term%' global search.
create index if not exists idx_scans_label_trgm on public.scans using gin (label gin_trgm_ops);

-- Single round-trip stats (total / duplicates / unique labels) for a filter.
-- When p_search is provided the date range is ignored, matching the UI behaviour.
create or replace function public.get_scan_stats(
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_search text default null
)
returns table (total bigint, duplicates bigint, unique_labels bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where is_duplicate)::bigint as duplicates,
    count(distinct label)::bigint as unique_labels
  from public.scans
  where
    (p_search is null or p_search = '' or label ilike '%' || p_search || '%')
    and (
      (p_search is not null and p_search <> '')
      or (scanned_at >= p_start and scanned_at <= p_end)
    );
$$;

grant execute on function public.get_scan_stats(timestamptz, timestamptz, text) to anon, authenticated;

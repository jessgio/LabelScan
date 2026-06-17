-- Fix historical duplicate flags, then provide a race-safe insert path.

-- First occurrence per label is unique; later scans are duplicates.
with ranked as (
  select
    id,
    row_number() over (
      partition by label
      order by scanned_at asc, id asc
    ) as rn
  from public.scans
)
update public.scans as s
set is_duplicate = (r.rn > 1)
from ranked as r
where s.id = r.id
  and s.is_duplicate is distinct from (r.rn > 1);

-- Serialize concurrent inserts per label so the duplicate check cannot race.
create or replace function public.insert_scan(p_label text)
returns table (
  id uuid,
  label text,
  scanned_at timestamptz,
  is_duplicate boolean
)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_label text;
  v_is_duplicate boolean;
begin
  v_label := trim(p_label);
  if v_label = '' then
    raise exception 'Label cannot be empty';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_label));

  select exists (
    select 1 from public.scans s where s.label = v_label
  ) into v_is_duplicate;

  return query
  insert into public.scans (label, is_duplicate)
  values (v_label, v_is_duplicate)
  returning scans.id, scans.label, scans.scanned_at, scans.is_duplicate;
end;
$$;

grant execute on function public.insert_scan(text) to authenticated;

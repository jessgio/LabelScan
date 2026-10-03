-- FTI only. Do not apply this to the Aeris label-scan project.
-- Picklists accumulate. A new upload does not remove earlier files.
-- Column C is the resi that is scanned. Column H is the order number.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table if not exists public.picklist_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  filename text not null check (char_length(filename) between 1 and 300),
  row_count integer not null check (row_count >= 0),
  uploaded_at timestamptz not null default now()
);

create table if not exists public.picklist_entries (
  file_id uuid not null references public.picklist_files (id) on delete cascade,
  resi_key text not null check (char_length(resi_key) between 1 and 200),
  order_number text not null check (char_length(order_number) between 1 and 200),
  order_key text not null check (char_length(order_key) between 1 and 200),
  order_suffix text,
  uploaded_at timestamptz not null,
  primary key (file_id, resi_key)
);

create index if not exists picklist_entries_resi_recent_idx
  on public.picklist_entries (resi_key, uploaded_at desc);

create index if not exists picklist_entries_order_recent_idx
  on public.picklist_entries (order_key, uploaded_at desc);

create index if not exists picklist_entries_suffix_recent_idx
  on public.picklist_entries (order_suffix, uploaded_at desc)
  where order_suffix is not null;

create index if not exists picklist_files_uploaded_idx
  on public.picklist_files (uploaded_at desc);

alter table public.picklist_files enable row level security;
alter table public.picklist_files force row level security;
alter table public.picklist_entries enable row level security;
alter table public.picklist_entries force row level security;

revoke all on public.picklist_files from public, anon;
revoke all on public.picklist_entries from public, anon;
grant select, delete on public.picklist_files to authenticated, service_role;
grant select on public.picklist_entries to authenticated, service_role;

create or replace function private.can_use_picklists()
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  allowed boolean;
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  if to_regprocedure('public.is_company_user()') is null then
    return true;
  end if;
  execute 'select public.is_company_user()' into allowed;
  return coalesce(allowed, false);
end;
$$;

revoke all on function private.can_use_picklists() from public, anon;
grant execute on function private.can_use_picklists() to authenticated, service_role;

drop policy if exists "Company members can read picklist files" on public.picklist_files;
drop policy if exists "Company members can delete picklist files" on public.picklist_files;
drop policy if exists "Company members can read picklist entries" on public.picklist_entries;

create policy "Company members can read picklist files"
  on public.picklist_files for select to authenticated
  using ((select private.can_use_picklists()));

create policy "Company members can delete picklist files"
  on public.picklist_files for delete to authenticated
  using ((select private.can_use_picklists()));

create policy "Company members can read picklist entries"
  on public.picklist_entries for select to authenticated
  using ((select private.can_use_picklists()));

create or replace function private.add_picklist(p_filename text, p_entries jsonb)
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
  if pg_catalog.jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Picklist rows must be a list';
  end if;
  if pg_catalog.jsonb_array_length(p_entries) > 20000 then
    raise exception 'Picklist is too large';
  end if;

  v_name := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_filename, '')), '^.*[/\\]', '');
  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 300 then
    raise exception 'Invalid file name';
  end if;

  insert into public.picklist_files (id, user_id, filename, row_count, uploaded_at)
  values (v_id, auth.uid(), v_name, 0, v_at);

  insert into public.picklist_entries (
    file_id, resi_key, order_number, order_key, order_suffix, uploaded_at
  )
  select
    v_id,
    deduped.resi_key,
    deduped.order_number,
    deduped.order_key,
    case
      when deduped.order_key ~ '^[A-Z]{1,4}-[A-Z0-9]{8,}$'
      then substring(deduped.order_key from '^[A-Z]{1,4}-(.+)$')
      else null
    end,
    v_at
  from (
    select distinct on (raw.resi_key)
      raw.resi_key,
      raw.order_number,
      upper(raw.order_number) as order_key
    from (
      select
        upper(pg_catalog.btrim(e.elem ->> 'resi')) as resi_key,
        pg_catalog.btrim(e.elem ->> 'order_number') as order_number,
        e.ord
      from pg_catalog.jsonb_array_elements(p_entries) with ordinality as e(elem, ord)
    ) raw
    where pg_catalog.char_length(raw.resi_key) between 6 and 200
      and pg_catalog.char_length(raw.order_number) between 6 and 200
      and raw.resi_key !~ '\s'
      and raw.order_number !~ '\s'
      and raw.resi_key ~ '\d'
      and raw.order_number ~ '\d'
      and raw.resi_key not in (
        'NO RESI', 'NO. RESI', 'NORESI', 'RESI',
        'NO ORDER', 'NO. ORDER', 'NOORDER', 'ORDER', 'BARANG', 'FOTO'
      )
      and upper(raw.order_number) not in (
        'NO RESI', 'NO. RESI', 'NO ORDER', 'NO. ORDER', 'BARANG', 'FOTO',
        'LOKASI/RAK', 'QTY PESAN', 'QTY AMBIL'
      )
    order by raw.resi_key, raw.ord desc
  ) deduped;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'No resi and order pairs found in columns C and H';
  end if;

  update public.picklist_files
  set row_count = v_count
  where picklist_files.id = v_id;

  return query select v_id, v_count;
end;
$$;

revoke all on function private.add_picklist(text, jsonb) from public, anon;
grant execute on function private.add_picklist(text, jsonb) to authenticated, service_role;

create or replace function public.add_picklist(p_filename text, p_entries jsonb)
returns table (id uuid, row_count integer)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.add_picklist(p_filename, p_entries);
$$;

revoke all on function public.add_picklist(text, jsonb) from public, anon;
grant execute on function public.add_picklist(text, jsonb) to authenticated, service_role;

create or replace function public.lookup_orders(p_labels text[])
returns table (label text, order_number text)
language sql
stable
security invoker
set search_path = ''
as $$
  with input as (
    select distinct pg_catalog.btrim(x) as label, upper(pg_catalog.btrim(x)) as key
    from pg_catalog.unnest(coalesce(p_labels, array[]::text[])) as t(x)
    where pg_catalog.btrim(coalesce(x, '')) <> ''
  )
  select i.label, found.order_number
  from input i
  join lateral (
    select picked.order_number
    from (
      select e.order_number, 0 as rank, e.uploaded_at
      from public.picklist_entries e
      where e.resi_key = i.key
      union all
      select e.order_number, 1, e.uploaded_at
      from public.picklist_entries e
      where e.order_key = i.key
      union all
      select e.order_number, 2, e.uploaded_at
      from public.picklist_entries e
      where pg_catalog.char_length(i.key) >= 8
        and e.order_suffix = i.key
    ) picked
    order by picked.rank, picked.uploaded_at desc
    limit 1
  ) found on true;
$$;

revoke all on function public.lookup_orders(text[]) from public, anon;
grant execute on function public.lookup_orders(text[]) to authenticated, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'picklist_files'
  ) then
    alter publication supabase_realtime add table public.picklist_files;
  end if;
end $$;

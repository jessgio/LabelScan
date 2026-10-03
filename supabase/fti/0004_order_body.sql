-- FTI only. Do not apply this to the Aeris label-scan project.
-- Instant and same-day labels barcode the marketplace order, not a resi.
-- Strip Jubelio's channel prefix and trailing shop id so that barcode can
-- match column H when column C does not.

-- Jubelio stores Shopee orders as SP-<order>, and TikTok / Tokopedia / Lazada
-- orders as TT-|TP-|LZ-<order>-<shop id>. Instant labels barcode the order
-- itself, so the body is what a scan can match when column C is a different resi.
create or replace function private.order_body(p_order text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v text;
begin
  v := pg_catalog.upper(pg_catalog.btrim(coalesce(p_order, '')));
  if v !~ '^(SP|TT|TP|LZ)-' then
    return null;
  end if;
  v := pg_catalog.regexp_replace(v, '^(SP|TT|TP|LZ)-', '');
  v := pg_catalog.regexp_replace(v, '-\d{4,6}$', '');
  if pg_catalog.char_length(v) < 8 or v !~ '\d' then
    return null;
  end if;
  return v;
end;
$$;

revoke all on function private.order_body(text) from public, anon;
grant execute on function private.order_body(text) to authenticated, service_role;

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
    private.order_body(deduped.order_number),
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
    select distinct
      pg_catalog.btrim(x) as label,
      upper(pg_catalog.btrim(x)) as key,
      coalesce(
        private.order_body(x),
        case
          when pg_catalog.char_length(upper(pg_catalog.btrim(x))) >= 8
          then upper(pg_catalog.btrim(x))
        end
      ) as body
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
      where i.body is not null
        and e.order_suffix = i.body
    ) picked
    order by picked.rank, picked.uploaded_at desc
    limit 1
  ) found on true;
$$;

revoke all on function public.lookup_orders(text[]) from public, anon;
grant execute on function public.lookup_orders(text[]) to authenticated, service_role;

update public.picklist_entries
set order_suffix = private.order_body(order_number)
where order_suffix is distinct from private.order_body(order_number);

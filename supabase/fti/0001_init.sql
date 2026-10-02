-- FTI Label Scan baseline. Apply to the fti-label-scan project only.
-- The email domain is From This Island; do not run this against Aeris.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists supabase_vault;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  label text not null check (char_length(label) between 1 and 500),
  scanned_at timestamptz not null default now(),
  is_duplicate boolean not null default false
);

create index if not exists idx_scans_recent
  on public.scans (scanned_at desc) include (id, label, is_duplicate);

create index if not exists idx_scans_label
  on public.scans (label);

create index if not exists idx_scans_user_id
  on public.scans (user_id);

create index if not exists idx_scans_label_trgm
  on public.scans using gin (label gin_trgm_ops);

alter table public.scans enable row level security;
alter table public.scans force row level security;

revoke all on public.scans from anon;
grant select, insert, update, delete on public.scans to authenticated, service_role;

create or replace function public.is_company_user()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 2))
    = 'fromthisisland.com';
$$;

revoke all on function public.is_company_user() from public, anon;
grant execute on function public.is_company_user() to authenticated, service_role;

drop policy if exists "Company members can read scans" on public.scans;
drop policy if exists "Company members can insert scans" on public.scans;
drop policy if exists "Company members can update scans" on public.scans;
drop policy if exists "Company members can delete scans" on public.scans;

create policy "Company members can read scans"
  on public.scans for select to authenticated
  using ((select public.is_company_user()));

create policy "Company members can insert scans"
  on public.scans for insert to authenticated
  with check (
    (select public.is_company_user())
    and user_id = (select auth.uid())
  );

create policy "Company members can update scans"
  on public.scans for update to authenticated
  using ((select public.is_company_user()))
  with check (
    (select public.is_company_user())
    and user_id = (select auth.uid())
  );

create policy "Company members can delete scans"
  on public.scans for delete to authenticated
  using ((select public.is_company_user()));

-- Split search vs date so the planner can use the trigram or time index.
-- p_search is expected to already have LIKE wildcards escaped by the client.
create or replace function public.get_scan_stats(
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_search text default null
)
returns table (total bigint, duplicates bigint, unique_labels bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_search is not null and p_search <> '' then
    return query
    select
      count(*)::bigint,
      count(*) filter (where s.is_duplicate)::bigint,
      count(distinct s.label)::bigint
    from public.scans s
    where s.label ilike '%' || p_search || '%';
  else
    return query
    select
      count(*)::bigint,
      count(*) filter (where s.is_duplicate)::bigint,
      count(distinct s.label)::bigint
    from public.scans s
    where s.scanned_at >= p_start and s.scanned_at <= p_end;
  end if;
end;
$$;

revoke all on function public.get_scan_stats(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.get_scan_stats(timestamptz, timestamptz, text)
  to authenticated, service_role;

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
set search_path = ''
as $$
declare
  v_label text;
  v_is_duplicate boolean;
begin
  v_label := trim(p_label);
  if v_label = '' then
    raise exception 'Label cannot be empty';
  end if;
  if char_length(v_label) > 500 then
    raise exception 'Label is too long';
  end if;

  -- 64-bit lock key avoids the collisions of hashtext().
  perform pg_advisory_xact_lock(hashtextextended(v_label, 0));

  select exists (
    select 1 from public.scans s where s.label = v_label
  ) into v_is_duplicate;

  return query
  insert into public.scans (label, is_duplicate)
  values (v_label, v_is_duplicate)
  returning scans.id, scans.label, scans.scanned_at, scans.is_duplicate;
end;
$$;

revoke all on function public.insert_scan(text) from public, anon;
grant execute on function public.insert_scan(text) to authenticated, service_role;

-- Daily report aggregates. The secret check lives in an unexposed schema so
-- the publishable key can call it from the cron route without a service key.
create or replace function private.get_daily_metrics(
  p_start timestamptz,
  p_end timestamptz,
  p_secret text
)
returns table (
  total bigint,
  unique_labels bigint,
  first_scan timestamptz,
  last_scan timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if v_secret is null or p_secret is distinct from v_secret then
    raise exception 'unauthorized';
  end if;

  return query
  select
    count(*)::bigint,
    count(distinct s.label)::bigint,
    min(s.scanned_at),
    max(s.scanned_at)
  from public.scans s
  where s.scanned_at >= p_start and s.scanned_at <= p_end;
end;
$$;

revoke all on function private.get_daily_metrics(timestamptz, timestamptz, text) from public;
grant execute on function private.get_daily_metrics(timestamptz, timestamptz, text)
  to anon, authenticated, service_role;

create or replace function public.get_daily_metrics(
  p_start timestamptz,
  p_end timestamptz,
  p_secret text
)
returns table (
  total bigint,
  unique_labels bigint,
  first_scan timestamptz,
  last_scan timestamptz
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.get_daily_metrics(p_start, p_end, p_secret);
$$;

revoke all on function public.get_daily_metrics(timestamptz, timestamptz, text) from public;
grant execute on function public.get_daily_metrics(timestamptz, timestamptz, text)
  to anon, authenticated, service_role;

create or replace function private.enforce_email_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null
     or lower(split_part(trim(new.email), '@', 2)) is distinct from 'fromthisisland.com' then
    raise exception 'Only @fromthisisland.com email addresses are allowed to sign up';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_email_domain() from public, anon, authenticated;

drop trigger if exists enforce_email_domain on auth.users;
create trigger enforce_email_domain
  before insert on auth.users
  for each row execute function private.enforce_email_domain();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'scans'
  ) then
    alter publication supabase_realtime add table public.scans;
  end if;
end $$;

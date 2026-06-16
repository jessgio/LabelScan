-- Restrict access to authenticated @aerisbeaute.com users.

-- 1) Restrict sign-ups to the company domain (enforced server-side, so it
--    cannot be bypassed by calling the API directly).
create or replace function public.enforce_email_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or lower(new.email) not like '%@aerisbeaute.com' then
    raise exception 'Only @aerisbeaute.com email addresses are allowed to sign up';
  end if;
  return new;
end;
$$;

-- The trigger function is invoked by the trigger only; block direct API/RPC calls.
revoke all on function public.enforce_email_domain() from public, anon, authenticated;

drop trigger if exists enforce_email_domain on auth.users;
create trigger enforce_email_domain
  before insert on auth.users
  for each row execute function public.enforce_email_domain();

-- 2) Attribute every scan to the signed-in user automatically.
alter table public.scans alter column user_id set default auth.uid();

-- 3) Lock down RLS: authenticated (domain) users only, no anonymous access.
drop policy if exists "Allow anonymous inserts" on public.scans;
drop policy if exists "Allow reading scans" on public.scans;
drop policy if exists "Allow deleting scans" on public.scans;

create policy "Authenticated can read scans"
  on public.scans for select to authenticated using (true);

create policy "Authenticated can insert scans"
  on public.scans for insert to authenticated with check (true);

create policy "Authenticated can update scans"
  on public.scans for update to authenticated using (true) with check (true);

create policy "Authenticated can delete scans"
  on public.scans for delete to authenticated using (true);

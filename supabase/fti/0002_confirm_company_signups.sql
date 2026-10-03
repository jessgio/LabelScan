-- Supabase's built-in mailer rejects signups after a couple of confirmation
-- emails per hour ("email rate limit exceeded"). Company addresses are already
-- limited to @fromthisisland.com, so confirm them when the account is created.

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

  if tg_op = 'INSERT' and new.email_confirmed_at is null then
    new.email_confirmed_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_email_domain() from public, anon, authenticated;

update auth.users
set email_confirmed_at = pg_catalog.now()
where email_confirmed_at is null
  and lower(split_part(email, '@', 2)) = 'fromthisisland.com';

import { createBrowserClient } from '@supabase/ssr';

// NEXT_PUBLIC_SUPABASE_ANON_KEY holds the publishable (sb_publishable_…) key.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

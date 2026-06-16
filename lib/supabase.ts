// Browser singleton used by Client Components. Backed by @supabase/ssr so the
// session lives in cookies and is shared with server-side rendering / the proxy.
import { createClient } from '@/lib/supabase/client';

export const supabase = createClient();

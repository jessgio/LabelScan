import { type EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Only allow same-site relative paths. `new URL('https://evil', base)` would
// otherwise follow an absolute `next` value off this app.
function safeNextPath(next: string | null) {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/';
  }
  return next;
}

// Handles email confirmation / magic links. Supports both the token_hash flow
// (verifyOtp) and the PKCE code flow (exchangeCodeForSession).
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  const supabase = await createClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(new URL('/login?error=auth', request.url));
}

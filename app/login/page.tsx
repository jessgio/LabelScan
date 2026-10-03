'use client';

import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { allowedEmailDomain, brandMark, brandName } from '@/lib/brand';

const ALLOWED_DOMAIN = allowedEmailDomain;

type AuthFailure = { code?: string; message?: string };

function isEmailRateLimit(error: AuthFailure) {
  return (
    error.code === 'over_email_send_rate_limit' ||
    /email rate limit exceeded/i.test(error.message ?? '')
  );
}

function isEmailNotConfirmed(error: AuthFailure) {
  return error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message ?? '');
}

function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.endsWith(`@${ALLOWED_DOMAIN}`)) {
      setError(`Only @${ALLOWED_DOMAIN} email addresses are allowed.`);
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
        });
        // The built-in mailer returns this after a couple of confirmation emails
        // per hour, even when the account was created. Sign in when it is already
        // confirmed; otherwise keep the email-confirmation path.
        if (error && !isEmailRateLimit(error)) throw error;
        if (data?.session) {
          router.replace('/');
          router.refresh();
          return;
        }

        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (!signInError) {
          router.replace('/');
          router.refresh();
          return;
        }
        if (!error && isEmailNotConfirmed(signInError)) {
          setInfo('Account created. Check your email to confirm, then sign in.');
          setMode('signin');
          return;
        }
        if (error && isEmailRateLimit(error)) {
          throw new Error(
            'Supabase is limiting confirmation emails right now. Wait a few minutes, then sign in or try again.',
          );
        }
        throw signInError;
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (error) throw error;
        router.replace('/');
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4">
      <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-8 shadow-xl ring-1 ring-black/5">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white">
            {brandMark}
          </div>
          <h1 className="text-xl font-bold text-slate-900">{brandName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'signin' ? 'Sign in to continue' : 'Create your account'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`you@${ALLOWED_DOMAIN}`}
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Password</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-brand"
            />
          </div>

          {error && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
          )}
          {info && (
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{info}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
            setError(null);
            setInfo(null);
          }}
          className="mt-5 w-full text-center text-sm text-slate-500 transition hover:text-slate-800"
        >
          {mode === 'signin'
            ? "Need an account? Create one"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

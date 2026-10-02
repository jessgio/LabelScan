import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import OpenAI from 'openai';
import { brandName, allowedEmailDomain } from '@/lib/brand';
import { APP_TIMEZONE, formatInAppTimezone, rangeIso, reportDay } from '@/lib/dates';

export const dynamic = 'force-dynamic';

type Metrics = {
  total: number;
  unique: number;
  totalMinutes: number;
  avgCycleTime: number;
};

async function loadMetrics(
  supabase: SupabaseClient,
  start: string,
  end: string,
  cronSecret: string,
): Promise<Metrics | null> {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const [statsRes, firstRes, lastRes] = await Promise.all([
      supabase.rpc('get_scan_stats', { p_start: start, p_end: end, p_search: null }),
      supabase
        .from('scans')
        .select('scanned_at')
        .gte('scanned_at', start)
        .lte('scanned_at', end)
        .order('scanned_at', { ascending: true })
        .limit(1),
      supabase
        .from('scans')
        .select('scanned_at')
        .gte('scanned_at', start)
        .lte('scanned_at', end)
        .order('scanned_at', { ascending: false })
        .limit(1),
    ]);

    if (statsRes.error) throw statsRes.error;
    if (firstRes.error) throw firstRes.error;
    if (lastRes.error) throw lastRes.error;

    const stat = (Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data) as
      | { total: number; unique_labels: number }
      | undefined;
    const total = Number(stat?.total ?? 0);
    if (total === 0) return null;

    const first = firstRes.data?.[0]?.scanned_at;
    const last = lastRes.data?.[0]?.scanned_at;
    const totalMinutes =
      first && last ? (new Date(last).getTime() - new Date(first).getTime()) / (1000 * 60) : 0;

    return {
      total,
      unique: Number(stat?.unique_labels ?? 0),
      totalMinutes,
      avgCycleTime: total > 1 ? totalMinutes / (total - 1) : 0,
    };
  }

  const { data, error } = await supabase.rpc('get_daily_metrics', {
    p_start: start,
    p_end: end,
    p_secret: cronSecret,
  });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as
    | { total: number; unique_labels: number; first_scan: string | null; last_scan: string | null }
    | undefined;
  const total = Number(row?.total ?? 0);
  if (total === 0) return null;

  const totalMinutes =
    row?.first_scan && row?.last_scan
      ? (new Date(row.last_scan).getTime() - new Date(row.first_scan).getTime()) / (1000 * 60)
      : 0;

  return {
    total,
    unique: Number(row?.unique_labels ?? 0),
    totalMinutes,
    avgCycleTime: total > 1 ? totalMinutes / (total - 1) : 0,
  };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const recipient = process.env.REPORT_RECIPIENT;
  if (!recipient) {
    return NextResponse.json({ error: 'REPORT_RECIPIENT is not configured' }, { status: 500 });
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const day = reportDay();
    const { start, end } = rangeIso(day, day);
    const metrics = await loadMetrics(supabase, start, end, cronSecret);

    if (!metrics) {
      return NextResponse.json({ message: 'No scans today', day });
    }

    let aiSummary = 'Automated summary unavailable. The metrics below are complete.';
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const openai = new OpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: process.env.OPENROUTER_API_KEY,
        });
        const completion = await openai.chat.completions.create({
          model: 'x-ai/grok-2-1212',
          messages: [
            {
              role: 'user',
              content: `You are a professional logistics analyst. Provide a formal summary of today's shipping activity.

Data:
- Total labels scanned: ${metrics.total}
- Unique labels processed: ${metrics.unique}
- Time from first to last scan: ${metrics.totalMinutes.toFixed(1)} minutes
- Average cycle time per order: ${metrics.avgCycleTime.toFixed(1)} minutes

Write a short, formal summary (maximum 3 sentences) focusing on overall throughput and operational efficiency.`,
            },
          ],
        });
        aiSummary = completion.choices[0]?.message?.content ?? aiSummary;
      } catch (err) {
        console.error('OpenRouter Error:', err);
      }
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json({ error: 'RESEND_API_KEY is not configured' }, { status: 500 });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const sender =
      process.env.REPORT_SENDER ?? `${brandName} <reports@${allowedEmailDomain}>`;

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: sender,
      to: recipient,
      subject: `Daily Shipping Report - ${day}`,
      text: `${brandName} daily shipping report – ${day} (${APP_TIMEZONE})

${aiSummary}

Key Metrics:
- Total Scans: ${metrics.total}
- Unique Labels: ${metrics.unique}
- Total Operation Time: ${metrics.totalMinutes.toFixed(1)} minutes
- Average Time per Label: ${metrics.avgCycleTime.toFixed(1)} minutes
- Window: ${formatInAppTimezone(start)} to ${formatInAppTimezone(end)}`,
    });

    if (emailError) {
      console.error('Resend Error:', emailError);
      return NextResponse.json({ error: emailError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, emailId: emailData?.id, day });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('Unexpected Error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

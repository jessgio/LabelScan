import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import OpenAI from 'openai';

// Always run fresh; never statically cache a report.
export const dynamic = 'force-dynamic';

const REPORT_TIMEZONE = 'Asia/Jakarta';

export async function GET(request: Request) {
  // Protect the endpoint: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    // Clients are created per-request so a missing secret never breaks the build.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: REPORT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const today = formatter.format(new Date());

    const { data: scans, error } = await supabase
      .from('scans')
      .select('label,scanned_at')
      .gte('scanned_at', `${today}T00:00:00`)
      .lte('scanned_at', `${today}T23:59:59.999`);

    if (error) {
      console.error('Supabase Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!scans || scans.length === 0) {
      return NextResponse.json({ message: 'No scans today' });
    }

    const totalScans = scans.length;
    const uniqueLabels = new Set(scans.map((s) => s.label)).size;

    const sorted = [...scans].sort(
      (a, b) => new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime(),
    );
    const firstScan = new Date(sorted[0].scanned_at);
    const lastScan = new Date(sorted[sorted.length - 1].scanned_at);
    const totalMinutes = (lastScan.getTime() - firstScan.getTime()) / (1000 * 60);
    // Average time between consecutive scans (throughput cadence).
    const avgCycleTime = totalScans > 1 ? totalMinutes / (totalScans - 1) : 0;

    const openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY!,
    });

    const completion = await openai.chat.completions.create({
      model: 'x-ai/grok-2-1212',
      messages: [
        {
          role: 'user',
          content: `You are a professional logistics analyst. Provide a formal summary of today's shipping activity.

Data:
- Total labels scanned: ${totalScans}
- Unique labels processed: ${uniqueLabels}
- Time from first to last scan: ${totalMinutes.toFixed(1)} minutes
- Average cycle time per order: ${avgCycleTime.toFixed(1)} minutes

Write a short, formal summary (maximum 3 sentences) focusing on overall throughput and operational efficiency.`,
        },
      ],
    });

    const aiSummary = completion.choices[0]?.message?.content ?? 'Summary unavailable.';

    const resend = new Resend(process.env.RESEND_API_KEY!);
    const recipient = process.env.REPORT_RECIPIENT ?? 'jessica@aerisbeaute.com';
    const sender = process.env.REPORT_SENDER ?? 'Label Scanner <reports@aerisbeaute.com>';

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: sender,
      to: recipient,
      subject: `Daily Shipping Report - ${today}`,
      text: `Daily Shipping Report – ${today}

${aiSummary}

Key Metrics:
- Total Scans: ${totalScans}
- Unique Labels: ${uniqueLabels}
- Total Operation Time: ${totalMinutes.toFixed(1)} minutes
- Average Time per Label: ${avgCycleTime.toFixed(1)} minutes`,
    });

    if (emailError) {
      console.error('Resend Error:', emailError);
      return NextResponse.json({ error: emailError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, emailId: emailData?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('Unexpected Error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

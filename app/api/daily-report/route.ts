import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import OpenAI from 'openai';

// 1. Force Next.js to run this dynamically every time (prevents static caching)
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const resend = new Resend(process.env.RESEND_API_KEY!);

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
});

export async function GET() {
  try {
    // 2. Pin the timezone to Jakarta so "today" is always accurate for your warehouse
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const today = formatter.format(new Date());

    // Fetch today's scans
    const { data: scans, error } = await supabase
      .from('scans')
      .select('*')
      .gte('scanned_at', `${today}T00:00:00`)
      .lte('scanned_at', `${today}T23:59:59.999`);

    if (error) {
      console.error("Supabase Error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!scans || scans.length === 0) {
      return NextResponse.json({ message: 'No scans today' });
    }

    // Calculate metrics
    const totalScans = scans.length;
    const uniqueLabels = new Set(scans.map(s => s.label)).size;

    const sortedScans = [...scans].sort((a, b) =>
      new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime()
    );

    const firstScan = new Date(sortedScans[0].scanned_at);
    const lastScan = new Date(sortedScans[sortedScans.length - 1].scanned_at);
    const totalMinutes = (lastScan.getTime() - firstScan.getTime()) / (1000 * 60);
    
    // Prevent division by zero if only 1 label was scanned
    const avgCycleTime = totalScans > 1 ? totalMinutes / totalScans : 0;

    // 3. Generate formal summary using a valid Grok model
    const completion = await openai.chat.completions.create({
      model: 'x-ai/grok-2-1212', // Changed from grok-4, which does not exist on OpenRouter yet
      messages: [
        {
          role: 'user',
          content: `You are a professional logistics analyst. Provide a formal summary of today’s shipping activity.

Data:
- Total labels scanned: ${totalScans}
- Unique labels processed: ${uniqueLabels}
- Time from first to last scan: ${totalMinutes.toFixed(1)} minutes
- Average cycle time per order: ${avgCycleTime.toFixed(1)} minutes

Write a short, formal summary (maximum 3 sentences) focusing on overall throughput and operational efficiency.`
        }
      ],
    });

    const aiSummary = completion.choices[0].message.content;

    // 4. Send email with proper error handling
    const { data: emailData, error: emailError } = await resend.emails.send({
      from: 'Label Scanner <reports@aerisbeaute.com>', 
      to: 'jessica@aerisbeaute.com',
      subject: `Daily Shipping Report - ${today}`,
      text: `
Daily Shipping Report – ${today}

${aiSummary}

Key Metrics:
- Total Scans: ${totalScans}
- Unique Labels: ${uniqueLabels}
- Total Operation Time: ${totalMinutes.toFixed(1)} minutes
- Average Time per Label: ${avgCycleTime.toFixed(1)} minutes
      `,
    });

    if (emailError) {
      console.error("Resend Error:", emailError);
      return NextResponse.json({ error: emailError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, emailId: emailData?.id });

  } catch (err: any) {
    console.error("Unexpected Error:", err);
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
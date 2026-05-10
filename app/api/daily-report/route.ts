import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import OpenAI from 'openai';

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
  const today = new Date().toISOString().split('T')[0];

  // Fetch today's scans
  const { data: scans, error } = await supabase
    .from('scans')
    .select('*')
    .gte('scanned_at', `${today}T00:00:00`)
    .lte('scanned_at', `${today}T23:59:59.999`);

  if (error || !scans || scans.length === 0) {
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
  const avgCycleTime = totalMinutes / totalScans;

  // Generate formal summary using Grok
  const completion = await openai.chat.completions.create({
    model: 'x-ai/grok-4', // Using Grok model via OpenRouter
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

  // Send email
  await resend.emails.send({
    from: 'Label Scanner <reports@aerisbeaute.com>', // You can change this later
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

  return NextResponse.json({ success: true });
}
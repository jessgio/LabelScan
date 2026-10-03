import { supabase } from '@/lib/supabase';

type OrderMatch = { label: string; order_number: string };

export async function lookupOrders(labels: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  const matches: Record<string, string> = {};
  const chunkSize = 500;

  for (let index = 0; index < unique.length; index += chunkSize) {
    const chunk = unique.slice(index, index + chunkSize);
    const { data, error } = await supabase.rpc('lookup_orders', { p_labels: chunk });
    if (error) throw error;
    for (const row of (data ?? []) as OrderMatch[]) {
      matches[row.label] = row.order_number;
    }
  }

  return matches;
}

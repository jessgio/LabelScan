'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import DuplicateModal from '@/components/DuplicateModal';

interface Scan {
  id: string;
  label: string;
  scanned_at: string;
  is_duplicate: boolean;
}

interface Stats {
  total: number;
  duplicates: number;
  unique: number;
}

type Feedback = { type: 'success' | 'error'; message: string } | null;

const PAGE_SIZE = 50;
const SCAN_COLUMNS = 'id,label,scanned_at,is_duplicate';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export default function LabelScanner() {
  const router = useRouter();
  const initialToday = todayStr();

  const [label, setLabel] = useState('');
  const [startDate, setStartDate] = useState(initialToday);
  const [endDate, setEndDate] = useState(initialToday);

  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [scans, setScans] = useState<Scan[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, duplicates: 0, unique: 0 });
  const [currentPage, setCurrentPage] = useState(1);

  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [showDuplicate, setShowDuplicate] = useState(false);
  const [duplicateLabel, setDuplicateLabel] = useState('');

  const scannerRef = useRef<HTMLInputElement>(null);

  const isSearching = debouncedSearch.trim() !== '';
  const totalPages = Math.max(1, Math.ceil(stats.total / PAGE_SIZE));

  const notify = useCallback((type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
  }, []);

  // Auto-dismiss feedback toast.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [feedback]);

  // Debounce the search box so we don't hit the DB on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // ====================== DATA LOADING ======================
  // One round trip for the visible page + one for aggregate stats.
  const loadData = useCallback(
    async (page: number) => {
      setIsLoading(true);
      try {
        const search = debouncedSearch.trim();
        const startDateTime = `${startDate}T00:00:00`;
        const endDateTime = `${endDate}T23:59:59.999`;

        const buildRowQuery = () => {
          let q = supabase.from('scans').select(SCAN_COLUMNS);
          if (search !== '') {
            q = q.ilike('label', `%${search}%`);
          } else {
            q = q.gte('scanned_at', startDateTime).lte('scanned_at', endDateTime);
          }
          return q
            .order('scanned_at', { ascending: false })
            .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
        };

        const [rowsRes, statsRes] = await Promise.all([
          buildRowQuery(),
          supabase.rpc('get_scan_stats', {
            p_start: startDateTime,
            p_end: endDateTime,
            p_search: search === '' ? null : search,
          }),
        ]);

        if (rowsRes.error) throw rowsRes.error;
        if (statsRes.error) throw statsRes.error;

        const rows = (rowsRes.data ?? []) as Scan[];
        const stat = (Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data) as
          | { total: number; duplicates: number; unique_labels: number }
          | undefined;

        // If we deleted the last item on a page, fall back to page 1.
        if (rows.length === 0 && page > 1 && (stat?.total ?? 0) > 0) {
          setCurrentPage(1);
          return;
        }

        setScans(rows);
        setStats({
          total: Number(stat?.total ?? 0),
          duplicates: Number(stat?.duplicates ?? 0),
          unique: Number(stat?.unique_labels ?? 0),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load scans';
        notify('error', message);
      } finally {
        setIsLoading(false);
      }
    },
    [debouncedSearch, startDate, endDate, notify],
  );

  // Keep a stable reference for realtime callbacks without re-subscribing.
  const loadRef = useRef(loadData);
  const pageRef = useRef(currentPage);
  useEffect(() => {
    loadRef.current = loadData;
    pageRef.current = currentPage;
  }, [loadData, currentPage]);

  // Load whenever filters or the page change (deferred to satisfy the
  // "no setState directly in effect" rule and to debounce naturally).
  useEffect(() => {
    const t = setTimeout(() => {
      loadData(currentPage);
    }, 0);
    return () => clearTimeout(t);
  }, [loadData, currentPage]);

  // ====================== REALTIME ======================
  // Subscribe once; coalesce bursts (e.g. bulk delete) into a single reload.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel('live-scans')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scans' }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => loadRef.current(pageRef.current), 300);
      })
      .subscribe();

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, []);

  // ====================== ACTIONS ======================
  const handleScan = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setLabel('');

    try {
      const { data, error: insertError } = await supabase.rpc('insert_scan', {
        p_label: trimmed,
      });
      if (insertError) throw insertError;

      const row = (Array.isArray(data) ? data[0] : data) as Scan | undefined;
      const isDuplicate = row?.is_duplicate ?? false;

      if (isDuplicate) {
        setDuplicateLabel(trimmed);
        setShowDuplicate(true);
      } else {
        notify('success', `Saved "${trimmed}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save scan';
      notify('error', message);
    }
  };

  const deleteSingleScan = async (id: string) => {
    if (!confirm('Delete this scan?')) return;
    const { error } = await supabase.from('scans').delete().eq('id', id);
    if (error) {
      notify('error', 'Failed to delete scan');
      return;
    }
    // Optimistic removal; realtime + reload will reconcile counts.
    setScans((prev) => prev.filter((s) => s.id !== id));
    notify('success', 'Scan deleted');
  };

  const deleteOldScans = async (days: number) => {
    const msg =
      days === 0
        ? 'Delete ALL scans permanently?'
        : `Delete scans older than ${days} days?`;
    if (!confirm(msg)) return;

    let query = supabase.from('scans').delete();
    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      query = query.lt('scanned_at', cutoff.toISOString());
    } else {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { error } = await query;
    if (error) {
      notify('error', 'Failed to delete scans');
      return;
    }
    notify('success', 'Scans deleted');
    setCurrentPage(1);
    loadData(1);
  };

  const refreshData = () => {
    const t = todayStr();
    setSearchTerm('');
    setStartDate(t);
    setEndDate(t);
    setCurrentPage(1);
    loadData(1);
  };

  const resetToToday = () => {
    const t = todayStr();
    setStartDate(t);
    setEndDate(t);
    setCurrentPage(1);
  };

  const exportToCSV = async () => {
    try {
      const search = debouncedSearch.trim();
      const startDateTime = `${startDate}T00:00:00`;
      const endDateTime = `${endDate}T23:59:59.999`;

      const all: Scan[] = [];
      const CHUNK = 1000;
      let start = 0;

      for (;;) {
        let query = supabase.from('scans').select(SCAN_COLUMNS);
        if (search !== '') {
          query = query.ilike('label', `%${search}%`);
        } else {
          query = query.gte('scanned_at', startDateTime).lte('scanned_at', endDateTime);
        }
        const { data, error } = await query
          .order('scanned_at', { ascending: false })
          .range(start, start + CHUNK - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as Scan[]));
        if (data.length < CHUNK) break;
        start += CHUNK;
      }

      if (all.length === 0) {
        notify('error', 'No data to export for this filter');
        return;
      }

      const headers = ['Label', 'Scanned At', 'Is Duplicate'];
      const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const rows = all.map((s) =>
        [s.label, new Date(s.scanned_at).toLocaleString(), s.is_duplicate ? 'Yes' : 'No']
          .map(escape)
          .join(','),
      );
      const csv = [headers.map(escape).join(','), ...rows].join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = isSearching
        ? `label_scans_search.csv`
        : `label_scans_${startDate}_to_${endDate}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      notify('success', `Exported ${all.length} scans`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to export';
      notify('error', message);
    }
  };

  const closeDuplicate = () => {
    setShowDuplicate(false);
    scannerRef.current?.focus();
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
    router.refresh();
  };

  // ====================== RENDER ======================
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900">
      {/* Toast */}
      {feedback && (
        <div
          role="status"
          className={`fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-medium shadow-lg ring-1 ring-black/5 ${
            feedback.type === 'success'
              ? 'bg-emerald-600 text-white'
              : 'bg-rose-600 text-white'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Label Scanner</h1>
            <p className="mt-0.5 text-sm text-slate-500">Warehouse shipping throughput</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshData}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  isLoading ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'
                }`}
              />
              {isLoading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              onClick={signOut}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Scanner — primary action, sticky at the top */}
        <div className="sticky top-3 z-30 mb-6">
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-lg ring-1 ring-black/5 backdrop-blur">
            <input
              ref={scannerRef}
              type="text"
              autoFocus
              inputMode="text"
              autoComplete="off"
              className="w-full rounded-xl border-2 border-indigo-200 bg-white px-4 py-4 text-lg font-medium text-slate-900 outline-none transition focus:border-indigo-500 sm:text-xl"
              placeholder="Scan or type a label, then press Enter"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleScan();
              }}
            />
          </div>
        </div>

        {/* Stats */}
        <div className="mb-6 grid grid-cols-3 gap-3 sm:gap-4">
          <StatCard label="Total" value={stats.total} accent="text-slate-900" />
          <StatCard label="Duplicates" value={stats.duplicates} accent="text-rose-600" />
          <StatCard label="Unique" value={stats.unique} accent="text-indigo-600" />
        </div>

        {/* Filters */}
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <label className="mb-1.5 block text-sm font-semibold text-slate-700">
            Search entire database
          </label>
          <input
            type="text"
            placeholder="Type to search all scans…"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-indigo-500"
          />

          {!isSearching && (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="flex-1 min-w-[140px]">
                <label className="mb-1 block text-xs font-semibold text-slate-500">From</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="mb-1 block text-xs font-semibold text-slate-500">To</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={resetToToday}
                  className="rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900"
                >
                  Today
                </button>
                <button
                  onClick={exportToCSV}
                  className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  Export CSV
                </button>
              </div>
            </div>
          )}
          {isSearching && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={exportToCSV}
                className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
              >
                Export CSV
              </button>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {isSearching ? `Results for “${debouncedSearch}”` : `Scans · ${startDate} → ${endDate}`}
          </h2>
          <span className="text-sm text-slate-500">{stats.total.toLocaleString()} total</span>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead className="bg-slate-800 text-white">
                <tr>
                  <th className="p-3 text-sm font-semibold sm:p-4">Label</th>
                  <th className="p-3 text-sm font-semibold sm:p-4">Time</th>
                  <th className="p-3 text-sm font-semibold sm:p-4">Status</th>
                  <th className="w-16 p-3 text-sm font-semibold sm:p-4">·</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scans.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-10 text-center text-slate-400">
                      {isLoading ? 'Loading…' : 'No scans found'}
                    </td>
                  </tr>
                ) : (
                  scans.map((scan) => (
                    <tr key={scan.id} className="transition hover:bg-slate-50">
                      <td className="p-3 font-mono text-sm text-slate-900 sm:p-4 sm:text-base">
                        {scan.label}
                      </td>
                      <td className="whitespace-nowrap p-3 text-sm text-slate-500 sm:p-4">
                        {new Date(scan.scanned_at).toLocaleString()}
                      </td>
                      <td className="p-3 sm:p-4">
                        {scan.is_duplicate ? (
                          <span className="inline-block rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700">
                            DUPLICATE
                          </span>
                        ) : (
                          <span className="inline-block rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                            NEW
                          </span>
                        )}
                      </td>
                      <td className="p-3 sm:p-4">
                        <button
                          onClick={() => deleteSingleScan(scan.id)}
                          aria-label="Delete scan"
                          className="text-sm font-medium text-rose-600 transition hover:text-rose-800"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              disabled={currentPage <= 1 || isLoading}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="text-sm text-slate-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
              disabled={currentPage >= totalPages || isLoading}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}

        {/* Danger zone — de-emphasised + collapsed */}
        <details className="mt-8 rounded-2xl border border-slate-200 bg-white shadow-sm">
          <summary className="cursor-pointer select-none p-4 text-sm font-semibold text-slate-600">
            Maintenance · delete old scans
          </summary>
          <div className="flex flex-col gap-3 border-t border-slate-100 p-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs text-slate-500">Delete scans older than</label>
              <select
                id="delete-days"
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900"
              >
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="0">All scans</option>
              </select>
            </div>
            <button
              onClick={() => {
                const select = document.getElementById('delete-days') as HTMLSelectElement;
                deleteOldScans(parseInt(select.value, 10));
              }}
              className="rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-700"
            >
              Delete
            </button>
          </div>
        </details>
      </div>

      {showDuplicate && <DuplicateModal label={duplicateLabel} onClose={closeDuplicate} />}
    </main>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400 sm:text-sm">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums sm:text-4xl ${accent}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

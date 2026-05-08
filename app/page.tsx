'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import DuplicateModal from '@/components/DuplicateModal';

interface Scan {
  id: string;
  label: string;
  scanned_at: string;
  is_duplicate: boolean;
}

export default function LabelScanner() {
  const [label, setLabel] = useState('');
  const [totalScans, setTotalScans] = useState(0);
  const [totalDuplicates, setTotalDuplicates] = useState(0);
  const [totalUnique, setTotalUnique] = useState(0);
  const [recentScans, setRecentScans] = useState<Scan[]>([]);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [duplicateLabel, setDuplicateLabel] = useState('');

  // Helper function for delete
  const deleteOldScans = async (days: number) => {
  let query = supabase.from('scans').delete();

  if (days > 0) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    query = query.lt('scanned_at', cutoffDate.toISOString());
  } else {
    // Delete all
    query = query.neq('id', '00000000-0000-0000-0000-000000000000');
  }

  return await query;
};

  // Load initial data + realtime
  useEffect(() => {
    const loadData = async () => {
      const { data } = await supabase
        .from('scans')
        .select('*')
        .order('scanned_at', { ascending: false })
        .limit(50);

      if (data) {
        setRecentScans(data);
        setTotalScans(data.length);
        setTotalDuplicates(data.filter((s) => s.is_duplicate).length);

        const uniqueLabels = new Set(data.map((s) => s.label));
        setTotalUnique(uniqueLabels.size);
      }
    };

    loadData();

    // Realtime subscription
    const channel = supabase
      .channel('live-scans')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scans' }, (payload) => {
        const newScan = payload.new as Scan;

        setRecentScans((prev) => {
          const alreadyExists = prev.some((s) => s.label === newScan.label);
          if (!alreadyExists) {
            setTotalUnique((u) => u + 1);
          }
          return [newScan, ...prev].slice(0, 50);
        });

        setTotalScans((prev) => prev + 1);
        if (newScan.is_duplicate) {
          setTotalDuplicates((prev) => prev + 1);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleScan = async (scannedLabel: string) => {
    const trimmed = scannedLabel.trim();
    if (!trimmed) return;

    const { data: existing } = await supabase
      .from('scans')
      .select('id')
      .eq('label', trimmed)
      .limit(1);

    const isDuplicate = !!(existing && existing.length > 0);

    await supabase.from('scans').insert({
      label: trimmed,
      is_duplicate: isDuplicate,
    });

    if (isDuplicate) {
      setDuplicateLabel(trimmed);
      setShowDuplicate(true);
    }

    setLabel('');
  };

  const exportToCSV = async () => {
    const { data } = await supabase
      .from('scans')
      .select('*')
      .order('scanned_at', { ascending: false });

    if (!data || data.length === 0) {
      alert('No data to export');
      return;
    }

    const headers = ['Label', 'Scanned At', 'Is Duplicate'];
    const rows = data.map((s) => [
      s.label,
      new Date(s.scanned_at).toLocaleString(),
      s.is_duplicate ? 'Yes' : 'No',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((r) => r.map((f) => `"${f}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `label_scans_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  return (
    <div className="max-w-5xl mx-auto p-8 bg-slate-50 min-h-screen">
      <h1 className="text-4xl font-bold mb-8 text-slate-900">Label Scanner</h1>

      {/* Stats Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        
        {/* Total Scans */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-sm text-slate-500">Total Scans</p>
          <p className="text-6xl font-bold text-slate-900 mt-2">{totalScans}</p>
        </div>
      
        {/* Total Duplicates */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-sm text-slate-500">Total Duplicates</p>
          <p className="text-6xl font-bold text-red-600 mt-2">{totalDuplicates}</p>
        </div>
      
        {/* Total Unique Scans */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-sm text-slate-500">Total Unique Scans</p>
          <p className="text-6xl font-bold text-blue-600 mt-2">{totalUnique}</p>
        </div>
      </div>
      
      {/* Delete Old Scans Section */}
      <div className="mb-8 border border-slate-200 rounded-2xl p-6 bg-white shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Delete Old Scans</h3>
        
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm text-slate-500 mb-1.5">Delete scans older than:</label>
            <select 
              id="delete-days" 
              className="w-full border border-slate-300 rounded-xl px-4 py-3 text-base bg-white"
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="0">All scans</option>
            </select>
          </div>
      
          <button
            onClick={async () => {
              const select = document.getElementById('delete-days') as HTMLSelectElement;
              const days = parseInt(select.value);
      
              const msg = days === 0 
                ? "Delete ALL scans permanently? This cannot be undone." 
                : `Delete scans older than ${days} days?`;
      
              if (!confirm(msg)) return;
      
              const { error } = await deleteOldScans(days);
      
              if (error) {
                alert('Failed to delete scans. Check console.');
                console.error(error);
              } else {
                alert('Scans deleted successfully');
                window.location.reload();
              }
            }}
            className="bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-xl font-semibold whitespace-nowrap"
          >
            Delete Selected Scans
          </button>
        </div>
      </div>

      {/* Scanner Input */}
      <div className="mb-8">
        <input
          type="text"
          autoFocus
          className="w-full bg-white p-5 text-2xl border border-slate-300 rounded-2xl focus:outline-none focus:border-slate-900 placeholder:text-slate-400"
          placeholder="Scan or type label and press Enter"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleScan(label)}
        />
      </div>

      {/* Export Button */}
      <div className="flex justify-end mb-4">
        <button
          onClick={exportToCSV}
          className="bg-slate-900 hover:bg-black text-white px-6 py-3 rounded-xl font-semibold"
        >
          Export to CSV
        </button>
      </div>

      {/* Recent Scans Table */}
      <div className="mb-4">
        <h2 className="text-2xl font-semibold text-slate-900">Recent Scans</h2>
      </div>

      <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-sm">
        <table className="w-full text-left">
          <thead className="bg-slate-800 text-white">
            <tr>
              <th className="p-4 font-semibold">Label</th>
              <th className="p-4 font-semibold">Time Scanned</th>
              <th className="p-4 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {recentScans.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-slate-500">No scans yet</td>
              </tr>
            ) : (
              recentScans.map((scan, index) => (
                <tr key={scan.id} className={index % 2 === 0 ? "bg-white" : "bg-slate-100"}>
                  <td className="p-4 font-mono text-lg text-slate-900">{scan.label}</td>
                  <td className="p-4 text-slate-600">
                    {new Date(scan.scanned_at).toLocaleString()}
                  </td>
                  <td className="p-4">
                    {scan.is_duplicate ? (
                      <span className="inline-block px-4 py-1 rounded-full bg-red-600 text-white text-sm font-semibold">
                        DUPLICATE
                      </span>
                    ) : (
                      <span className="inline-block px-4 py-1 rounded-full bg-green-600 text-white text-sm font-semibold">
                        NEW
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showDuplicate && (
        <DuplicateModal
          label={duplicateLabel}
          onClose={() => setShowDuplicate(false)}
        />
      )}
    </div>
  );
}

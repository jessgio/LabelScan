'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Scan {
  id: string;
  label: string;
  scanned_at: string;
  is_duplicate: boolean;
}

export default function AdminDashboard() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [filteredScans, setFilteredScans] = useState<Scan[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);

  // Calculated metrics
  const totalScans = scans.length;
  const totalDuplicates = scans.filter((s) => s.is_duplicate).length;
  const totalUnique = new Set(scans.map((s) => s.label)).size; // ← UNIQUE LABELS

  // Load scans + realtime
  useEffect(() => {
    const fetchScans = async () => {
      const { data } = await supabase
        .from('scans')
        .select('*')
        .order('scanned_at', { ascending: false });

      if (data) {
        setScans(data);
        setFilteredScans(data);
      }
      setLoading(false);
    };

    fetchScans();

    const channel = supabase
      .channel('admin-scans')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scans' }, () => {
        fetchScans();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Search filter
  useEffect(() => {
    if (!searchTerm.trim()) {
      setFilteredScans(scans);
    } else {
      const term = searchTerm.toLowerCase();
      setFilteredScans(
        scans.filter((s) => s.label.toLowerCase().includes(term))
      );
    }
  }, [searchTerm, scans]);

  const deleteScan = async (id: string) => {
    if (!confirm('Delete this scan?')) return;

    const { error } = await supabase.from('scans').delete().eq('id', id);
    if (!error) {
      setScans((prev) => prev.filter((s) => s.id !== id));
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-8 bg-slate-50 min-h-screen">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-4xl font-bold text-slate-900">Admin Dashboard</h1>
        <a href="/" className="text-blue-600 hover:underline">← Back to Scanner</a>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <p className="text-sm text-slate-500">Total Scans</p>
          <p className="text-5xl font-bold text-slate-900 mt-1">{totalScans}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <p className="text-sm text-slate-500">Total Duplicates</p>
          <p className="text-5xl font-bold text-red-600 mt-1">{totalDuplicates}</p>
        </div>

        {/* NEW: Total Unique Scans */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <p className="text-sm text-slate-500">Total Unique Scans</p>
          <p className="text-5xl font-bold text-blue-600 mt-1">{totalUnique}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6 flex items-center justify-center">
          <p className="text-slate-600 text-center">Live updates enabled</p>
        </div>
      </div>

      {/* Search Bar */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search labels..."
          className="w-full p-4 text-lg border border-slate-300 rounded-2xl focus:outline-none focus:border-slate-900"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* All Scans Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-8 text-center">Loading...</div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-slate-800 text-white">
              <tr>
                <th className="p-4">Label</th>
                <th className="p-4">Time Scanned</th>
                <th className="p-4">Status</th>
                <th className="p-4 w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredScans.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">No scans found</td>
                </tr>
              ) : (
                filteredScans.map((scan, index) => (
                  <tr key={scan.id} className={index % 2 === 0 ? "bg-white" : "bg-slate-100"}>
                    <td className="p-4 font-mono text-lg">{scan.label}</td>
                    <td className="p-4 text-slate-600">
                      {new Date(scan.scanned_at).toLocaleString()}
                    </td>
                    <td className="p-4">
                      {scan.is_duplicate ? (
                        <span className="px-3 py-1 rounded-full bg-red-600 text-white text-sm font-medium">
                          DUPLICATE
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full bg-green-600 text-white text-sm font-medium">
                          NEW
                        </span>
                      )}
                    </td>
                    <td className="p-4">
                      <button
                        onClick={() => deleteScan(scan.id)}
                        className="text-red-600 hover:text-red-800 font-medium"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
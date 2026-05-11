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
  
  // ====================== DATE RANGE ======================
  const today = new Date().toISOString().split('T')[0];
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);

  // ====================== STATS ======================
  const [totalScans, setTotalScans] = useState(0);
  const [totalDuplicates, setTotalDuplicates] = useState(0);
  const [totalUnique, setTotalUnique] = useState(0);

  // ====================== DATA ======================
  const [recentScans, setRecentScans] = useState<Scan[]>([]);
  const [allScans, setAllScans] = useState<Scan[]>([]);

  // ====================== DUPLICATE MODAL ======================
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [duplicateLabel, setDuplicateLabel] = useState('');

  // ====================== CURRENT PAGE/NEXT PAGE ===============
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 100;

  // ======================= ADD SEARCH FIELD ====================
  // Global Search
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // ====================== DELETE SINGLE SCAN ======================
  // Delete a single scan
  const deleteSingleScan = async (id: string) => {
    if (!confirm("Delete this scan?")) return;

    const { error } = await supabase.from('scans').delete().eq('id', id);

    if (!error) {
      // Remove from local state
      setAllScans((prev) => prev.filter((s) => s.id !== id));
      setRecentScans((prev) => prev.filter((s) => s.id !== id));

      // Update counters
      const remaining = allScans.filter((s) => s.id !== id);
      const filtered = remaining.filter((scan) => {
        const scanDate = new Date(scan.scanned_at).toISOString().split('T')[0];
        return scanDate >= startDate && scanDate <= endDate;
      });
      setTotalScans(filtered.length);
      setTotalDuplicates(filtered.filter((s) => s.is_duplicate).length);
      setTotalUnique(new Set(filtered.map((s) => s.label)).size);
    } else {
      alert("Failed to delete scan");
    }
  };

  // ====================== LOAD ALL DATA ======================
  useEffect(() => {
    const loadAllScans = async () => {
      const { data } = await supabase
        .from('scans')
        .select('*')
        .order('scanned_at', { ascending: false })
        .limit(30000);

      if (data) setAllScans(data);
    };
    loadAllScans();
  }, []);

  // ====================== FILTER BY DATE RANGE ======================
  // Filter by date range + pagination
  useEffect(() => {
  let filtered = [...allScans];

  // If searching, search the entire database
    if (searchTerm.trim() !== '') {
      const term = searchTerm.toLowerCase();
      filtered = allScans.filter((scan) =>
        scan.label.toLowerCase().includes(term)
      );
      setIsSearching(true);
    } else {
      // Normal date range filtering
      filtered = filtered.filter((scan) => {
        const scanDate = new Date(scan.scanned_at).toISOString().split('T')[0];
        return scanDate >= startDate && scanDate <= endDate;
      });
      setIsSearching(false);
    }

    // Pagination reset when search or date changes
    setRecentScans(filtered);
    setCurrentPage(1);

    // Update stats based on current view
    setTotalScans(filtered.length);
    setTotalDuplicates(filtered.filter((s) => s.is_duplicate).length);
    setTotalUnique(new Set(filtered.map((s) => s.label)).size);
  }, [searchTerm, startDate, endDate, allScans]);

  // ====================== REALTIME UPDATES ======================
  useEffect(() => {
    const channel = supabase
      .channel('live-scans')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scans' }, (payload) => {
        const newScan = payload.new as Scan;
        setAllScans((prev) => [newScan, ...prev]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // ====================== RESET TO TODAY ======================
  const resetToToday = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    setStartDate(todayStr);
    setEndDate(todayStr);
  };

  // ====================== HANDLE SCAN ======================
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

  // ====================== EXPORT TO CSV ======================
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

  // ====================== DELETE OLD SCANS ======================
  const deleteOldScans = async (days: number) => {
    let query = supabase.from('scans').delete();

    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      query = query.lt('scanned_at', cutoff.toISOString());
    } else {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000');
    }
    const { error } = await query;
    return { error };
  };

  // ==================== ADD REFRESH BUTTON ====================
  const refreshData = async () => {
    const { data } = await supabase
      .from('scans')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(30000);
  
    if (data) {
      setAllScans(data);
      console.log('Data refreshed');
    }
  };

  const totalPages = Math.ceil(recentScans.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedScans = recentScans.slice(startIndex, endIndex);

  return (
    <div className="max-w-5xl mx-auto p-8 bg-slate-50 min-h-screen">
      <h1 className="text-4xl font-bold mb-8 text-slate-900">Label Scanner</h1>

      <button
        onClick={refreshData}
        className="bg-slate-600 hover:bg-slate-700 text-white px-5 py-2.5 rounded-xl"
      >
        Refresh Data
      </button>
      
      {/* ====================== SEARCH + DATE RANGE ====================== */}
      <div className="mb-8">
        {/* Global Search */}
        <div className="mb-4">
          <label className="block text-sm font-semibold text-black mb-1">Search Entire Database</label>
          <input
            type="text"
            placeholder="Type to search all scans..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full border border-slate-300 px-4 py-3 rounded-2xl text-lg focus:outline-none focus:border-slate-900 text-slate-900"
          />
        </div>

        {/* Date Range (only show when not searching) */}
        {!isSearching && (
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-sm font-semibold text-black mb-1">From</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="border border-slate-300 px-4 py-2 rounded-xl text-lg text-slate-900"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-black mb-1">To</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="border border-slate-300 px-4 py-2 rounded-xl text-lg text-slate-900"
              />
            </div>
            <button
              onClick={resetToToday}
              className="bg-slate-800 hover:bg-black text-white px-5 py-2.5 rounded-xl h-[50px]"
            >
              Reset to Today
            </button>
            <button
              onClick={exportToCSV}
              className="ml-auto bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl h-[50px]"
            >
              Export to CSV
            </button>
          </div>
        )}
      </div>

      {/* ====================== STATS ====================== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-m4 text-slate-500">Total Scans</p>
          <p className="text-6xl font-bold text-slate-900 mt-2">{totalScans}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-m4 text-slate-500">Total Duplicates</p>
          <p className="text-6xl font-bold text-red-600 mt-2">{totalDuplicates}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <p className="text-m4 text-slate-500">Total Unique Scans</p>
          <p className="text-6xl font-bold text-blue-600 mt-2">{totalUnique}</p>
        </div>
      </div>

      {/* ====================== DELETE OLD SCANS ====================== */}
      <div className="mb-8 border border-slate-200 rounded-2xl p-6 bg-white shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Delete Old Scans</h3>
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm text-slate-500 mb-1.5">Delete scans older than:</label>
            <select id="delete-days" className="w-full border border-slate-950 rounded-xl px-4 py-3 text-slate bg-white">
              <option value="7" className="text-slate-500">7 days</option>
              <option value="30" className="text-slate-500">30 days</option>
              <option value="90" className="text-slate-500">90 days</option>
              <option value="0" className="text-slate-500">All scans</option>
            </select>
          </div>
          <button
            onClick={async () => {
              const select = document.getElementById('delete-days') as HTMLSelectElement;
              const days = parseInt(select.value);
              const msg = days === 0 
                ? "Delete ALL scans permanently?" 
                : `Delete scans older than ${days} days?`;

              if (!confirm(msg)) return;

              const { error } = await deleteOldScans(days);
              if (error) {
                alert('Failed to delete scans');
              } else {
                alert('Scans deleted successfully');
                window.location.reload();
              }
            }}
            className="bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-xl font-semibold"
          >
            Delete Selected Scans
          </button>
        </div>
      </div>

      {/* ====================== SCANNER INPUT ====================== */}
      <input
        type="text"
        autoFocus
        className="w-full bg-white p-5 text-2xl border border-slate-300 rounded-2xl mb-8 focus:outline-none focus:border-slate-900 text-slate-950"
        placeholder="Scan or type label and press Enter"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleScan(label)}
      />

     
     {/* ====================== RECENT SCANS TABLE ====================== */}
      <h2 className="text-2xl font-semibold mb-4 text-slate-900">
        {isSearching 
        ? `Search Results for "${searchTerm}"` 
        : `Scans from ${startDate} to ${endDate}`}
      </h2>
  
      <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-sm">
        <table className="w-full text-left">
          <thead className="bg-slate-800 text-white">
            <tr>
              <th className="p-4 font-semibold">Label</th>
              <th className="p-4 font-semibold">Time Scanned</th>
              <th className="p-4 font-semibold">Status</th>
              <th className="p-4 font-semibold w-24">Action</th>
            </tr>
          </thead>
          <tbody>
            {paginatedScans.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-slate-500">
                  No scans in this date range
                </td>
              </tr>
            ) : (
              paginatedScans.map((scan, index) => (
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
                  <td className="p-4">
                    <button
                      onClick={() => deleteSingleScan(scan.id)}
                      className="text-red-600 hover:text-red-800 font-medium text-sm"
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
  
      {/* Pagination Controls */}
      {paginatedScans.length > 0 && totalPages > 1 && (
        <div className="flex justify-between items-center mt-4">
          <button
            onClick={() => setCurrentPage(Math.max(currentPage - 1, 1))}
            disabled={currentPage === 1}
            className="px-4 py-2 bg-white border border-slate-300 rounded-xl disabled:opacity-50 hover:bg-slate-100 text-slate-950"
          >
            ← Previous
          </button>
  
          <span className="text-slate-600">
            Page {currentPage} of {totalPages}
          </span>
  
          <button
            onClick={() => setCurrentPage(Math.min(currentPage + 1, totalPages))}
            disabled={currentPage === totalPages}
            className="px-4 py-2 bg-white border border-slate-300 rounded-xl disabled:opacity-50 hover:bg-slate-100 text-slate-950"
          >
            Next →
          </button>
        </div>
      )}
      </div>
  )}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInAppTimezone } from '@/lib/dates';

type ChannelFile = {
  id: string;
  channel: 'shopee' | 'tiktok' | 'lazada';
  filename: string;
  row_count: number;
  uploaded_at: string;
};

const VISIBLE_FILES = 40;
const OPEN_STORAGE_KEY = 'channels-panel-open';

const CHANNELS = [
  { id: 'shopee', label: 'Shopee' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'lazada', label: 'Lazada' },
] as const;

export default function ChannelUploads({
  refreshToken,
  onChanged,
  notify,
}: {
  refreshToken: number;
  onChanged: () => void;
  notify: (type: 'success' | 'error', message: string) => void;
}) {
  const shopeeRef = useRef<HTMLInputElement>(null);
  const tiktokRef = useRef<HTMLInputElement>(null);
  const lazadaRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ChannelFile[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [uploading, setUploading] = useState<'shopee' | 'tiktok' | 'lazada' | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(OPEN_STORAGE_KEY) === '0') setOpen(false);
    } catch {
      // Keep the panel open when storage is unavailable.
    }
  }, []);

  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(OPEN_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // The choice still applies for this visit.
      }
      return next;
    });
  };

  const loadFiles = useCallback(async () => {
    const { count, error: countError } = await supabase
      .from('channel_files')
      .select('id', { count: 'exact', head: true });
    if (countError) throw countError;

    const { data, error } = await supabase
      .from('channel_files')
      .select('id,channel,filename,row_count,uploaded_at')
      .order('uploaded_at', { ascending: false })
      .limit(VISIBLE_FILES);
    if (error) throw error;

    setFiles((data ?? []) as ChannelFile[]);
    setHiddenCount(Math.max(0, (count ?? 0) - (data?.length ?? 0)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadFiles().catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : 'Failed to load channel files';
      notify('error', message);
    });
    return () => {
      cancelled = true;
    };
  }, [loadFiles, notify, refreshToken]);

  useEffect(() => {
    const channel = supabase
      .channel('channel-files')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'channel_files' }, () => {
        loadFiles().catch(() => undefined);
        onChanged();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadFiles, onChanged]);

  const upload = async (channel: 'shopee' | 'tiktok' | 'lazada', file: File) => {
    setUploading(channel);
    setWarning(null);
    try {
      const { parseChannelFile } = await import('@/lib/channel-orders');
      const parsed = await parseChannelFile(file, channel);
      const { data, error } = await supabase.rpc('add_channel_orders', {
        p_channel: channel,
        p_filename: file.name,
        p_orders: parsed.orders,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { row_count: number } | undefined;
      const count = row?.row_count ?? parsed.orders.length;
      const notes: string[] = [];
      if (parsed.skippedRounded > 0) {
        notes.push(
          `${parsed.skippedRounded} long ${parsed.skippedRounded === 1 ? 'number was' : 'numbers were'} rounded by Excel. Format those columns as text and upload the file again.`,
        );
      }
      if (parsed.skippedNoDeadline > 0) {
        notes.push(
          `${parsed.skippedNoDeadline} ${parsed.skippedNoDeadline === 1 ? 'row has' : 'rows have'} no ship-by time yet.`,
        );
      }
      setWarning(notes.length > 0 ? notes.join(' ') : null);
      notify('success', `Added ${file.name} · ${count} orders.`);
      await loadFiles();
      onChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload channel file';
      notify('error', message);
    } finally {
      setUploading(null);
      if (channel === 'shopee' && shopeeRef.current) shopeeRef.current.value = '';
      if (channel === 'tiktok' && tiktokRef.current) tiktokRef.current.value = '';
    }
  };

  const remove = async (file: ChannelFile) => {
    if (!confirm(`Remove ${file.filename}? Its orders will no longer count toward the ship-by totals.`)) return;
    const { error } = await supabase.from('channel_files').delete().eq('id', file.id);
    if (error) {
      notify('error', 'Failed to remove channel file');
      return;
    }
    notify('success', `Removed ${file.filename}`);
    await loadFiles();
    onChanged();
  };

  const fileCount = files.length + hiddenCount;
  const inputFor = { shopee: shopeeRef, tiktok: tiktokRef, lazada: lazadaRef } as const;

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-800">Channel orders</h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="rounded-lg px-2 py-1 text-sm font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open ? (
        <>
          <p className="mt-3 text-sm text-slate-500">
            Upload Shopee, TikTok, and Lazada exports. The same order number stays one order
            across every file, including orders that have already moved to Sent. Shopee is due
            by its ship-before time. TikTok orders from 15:00 onward are due the next day, and
            Sunday moves to Monday. Lazada is due by Promised Shipping Time. Instant and same-day
            come from Opsi Pengiriman on Shopee and Shipping Provider Name on TikTok.
          </p>
          <div className="mt-3 grid gap-2">
            {CHANNELS.map((channel) => (
              <div key={channel.id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-700">{channel.label}</span>
                <input
                  ref={inputFor[channel.id]}
                  type="file"
                  accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void upload(channel.id, file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => inputFor[channel.id].current?.click()}
                  disabled={uploading !== null}
                  className="rounded-xl bg-slate-800 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50"
                >
                  {uploading === channel.id ? 'Reading…' : 'Upload'}
                </button>
              </div>
            ))}
          </div>

          {warning && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>
          )}

          {files.length > 0 && (
            <ul className="mt-4 max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100">
              {files.map((file) => (
                <li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{file.filename}</p>
                    <p className="text-xs text-slate-500">
                      {file.channel === 'shopee' ? 'Shopee' : file.channel === 'tiktok' ? 'TikTok' : 'Lazada'}
                      {' · '}
                      {file.row_count.toLocaleString()} orders · {formatInAppTimezone(file.uploaded_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void remove(file)}
                    className="shrink-0 text-sm font-medium text-slate-500 transition hover:text-rose-700"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {hiddenCount > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {hiddenCount} older {hiddenCount === 1 ? 'file is' : 'files are'} still used.
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-500">
          {fileCount === 0
            ? 'No channel files uploaded'
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} kept for ship-by totals`}
        </p>
      )}
    </section>
  );
}

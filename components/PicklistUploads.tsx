'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInAppTimezone } from '@/lib/dates';

type PicklistFile = {
  id: string;
  filename: string;
  row_count: number;
  uploaded_at: string;
};

const VISIBLE_FILES = 8;

export default function PicklistUploads({
  refreshToken,
  onChanged,
  notify,
}: {
  refreshToken: number;
  onChanged: () => void;
  notify: (type: 'success' | 'error', message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PicklistFile[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    const { count, error: countError } = await supabase
      .from('picklist_files')
      .select('id', { count: 'exact', head: true });
    if (countError) throw countError;

    const { data, error } = await supabase
      .from('picklist_files')
      .select('id,filename,row_count,uploaded_at')
      .order('uploaded_at', { ascending: false })
      .limit(VISIBLE_FILES);
    if (error) throw error;

    setFiles((data ?? []) as PicklistFile[]);
    setHiddenCount(Math.max(0, (count ?? 0) - (data?.length ?? 0)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadFiles().catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : 'Failed to load picklists';
      notify('error', message);
    });
    return () => {
      cancelled = true;
    };
  }, [loadFiles, notify, refreshToken]);

  useEffect(() => {
    const channel = supabase
      .channel('picklist-files')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picklist_files' }, () => {
        loadFiles().catch(() => undefined);
        onChanged();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadFiles, onChanged]);

  const upload = async (file: File) => {
    setUploading(true);
    setWarning(null);
    try {
      const { parsePicklistFile } = await import('@/lib/picklist');
      const parsed = await parsePicklistFile(file);
      const { data, error } = await supabase.rpc('add_picklist', {
        p_filename: file.name,
        p_entries: parsed.entries,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { row_count: number } | undefined;
      const count = row?.row_count ?? parsed.entries.length;
      if (parsed.skippedRounded > 0) {
        setWarning(
          `${parsed.skippedRounded} resi ${parsed.skippedRounded === 1 ? 'number was' : 'numbers were'} rounded by Excel. Format column C as text and upload that file again.`,
        );
      }
      notify('success', `Added ${file.name} · ${count} orders. Earlier picklists were kept.`);
      await loadFiles();
      onChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload picklist';
      notify('error', message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (file: PicklistFile) => {
    if (!confirm(`Remove ${file.filename}? Scans will no longer match orders from this file.`)) return;
    const { error } = await supabase.from('picklist_files').delete().eq('id', file.id);
    if (error) {
      notify('error', 'Failed to remove picklist');
      return;
    }
    notify('success', `Removed ${file.filename}`);
    await loadFiles();
    onChanged();
  };

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Picklists</h2>
          <p className="mt-1 text-sm text-slate-500">
            Column C is the resi you scan. Column H is the order number. New files are added to the
            ones already uploaded.
          </p>
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:opacity-50"
          >
            {uploading ? 'Reading…' : 'Upload picklist'}
          </button>
        </div>
      </div>

      {warning && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>
      )}

      {files.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{file.filename}</p>
                <p className="text-xs text-slate-500">
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
          {hiddenCount} older {hiddenCount === 1 ? 'file is' : 'files are'} still used for matching.
        </p>
      )}
    </section>
  );
}

'use client';

import { useEffect } from 'react';

interface DuplicateModalProps {
  label: string;
  onClose: () => void;
}

export default function DuplicateModal({ label, onClose }: DuplicateModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Duplicate label warning"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-slate-900 p-8 text-center shadow-2xl sm:p-12"
      >
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-rose-500/15 text-4xl">
          ⚠️
        </div>
        <h2 className="text-2xl font-bold text-white sm:text-3xl">Duplicate label</h2>

        <div className="my-6 rounded-2xl bg-slate-800 p-4">
          <p className="break-all font-mono text-lg text-rose-300 sm:text-xl">{label}</p>
        </div>

        <p className="mb-7 text-sm text-slate-400 sm:text-base">
          This label has already been scanned.
        </p>

        <button
          onClick={onClose}
          autoFocus
          className="w-full rounded-2xl bg-rose-600 px-8 py-4 text-base font-bold text-white transition-colors hover:bg-rose-700 sm:text-lg"
        >
          Acknowledge & continue
        </button>
      </div>
    </div>
  );
}

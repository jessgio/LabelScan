'use client';

interface DuplicateModalProps {
  label: string;
  onClose: () => void;
}

export default function DuplicateModal({ label, onClose }: DuplicateModalProps) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-12 text-center max-w-lg shadow-2xl">
        <div className="text-7xl mb-4">⚠️</div>
        <h2 className="text-5xl font-bold text-white mb-3">DUPLICATE LABEL</h2>
        
        <div className="my-8 p-4 bg-slate-800 rounded-xl">
          <p className="font-mono text-2xl text-red-400 break-all">{label}</p>
        </div>

        <p className="text-xl text-slate-400 mb-8">
          This label has already been scanned before.
        </p>

        <button
          onClick={onClose}
          className="bg-red-600 hover:bg-red-700 text-white px-12 py-4 rounded-xl text-xl font-bold transition-colors"
        >
          ACKNOWLEDGE & CLOSE
        </button>
      </div>
    </div>
  );
}
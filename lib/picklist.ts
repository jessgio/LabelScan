import * as XLSX from 'xlsx';

// Daftar Picklist keeps the scanned resi in Excel column C and the order
// number in column H. Product titles and the NO RESI / NO ORDER headings sit
// on other rows in those same columns, so only code-like pairs are kept.
const RESI_COLUMN = 2;
const ORDER_COLUMN = 7;
const MAX_ROWS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

const HEADER = new Set([
  'NO RESI',
  'NO. RESI',
  'NORESI',
  'RESI',
  'NO ORDER',
  'NO. ORDER',
  'NOORDER',
  'ORDER',
  'BARANG',
  'FOTO',
  'LOKASI/RAK',
  'QTY PESAN',
  'QTY AMBIL',
]);

export type PicklistEntry = {
  resi: string;
  order_number: string;
};

export type PicklistParse = {
  entries: PicklistEntry[];
  skippedRounded: number;
};

type CellRead = { text: string; rounded: boolean };

function readCell(sheet: XLSX.WorkSheet, row: number, column: number): CellRead {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null || cell.v === '') return { text: '', rounded: false };

  // Excel stores long resi numbers as floats and rounds them. A rounded key
  // would never match a scan, so those rows are reported instead of stored.
  if (cell.t === 'n' && typeof cell.v === 'number' && Math.abs(cell.v) >= 1e15) {
    return { text: '', rounded: true };
  }

  if (typeof cell.w === 'string' && cell.w.trim() !== '') {
    return { text: cell.w.trim(), rounded: false };
  }
  return { text: String(cell.v).trim(), rounded: false };
}

function isCode(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.length > 200) return false;
  if (/\s/.test(trimmed)) return false;
  if (!/\d/.test(trimmed)) return false;
  return !HEADER.has(trimmed.toUpperCase());
}

export function parsePicklistWorkbook(workbook: XLSX.WorkBook): PicklistParse {
  const byResi = new Map<string, string>();
  let skippedRounded = 0;

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);

    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const resi = readCell(sheet, row, RESI_COLUMN);
      const order = readCell(sheet, row, ORDER_COLUMN);
      if (resi.rounded || order.rounded) {
        skippedRounded += 1;
        continue;
      }
      if (!isCode(resi.text) || !isCode(order.text)) continue;
      byResi.set(resi.text.trim().toUpperCase(), order.text.trim());
    }
  }

  if (byResi.size > MAX_ROWS) {
    throw new Error('This picklist has too many rows.');
  }

  return {
    entries: [...byResi.entries()].map(([resi, order_number]) => ({ resi, order_number })),
    skippedRounded,
  };
}

export async function parsePicklistFile(file: File): Promise<PicklistParse> {
  if (file.size > MAX_BYTES) {
    throw new Error('Picklist files must be 8 MB or smaller.');
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
    throw new Error('Upload an Excel or CSV picklist.');
  }

  const bytes = await file.arrayBuffer();
  const workbook = name.endsWith('.csv')
    ? XLSX.read(new TextDecoder().decode(bytes), { type: 'string' })
    : XLSX.read(bytes, { type: 'array', cellDates: false });

  const parsed = parsePicklistWorkbook(workbook);
  if (parsed.entries.length === 0) {
    throw new Error('No resi and order pairs found in columns C and H.');
  }
  return parsed;
}

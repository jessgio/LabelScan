import * as XLSX from 'xlsx';
import { APP_TIMEZONE, shiftDay, zonedWallTimeToUtc } from './dates';

export type ChannelOrder = {
  order_number: string;
  resi: string | null;
  due_at: string;
};

export type ChannelParse = {
  orders: ChannelOrder[];
  skippedRounded: number;
  skippedNoDeadline: number;
};

type RawCell = { text: string; rounded: boolean; number: number | null };
type WallClock = { day: string; time: string };

const MAX_SCANNED_ROWS = 50_000;
const MAX_ORDERS = 20_000;
const MAX_BYTES = 12 * 1024 * 1024;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

const EMPTY_CODE = new Set(['', '-', '—', 'N/A', 'NA', 'NULL']);

export function isCodPayment(method: string) {
  const value = method.trim().toLowerCase().replace(/\s+/g, ' ');
  return value.includes('bayar di tempat') || value === 'cash on delivery' || value === 'cod';
}

export function weekdayOfCivilDay(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

/** Orders at or after 15:00 are due the next civil day. Sunday is closed, so that due day moves to Monday. */
export function tiktokDueIso(day: string, time: string, timeZone = APP_TIMEZONE) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error('Invalid TikTok time');
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  let dueDay = seconds >= 15 * 3600 ? shiftDay(day, 1) : day;
  if (weekdayOfCivilDay(dueDay) === 0) dueDay = shiftDay(dueDay, 1);
  return zonedWallTimeToUtc(dueDay, '23:59:59', timeZone).toISOString();
}

export function wallToIso(day: string, time: string, timeZone = APP_TIMEZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    throw new Error('Invalid deadline');
  }
  return zonedWallTimeToUtc(day, time, timeZone).toISOString();
}

export function parseWallClock(raw: string): WallClock | null {
  const value = raw.trim();
  if (!value || EMPTY_CODE.has(value.toUpperCase())) return null;

  const iso =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/.exec(value);
  if (iso) {
    return {
      day: `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`,
      time: `${pad(Number(iso[4] ?? 0))}:${pad(Number(iso[5] ?? 0))}:${pad(Number(iso[6] ?? 0))}`,
    };
  }

  const local =
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/.exec(value);
  if (!local) return null;

  let day = Number(local[1]);
  let month = Number(local[2]);
  const year = Number(local[3]);
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return {
    day: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(Number(local[4] ?? 0))}:${pad(Number(local[5] ?? 0))}:${pad(Number(local[6] ?? 0))}`,
  };
}

export function excelSerialToWall(serial: number): WallClock | null {
  if (!Number.isFinite(serial) || serial < 20_000 || serial > 80_000) return null;
  const utc = new Date(EXCEL_EPOCH_MS + Math.round(serial * 86_400_000));
  if (Number.isNaN(utc.getTime())) return null;
  return {
    day: utc.toISOString().slice(0, 10),
    time: utc.toISOString().slice(11, 19),
  };
}

function headerName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readCell(sheet: XLSX.WorkSheet, row: number, column: number): RawCell {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null || cell.v === '') return { text: '', rounded: false, number: null };

  if (cell.t === 'n' && typeof cell.v === 'number') {
    const integerLike = Math.abs(cell.v) >= 1e12 && Math.abs(cell.v - Math.round(cell.v)) < 1e-6;
    if (integerLike && !Number.isSafeInteger(Math.round(cell.v))) {
      return { text: '', rounded: true, number: null };
    }
    const text = typeof cell.w === 'string' && cell.w.trim() ? cell.w.trim() : String(cell.v);
    return { text, rounded: false, number: cell.v };
  }

  if (typeof cell.w === 'string' && cell.w.trim()) return { text: cell.w.trim(), rounded: false, number: null };
  return { text: String(cell.v).trim(), rounded: false, number: null };
}

function readWall(cell: RawCell): WallClock | null {
  if (cell.number != null && cell.number >= 20_000 && cell.number < 80_000) {
    return excelSerialToWall(cell.number);
  }
  return parseWallClock(cell.text);
}

function cleanCode(text: string) {
  const value = text.trim().toUpperCase();
  if (EMPTY_CODE.has(value)) return null;
  if (value.length < 6 || value.length > 200) return null;
  if (/\s/.test(value) || !/\d/.test(value)) return null;
  return value;
}

function columnIndex(headers: string[], match: (header: string) => boolean) {
  return headers.findIndex((header) => Boolean(header) && match(header));
}

function headersOf(sheet: XLSX.WorkSheet, row: number, range: XLSX.Range) {
  const headers: string[] = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    headers[column] = headerName(readCell(sheet, row, column).text);
  }
  return headers;
}

function shopeeColumns(headers: string[]) {
  const order = columnIndex(
    headers,
    (header) => header === 'no. pesanan' || header === 'no pesanan' || header === 'nomor pesanan',
  );
  const resi = columnIndex(
    headers,
    (header) =>
      header === 'no. resi' ||
      header === 'no resi' ||
      header === 'nomor resi' ||
      header.startsWith('no. resi ') ||
      header.startsWith('no resi '),
  );
  const due = columnIndex(headers, (header) => header.includes('pesanan harus dikirimkan'));
  if (order < 0 || resi < 0 || due < 0) return null;
  return { order, resi, due };
}

function tiktokColumns(headers: string[]) {
  const order = columnIndex(headers, (header) => header === 'order id');
  const tracking = columnIndex(headers, (header) => header === 'tracking id');
  const payment = columnIndex(headers, (header) => header === 'payment method');
  const created = columnIndex(headers, (header) => header === 'created time');
  const paid = columnIndex(headers, (header) => header === 'paid time');
  if (order < 0 || payment < 0 || created < 0 || paid < 0) return null;
  return { order, tracking, payment, created, paid };
}

function remember(
  orders: Map<string, ChannelOrder>,
  orderNumber: string,
  resi: string | null,
  dueAt: string,
) {
  const previous = orders.get(orderNumber);
  orders.set(orderNumber, {
    order_number: orderNumber,
    resi: resi ?? previous?.resi ?? null,
    due_at: dueAt,
  });
}

export function parseChannelWorkbook(
  workbook: XLSX.WorkBook,
  channel: 'shopee' | 'tiktok',
): ChannelParse {
  const orders = new Map<string, ChannelOrder>();
  let skippedRounded = 0;
  let skippedNoDeadline = 0;
  let scannedRows = 0;
  let foundHeader = false;

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const lastHeaderRow = Math.min(range.e.r, range.s.r + 40);

    for (let row = range.s.r; row <= lastHeaderRow; row += 1) {
      const headers = headersOf(sheet, row, range);
      const shopee = channel === 'shopee' ? shopeeColumns(headers) : null;
      const tiktok = channel === 'tiktok' ? tiktokColumns(headers) : null;
      if (!shopee && !tiktok) continue;
      foundHeader = true;

      for (let dataRow = row + 1; dataRow <= range.e.r; dataRow += 1) {
        scannedRows += 1;
        if (scannedRows > MAX_SCANNED_ROWS) throw new Error('This export has too many rows.');

        if (shopee) {
          const orderCell = readCell(sheet, dataRow, shopee.order);
          const resiCell = readCell(sheet, dataRow, shopee.resi);
          const dueCell = readCell(sheet, dataRow, shopee.due);
          if (orderCell.rounded) {
            skippedRounded += 1;
            continue;
          }
          const orderNumber = cleanCode(orderCell.text);
          if (!orderNumber) continue;
          if (resiCell.rounded) skippedRounded += 1;
          const wall = readWall(dueCell);
          if (!wall) {
            skippedNoDeadline += 1;
            continue;
          }
          remember(
            orders,
            orderNumber,
            resiCell.rounded ? null : cleanCode(resiCell.text),
            wallToIso(wall.day, wall.time),
          );
          continue;
        }

        if (!tiktok) continue;
        const orderCell = readCell(sheet, dataRow, tiktok.order);
        if (orderCell.rounded) {
          skippedRounded += 1;
          continue;
        }
        const orderNumber = cleanCode(orderCell.text);
        if (!orderNumber) continue;

        const payment = readCell(sheet, dataRow, tiktok.payment).text;
        const created = readCell(sheet, dataRow, tiktok.created);
        const paid = readCell(sheet, dataRow, tiktok.paid);
        const reference = isCodPayment(payment) ? created : paid;
        const wall = readWall(reference);
        if (!wall) {
          skippedNoDeadline += 1;
          continue;
        }

        const trackingCell = tiktok.tracking >= 0 ? readCell(sheet, dataRow, tiktok.tracking) : null;
        if (trackingCell?.rounded) skippedRounded += 1;
        remember(
          orders,
          orderNumber,
          trackingCell && !trackingCell.rounded ? cleanCode(trackingCell.text) : null,
          tiktokDueIso(wall.day, wall.time),
        );
      }
      break;
    }
    if (foundHeader) break;
  }

  if (!foundHeader) {
    throw new Error(
      channel === 'shopee'
        ? 'This Shopee file needs No. Pesanan, No. Resi, and Pesanan Harus Dikirimkan Sebelum.'
        : 'This TikTok file needs Order ID, Payment Method, Created Time, and Paid Time.',
    );
  }
  if (orders.size > MAX_ORDERS) throw new Error('This export has too many orders.');

  return { orders: [...orders.values()], skippedRounded, skippedNoDeadline };
}

export async function parseChannelFile(file: File, channel: 'shopee' | 'tiktok') {
  if (file.size > MAX_BYTES) throw new Error('Channel files must be 12 MB or smaller.');
  const name = file.name.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
    throw new Error('Upload an Excel or CSV export.');
  }

  const bytes = await file.arrayBuffer();
  const workbook = name.endsWith('.csv')
    ? XLSX.read(new TextDecoder().decode(bytes), { type: 'string' })
    : XLSX.read(bytes, { type: 'array', cellDates: false });
  const parsed = parseChannelWorkbook(workbook, channel);
  if (parsed.orders.length === 0) throw new Error('No orders with a ship-by time were found.');
  return parsed;
}

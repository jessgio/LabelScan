import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  excelSerialToWall,
  isCodPayment,
  parseChannelWorkbook,
  tiktokDueIso,
  wallToIso,
} from '../lib/channel-orders.ts';

assert.equal(isCodPayment('Bayar di tempat'), true);
assert.equal(isCodPayment('  BAYAR DI TEMPAT '), true);
assert.equal(isCodPayment('Transfer'), false);

// Friday 15:00 is due Saturday. Saturday 15:00 and Sunday morning are due Monday.
assert.equal(tiktokDueIso('2026-10-02', '15:00:00'), wallToIso('2026-10-03', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-02', '14:59:59'), wallToIso('2026-10-02', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-03', '14:59:59'), wallToIso('2026-10-03', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-03', '15:00:00'), wallToIso('2026-10-05', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-04', '10:00:00'), wallToIso('2026-10-05', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-04', '15:00:00'), wallToIso('2026-10-05', '23:59:59'));
assert.equal(tiktokDueIso('2026-10-05', '09:00:00'), wallToIso('2026-10-05', '23:59:59'));

const shopeeRows = [
  ['Laporan Pesanan'],
  [
    'No. Pesanan',
    'No. Resi',
    'Pesanan Harus Dikirimkan Sebelum (Menghindari keterlambatan)',
    'Nama Produk',
  ],
  ['261002ABCDEFGH', 'JY1234567890', '2026-10-03 18:00:00', 'Gel'],
  ['261002ABCDEFGH', '', '03/10/2026 19.30', 'Gel refill'],
  ['261002NORESIII', '-', '03-10-2026 12:00:00', 'Instant'],
  ['261002LATERXX', 'JY9988776655', '2026-10-04 23:59:59', 'Tomorrow'],
];
const shopeeSheet = XLSX.utils.aoa_to_sheet(shopeeRows);
const serial = (Date.UTC(2026, 9, 3, 8, 15, 0) - Date.UTC(1899, 11, 30)) / 86_400_000;
const serialRow = shopeeRows.length;
shopeeSheet[XLSX.utils.encode_cell({ r: serialRow, c: 0 })] = { t: 's', v: '261002SERIAL1' };
shopeeSheet[XLSX.utils.encode_cell({ r: serialRow, c: 1 })] = { t: 's', v: 'JY1122334455' };
shopeeSheet[XLSX.utils.encode_cell({ r: serialRow, c: 2 })] = { t: 'n', v: serial };
const range = XLSX.utils.decode_range(shopeeSheet['!ref'] ?? 'A1');
range.e.r = serialRow;
shopeeSheet['!ref'] = XLSX.utils.encode_range(range);

const shopee = parseChannelWorkbook(
  { SheetNames: ['orders'], Sheets: { orders: shopeeSheet } },
  'shopee',
);
const byOrder = new Map(shopee.orders.map((order) => [order.order_number, order]));
assert.equal(byOrder.size, 4);
assert.equal(byOrder.get('261002ABCDEFGH')?.resi, 'JY1234567890');
assert.equal(byOrder.get('261002ABCDEFGH')?.due_at, wallToIso('2026-10-03', '19:30:00'));
assert.equal(byOrder.get('261002NORESIII')?.resi, null);
assert.equal(byOrder.get('261002NORESIII')?.due_at, wallToIso('2026-10-03', '12:00:00'));
assert.equal(byOrder.get('261002LATERXX')?.due_at, wallToIso('2026-10-04', '23:59:59'));
assert.equal(byOrder.get('261002SERIAL1')?.due_at, wallToIso('2026-10-03', '08:15:00'));
assert.deepEqual(excelSerialToWall(serial), { day: '2026-10-03', time: '08:15:00' });

const tiktokRows = [
  ['Order ID', 'Tracking ID', 'Payment Method', 'Created Time', 'Paid Time', 'Seller SKU'],
  ['586373837435077921', 'JY1839194946', 'Transfer', '02/10/2026 10:00:00', '02/10/2026 16:00:00', 'A'],
  ['586373837435077921', 'JY1839194946', 'Transfer', '02/10/2026 10:00:00', '02/10/2026 16:00:00', 'B'],
  ['111122223333444455', '', 'Bayar di tempat', '03/10/2026 15:00:00', '', 'C'],
  ['222233334444555566', 'GTL123456789', 'Bayar di tempat', '03/10/2026 14:00:00', '', 'D'],
  ['333344445555666677', '', 'Credit card', '03/10/2026 09:00:00', '', 'E'],
];
const tiktok = parseChannelWorkbook(
  { SheetNames: ['Orders'], Sheets: { Orders: XLSX.utils.aoa_to_sheet(tiktokRows) } },
  'tiktok',
);
const tiktokByOrder = new Map(tiktok.orders.map((order) => [order.order_number, order]));
assert.equal(tiktok.orders.length, 3);
assert.equal(tiktok.skippedNoDeadline, 1);
assert.equal(tiktokByOrder.get('586373837435077921')?.resi, 'JY1839194946');
assert.equal(tiktokByOrder.get('586373837435077921')?.due_at, wallToIso('2026-10-03', '23:59:59'));
assert.equal(tiktokByOrder.get('111122223333444455')?.due_at, wallToIso('2026-10-05', '23:59:59'));
assert.equal(tiktokByOrder.get('222233334444555566')?.due_at, wallToIso('2026-10-03', '23:59:59'));
assert.equal(tiktokByOrder.has('333344445555666677'), false);

console.log('channel order parser ok');

import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parsePicklistWorkbook } from '../lib/picklist.ts';

const rows: (string | number | null)[][] = [
  ['PT. Inovasi Alam Nusantara', null, 'Daftar Picklist'],
  ['NO. PICKLIST', 'TANGGAL PICKLIST', 'BARANG', null, null, null, null, 'FOTO'],
  [
    'PICK-0000228870',
    '03/10/2026 09.02.01',
    'FCR-TGV-BARRIERMOISTUREGEL-50ML - From This Island Tropical Guava',
    null,
    null,
    null,
    null,
    'Gudang Finished Goods',
  ],
  [null, null, 'NO RESI', null, null, null, null, 'NO ORDER'],
  [null, null, 'SD-2-0HY7CRH3H1SLZ4LSESH5', null, null, null, null, 'SP-261002J9DH6K1'],
  [null, null, 'sd-2-0hy7crh3h1slz4lsesh5', null, null, null, null, 'SP-261002NEWER'],
  [null, null, 'GK-11-894535116', null, null, null, null, 'SP-261002JTDS8DC5'],
  [null, null, 4668233206, null, null, null, null, 'SP-261002NUMERIC'],
];

const sheet = XLSX.utils.aoa_to_sheet(rows);
// A 19-digit resi stored as a number is rounded by Excel and must be skipped.
const rounded = XLSX.utils.encode_cell({ r: rows.length, c: 2 });
const order = XLSX.utils.encode_cell({ r: rows.length, c: 7 });
sheet[rounded] = { t: 'n', v: 3287147827578880500 };
sheet[order] = { t: 's', v: 'SP-261003ROUNDED' };
const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
range.e.r = rows.length;
sheet['!ref'] = XLSX.utils.encode_range(range);

const parsed = parsePicklistWorkbook({ SheetNames: ['Picklist'], Sheets: { Picklist: sheet } });
const byResi = new Map(parsed.entries.map((entry) => [entry.resi, entry.order_number]));

assert.equal(parsed.skippedRounded, 1);
assert.equal(byResi.get('SD-2-0HY7CRH3H1SLZ4LSESH5'), 'SP-261002NEWER');
assert.equal(byResi.get('GK-11-894535116'), 'SP-261002JTDS8DC5');
assert.equal(byResi.get('4668233206'), 'SP-261002NUMERIC');
assert.equal(byResi.has('FCR-TGV-BARRIERMOISTUREGEL-50ML - FROM THIS ISLAND TROPICAL GUAVA'), false);
assert.equal(parsed.entries.length, 3);

console.log('picklist parser ok');

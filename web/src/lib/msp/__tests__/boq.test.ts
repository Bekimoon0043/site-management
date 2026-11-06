// "Schedule is the BoQ" format: custom Unit / Qty / Rate / Amount columns (synthetic fixture, same shape as the client's file).
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import {
  boqColumnOf, customNumber, detectEmbeddedBoq, embeddedBoqRows, isSubItemName, normalizeUnit, parseMspdi, toImportPayload, type ParseOptions,
} from '../index';

const DP = DOMParser as unknown as ParseOptions['DOMParser'];
const xml = readFileSync(new URL('./fixtures/boq-in-schedule.xml', import.meta.url), 'utf8');
const s = parseMspdi(xml, 'boq-in-schedule.xml', { DOMParser: DP });
const T = (uid: number) => s.tasks.find((t) => t.uid === uid)!;

describe('MSPDI custom fields', () => {
  it('dedupes duplicate custom field definitions (Cost1 "Amount" defined twice)', () => {
    expect(s.custom_fields).toEqual([
      { field_id: 188743731, field_name: 'Text1', alias: 'Unit' }, { field_id: 188743767, field_name: 'Number1', alias: 'Qty' },
      { field_id: 188743768, field_name: 'Number2', alias: 'Rate' }, { field_id: 188743786, field_name: 'Cost1', alias: 'Amount' },
    ]);
  });
  it('scales custom Cost fields by currencyScale like task Cost; Number / Text are left as written', () => {
    expect(T(5).custom).toEqual({ Text1: 'm³', Number1: '850', Number2: '180', Cost1: '175950' });
    expect(T(5).cost).toBe(175950);
    const raw = parseMspdi(xml, 'x.xml', { DOMParser: DP, currencyScale: 1 });
    expect(raw.tasks.find((t) => t.uid === 5)!.custom.Cost1).toBe('17595000');
  });
  it('sends custom values (already scaled) with the import payload', () => {
    const p = toImportPayload(s, { op_id: 'o', project_id: 'p' });
    expect(p.schedule.tasks.find((t) => t.uid === 11)!.custom).toMatchObject({ Number1: '420', Number2: '6500', Cost1: '3139500' });
    expect(p.schedule.custom_fields).toHaveLength(4);
  });
});

describe('detectEmbeddedBoq', () => {
  const d = detectEmbeddedBoq(s);
  it('finds the columns by alias and measures VAT from the leaves (summaries ignored)', () => {
    expect(d).toEqual({
      unitField: 'Text1', qtyField: 'Number1', rateField: 'Number2', amountField: 'Cost1',
      leafWithQty: 14, subItems: 7, vatFactor: 1.15, vatIncluded: true, vatPct: 15, consistency: 1,
      totalExVat: 16002000, totalAmount: 18402300, confidence: 'high',
    });
  });
  it('recognises alias variants (English, Amharic) and ignores unrelated fields', () => {
    for (const [a, c] of [['Unit', 'unit'], ['UoM', 'unit'], ['U.O.M', 'unit'], ['Unit of measure', 'unit'], ['መለኪያ', 'unit'],
      ['QTY', 'qty'], ['Quantity', 'qty'], ['Qty.', 'qty'], ['መጠን', 'qty'], ['Rate', 'rate'], ['Unit rate', 'rate'], ['Unit Price (ETB)', 'rate'],
      ['Rate (excl. VAT)', 'rate'], ['ነጠላ ዋጋ', 'rate'], ['Amount', 'amount'], ['Total', 'amount'], ['Amount (incl. VAT)', 'amount'], ['ጠቅላላ ዋጋ', 'amount'],
      ['BoQ Code', null], ['Element Codes', null], [null, null]] as const) expect([a, boqColumnOf(a)]).toEqual([a, c]);
  });
  it('without VAT in the amount → factor 1, vatIncluded false', () => {
    const noVat = { custom_fields: s.custom_fields, tasks: s.tasks.map((t) => ({ ...t, custom: { ...t.custom,
      ...(t.is_summary || !t.custom.Number1 ? {} : { Cost1: String(Number(t.custom.Number1) * Number(t.custom.Number2)) }) } })) };
    expect(detectEmbeddedBoq(noVat)).toMatchObject({ vatFactor: 1, vatIncluded: false, vatPct: null, confidence: 'high' });
  });
  it('no such columns → confidence none', () => {
    expect(detectEmbeddedBoq({ custom_fields: [{ field_id: 1, field_name: 'Text1', alias: 'BoQ Code' }], tasks: s.tasks })).toMatchObject({
      qtyField: null, leafWithQty: 0, confidence: 'none' });
  });
  it('field override (user pick) wins', () => {
    expect(detectEmbeddedBoq(s, { rateField: null, amountField: 'Cost1' })).toMatchObject({ rateField: null, vatFactor: null, confidence: 'high' });
  });
});

describe('helpers', () => {
  it('normalises units (case, superscripts, variants)', () => {
    expect(['m2', 'M2', 'm²', 'sq.m', 'm3', 'M3', 'm³', 'cu.m', 'Kg', 'KG', 'No', 'no.', 'Nos', 'ml', 'ML', 'L.M', 'Lump sum', 'm', 'bag', '', null]
      .map(normalizeUnit)).toEqual(['m2', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm3', 'kg', 'kg', 'No', 'No', 'No', 'ml', 'ml', 'ml', 'LS', 'm', 'bag', null, null]);
  });
  it('reads numbers and sub-item markers', () => {
    expect([customNumber('1,234.50'), customNumber(' 45 '), customNumber(''), customNumber('abc'), customNumber(undefined)]).toEqual([1234.5, 45, null, null, null]);
    expect(['a) In Flat Mat slab', '(b) In retaining wall', 'iv) Roof', 'Bulk excavation', '1. EXCAVATION'].map(isSubItemName)).toEqual([true, true, true, false, false]);
  });
  it('previews the BoQ items: WBS item numbers, parent + name for a)/b) items, ex-VAT rates', () => {
    const rows = embeddedBoqRows(s, detectEmbeddedBoq(s), { vatIncluded: true, vatPct: 15 });
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ uid: 4, item_no: '1.1.1.1', description: 'Site clearing and removal of top soil to an average depth of 200mm.', unit: 'm2',
      qty: 1200, rate_ex_vat: 35, amount_ex_vat: 42000, amount_incl_vat: 48300, sub_item: false });
    expect(rows.find((r) => r.uid === 11)).toMatchObject({ item_no: '1.1.2.1.1', description: 'Concrete C-25 in… – a) In Flat Mat slab', unit: 'm3', qty: 420 });
    expect(rows.find((r) => r.uid === 14)).toMatchObject({ unit: 'kg', amount_incl_vat: 7452000 });
    expect(embeddedBoqRows(s, detectEmbeddedBoq(s), { descriptionMode: 'name' }).find((r) => r.uid === 11)!.description).toBe('a) In Flat Mat slab');
    // rate missing → derived from the amount (VAT removed)
    const noRate = embeddedBoqRows(s, { ...detectEmbeddedBoq(s), rateField: null }, { vatIncluded: true, vatPct: 15 });
    expect(noRate.find((r) => r.uid === 5)).toMatchObject({ rate_ex_vat: 180, amount_ex_vat: 153000 });
  });
});

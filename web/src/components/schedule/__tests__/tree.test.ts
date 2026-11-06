import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { parseMspdi, type ParseOptions } from '../../../lib/msp';
import { buildTree, flatten } from '../tree';
import { dayNo, dayStr, lateDays, normCode, type SchedTask } from '../data';

const xml = readFileSync(new URL('../../../../../docs/samples/demo-tower-schedule.xml', import.meta.url), 'utf8');
const s = parseMspdi(xml, 'demo-tower-schedule.xml', { DOMParser: DOMParser as unknown as ParseOptions['DOMParser'] });

describe('schedule tree', () => {
  const idx = new Map(s.tasks.map((t, i) => [t.uid, i]));
  const tree = buildTree(s.tasks.length, (i) => (s.tasks[i].parent_uid != null ? idx.get(s.tasks[i].parent_uid!) ?? -1 : -1));

  it('flattens the sample in outline order with depths', () => {
    const rows = flatten(tree, () => true, null);
    expect(rows).toHaveLength(s.tasks.length);
    expect(rows.map((r) => s.tasks[r.i].uid)).toEqual(s.tasks.map((t) => t.uid));
    for (const r of rows) expect(r.depth).toBe(s.tasks[r.i].outline_level - Math.min(...s.tasks.map((t) => t.outline_level)));
  });

  it('collapsing a summary hides its subtree', () => {
    const sum = s.tasks.findIndex((t) => t.is_summary);
    const rows = flatten(tree, (i) => i !== sum, null);
    const desc = (i: number): number => tree.children[i].reduce((n, c) => n + 1 + desc(c), 0);
    expect(rows).toHaveLength(s.tasks.length - desc(sum));
    expect(rows.find((r) => r.i === sum)?.expanded).toBe(false);
  });

  it('filters keep ancestors as context rows', () => {
    const leaf = s.tasks.findIndex((t) => !t.is_summary && t.parent_uid != null);
    const rows = flatten(tree, () => false, (i) => i === leaf);
    expect(rows[rows.length - 1].i).toBe(leaf);
    expect(rows.slice(0, -1).every((r) => r.ctx)).toBe(true);
    expect(rows.length).toBe(tree.depth[leaf] + 1);
  });

  it('flattens 3,000 tasks fast', () => {
    const n = 3000;
    const parent = (i: number) => (i % 20 === 0 ? -1 : i - (i % 20));
    const big = buildTree(n, parent);
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) flatten(big, () => true, (i) => i % 7 === 0);
    expect((performance.now() - t0) / 20).toBeLessThan(25);
  });
});

describe('schedule dates', () => {
  it('day numbers round-trip', () => {
    expect(dayStr(dayNo('2026-10-30'))).toBe('2026-10-30');
    expect(dayNo('1970-01-02')).toBe(1);
    expect(Number.isNaN(dayNo(null))).toBe(true);
  });
  it('late days: forecast slip, finish passed, start missed', () => {
    const base = { is_summary: false, pct_complete: 0, actual_start: null, actual_finish: null, forecast_finish: null, baseline_finish: null } as unknown as SchedTask;
    const sd = dayNo('2026-10-30');
    expect(lateDays({ ...base, planned_start: '2026-11-02', planned_finish: '2026-11-10' }, sd)).toBe(0);
    expect(lateDays({ ...base, planned_start: '2026-10-25', planned_finish: '2026-11-10' }, sd)).toBe(5);
    expect(lateDays({ ...base, planned_start: '2026-11-02', planned_finish: '2026-11-10', forecast_finish: '2026-11-17' }, sd)).toBe(7);
    expect(lateDays({ ...base, pct_complete: 100, planned_start: '2026-10-01', planned_finish: '2026-10-05' }, sd)).toBe(0);
  });
  it('normalises codes', () => expect(normCode(' 02.03-01 ')).toBe('020301'));
});

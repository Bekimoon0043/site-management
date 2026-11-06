// Generates local-server/fixtures/demo-tower-schedule.json — the import_schedule payload of
// docs/samples/demo-tower-schedule.xml (without op_id / project_id) — for the local server's
// rich demo (local-server/demo-rich.mjs), which is plain Node ESM and cannot import the
// TypeScript MSPDI parser. Re-run after changing the sample file or the parser:
//
//   cd web && npx vitest run --root scripts
//
// (Lives outside src/, so the normal `npm test` run does not pick it up.)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { parseMspdi, toImportPayload } from '../src/lib/msp';

const here = dirname(fileURLToPath(import.meta.url));
const XML = resolve(here, '../../docs/samples/demo-tower-schedule.xml');
const OUT = resolve(here, '../../local-server/fixtures/demo-tower-schedule.json');

describe('demo schedule fixture', () => {
  it('writes the import payload of the sample MSPDI file', () => {
    const bytes = readFileSync(XML);
    const parsed = parseMspdi(bytes.toString('utf8'), 'demo-tower-schedule.xml', { boqField: 'BoQ Code', DOMParser: DOMParser as never });
    parsed.file_sha256 = createHash('sha256').update(bytes).digest('hex');
    const { op_id: _op, project_id: _project, ...payload } = toImportPayload(parsed, { op_id: '', project_id: '', elementField: 'Element Codes' });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');
    expect(payload.schedule.tasks.length).toBeGreaterThan(70);
  });
});

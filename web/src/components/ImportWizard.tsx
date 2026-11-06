import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { downloadTemplate, exportExcel, normHeader, readWorkbook } from '../lib/format';
import { DataTable, type Column } from './DataTable';
import { Banner, Card, ErrorBanner } from './Page';
import { Field, FilterToggle } from './Form';
import { Stepper } from './Stepper';

export interface ImportRow<T> {
  rowNo: number;
  display: Record<string, string>;
  errors: string[];
  /** Non-blocking notes ("will update existing"). */
  warnings?: string[];
  record: T | null;
}

type Raw = Record<string, unknown>;
const STEPS = ['Upload', 'Map columns', 'Review', 'Done'];

function loadMapping(key: string): Record<string, string> | null {
  try { const v = localStorage.getItem(`sc.map.${key}`); return v ? (JSON.parse(v) as Record<string, string>) : null; } catch { return null; }
}

/**
 * Excel/CSV import wizard (FR-MD-03): Upload (template, sheet, header row) → Map columns
 * (auto-match by header/aliases, remembered per importer) → Review (errors-only, error report .xlsx)
 * → Commit ("Import N, skip M"). `validate` receives rows keyed by the canonical `headers`.
 */
export function ImportWizard<T>({ title, templateFile, headers, example, validate, commit, note, aliases = {}, required = [] }: {
  title: string;
  templateFile: string;
  headers: string[];
  example?: unknown[];
  validate: (rows: Raw[]) => Promise<ImportRow<T>[]>;
  commit: (records: T[]) => Promise<string>;
  note?: string;
  /** Extra header spellings per field, e.g. { Level: ['Floor'] }. */
  aliases?: Record<string, string[]>;
  /** Fields that must be mapped. */
  required?: string[];
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [wb, setWb] = useState<Awaited<ReturnType<typeof readWorkbook>> | null>(null);
  const [sheet, setSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [rows, setRows] = useState<ImportRow<T>[] | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const raw = useMemo(() => (wb && sheet ? wb.rows(sheet, headerRow) : []), [wb, sheet, headerRow]);
  const sourceCols = useMemo(() => {
    const s = new Set<string>();
    for (const r of raw.slice(0, 50)) Object.keys(r).forEach((k) => { if (!k.startsWith('__EMPTY')) s.add(k); });
    return [...s];
  }, [raw]);

  // Auto-map whenever the source columns change.
  useEffect(() => {
    if (!sourceCols.length) return;
    const saved = loadMapping(templateFile);
    const m: Record<string, string> = {};
    for (const h of headers) {
      if (saved?.[h] && sourceCols.includes(saved[h])) { m[h] = saved[h]; continue; }
      const want = [h, ...(aliases[h] ?? [])].map(normHeader);
      const hit = sourceCols.find((c) => want.includes(normHeader(c)));
      if (hit) m[h] = hit;
    }
    setMapping(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCols.join('|')]);

  // Warn before leaving with unsaved import work.
  useEffect(() => {
    if (step === 0 || step === 3) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [step]);

  const reset = () => { setStep(0); setFile(null); setWb(null); setRows(null); setResult(null); setError(null); setErrorsOnly(false); };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setError(null);
    try {
      const w = await readWorkbook(f);
      if (!w.sheets.length) throw new Error('The file has no sheets');
      setFile(f); setWb(w); setSheet(w.sheets[0]); setHeaderRow(1); setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const missingRequired = required.filter((h) => !mapping[h]);
  const runValidate = async () => {
    setBusy(true); setError(null);
    try {
      if (!raw.length) throw new Error('The selected sheet has no data rows below the header row');
      if (remember) { try { localStorage.setItem(`sc.map.${templateFile}`, JSON.stringify(mapping)); } catch { /* ignore */ } }
      const remapped = raw.map((r) => Object.fromEntries(headers.map((h) => [h, mapping[h] ? r[mapping[h]] : ''])));
      const v = await validate(remapped);
      // Row numbers relative to the sheet (header row + 1).
      setRows(v.map((x, i) => ({ ...x, rowNo: headerRow + 1 + i })));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const valid = rows?.filter((r) => !r.errors.length) ?? [];
  const invalid = rows ? rows.length - valid.length : 0;
  const warned = rows?.filter((r) => r.warnings?.length).length ?? 0;

  const go = async () => {
    setBusy(true); setError(null);
    try {
      setResult(await commit(valid.map((r) => r.record as T)));
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const errorReport = () => void exportExcel(`${templateFile.replace(/\.xlsx$/, '')}-errors`, (rows ?? []).filter((r) => r.errors.length)
    .map((r) => ({ Row: r.rowNo, ...r.display, Error: r.errors.join('; ') })), 'Errors');

  const columns: Column<ImportRow<T>>[] = [
    { key: 'rowNo', label: 'Row', align: 'right', width: 56 },
    { key: 'status', label: 'Status', value: (r) => (r.errors.length ? 'Error' : 'OK'),
      render: (r) => (r.errors.length ? <span className="danger-text row nowrap"><CircleX size={14} aria-hidden />Error</span> : <span className="ok-text row nowrap"><CircleCheck size={14} aria-hidden />{r.warnings?.length ? 'Update' : 'Ready'}</span>) },
    { key: 'issue', label: 'Issue', value: (r) => [...r.errors, ...(r.warnings ?? [])].join('; '),
      render: (r) => (r.errors.length ? <span className="danger-text">{r.errors.join('; ')}</span> : r.warnings?.length ? <span className="warn-text">{r.warnings.join('; ')}</span> : <span className="muted-dash">—</span>) },
    ...headers.map((h) => ({ key: h, label: h, value: (r: ImportRow<T>) => r.display[h] ?? '' })),
  ];

  return (
    <Card title={title} actions={<><span className="muted small-text">Step {step + 1} of 4</span>
      <button className="small" onClick={() => void downloadTemplate(templateFile, headers, example)}><Download size={14} aria-hidden />Template</button></>}>
      <div className="stack">
        <Stepper steps={STEPS} current={step} onStep={(i) => { if (i < step && step < 3) setStep(i); }} />
        <ErrorBanner error={error} />

        {step === 0 && (
          <>
            {note && <p className="muted mb-0">{note}</p>}
            <label className={`dropzone${over ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void onFile(e.dataTransfer.files?.[0]); }}>
              <Upload size={28} aria-hidden />
              <strong>{busy ? 'Reading file…' : 'Drop an Excel or CSV file here, or click to choose'}</strong>
              <span className="small-text">.xlsx, .xls or .csv · first row should hold the column names (you can change this next)</span>
              <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </>
        )}

        {step === 1 && wb && (
          <>
            <div className="summary-strip">
              <span className="s"><FileSpreadsheet size={16} aria-hidden /><strong>{file?.name}</strong></span>
              <label className="s">Sheet <select value={sheet} onChange={(e) => setSheet(e.target.value)}>{wb.sheets.map((s) => <option key={s}>{s}</option>)}</select></label>
              <label className="s">Header row <select value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
              <span className="s"><strong>{raw.length.toLocaleString()}</strong> data rows</span>
            </div>
            <div className="table-wrap">
              <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="map-table">
                  <thead><tr><th>Field</th><th>Your column</th><th>Sample values</th><th>Status</th></tr></thead>
                  <tbody>
                    {headers.map((h) => {
                      const src = mapping[h];
                      const auto = src && [h, ...(aliases[h] ?? [])].map(normHeader).includes(normHeader(src));
                      return (
                        <tr key={h}>
                          <td className="strong">{h}{required.includes(h) && <span className="danger-text"> *</span>}</td>
                          <td>
                            <select value={src ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })} aria-label={`Column for ${h}`}>
                              <option value="">— Not in file —</option>
                              {sourceCols.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </td>
                          <td className="muted small-text truncate" style={{ maxWidth: 260 }}>{src ? raw.slice(0, 3).map((r) => String(r[src] ?? '')).filter(Boolean).join(', ') : '—'}</td>
                          <td>{src ? <span className="ok-text small-text">✓ {auto ? 'auto' : 'mapped'}</span> : required.includes(h) ? <span className="danger-text small-text">required</span> : <span className="muted small-text">optional</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="row">
              <Field label="Remember this mapping for next time" check><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /></Field>
              <span className="spacer" />
              <button onClick={reset}>Back</button>
              <button className="primary" disabled={busy || !!missingRequired.length || !raw.length} title={missingRequired.length ? `Map: ${missingRequired.join(', ')}` : undefined}
                onClick={() => void runValidate()}>{busy && <span className="spinner" />}Validate {raw.length.toLocaleString()} rows</button>
            </div>
          </>
        )}

        {step === 2 && rows && (
          <>
            <div className="summary-strip">
              <span className="s ok-text"><CircleCheck size={16} aria-hidden /><strong>{valid.length.toLocaleString()}</strong> ready</span>
              <span className={`s ${invalid ? 'danger-text' : 'muted'}`}><CircleX size={16} aria-hidden /><strong>{invalid.toLocaleString()}</strong> with errors (skipped)</span>
              {warned > 0 && <span className="s warn-text"><strong>{warned}</strong> will update existing</span>}
              <span className="spacer" />
              {invalid > 0 && <FilterToggle label="Errors only" checked={errorsOnly} onChange={setErrorsOnly} />}
              {invalid > 0 && <button className="small" onClick={errorReport}><Download size={14} aria-hidden />Error report (.xlsx)</button>}
            </div>
            {invalid > 0 && <Banner tone="info">Fix errors in Excel using the error report (it has an Error column), then upload again — or import the {valid.length} valid rows now.</Banner>}
            <DataTable rows={errorsOnly ? rows.filter((r) => r.errors.length) : rows} columns={columns} rowKey={(r) => String(r.rowNo)} pageSize={100} maxHeight="420px"
              rowClass={(r) => (r.errors.length ? 'row-error' : r.warnings?.length ? 'row-warn' : undefined)} />
            <div className="row">
              <span className="spacer" />
              <button onClick={() => setStep(1)} disabled={busy}>Back</button>
              <button className="primary" disabled={busy || !valid.length} onClick={() => void go()}>
                {busy && <span className="spinner" />}{busy ? 'Importing…' : `Import ${valid.length.toLocaleString()} row${valid.length === 1 ? '' : 's'}${invalid ? `, skip ${invalid}` : ''}`}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Banner tone="ok">{result}</Banner>
            <div className="row"><button className="primary" onClick={reset}>Import another file</button></div>
          </>
        )}
      </div>
    </Card>
  );
}

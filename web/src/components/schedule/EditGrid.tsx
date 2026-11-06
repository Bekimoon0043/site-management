// "Edit plan" tab: MS Project-like Gantt table — inline editing of name, duration, start (→ SNET), constraint and the
// Predecessors column, add / indent / outdent / move / delete / link, undo. Every edit re-plans with CPM on the server.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Diamond, FolderPlus, History, IndentDecrease, IndentIncrease, Link2, Plus, Trash2, Undo2, Unlink,
} from 'lucide-react';
import { num } from '../../lib/format';
import { CONSTRAINT_TYPES, type ScheduleEdit, type ScheduleResource, type TaskAssignment } from '../../lib/contract-schedule-edit';
import { Popover, confirm, toast } from '../ui';
import type { FlatRow } from './tree';
import { d2, type SchedHeader, type SchedLink, type SchedTask } from './data';
import { editRpc, formatPredecessors, parseDuration, parsePredecessors } from './editing';

type Col = 'name' | 'duration' | 'start' | 'preds' | 'constraint';
const EDIT_COLS: Col[] = ['name', 'duration', 'start', 'preds', 'constraint'];

export function EditGrid({ schedule, tasks, rows, byId, links, resources, assignments, edits, onOpen, onToggle }: {
  schedule: SchedHeader; tasks: SchedTask[]; rows: FlatRow[]; byId: Map<string, SchedTask>; links: SchedLink[] | undefined;
  resources: ScheduleResource[]; assignments: TaskAssignment[]; edits: ScheduleEdit[] | undefined;
  onOpen: (id: string) => void; onToggle: (i: number) => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; col: Col; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const uids = useMemo(() => new Set(tasks.map((t) => t.msp_uid)), [tasks]);
  const resById = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const asgByTask = useMemo(() => {
    const m = new Map<string, TaskAssignment[]>();
    for (const a of assignments) { const l = m.get(a.task_id) ?? []; l.push(a); m.set(a.task_id, l); }
    return m;
  }, [assignments]);
  const order = rows.map((r) => tasks[r.i].id);
  const cur = sel ? byId.get(sel) : undefined;

  useEffect(() => { if (sel && !byId.has(sel)) setSel(null); }, [byId, sel]);

  const run = async (fn: () => Promise<Record<string, unknown>>, after?: (r: Record<string, unknown>) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      const moved = Number(r.moved ?? 0);
      toast.success(`${String(r.summary ?? r.undone ?? 'Saved')}${moved ? ` · ${moved} task${moved === 1 ? '' : 's'} moved` : ''}`);
      after?.(r);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };
  const edit = (p: Parameters<typeof editRpc<'edit_schedule'>>[1]) => run(() => editRpc('edit_schedule', { schedule_id: schedule.id, ...p } as never),
    (r) => { if (r.task_id) setSel(String(r.task_id)); });

  const add = (kind: 'task' | 'milestone' | 'summary') => run(
    () => editRpc('edit_schedule', { schedule_id: schedule.id, action: 'add_task', kind, name: kind === 'milestone' ? 'New milestone' : kind === 'summary' ? 'New summary' : 'New task',
      ...(cur ? { after_task_id: cur.id } : {}) } as never),
    (r) => { const id = String(r.task_id); setSel(id); setEditing({ id, col: 'name', value: kind === 'milestone' ? 'New milestone' : kind === 'summary' ? 'New summary' : 'New task' }); });
  const del = async () => {
    if (!cur) return;
    const ok = await confirm({ title: `Delete “${cur.name}”?`, body: cur.is_summary ? 'Its sub-tasks and their links are deleted too. You can undo it.' : 'Its links are removed too. You can undo it.', confirm: 'Delete', danger: true });
    if (ok) void edit({ action: 'delete_task', task_id: cur.id });
  };
  const linkSelected = () => {
    const ids = (multi.length >= 2 ? multi : []).filter((id) => byId.has(id) && !byId.get(id)!.is_summary);
    if (ids.length < 2) { toast.error('Select two or more detailed tasks (Ctrl+click or Space), in the order to link them'); return; }
    void run(async () => {
      let last: Record<string, unknown> = {};
      for (let k = 1; k < ids.length; k++) last = await editRpc('edit_schedule', { schedule_id: schedule.id, action: 'add_link', pred_task_id: ids[k - 1], succ_task_id: ids[k], link_type: 'FS' } as never);
      return { ...last, summary: `Linked ${ids.length} tasks finish-to-start` };
    }, () => setMulti([]));
  };
  const unlinkSelected = () => {
    const ids = multi.length >= 2 ? multi : [];
    const pairs = (links ?? []).filter((l) => ids.includes(l.pred_task_id) && ids.includes(l.succ_task_id));
    if (!pairs.length) { toast.error('Select two linked tasks to remove the link between them'); return; }
    void run(async () => {
      let last: Record<string, unknown> = {};
      for (const l of pairs) last = await editRpc('edit_schedule', { schedule_id: schedule.id, action: 'delete_link', pred_task_id: l.pred_task_id, succ_task_id: l.succ_task_id, link_type: l.link_type } as never);
      return { ...last, summary: `Removed ${pairs.length} link${pairs.length === 1 ? '' : 's'}` };
    }, () => setMulti([]));
  };
  const undo = () => run(() => editRpc('undo_schedule_edit', { schedule_id: schedule.id }));

  const startEdit = (t: SchedTask, col: Col) => {
    if (t.is_summary && col !== 'name') return;
    const value = col === 'name' ? t.name : col === 'duration' ? String(Number(t.duration_days ?? 0))
      : col === 'start' ? (t.planned_start ?? '') : col === 'preds' ? formatPredecessors(t.id, links, byId) : String(constraintOf(t).type);
    setSel(t.id);
    setEditing({ id: t.id, col, value });
  };
  const commit = (next?: Col) => {
    if (!editing) return;
    const t = byId.get(editing.id);
    const { col, value } = editing;
    setEditing(null);
    if (!t) return;
    const go = () => { if (next) { const n = byId.get(editing.id); if (n) startEdit(n, next); } };
    try {
      if (col === 'name') { if (value.trim() && value.trim() !== t.name) void edit({ action: 'update_task', task_id: t.id, name: value.trim() }); }
      else if (col === 'duration') {
        const d = parseDuration(value);
        if (d === null) throw new Error('Duration: write it like 5, 5d or 2w');
        if (d !== Number(t.duration_days ?? 0)) void edit({ action: 'update_task', task_id: t.id, duration_days: d });
      } else if (col === 'start') { if (value !== (t.planned_start ?? '')) void edit({ action: 'update_task', task_id: t.id, start: value || null }); }
      else if (col === 'preds') {
        if (value.trim() !== formatPredecessors(t.id, links, byId)) void edit({ action: 'set_predecessors', task_id: t.id, predecessors: parsePredecessors(value, uids) });
      } else if (col === 'constraint') {
        const type = Number(value);
        if (type !== constraintOf(t).type) void edit({ action: 'update_task', task_id: t.id, constraint_type: type, ...(type >= 2 ? { constraint_date: constraintOf(t).date ?? t.planned_start ?? undefined } : {}) });
      }
      go();
    } catch (e) { toast.error((e as Error).message); setEditing({ id: t.id, col, value }); }
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing || busy) return;
    const i = sel ? order.indexOf(sel) : -1;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); void undo(); return; }
    if (e.altKey && e.shiftKey && k === 'ArrowRight' && cur) { e.preventDefault(); void edit({ action: 'indent', task_id: cur.id }); return; }
    if (e.altKey && e.shiftKey && k === 'ArrowLeft' && cur) { e.preventDefault(); void edit({ action: 'outdent', task_id: cur.id }); return; }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && cur) { e.preventDefault(); void edit({ action: 'move', task_id: cur.id, direction: k === 'ArrowUp' ? 'up' : 'down' }); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const j = Math.max(0, Math.min(order.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
      setSel(order[j]);
      box.current?.querySelector(`[data-row="${order[j]}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!cur) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(cur, 'name'); }
    else if (k === 'Insert') { e.preventDefault(); void add('task'); }
    else if (k === 'Delete') { e.preventDefault(); void del(); }
    else if (k === ' ') { e.preventDefault(); setMulti((m) => (m.includes(cur.id) ? m.filter((x) => x !== cur.id) : [...m, cur.id])); }
    else if (k === 'o' || k === 'O') { e.preventDefault(); onOpen(cur.id); }
  };

  const cell = (t: SchedTask, col: Col, text: React.ReactNode, cls = '') => {
    const ed = editing && editing.id === t.id && editing.col === col;
    const editable = col === 'name' || !t.is_summary;
    if (ed) {
      const keyDown = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); box.current?.focus(); }
        else if (e.key === 'Tab') { e.preventDefault(); const n = EDIT_COLS[EDIT_COLS.indexOf(col) + (e.shiftKey ? -1 : 1)]; commit(n); }
      };
      return (
        <td className={`eg-cell editing ${cls}`}>
          {col === 'constraint' ? (
            <select autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={() => commit()} onKeyDown={keyDown} aria-label="Constraint">
              {CONSTRAINT_TYPES.map((c) => <option key={c.value} value={c.value}>{c.code} — {c.label}</option>)}
            </select>
          ) : (
            <input autoFocus type={col === 'start' ? 'date' : 'text'} value={editing.value} aria-label={col}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={() => commit()} onKeyDown={keyDown}
              onFocus={(e) => { if (col !== 'start') e.currentTarget.select(); }} />
          )}
        </td>
      );
    }
    return (
      <td className={`eg-cell${editable ? ' editable' : ''} ${cls}`} onDoubleClick={() => editable && startEdit(t, col)}
        title={editable ? 'Double-click to edit' : undefined}>{text}</td>
    );
  };

  const lastEdit = edits?.find((e) => !e.undone_at);

  return (
    <div className="edit-plan">
      <div className="eg-toolbar no-print" role="toolbar" aria-label="Edit the plan">
        <button className="small primary" disabled={busy} onClick={() => void add('task')} title="Add a task below the selected one (Insert)"><Plus size={14} />Task</button>
        <button className="small" disabled={busy} onClick={() => void add('milestone')}><Diamond size={14} />Milestone</button>
        <button className="small" disabled={busy} onClick={() => void add('summary')}><FolderPlus size={14} />Summary</button>
        <span className="eg-sep" />
        <button className="small icon-only" disabled={busy || !cur} onClick={() => cur && void edit({ action: 'outdent', task_id: cur.id })} title="Outdent (Alt+Shift+←)" aria-label="Outdent"><IndentDecrease size={15} /></button>
        <button className="small icon-only" disabled={busy || !cur} onClick={() => cur && void edit({ action: 'indent', task_id: cur.id })} title="Indent (Alt+Shift+→)" aria-label="Indent"><IndentIncrease size={15} /></button>
        <button className="small icon-only" disabled={busy || !cur} onClick={() => cur && void edit({ action: 'move', task_id: cur.id, direction: 'up' })} title="Move up (Alt+↑)" aria-label="Move up"><ArrowUp size={15} /></button>
        <button className="small icon-only" disabled={busy || !cur} onClick={() => cur && void edit({ action: 'move', task_id: cur.id, direction: 'down' })} title="Move down (Alt+↓)" aria-label="Move down"><ArrowDown size={15} /></button>
        <span className="eg-sep" />
        <button className="small" disabled={busy || multi.length < 2} onClick={linkSelected} title="Link the ticked tasks finish-to-start, in the order ticked"><Link2 size={14} />Link{multi.length ? ` (${multi.length})` : ''}</button>
        <button className="small" disabled={busy || multi.length < 2} onClick={unlinkSelected}><Unlink size={14} />Unlink</button>
        <button className="small" disabled={busy || !cur} onClick={() => void del()} title="Delete (Del)"><Trash2 size={14} />Delete</button>
        <span className="grow" />
        {busy && <span className="spinner" aria-label="Saving" />}
        <button className="small" disabled={busy || !lastEdit} onClick={() => void undo()} title={lastEdit ? `Undo: ${lastEdit.summary} (Ctrl+Z)` : 'Nothing to undo'}><Undo2 size={14} />Undo</button>
        <Popover align="right" trigger={(p) => <button {...p} className="small" aria-label="Edit history"><History size={14} />History</button>}>
          {() => (
            <div className="eg-history">
              <div className="menu-label">Recent edits</div>
              {!edits?.length ? <p className="muted small-text pad">No edits in the app yet.</p> : (
                <ul>{edits.map((e) => (
                  <li key={e.id} className={e.undone_at ? 'undone' : ''}>
                    <span>{e.summary}{e.moved ? <span className="muted"> · {e.moved} moved</span> : null}</span>
                    <span className="muted small-text">{new Date(e.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{e.undone_at ? ' · undone' : ''}</span>
                  </li>
                ))}</ul>
              )}
            </div>
          )}
        </Popover>
      </div>

      <div className="eg-wrap" ref={box} tabIndex={0} onKeyDown={onKey} aria-label="Plan table — arrows move, Enter edits, Insert adds, Del deletes, Space ticks for linking">
        <table className="edit-grid">
          <thead><tr>
            <th className="eg-num">UID</th><th>WBS</th><th className="eg-name">Task name</th><th className="eg-num">Duration</th><th>Start</th><th>Finish</th>
            <th>Predecessors</th><th>Resources</th><th>Constraint</th><th className="eg-num">Float</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const t = tasks[r.i];
              const c = constraintOf(t);
              const asg = asgByTask.get(t.id) ?? [];
              const ticked = multi.indexOf(t.id);
              return (
                <tr key={t.id} data-row={t.id} className={`${sel === t.id ? 'sel' : ''}${t.is_summary ? ' summary' : ''}${t.is_critical && !t.is_summary ? ' crit' : ''}`}
                  onClick={(e) => { setSel(t.id); if (e.ctrlKey || e.metaKey) setMulti((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id])); }}>
                  <td className="eg-num muted">{ticked >= 0 ? <span className="eg-tick" title={`Link order ${ticked + 1}`}>{ticked + 1}</span> : t.msp_uid}</td>
                  <td className="muted small-text">{t.wbs}</td>
                  {cell(t, 'name', (
                    <span className="tree-name" style={{ paddingLeft: r.depth * 16 }}>
                      {r.hasKids ? <button type="button" className="caret" aria-label={r.expanded ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); onToggle(r.i); }}>
                        {r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span style={{ width: 18 }} />}
                      {t.is_milestone ? '◆ ' : ''}{t.name}
                      {t.origin === 'app' && <span className="eg-origin" title="Created in the app — export to MS Project before re-importing">app</span>}
                      <button type="button" className="link-btn eg-open" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} aria-label={`Open ${t.name}`}>open</button>
                    </span>
                  ), 'eg-name')}
                  {cell(t, 'duration', t.is_milestone ? '0 d' : `${num(t.duration_days, 1)} d`, 'eg-num')}
                  {cell(t, 'start', d2(t.planned_start))}
                  <td className="eg-cell">{d2(t.planned_finish)}</td>
                  {cell(t, 'preds', <span className="eg-preds">{formatPredecessors(t.id, links, byId)}</span>)}
                  <td className="eg-cell small-text">{asg.map((a) => { const res = resById.get(a.resource_id); return res ? `${res.code}${Number(a.units) !== 1 ? `×${num(a.units, 0)}` : ''}` : ''; }).filter(Boolean).join(', ')}</td>
                  {cell(t, 'constraint', c.type ? <span title={CONSTRAINT_TYPES[c.type]?.label}>{CONSTRAINT_TYPES[c.type]?.code} {d2(c.date)}</span> : <span className="muted">ASAP</span>)}
                  <td className={`eg-num${Number(t.total_float_days) < 0 ? ' danger-text' : ''}`}>{t.is_summary || t.total_float_days == null ? '' : `${num(t.total_float_days, 0)} d`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small-text no-print">
        Double-click a cell to edit · Enter/F2 rename · Tab next column · Insert add · Del delete · Alt+Shift+→/← indent/outdent · Alt+↑/↓ move ·
        Ctrl+click or Space tick tasks, then Link · Ctrl+Z undo. Predecessors like <code>12, 15SS, 20FS+2d, 9SS+50%</code>.
        Dates are re-planned with the critical path after every change. Re-importing from MS Project replaces these edits — use <b>Export to MS Project (XML)</b> first.
      </p>
    </div>
  );
}

function constraintOf(t: SchedTask): { type: number; date: string | null } {
  return { type: Number(t.constraint_type ?? 0), date: t.constraint_date ?? null };
}

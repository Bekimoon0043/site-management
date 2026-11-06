// Printable forms and reports (FR-RP-02/03) rendered to PDF and shared.
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { get, list } from './db';
import type { Grn, GrnLine, MaterialRequest, Miv, MivLine, MrLine, Project, Store } from './contract';

interface AppSettings { company_name: string }
import { elementLabel, lineElements, personName, specLabel, specUom, stockBalances } from './queries';
import { fmtDate, fmtDateTime, fmtQty, titleCase } from './format';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function sigSvg(path: string | null | undefined) {
  return path ? `<svg viewBox="0 0 320 140" width="200" height="88"><path d="${esc(path)}" stroke="#000" stroke-width="2.5" fill="none"/></svg>` : '';
}

function page(title: string, number: string, projectId: string, body: string, signatures: { label: string; name?: string; sig?: string | null }[]) {
  const company = get<AppSettings>('app_settings', '1')?.company_name ?? 'Company';
  const p = get<Project>('projects', projectId);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#111;margin:24px}
    h1{font-size:18px;margin:0}.muted{color:#555}.hdr{display:flex;justify-content:space-between;border-bottom:2px solid #1f3864;padding-bottom:8px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #999;padding:5px;text-align:left;vertical-align:top}
    th{background:#dbe5f1}.r{text-align:right}.meta td{border:none;padding:2px 8px 2px 0}
    .sigs{display:flex;gap:16px;margin-top:36px}.sig{flex:1;border-top:1px solid #000;padding-top:4px;min-height:90px}
  </style></head><body>
  <div class="hdr"><div><h1>${esc(company)}</h1><div class="muted">${esc(p?.name ?? '')} (${esc(p?.code ?? '')})</div></div>
  <div style="text-align:right"><h1>${esc(title)}</h1><div>${esc(number)}</div></div></div>
  ${body}
  <div class="sigs">${signatures.map((s) => `<div class="sig">${sigSvg(s.sig)}<div><b>${esc(s.label)}</b></div><div>${esc(s.name ?? '')}</div><div class="muted">Signature / Date</div></div>`).join('')}</div>
  </body></html>`;
}

async function share(html: string, name: string) {
  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: name, UTI: 'com.adobe.pdf' });
  } else {
    await Print.printAsync({ uri });
  }
}

export async function printMr(id: string) {
  const mr = get<MaterialRequest>('material_requests', id);
  if (!mr) return;
  const lines = list<MrLine>('mr_lines', { parent: id }).filter((l) => !l.deleted_at).sort((a, b) => a.line_no - b.line_no);
  const body = `<table class="meta"><tr><td>Requested by</td><td><b>${esc(personName(mr.requested_by))}</b></td><td>Priority</td><td><b>${esc(titleCase(mr.priority))}</b></td></tr>
    <tr><td>Required date</td><td>${fmtDate(mr.required_date)}</td><td>Status</td><td>${esc(titleCase(mr.status))}</td></tr>
    <tr><td>Delivery</td><td>${esc(mr.delivery_location ?? '')}</td><td>Drawing</td><td>${esc(mr.drawing_ref ?? '')}</td></tr></table>
    <table><tr><th>#</th><th>Material / grade</th><th>Elements</th><th class="r">Qty</th><th class="r">Approved</th><th>UoM</th><th>Remarks</th></tr>
    ${lines.map((l) => `<tr><td>${l.line_no}</td><td>${esc(specLabel(l.material_spec_id))}</td>
      <td>${lineElements(l.id).filter((e) => !e.deleted_at).map((e) => `${esc(elementLabel(e.element_id))}: ${fmtQty(e.qty)}`).join('<br>')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="r">${fmtQty(l.approved_qty)}</td><td>${esc(specUom(l.material_spec_id))}</td>
      <td>${esc(l.remarks ?? '')}${l.over_boq_reason ? `<br><i>Over BoQ: ${esc(l.over_boq_reason)}</i>` : ''}</td></tr>`).join('')}
    </table>${mr.purpose ? `<p><b>Purpose:</b> ${esc(mr.purpose)}</p>` : ''}`;
  await share(page('Material Request', mr.number, mr.project_id, body, [
    { label: 'Requested by', name: personName(mr.requested_by) },
    { label: 'Reviewed by', name: mr.reviewed_by ? personName(mr.reviewed_by) : '' },
    { label: 'Approved by', name: mr.approved_by ? personName(mr.approved_by) : '' },
  ]), mr.number);
}

export async function printMiv(id: string) {
  const m = get<Miv & { receiver_signature?: string | null }>('mivs', id);
  if (!m) return;
  const mr = get<MaterialRequest>('material_requests', m.mr_id);
  const store = get<Store>('stores', m.store_id);
  const lines = list<MivLine>('miv_lines', { parent: id }).sort((a, b) => a.line_no - b.line_no);
  const body = `<table class="meta"><tr><td>Store</td><td>${esc(store?.name)}</td><td>Request</td><td>${esc(mr?.number ?? (m.is_emergency ? 'EMERGENCY' : ''))}</td></tr>
    <tr><td>Issued</td><td>${fmtDateTime(m.issued_at)}</td><td>Status</td><td>${esc(titleCase(m.status))}</td></tr></table>
    <table><tr><th>#</th><th>Material / grade</th><th>Element</th><th class="r">Qty</th><th>UoM</th><th>Note</th></tr>
    ${lines.map((l) => `<tr><td>${l.line_no}</td><td>${esc(specLabel(l.material_spec_id))}</td><td>${esc(elementLabel(l.element_id))}</td>
      <td class="r">${fmtQty(l.qty)}</td><td>${esc(specUom(l.material_spec_id))}</td><td>${esc(l.substitution_reason ? `Substitution: ${l.substitution_reason}` : '')}</td></tr>`).join('')}
    </table>${m.emergency_reason ? `<p><b>Emergency reason:</b> ${esc(m.emergency_reason)}</p>` : ''}`;
  await share(page('Material Issue Voucher', m.number, m.project_id, body, [
    { label: 'Issued by (Store Keeper)', name: personName(m.issued_by) },
    { label: 'Received by', name: personName(m.issued_to), sig: m.receiver_signature },
  ]), m.number);
}

export async function printGrn(id: string) {
  const g = get<Grn & { supplier_signature?: string | null }>('grns', id);
  if (!g) return;
  const store = get<Store>('stores', g.store_id);
  const lines = list<GrnLine>('grn_lines', { parent: id }).sort((a, b) => a.line_no - b.line_no);
  const body = `<table class="meta"><tr><td>Supplier</td><td><b>${esc(g.supplier_name ?? '')}</b></td><td>Delivery note</td><td>${esc(g.delivery_note_no ?? '')}</td></tr>
    <tr><td>Vehicle</td><td>${esc(g.vehicle_plate ?? '')}</td><td>Driver</td><td>${esc(g.driver_name ?? '')}</td></tr>
    <tr><td>Store</td><td>${esc(store?.name)}</td><td>Received</td><td>${fmtDateTime(g.received_at)}</td></tr></table>
    <table><tr><th>#</th><th>Material / grade</th><th class="r">Ordered</th><th class="r">Delivered</th><th class="r">Accepted</th><th class="r">Rejected</th><th>Inspection</th><th>Batch</th></tr>
    ${lines.map((l) => `<tr><td>${l.line_no}</td><td>${esc(specLabel(l.material_spec_id))} (${esc(specUom(l.material_spec_id))})</td><td class="r">${fmtQty(l.ordered_qty)}</td>
      <td class="r">${fmtQty(l.qty_delivered)}</td><td class="r">${fmtQty(l.qty_accepted)}</td><td class="r">${fmtQty(l.qty_rejected)}</td>
      <td>${esc(titleCase(l.inspection_result))}${l.variance_flag ? ` — ${esc(titleCase(l.variance_flag))}` : ''}${l.inspection_notes ? `<br>${esc(l.inspection_notes)}` : ''}</td><td>${esc(l.batch_no ?? '')}</td></tr>`).join('')}
    </table>`;
  await share(page('Goods Received Note', g.number, g.project_id, body, [
    { label: 'Received by (Store Keeper)', name: personName(g.created_by) },
    { label: 'Supplier / driver', name: g.driver_name ?? g.supplier_name ?? '', sig: g.supplier_signature },
  ]), g.number);
}

export async function printStockStatus(projectId: string) {
  const rows = stockBalances(projectId);
  const body = `<p class="muted">As of ${fmtDateTime(new Date().toISOString())}</p>
    <table><tr><th>Store</th><th>Material / grade</th><th class="r">Available</th><th class="r">Quarantine</th><th>UoM</th><th>Last movement</th></tr>
    ${rows.map((r) => `<tr><td>${esc(get<Store>('stores', r.store_id)?.name)}</td><td>${esc(specLabel(r.material_spec_id))}</td>
      <td class="r">${fmtQty(r.available)}</td><td class="r">${fmtQty(r.quarantine)}</td><td>${esc(specUom(r.material_spec_id))}</td><td>${fmtDate(r.last)}</td></tr>`).join('')}
    </table>`;
  await share(page('Stock Status Report', '', projectId, body, [{ label: 'Store Keeper' }, { label: 'Checked by' }]), 'Stock status');
}

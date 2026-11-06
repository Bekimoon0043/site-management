// Procurement + site-control sync tables (contract-procurement.ts, contract-control.ts).
// Pure module (no db import) so db.ts can use it for primary keys / parent columns.
import type { SyncTable } from './contract';
import { PRICE_TABLES_PROCUREMENT, SYNC_TABLES_PROCUREMENT } from './contract-procurement';
import { SYNC_TABLES_CONTROL } from './contract-control';

/** Every table this module may pull (for primary-key lookup). */
export const PC_TABLES: SyncTable[] = [...SYNC_TABLES_PROCUREMENT, ...PRICE_TABLES_PROCUREMENT, ...SYNC_TABLES_CONTROL];

export const PC_PARENT_COLUMN: Record<string, string> = {
  rfq_lines: 'rfq_id', rfq_suppliers: 'rfq_id', quotations: 'rfq_id', quotation_lines: 'quotation_id', rfq_awards: 'rfq_id',
  po_lines: 'po_id', po_events: 'po_id', po_delivery_updates: 'po_id', po_totals: 'po_id',
  price_observations: 'material_spec_id',
  gate_pass_lines: 'gate_pass_id', gate_events: 'gate_pass_id', qr_labels: 'entity_id',
  notification_prefs: 'user_id',
};

/** Tables to pull this round: price tables only when the user may see prices. */
export const pcPullTables = (pricesVisible: boolean): SyncTable[] =>
  [...SYNC_TABLES_PROCUREMENT, ...SYNC_TABLES_CONTROL, ...(pricesVisible ? PRICE_TABLES_PROCUREMENT : [])];

/** Tolerate servers where the 0005/0007 migrations are not applied yet (table missing). */
export function skipMissingTable(e: unknown): void {
  const m = e instanceof Error ? e.message : String(e);
  if (/does not exist|Could not find the table|schema cache/i.test(m)) return;
  throw e;
}

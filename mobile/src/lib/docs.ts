export type StoreDocType = 'grn' | 'miv' | 'mrn' | 'adjustment' | 'count' | 'transfer';
export const DOC_TABLE: Record<StoreDocType, string> = {
  grn: 'grns', miv: 'mivs', mrn: 'mrns', adjustment: 'adjustments', count: 'stock_counts', transfer: 'transfers',
};

// Plain-language EVM copy (docs/research/schedule-ux.md §6.4) + band badge. Amharic is a first draft.
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { EvmBand } from '../../lib/contract-schedule';
import { EVM_METRICS } from '../../lib/contract-schedule';
import { Badge } from '../Badge';
import { bandTone, bandWord, isAm, moneyShort } from './data';

export function BandBadge({ kind, band, value }: { kind: 'schedule' | 'cost'; band: EvmBand | null | undefined; value?: number | null }) {
  const icon = band === 'ok' ? CircleCheck : band === 'warning' ? TriangleAlert : band === 'critical' ? OctagonAlert : Info;
  return <Badge tone={bandTone(band)} icon={band ? icon : null} label={bandWord(kind, band, value)} />;
}

/** Metric label in the user's language, acronym secondary. */
export function metricLabel(key: string, withKey = true): string {
  const m = EVM_METRICS.find((x) => x.key === key);
  if (!m) return key.toUpperCase();
  const l = isAm() ? m.label_am : m.label;
  return withKey && !['pct_planned', 'pct_earned', 'sv_t_days'].includes(key) ? `${l} (${key === 'spi_t' ? 'SPI(t)' : key.toUpperCase()})` : l;
}
export function metricExplain(key: string, v?: number | null): string {
  const m = EVM_METRICS.find((x) => x.key === key);
  if (!m) return '';
  const s = isAm() ? m.explain_am : m.explain;
  return s.replace('{v}', v == null ? '—' : Number(v).toFixed(2));
}

export interface SummaryInput {
  spi: number | null; cpi: number | null; sv_t_days: number | null; eac: number | null; bac: number | null; vac: number | null;
  spi_status: EvmBand | null; cpi_status: EvmBand | null; pv: number | null; ac: number | null;
}

/** CPI above this means actual cost is missing (e.g. materials not yet issued/invoiced), not a real saving. */
export const INCOMPLETE_COST_CPI = 2;

/** "For every 1 birr spent we earned 0.92 birr of work; we are 8 days behind." + headline + forecast. */
export function evmSummary(k: SummaryInput, currency = 'ETB'): { headline: string; sentence: string; forecast: string | null } {
  const am = isAm();
  const behind = k.spi_status === 'warning' || k.spi_status === 'critical';
  const over = k.cpi_status === 'warning' || k.cpi_status === 'critical';
  const headline = !k.pv
    ? (am ? 'ሥራው ገና አልተጀመረም።' : 'Work has not started yet.')
    : am
      ? `${behind ? 'ከዕቅዱ ወደኋላ' : 'በዕቅዱ መሠረት'} ነን${k.cpi == null ? '' : over ? '፤ ከበጀት በላይ እያወጣን ነው' : '፤ በበጀቱ ውስጥ ነን'}።`
      : `We are ${behind ? 'BEHIND schedule' : 'ON schedule'}${k.cpi == null ? '' : over ? ' and OVER budget' : ' and within budget'}.`;
  const cost = k.cpi == null
    ? (am ? 'እስካሁን ወጪ አልተመዘገበም' : 'No costs recorded yet')
    : am ? `ለወጣው እያንዳንዱ 1 ብር ${k.cpi.toFixed(2)} ብር የሚያወጣ ሥራ ሠርተናል` : `For every 1 birr spent we earned ${k.cpi.toFixed(2)} birr of work`;
  const d = k.sv_t_days == null ? null : Math.round(Math.abs(k.sv_t_days));
  const time = k.sv_t_days == null
    ? (k.spi == null ? '' : am ? `ለታቀደው 1 ብር ሥራ ${k.spi.toFixed(2)} ብር ሠርተናል` : `we did ${k.spi.toFixed(2)} birr of work for every 1 birr planned`)
    : d === 0 ? (am ? 'በጊዜ ሰሌዳው ላይ ነን' : 'we are on schedule')
      : k.sv_t_days! < 0 ? (am ? `ከዕቅዱ ${d} የሥራ ቀን ወደኋላ ነን` : `we are ${d} working day${d === 1 ? '' : 's'} behind`)
        : (am ? `ከዕቅዱ ${d} የሥራ ቀን ቀድመናል` : `we are ${d} working day${d === 1 ? '' : 's'} ahead`);
  const sentence = `${cost}${time ? (am ? '፤ ' : '; ') + time : ''}${am ? '።' : '.'}`;
  let forecast: string | null = null;
  if (k.cpi != null && k.cpi > INCOMPLETE_COST_CPI) {
    // Earned value includes materials (BoQ rates) while only labour / a few invoices are posted: EAC = BAC / CPI would be nonsense.
    forecast = am
      ? `እስካሁን የተመዘገበው ወጪ (${moneyShort(k.ac ?? 0, currency)}) ከተሠራው ሥራ ጋር ሲነጻጸር ያልተሟላ ይመስላል — የግብዓትና ሌሎች ወጪዎች እስኪመዘገቡ የወጪ ትንበያው ትርጉም የለውም።`
      : `Costs recorded so far (${moneyShort(k.ac ?? 0, currency)}) look incomplete for the work earned — the cost forecast is not meaningful until material and other costs are posted.`;
  } else if (k.eac != null && k.bac && k.cpi != null) {
    const diff = Math.abs(k.vac ?? k.bac - k.eac);
    const more = (k.vac ?? k.bac - k.eac) < 0;
    forecast = am
      ? `በዚህ ከቀጠልን ፕሮጀክቱ ${moneyShort(k.eac, currency)} ያስወጣል (ከበጀቱ ${moneyShort(diff, currency)} ${more ? 'በላይ' : 'በታች'})።`
      : `If this continues the project will cost ${moneyShort(k.eac, currency)} (${moneyShort(diff, currency)} ${more ? 'more' : 'less'} than budget).`;
  }
  return { headline, sentence, forecast };
}

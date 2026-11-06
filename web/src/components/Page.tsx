import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CircleAlert, CircleCheck, Inbox, Info, TriangleAlert } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { dateTime, num } from '../lib/format';

export interface Crumb { label: string; to?: string }

/**
 * Page template: breadcrumbs (detail pages only) · title + badges · subtitle · actions (≤1 primary).
 * `width`: 'fluid' (registers, default) · 'form' (≤1200px: forms/detail/settings) · 'dash' (≤1600px).
 */
export function Page({ title, titleExtra, subtitle, actions, children, breadcrumbs, width = 'fluid' }: {
  title: ReactNode; titleExtra?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
  breadcrumbs?: Crumb[]; width?: 'fluid' | 'form' | 'dash';
}) {
  return (
    <div className={`page${width === 'form' ? ' w-form' : width === 'dash' ? ' w-dash' : ''}`}>
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="page-head">
        <div className="titles">
          <div className="title-row"><h1>{title}</h1>{titleExtra}</div>
          {subtitle && <div className="subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="page-actions no-print">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumbs no-print" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight size={12} aria-hidden />}
          {c.to ? <Link className="crumb" to={c.to}>{c.label}</Link> : <span className="crumb" aria-current="page">{c.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

/** Surface container. `flush` removes padding (for tables). */
export function Card({ title, sub, actions, children, flush, className }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string;
}) {
  return (
    <section className={`card${flush ? ' flush' : ''}${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div><h2>{title}</h2>{sub && <div className="sub">{sub}</div>}</div>
          {actions && <div className="row no-print">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Inline message. tone: error | warn | ok | info | attention. */
export function Banner({ tone = 'info', children, action }: { tone?: 'error' | 'warn' | 'ok' | 'info' | 'attention'; children: ReactNode; action?: ReactNode }) {
  const I = tone === 'error' ? CircleAlert : tone === 'warn' || tone === 'attention' ? TriangleAlert : tone === 'ok' ? CircleCheck : Info;
  return (
    <div className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <I size={16} aria-hidden /><div className="grow">{children}</div>{action}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return <Banner tone="error" action={onRetry && <button className="small" onClick={onRetry}>Retry</button>}>{error}</Banner>;
}

/** Skeleton block in final layout dimensions (no spinners). */
export function Loading({ what, lines = 4 }: { what?: string; lines?: number }) {
  return (
    <div className="loading-block" aria-busy="true" aria-label={what ?? 'Loading'}>
      {Array.from({ length: lines }, (_, i) => <span key={i} className="skel" style={{ width: `${90 - (i % 3) * 18}%` }} />)}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skel" style={{ width, height }} />;
}

/** Empty state: what's missing + why + the action that fixes it. Plain children still work. */
export function Empty({ children, title, action, icon, inline }: { children?: ReactNode; title?: ReactNode; action?: ReactNode; icon?: ReactNode; inline?: boolean }) {
  return (
    <div className={`empty${inline ? ' inline' : ''}`}>
      {icon ?? (title ? <Inbox size={28} className="empty-icon" aria-hidden /> : null)}
      {title && <div className="empty-title">{title}</div>}
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

/** Progress bar with right-aligned % (tabular). */
export function Bar({ pct, tone }: { pct: number; tone?: 'warn' }) {
  return (
    <div className="bar-cell">
      <div className={`bar${tone ? ` ${tone}` : ''}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <span className="num">{num(pct, 1)}%</span>
    </div>
  );
}

/** Number + muted unit (tabular). Empty → "—". */
export function Qty({ value, unit, digits = 2 }: { value: unknown; unit?: string | null; digits?: number }) {
  if (value === null || value === undefined || value === '') return <span className="muted-dash">—</span>;
  return <>{num(value, digits)}{unit && <span className="unit">{unit}</span>}</>;
}

export const Dash = () => <span className="muted-dash">—</span>;

/** Print-only header for reports/documents: company, title, project, filters in words, printed at/by. */
export function PrintHeader({ title, filters }: { title: string; filters?: string }) {
  const auth = useAuth();
  return (
    <div className="print-header" aria-hidden>
      <div className="ph-top">
        <strong>{auth.companyName}</strong>
        <div className="ph-title">{title}</div>
        <span>{auth.project?.code}</span>
      </div>
      <div className="ph-meta">
        Project {auth.project?.code} · {auth.project?.name}{filters ? ` · Filters: ${filters}` : ''} · Printed {dateTime(new Date().toISOString())} by {auth.profile?.full_name}
      </div>
    </div>
  );
}

/** Print-only Prepared/Checked/Approved signature blocks (end of report/document). */
export function Signatures() {
  return <div className="signatures" aria-hidden><div>Prepared by</div><div>Checked by</div><div>Approved by</div></div>;
}

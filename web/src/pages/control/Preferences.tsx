import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2Off, Send } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { calendarPref } from '../../lib/calendar';
import { canControl, formatEthiopian, type NotificationPref, type ProfileLocale, type TelegramLink } from '../../lib/contract-control';
import { rpcx } from '../../lib/fieldx';
import { dateTime, today } from '../../lib/format';
import { Banner, Card, ErrorBanner, Field, Loading, Page, confirm, toast, useBusy } from '../../components/ui';
import '../../components/field/field.css';
import { DelegationsCard } from '../../components/flows/FlowSettings';

const BOT = (import.meta.env.VITE_TELEGRAM_BOT as string | undefined) ?? '';
const CHANNELS = ['in_app', 'push', 'telegram', 'sms'] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_LABEL: Record<Channel, string> = { in_app: 'In app', push: 'Push', telegram: 'Telegram', sms: 'SMS' };
const EVENTS: { event: string; label: string }[] = [
  { event: '*', label: 'Everything (default)' },
  { event: 'material_request', label: 'Material requests' }, { event: 'purchase_order', label: 'Purchase orders' },
  { event: 'grn', label: 'Receipts (GRN)' }, { event: 'miv', label: 'Issues (MIV)' }, { event: 'adjustment', label: 'Adjustments' },
  { event: 'stock_count', label: 'Stock counts' }, { event: 'progress_update', label: 'Progress verification' },
  { event: 'site_diary', label: 'Site diaries' }, { event: 'inspection', label: 'Inspections' }, { event: 'snag', label: 'Snags' },
  { event: 'cube_set', label: 'Concrete cube results' }, { event: 'gate_pass', label: 'Gate passes' }, { event: 'alert', label: 'Alerts' },
];
type Row = Record<Channel, boolean> & { set: boolean };
const DEFAULT: Row = { in_app: true, push: true, telegram: true, sms: false, set: false };

/** Personal settings every user can change: language & calendar, Telegram link, notification channels (F1 / H1). */
export function Preferences() {
  const auth = useAuth();
  const canTelegram = canControl(auth.profile?.role, 'telegram.link');
  return (
    <Page title="My preferences" subtitle={auth.profile?.full_name} width="form">
      <LocaleCard />
      {canTelegram && <TelegramCard />}
      <NotificationCard />
      <DelegationsCard projectId={auth.projectId} />
    </Page>
  );
}

function LocaleCard() {
  const auth = useAuth();
  const cur = calendarPref();
  const [pref, setPref] = useState<ProfileLocale>(cur);
  const { busy, error, run } = useBusy();
  const dirty = pref.locale !== cur.locale || pref.calendar !== cur.calendar;
  const save = () => run(async () => {
    await rpcx('set_my_locale', pref);
    await auth.reload();
    toast.success('Language and calendar saved');
  });
  const t = today();
  return (
    <Card title="Language & calendar" sub="Dates are stored Gregorian; this changes how they are shown to you">
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Language" hint="Amharic applies to the mobile app and Telegram messages; the web console stays in English for now">
          <select value={pref.locale} onChange={(e) => setPref({ ...pref, locale: e.target.value as ProfileLocale['locale'] })}>
            <option value="en">English</option><option value="am">አማርኛ (Amharic)</option>
          </select>
        </Field>
        <Field label="Calendar" hint={`Today: ${pref.calendar === 'ethiopian' ? formatEthiopian(t, pref.locale) : new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`}>
          <select value={pref.calendar} onChange={(e) => setPref({ ...pref, calendar: e.target.value as ProfileLocale['calendar'] })}>
            <option value="gregorian">Gregorian (European)</option><option value="ethiopian">Ethiopian (ዓ.ም.)</option>
          </select>
        </Field>
      </div>
      <div className="save-bar mt-2">
        <span className="grow">{dirty ? 'Unsaved changes' : ''}</span>
        <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
      </div>
    </Card>
  );
}

function TelegramCard() {
  const auth = useAuth();
  const me = auth.profile?.id ?? '';
  const q = useAsync(async () => check(await supabase.from('telegram_links').select('*').eq('user_id', me).maybeSingle()) as TelegramLink | null,
    [me], { key: 'telegram-link', enabled: !!me });
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const { busy, error, run } = useBusy();
  // While a code is showing, poll until the bot binds the chat.
  useEffect(() => {
    if (!code || q.data) return;
    const t = setInterval(() => q.reload(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, q.data]);
  useEffect(() => { if (q.data && code) { setCode(null); toast.success('Telegram connected'); } }, [q.data, code]);
  const create = () => run(async () => {
    const r = await rpcx('create_telegram_link_code', {}) as { code: string; expires_at: string };
    setCode({ code: r.code, expires_at: r.expires_at });
  });
  const unlink = () => run(async () => {
    if (!(await confirm({ title: 'Disconnect Telegram?', body: <p className="muted mb-0">You'll stop getting notifications and approval buttons in Telegram.</p>, confirm: 'Disconnect', danger: true }))) return;
    await rpcx('unlink_telegram', {});
    q.reload();
    toast.success('Telegram disconnected');
  });
  const link = code && BOT ? `https://t.me/${BOT}?start=${code.code}` : null;
  return (
    <Card title="Telegram" sub="Get notifications with Approve / Reject buttons in Telegram">
      <ErrorBanner error={error ?? q.error} />
      {q.data === undefined ? <Loading lines={2} /> : q.data ? (
        <div className="row">
          <span className="grow">Connected{q.data.username ? <> as <strong>@{q.data.username}</strong></> : ''} since {dateTime(q.data.linked_at)}.</span>
          <button disabled={busy} onClick={() => void unlink()}><Link2Off size={14} aria-hidden />Disconnect</button>
        </div>
      ) : code ? (
        <div className="stack">
          <ol className="mb-0">
            <li>{link ? <>Open <a href={link} target="_blank" rel="noreferrer">t.me/{BOT} <ExternalLink size={12} aria-hidden /></a> on your phone and press <strong>Start</strong>.</> : <>Open the project's Telegram bot and send:</>}</li>
            <li>Or send this to the bot: <code>/start {code.code}</code></li>
          </ol>
          <div className="row">
            <span className="tg-code" aria-label="Link code">{code.code}</span>
            <button className="small" onClick={() => { void navigator.clipboard?.writeText(`/start ${code.code}`); toast.info('Copied'); }}><Copy size={14} aria-hidden />Copy</button>
          </div>
          <span className="muted small-text">The code works once and expires {dateTime(code.expires_at)}. This page updates when the bot confirms.</span>
        </div>
      ) : (
        <button className="primary" disabled={busy} onClick={() => void create()}>{busy && <span className="spinner" />}<Send size={14} aria-hidden />Connect Telegram</button>
      )}
      {!BOT && code && <Banner tone="info">Ask your administrator for the bot's name (VITE_TELEGRAM_BOT is not set for this console).</Banner>}
    </Card>
  );
}

function NotificationCard() {
  const auth = useAuth();
  const me = auth.profile?.id ?? '';
  const q = useAsync(async () => check(await supabase.from('notification_prefs').select('*').eq('user_id', me)) as NotificationPref[], [me], { key: 'notification-prefs', enabled: !!me });
  const [rows, setRows] = useState<Record<string, Row> | null>(null);
  const [quiet, setQuiet] = useState({ from: '', to: '' });
  const { busy, error, run } = useBusy();
  useEffect(() => {
    if (!q.data) return;
    const m: Record<string, Row> = {};
    for (const p of q.data) m[p.event] = { in_app: p.in_app, push: p.push, telegram: p.telegram, sms: p.sms, set: true };
    setRows(m);
    const star = q.data.find((p) => p.event === '*');
    setQuiet({ from: star?.quiet_from?.slice(0, 5) ?? '', to: star?.quiet_to?.slice(0, 5) ?? '' });
  }, [q.data]);
  if (!rows) return <Card title="Notifications"><ErrorBanner error={q.error} onRetry={q.reload} /><Loading lines={6} /></Card>;
  const eff = (event: string): Row => rows[event] ?? (event === '*' ? DEFAULT : { ...(rows['*'] ?? DEFAULT), set: false });
  const toggle = (event: string, ch: Channel) => { const cur = eff(event); setRows({ ...rows, [event]: { ...cur, [ch]: !cur[ch], set: true } }); };
  const save = () => run(async () => {
    if ((quiet.from && !quiet.to) || (!quiet.from && quiet.to)) throw new Error('Set both ends of the quiet hours, or neither.');
    const prefs = Object.entries(rows).filter(([e, r]) => r.set || e === '*').map(([event, r]) => ({
      event, in_app: r.in_app, push: r.push, telegram: r.telegram, sms: r.sms,
      ...(event === '*' ? { quiet_from: quiet.from || null, quiet_to: quiet.to || null } : {}),
    }));
    if (!prefs.some((p) => p.event === '*')) prefs.unshift({ event: '*', ...DEFAULT, quiet_from: quiet.from || null, quiet_to: quiet.to || null });
    await rpcx('set_notification_prefs', { prefs });
    toast.success('Notification preferences saved');
  });
  return (
    <Card title="Notifications" sub="Which channels you get, per kind of event. Rows you don't change follow “Everything”. Critical notifications ignore quiet hours.">
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="pref-matrix">
          <thead><tr><th scope="col">Event</th>{CHANNELS.map((c) => <th key={c} scope="col">{CHANNEL_LABEL[c]}</th>)}</tr></thead>
          <tbody>
            {EVENTS.map(({ event, label }) => {
              const r = eff(event);
              return (
                <tr key={event}>
                  <th scope="row" className={event === '*' ? 'strong' : r.set ? '' : 'muted'} style={{ fontWeight: event === '*' ? undefined : 'normal' }}>{label}</th>
                  {CHANNELS.map((c) => (
                    <td key={c}><input type="checkbox" aria-label={`${label}: ${CHANNEL_LABEL[c]}`} checked={r[c]} onChange={() => toggle(event, c)} /></td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-grid mt-2">
        <Field label="Quiet hours from" hint="Ethiopian time (EAT)"><input type="time" value={quiet.from} onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} /></Field>
        <Field label="to"><input type="time" value={quiet.to} onChange={(e) => setQuiet({ ...quiet, to: e.target.value })} /></Field>
      </div>
      <div className="save-bar mt-2">
        <span className="grow" />
        <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save preferences</button>
      </div>
    </Card>
  );
}

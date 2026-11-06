import { useEffect, useState } from 'react';
import { Skeleton } from '../ui';

// `qrcode` is only fetched when a QR is actually rendered (labels, gate pass printout).
let lib: Promise<typeof import('qrcode')> | null = null;
const load = () => (lib ??= import('qrcode'));
const cache = new Map<string, string>();

/** Renders a signed code (SM1:…) as an inline SVG QR. */
export async function qrSvg(code: string): Promise<string> {
  const hit = cache.get(code);
  if (hit) return hit;
  const QR = await load();
  const svg = await QR.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  cache.set(code, svg);
  return svg;
}

export function QrCode({ code, size = 96, label }: { code: string; size?: number; label?: string }) {
  const [svg, setSvg] = useState<string | null>(cache.get(code) ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    qrSvg(code).then((s) => { if (alive) setSvg(s); }, (e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [code]);
  if (err) return <span className="danger-text small-text">QR failed: {err}</span>;
  if (!svg) return <Skeleton width={size} height={size} />;
  // SVG markup comes from the qrcode library for a server-signed string — no user HTML.
  return <span role="img" aria-label={label ?? 'QR code'} style={{ display: 'inline-block', width: size, height: size, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg width="100%" height="100%" ') }} />;
}

// Signature capture (spec §3.16): inline 120 dp preview + full-screen pad. Produces SVG path
// data in a 320×140 viewBox (same as the PDF templates in lib/print.ts).
// Perf: committed paths are memoised; only the live path re-renders (rAF-throttled),
// points closer than 1.5 px are skipped.
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { radius, space, useTheme } from '../../theme';
import { Icon } from './Icon';
import { Text } from './Text';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { FieldLabel, FieldMessage } from './Field';
import { useFieldRef } from './Form';
import { haptic } from './haptics';

export const SIG_W = 320;
export const SIG_H = 140;

const Committed = memo(function Committed({ paths, color, width }: { paths: string[]; color: string; width: number }) {
  return <>{paths.map((d, i) => <Path key={i} d={d} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}</>;
});

function Pad({ initial, onDone, onCancel }: { initial: string | null; onDone: (p: string | null) => void; onCancel: () => void }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const [paths, setPaths] = useState<string[]>(initial ? [initial] : []);
  const [live, setLive] = useState('');
  const cur = useRef('');
  const last = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);
  const box = useRef({ w: SIG_W, h: SIG_H });

  const flush = () => { raf.current = null; setLive(cur.current); };
  const schedule = () => { if (raf.current == null) raf.current = requestAnimationFrame(flush); };
  const pt = (x: number, y: number) => `${((x / box.current.w) * SIG_W).toFixed(1)},${((y / box.current.h) * SIG_H).toFixed(1)}`;

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      last.current = { x, y };
      cur.current = `M${pt(x, y)}`;
      schedule();
    },
    onPanResponderMove: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      const l = last.current;
      if (l && Math.hypot(x - l.x, y - l.y) < 1.5) return;
      last.current = { x, y };
      cur.current += ` L${pt(x, y)}`;
      schedule();
    },
    onPanResponderRelease: () => {
      const done = cur.current.includes('L') ? cur.current : `${cur.current} l0.1,0.1`;
      cur.current = '';
      last.current = null;
      if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
      setLive('');
      setPaths((ps) => [...ps, done]);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const landscape = width > height;
  const canvasW = Math.min(width - space[4] * 2, (height - 220) * (SIG_W / SIG_H));
  return (
    <View style={styles.padWrap}>
      {!landscape ? (
        <View style={styles.hint}>
          <Icon name="phone-rotate-landscape" size={20} tone="muted" />
          <Text variant="bodySm" tone="muted">Turn phone sideways for more space</Text>
        </View>
      ) : null}
      <View
        {...responder.panHandlers}
        onLayout={(e) => { box.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
        style={[styles.canvas, { width: canvasW, backgroundColor: t.canvas, borderColor: t.borderStrong }]}
        accessibilityLabel="Signature area. Sign with your finger."
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${SIG_W} ${SIG_H}`}>
          <Line x1={20} y1={SIG_H - 30} x2={SIG_W - 20} y2={SIG_H - 30} stroke="#9AA3AF" strokeWidth={1} />
          <Committed paths={paths} color={t.ink} width={3} />
          {live ? <Path d={live} stroke={t.ink} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
        </Svg>
        <View style={styles.x} pointerEvents="none"><Icon name="close" size={22} color="#6B7280" /></View>
        {!paths.length && !live ? <Text variant="bodySm" color="#6B7280" style={styles.signHere}>Sign here</Text> : null}
      </View>
      <View style={[styles.padActions, { width: canvasW }]}>
        <Button title="Cancel" variant="ghost" onPress={onCancel} />
        <Button title="Clear" variant="outline" icon="close" flex onPress={() => setPaths([])} />
        <Button title="Done" icon="check" flex onPress={() => { haptic('confirm'); onDone(paths.length ? paths.join(' ') : null); }} />
      </View>
    </View>
  );
}

export interface SignatureFieldProps {
  label: string;
  value: string | null;
  onChange: (path: string | null) => void;
  /** Signer's name shown under the preview (e.g. the driver). */
  signer?: string | null;
  error?: string | null;
  hint?: string | null;
  optional?: boolean;
  name?: string;
}

/** Inline preview + full-screen pad. Also exported as `SignaturePad` for older screens. */
export function SignatureField({ label, value, onChange, signer, error, hint, optional, name }: SignatureFieldProps) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useFieldRef(name);
  const done = useCallback((p: string | null) => { onChange(p); setOpen(false); }, [onChange]);
  return (
    <View ref={wrapRef} style={styles.wrap}>
      <FieldLabel label={label} optional={optional} />
      {value ? (
        <View style={[styles.preview, { backgroundColor: t.canvas, borderColor: t.borderStrong }]}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${SIG_W} ${SIG_H}`}>
            <Path d={value} stroke={t.ink} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
      ) : (
        <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}: tap to sign`}
          android_ripple={{ color: t.ripple }}
          style={[styles.empty, { borderColor: error ? t.danger : t.borderStrong, backgroundColor: t.surface }]}>
          <Icon name="draw-pen" size={24} tone="primary" />
          <Text variant="label" tone="primary">{signer ? `${signer} signs here` : 'Tap to sign'}</Text>
          <Icon name="chevron-right" size={22} tone="primary" />
        </Pressable>
      )}
      {value ? (
        <View style={styles.row}>
          {signer ? <Text variant="bodySm" tone="muted" style={styles.flex}>Signed by {signer}</Text> : <View style={styles.flex} />}
          <Button size="sm" variant="ghost" title="Clear" onPress={() => onChange(null)} />
          <Button size="sm" variant="tonal" icon="draw-pen" title="Re-sign" onPress={() => setOpen(true)} />
        </View>
      ) : null}
      <FieldMessage error={error} hint={hint} />
      {open ? (
        <Sheet visible={open} onClose={() => setOpen(false)} fullscreen title={label}>
          <Pad initial={value} onDone={done} onCancel={() => setOpen(false)} />
        </Sheet>
      ) : null}
    </View>
  );
}
export const SignaturePad = SignatureField;

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  preview: { height: 120, borderWidth: 1.5, borderRadius: radius.md, overflow: 'hidden' },
  empty: { minHeight: 64, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space[2], overflow: 'hidden' },
  padWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[3], padding: space[4] },
  hint: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  canvas: { aspectRatio: SIG_W / SIG_H, borderWidth: 2, borderRadius: radius.md, overflow: 'hidden' },
  x: { position: 'absolute', left: 14, bottom: 30 },
  signHere: { position: 'absolute', left: 44, bottom: 36 },
  padActions: { flexDirection: 'row', gap: space[3], maxWidth: '100%' },
});

// Reason picker sheet: common reasons as chips, "Other…" reveals a text field (spec §3.9).
// Used for reject / return / reverse / over-BoQ reasons.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { space } from '../../theme';
import { Sheet } from './Sheet';
import { ChipGroup } from './Chip';
import { Field } from './Field';
import { Button, type ButtonVariant } from './Button';
import { Text } from './Text';

export const OTHER = '__other';

export function ReasonSheet({ visible, onClose, title, subtitle, reasons, confirmLabel, variant = 'primary', onConfirm, allowEmpty, placeholder }: {
  visible: boolean; onClose: () => void; title: string; subtitle?: string;
  reasons: string[]; confirmLabel: string; variant?: ButtonVariant;
  onConfirm: (reason: string) => void;
  /** Allow confirming without a reason (optional comment). */
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const reason = pick === OTHER || !reasons.length ? text.trim() : [pick, text.trim()].filter(Boolean).join(' · ');
  const submit = () => {
    if (!reason && !allowEmpty) { setErr('Choose or type a reason'); return; }
    onConfirm(reason);
    setPick(null); setText(''); setErr(null);
  };
  const showText = pick === OTHER || !reasons.length || !!pick;
  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}
      footer={<>
        <Button title="Cancel" variant="ghost" onPress={onClose} />
        <Button title={confirmLabel} variant={variant} flex onPress={submit} />
      </>}>
      <View style={styles.body}>
        {reasons.length ? (
          <ChipGroup value={pick} onChange={(v) => { setPick(v); setErr(null); }}
            options={[...reasons.map((r) => ({ value: r, label: r })), { value: OTHER, label: 'Other…' }]} />
        ) : null}
        {showText ? (
          <Field label={pick === OTHER || !reasons.length ? 'Reason' : 'Details'} optional={pick !== OTHER && !!reasons.length}
            value={text} onChangeText={(v) => { setText(v); setErr(null); }} multiline placeholder={placeholder} autoFocus={pick === OTHER} />
        ) : null}
        {err ? <Text variant="bodySm" tone="danger">{err}</Text> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space[4], paddingBottom: space[3], gap: space[3] },
});

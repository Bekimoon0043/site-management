// Scan a gate pass QR at the gate. Verified offline with the project key (get_qr_key, kept in
// secure storage), then opens the pass for the plate check and exit / return.
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { checkQr } from '../../lib/qr';
import { t } from '../../lib/i18n';
import { Banner, Button, EmptyState, QrScanner, Screen, haptic } from '../../components/ui';

export default function ScanGatePass() {
  const { project } = useSession();
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const onCode = (code: string) => {
    setOpen(false);
    void checkQr(code).then((r) => {
      if (!r.ok || !r.payload) { haptic('reject'); setError(r.reason ?? t('gate.invalidQr')); return; }
      if (r.payload.entity_type !== 'gate_pass') { haptic('reject'); setError('This QR code is not a gate pass.'); return; }
      if (r.payload.project_id !== project.id) { haptic('reject'); setError('This gate pass belongs to another project.'); return; }
      if (!get('gate_passes', r.payload.entity_id)) { setError('Valid gate pass, but it is not on this phone yet. Sync and scan again.'); return; }
      haptic('confirm');
      router.replace(`/gate/${r.payload.entity_id}?scanned=${r.how ?? 'offline'}`);
    });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('gate.scan') }} />
      {error ? <Banner tone="danger" icon="shield-alert-outline" title={t('gate.invalidQr')} text={error} /> : null}
      <EmptyState icon="qrcode-scan" title={t('gate.scan')} body={t('gate.scanHint')}
        action={{ label: t('common.scan'), icon: 'qrcode-scan', onPress: () => { setError(null); setOpen(true); } }} />
      <Button title={t('gate.passes')} variant="ghost" icon="boom-gate-outline" onPress={() => router.replace('/passes')} />
      <QrScanner visible={open} onClose={() => setOpen(false)} onCode={onCode} title={t('gate.scan')} />
    </Screen>
  );
}

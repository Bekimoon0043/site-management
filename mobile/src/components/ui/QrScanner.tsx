// Full-screen QR scanner (expo-camera barcode scanning). expo-camera is required lazily so a
// native build that predates the module still runs (the scanner then explains how to update).
import React, { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../../lib/i18n';
import { radius, space } from '../../theme';
import { Button, IconButton } from './Button';
import { Text } from './Text';
import { haptic } from './haptics';

type CameraModule = typeof import('expo-camera');
let cam: CameraModule | null | undefined;
function camera(): CameraModule | null {
  if (cam === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cam = require('expo-camera') as CameraModule;
    } catch {
      cam = null;
    }
  }
  return cam;
}

export function QrScanner({ visible, onClose, onCode, title, hint }: {
  visible: boolean; onClose: () => void; onCode: (code: string) => void; title?: string; hint?: string;
}) {
  if (!visible) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <ScannerBody onClose={onClose} onCode={onCode} title={title} hint={hint} />
    </Modal>
  );
}

function ScannerBody({ onClose, onCode, title, hint }: { onClose: () => void; onCode: (code: string) => void; title?: string; hint?: string }) {
  const insets = useSafeAreaInsets();
  const mod = camera();
  const [perm, setPerm] = useState<boolean | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!mod) return;
    let alive = true;
    void (async () => {
      try {
        const cur = await mod.Camera.getCameraPermissionsAsync();
        const ok = cur.granted || (await mod.Camera.requestCameraPermissionsAsync()).granted;
        if (alive) setPerm(ok);
      } catch {
        if (alive) setPerm(false);
      }
    })();
    return () => { alive = false; };
  }, [mod]);

  const header = (
    <View style={[styles.top, { paddingTop: insets.top + space[2] }]}>
      <IconButton icon="close" accessibilityLabel={t('common.close')} onPress={onClose} color="#FFFFFF" />
      <Text variant="title" color="#FFFFFF" style={styles.flex} numberOfLines={1}>{title ?? t('common.scan')}</Text>
    </View>
  );

  if (!mod || perm === false) {
    return (
      <View style={[styles.root, styles.center]}>
        {header}
        <View style={styles.msg}>
          <Text variant="titleSm" color="#FFFFFF" align="center">
            {!mod ? 'Scanning needs the latest app build. Ask your administrator to update the app.' : 'Camera permission is needed to scan QR codes.'}
          </Text>
          <Button title={t('common.close')} variant="tonal" onPress={onClose} />
        </View>
      </View>
    );
  }
  const { CameraView } = mod;
  return (
    <View style={styles.root}>
      {perm ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r) => {
            if (done.current || !r.data) return;
            done.current = true;
            haptic('tick');
            onCode(r.data);
          }} />
      ) : null}
      {header}
      <View style={styles.frameWrap} pointerEvents="none">
        <View style={styles.frame} />
      </View>
      <View style={[styles.bottom, { paddingBottom: insets.bottom + space[4] }]}>
        <Text variant="body" color="#FFFFFF" align="center">{hint ?? t('gate.pointCamera')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  center: { justifyContent: 'center' },
  flex: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[2], backgroundColor: 'rgba(0,0,0,0.45)', paddingBottom: space[2] },
  frameWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderRadius: radius.lg, borderWidth: 3, borderColor: '#F5B301' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space[4], backgroundColor: 'rgba(0,0,0,0.45)' },
  msg: { padding: space[6], gap: space[4], alignItems: 'center' },
});

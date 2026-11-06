// Bottom sheet on RN Modal (spec §3.6): scrim fade + native-driver slide, keyboard-safe,
// optional sticky footer. `full` gives the 90 % height search-sheet layout.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { duration, elevation, radius, space, useTheme } from '../../theme';
import { IconButton } from './Button';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 90 % height (lists). Otherwise sized to content (max 90 %). */
  full?: boolean;
  /** Full-screen, no rounded top (signature pad). */
  fullscreen?: boolean;
  testID?: string;
}

export function Sheet({ visible, onClose, title, subtitle, children, footer, full, fullscreen, testID }: SheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const y = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (visible) {
      y.setValue(1);
      Animated.timing(y, { toValue: 0, duration: duration.enter, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [visible, y]);

  const maxH = fullscreen ? height : height * 0.9;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'android' ? 'height' : 'padding'}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose}
          accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.flex} pointerEvents="box-none" />
        <Animated.View
          testID={testID}
          style={[
            styles.sheet,
            elevation(t, 3),
            {
              backgroundColor: t.dark ? t.surfaceElevated : t.surface,
              maxHeight: maxH,
              height: fullscreen ? height : full ? maxH : undefined,
              borderTopLeftRadius: fullscreen ? 0 : radius.xl,
              borderTopRightRadius: fullscreen ? 0 : radius.xl,
              paddingTop: fullscreen ? insets.top : 0,
              borderColor: t.border, borderWidth: t.boost ? 2 : 0,
              transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [0, 400] }) }],
            },
          ]}
        >
          {!fullscreen ? <View style={[styles.handle, { backgroundColor: t.borderStrong }]} /> : null}
          {title ? (
            <View style={styles.head}>
              <View style={styles.flex}>
                <Text variant="title" numberOfLines={2} accessibilityRole="header">{title}</Text>
                {subtitle ? <Text variant="bodySm" tone="muted" numberOfLines={2}>{subtitle}</Text> : null}
              </View>
              <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" />
            </View>
          ) : null}
          <View style={full || fullscreen ? styles.flex : styles.shrink}>{children}</View>
          {footer ? (
            <View style={[styles.footer, { borderTopColor: t.border, paddingBottom: Math.max(insets.bottom, space[3]) }]}>{footer}</View>
          ) : <View style={{ height: insets.bottom }} />}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  sheet: { overflow: 'hidden' },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: 8, marginBottom: 4, opacity: 0.6 },
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], paddingRight: space[2], paddingVertical: space[1], gap: space[2] },
  footer: { flexDirection: 'row', gap: space[3], paddingHorizontal: space[4], paddingTop: space[3], borderTopWidth: 1, justifyContent: 'flex-end' },
});

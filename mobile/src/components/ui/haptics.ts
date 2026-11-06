// Haptics (spec §2.8): Android system effects, fire-and-forget, respects the setting.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { hapticsEnabled } from '../../theme';

type Effect = 'confirm' | 'reject' | 'tick' | 'toggleOn' | 'toggleOff' | 'gesture';

const MAP: Record<Effect, Haptics.AndroidHaptics> = {
  confirm: Haptics.AndroidHaptics.Confirm,
  reject: Haptics.AndroidHaptics.Reject,
  tick: Haptics.AndroidHaptics.Keyboard_Tap,
  toggleOn: Haptics.AndroidHaptics.Toggle_On,
  toggleOff: Haptics.AndroidHaptics.Toggle_Off,
  gesture: Haptics.AndroidHaptics.Gesture_Start,
};

/** `haptic('confirm')` after posting / approving; `'reject'` when validation blocks; `'tick'` for steppers. */
export function haptic(effect: Effect) {
  if (!hapticsEnabled()) return;
  try {
    if (Platform.OS === 'android') void Haptics.performAndroidHapticsAsync(MAP[effect]).catch(() => undefined);
    else if (effect === 'confirm') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    else if (effect === 'reject') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    else void Haptics.selectionAsync().catch(() => undefined);
  } catch {
    // no haptics engine
  }
}

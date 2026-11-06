// Settings: account, language (English / አማርኛ) + calendar (Gregorian / Ethiopian), theme, project,
// Telegram link, notification preferences, vibration, photos, biometrics, data.
import React, { useState } from 'react';
import { Linking, StyleSheet, Switch, View } from 'react-native';
import { Stack } from 'expo-router';
import { useApp, useData } from '../lib/app';
import { ROLE_LABELS } from '../lib/contract';
import { ROLE_LABELS_AM, type NotificationPref, type TelegramLink } from '../lib/contract-control';
import { get, kvGet, kvSet, bump, list } from '../lib/db';
import { projects } from '../lib/queries';
import { devicePrefix } from '../lib/device';
import { enqueue, resetSyncCursors, syncNow } from '../lib/sync';
import { getDeviceId, supabase } from '../lib/supabase';
import { fmtDate, fmtDateTime, today } from '../lib/format';
import { setLocalePrefs, t, useLocale, type Calendar, type Locale } from '../lib/i18n';
import { setHapticsEnabled, setThemeMode, space, useTheme, useUiPrefs, type ThemeMode } from '../theme';
import {
  Banner, Button, Card, Icon, InfoRow, ListRow, Screen, Section, Segmented, Text, confirm, haptic, showError, toast, useOutboxCounts, type IconName,
} from '../components/ui';

const TELEGRAM_BOT = process.env.EXPO_PUBLIC_TELEGRAM_BOT || 'SiteMaterialsBot';

// Events = notifications.entity_type ('*' = everything else).
const EVENTS: { event: string; label: string; icon: IconName }[] = [
  { event: '*', label: 'All notifications', icon: 'bell-outline' },
  { event: 'material_request', label: 'Material requests', icon: 'clipboard-list-outline' },
  { event: 'purchase_order', label: 'Purchase orders', icon: 'cart-outline' },
  { event: 'grn', label: 'Deliveries (GRN)', icon: 'truck-delivery-outline' },
  { event: 'miv', label: 'Issues (MIV)', icon: 'package-variant-closed' },
  { event: 'gate_pass', label: 'Gate passes', icon: 'boom-gate-outline' },
  { event: 'alert', label: 'Alerts', icon: 'bell-alert-outline' },
];

function SwitchRow({ icon, label, sub, value, onChange }: { icon: IconName; label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <View style={styles.switchRow}>
      <Icon name={icon} size={24} tone="primary" />
      <View style={styles.flex}>
        <Text variant="body" weight="600">{label}</Text>
        {sub ? <Text variant="bodySm" tone="muted">{sub}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label}
        trackColor={{ true: t.primary, false: t.surfaceMuted }} thumbColor={value ? t.onPrimary : t.borderStrong} />
    </View>
  );
}

export default function Settings() {
  const { profile, project, selectProject, signOut, biometric, setBiometric } = useApp();
  const { mode, haptics } = useUiPrefs();
  const { locale, calendar } = useLocale();
  const ps = useData(() => projects());
  const wifi = useData(() => kvGet('wifi-only-photos') === '1');
  const { pending, failed } = useOutboxCounts();
  const uid = profile?.id ?? '';
  const tg = useData(() => {
    const l = get<TelegramLink & { deleted_at?: string | null }>('telegram_links', uid);
    return l && !l.deleted_at ? l : null;
  }, [uid]);
  const prefs = useData(() => new Map(list<NotificationPref>('notification_prefs', { parent: uid }).map((p) => [p.event, p])), [uid]);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const setLang = (l: Locale) => {
    setLocalePrefs({ locale: l });
    enqueue('set_my_locale', { locale: l }, { entityType: 'profile', entityId: uid, label: `Language: ${l === 'am' ? 'Amharic' : 'English'}` });
  };
  const setCal = (c: Calendar) => {
    setLocalePrefs({ calendar: c });
    enqueue('set_my_locale', { calendar: c }, { entityType: 'profile', entityId: uid, label: `Calendar: ${c}` });
  };

  const connectTelegram = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('create_telegram_link_code', { p: {} });
      if (error) throw new Error(error.code ? error.message : 'Connect to the internet to link Telegram.');
      const d = data as { code: string; expires_at: string };
      setCode(d);
      await Linking.openURL(`https://t.me/${TELEGRAM_BOT}?start=${encodeURIComponent(d.code)}`).catch(() => undefined);
    } catch (e) { showError(e, t('set.connectTelegram')); } finally { setBusy(false); }
  };

  const pref = (event: string) => prefs.get(event) ?? prefs.get('*') ?? null;
  const setPref = (event: string, patch: Partial<Pick<NotificationPref, 'push' | 'telegram' | 'quiet_from' | 'quiet_to'>>) => {
    const cur = pref(event);
    enqueue('set_notification_prefs', {
      prefs: [{ event, in_app: true, push: cur?.push ?? true, telegram: cur?.telegram ?? true, sms: cur?.sms ?? false,
        quiet_from: cur?.quiet_from ?? null, quiet_to: cur?.quiet_to ?? null, ...patch }],
    }, { entityType: 'notification_prefs', entityId: `${uid}|${event}`, label: 'Notification settings' });
    haptic('tick');
  };
  const quiet = !!prefs.get('*')?.quiet_from;

  return (
    <Screen>
      <Stack.Screen options={{ title: t('title.settings') }} />
      <Card>
        <Text variant="titleSm">{profile?.full_name}</Text>
        <Text variant="bodySm" tone="muted">{profile ? (locale === 'am' ? ROLE_LABELS_AM[profile.role] : ROLE_LABELS[profile.role]) : ''} · {profile?.email ?? profile?.phone}</Text>
        <InfoRow label="Device" value={devicePrefix() ?? 'not registered'} />
        <Text variant="caption" tone="muted">{getDeviceId()}</Text>
      </Card>

      <Section title={t('set.language')}>
        <Segmented<Locale> value={locale} onChange={setLang} accessibilityLabel={t('set.language')} options={[
          { value: 'en', label: 'English' }, { value: 'am', label: 'አማርኛ' },
        ]} />
      </Section>
      <Section title={t('set.calendar')}>
        <Segmented<Calendar> value={calendar} onChange={setCal} accessibilityLabel={t('set.calendar')} options={[
          { value: 'gregorian', label: t('set.gregorian') }, { value: 'ethiopian', label: t('set.ethiopian') },
        ]} />
        <Text variant="bodySm" tone="muted">{t('home.today')}: {fmtDate(today())}</Text>
      </Section>

      <Section title={t('set.theme')}>
        <Segmented<ThemeMode> value={mode} onChange={setThemeMode} accessibilityLabel="Theme" options={[
          { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'sunlight', label: 'Sunlight' },
        ]} />
        <Text variant="bodySm" tone="muted">Sunlight: maximum contrast, thicker borders and bolder text for direct sun.</Text>
      </Section>

      <Section title={t('set.project')}>
        <Card flush>
          {ps.map((p) => (
            <ListRow key={p.id} id={p.id} title={p.name} subtitle={p.code} icon={p.id === project?.id ? 'check' : 'crane'}
              iconTone={p.id === project?.id ? 'success' : 'primary'} onPress={selectProject} />
          ))}
        </Card>
      </Section>

      <Section title={t('set.telegram')}>
        <Card>
          {tg ? (
            <>
              <InfoRow label={t('set.telegram')} value={t('set.telegramLinked', { u: tg.username ? `@${tg.username}` : String(tg.chat_id) })} icon="check" tone="success" />
              <Text variant="caption" tone="muted">Linked {fmtDateTime(tg.linked_at)}</Text>
              <Button title="Disconnect" variant="dangerOutline" size="md" onPress={() => confirm('Disconnect Telegram', 'You will stop getting messages and approval buttons in Telegram.', () => {
                enqueue('unlink_telegram', {}, { entityType: 'telegram_link', entityId: uid, label: 'Telegram disconnected' });
              }, 'Disconnect', true)} />
            </>
          ) : (
            <>
              <Text variant="bodySm" tone="muted">{t('set.telegramHint')}</Text>
              {code ? (
                <Banner tone="info" icon="send" title={`Code: ${code.code}`}
                  text={`Open @${TELEGRAM_BOT} and press Start (or send /start ${code.code}). Valid until ${fmtDateTime(code.expires_at)}.`}
                  actions={[{ label: 'Open Telegram', onPress: () => void Linking.openURL(`https://t.me/${TELEGRAM_BOT}?start=${encodeURIComponent(code.code)}`) }]} />
              ) : null}
              <Button title={code ? 'New code' : t('set.connectTelegram')} icon="send" variant={code ? 'outline' : 'tonal'} busy={busy} onPress={() => void connectTelegram()} />
            </>
          )}
        </Card>
      </Section>

      <Section title={t('set.notifications')}>
        <Card>
          <Text variant="caption" tone="muted">In-app notifications are always on. Critical alerts ignore quiet hours.</Text>
          {EVENTS.map((e) => {
            const p = pref(e.event);
            return (
              <View key={e.event} style={styles.prefBlock}>
                <SwitchRow icon={e.icon} label={`${e.label} · push`} value={p?.push ?? true} onChange={(v) => setPref(e.event, { push: v })} />
                {tg ? <SwitchRow icon="send" label={`${e.label} · Telegram`} value={p?.telegram ?? true} onChange={(v) => setPref(e.event, { telegram: v })} /> : null}
              </View>
            );
          })}
          <SwitchRow icon="weather-night" label="Quiet hours" sub="21:00 – 06:00, no push or Telegram" value={quiet}
            onChange={(v) => setPref('*', v ? { quiet_from: '21:00', quiet_to: '06:00' } : { quiet_from: null, quiet_to: null })} />
        </Card>
      </Section>

      <Section title={t('set.preferences')}>
        <Card>
          <SwitchRow icon="vibrate" label="Vibration feedback" value={haptics} onChange={(v) => { setHapticsEnabled(v); if (v) haptic('toggleOn'); }} />
          <SwitchRow icon="wifi" label="Upload photos on Wi-Fi only" value={wifi} onChange={(v) => { kvSet('wifi-only-photos', v ? '1' : '0'); bump(); }} />
          <SwitchRow icon="fingerprint" label="Biometric unlock" value={biometric} onChange={async (v) => {
            const ok = await setBiometric(v);
            if (!ok) showError(new Error('Biometric unlock is not available or was not confirmed on this device.'));
          }} />
        </Card>
      </Section>

      <Section title={t('set.data')}>
        <Card flush>
          <ListRow id="redl" title="Full re-download from server" subtitle="Unsynced changes are kept" icon="database-refresh-outline"
            onPress={() => confirm('Re-download', 'Fetches all data again. Unsynced changes are kept.', () => { resetSyncCursors(); void syncNow(); toast.show('Re-downloading…'); })} />
          <ListRow id="out" title={t('common.signOut')} icon="logout" iconTone="danger" onPress={() => {
            const n = pending + failed;
            const msg = n ? `${n} change(s) are not synced yet and will be lost if another user signs in on this device.` : 'You will need to sign in again.';
            confirm(t('common.signOut'), msg, () => void signOut(), t('common.signOut'), true);
          }} />
        </Card>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 56 },
  prefBlock: { gap: 0 },
});

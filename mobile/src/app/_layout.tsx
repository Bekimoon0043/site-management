// Root: providers → Gate (configure / login / lock / project) → root Stack.
// Tabs live in (tabs)/; create & post flows push full-screen on this stack (no tab bar).
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp, useData, useSyncState } from '../lib/app';
import { ThemeProvider, space, typeFor, useTheme } from '../theme';
import { Button, Card, Field, Icon, ListRow, Screen, SyncPill, Text, ToastHost, showError } from '../components/ui';
import { projects } from '../lib/queries';
import { ROLE_LABELS } from '../lib/contract';
import { LocaleRoot } from '../components/LocaleRoot';

function Brand({ subtitle }: { subtitle?: string }) {
  const t = useTheme();
  return (
    <View style={styles.brand}>
      <View style={[styles.mark, { backgroundColor: t.dark ? t.primaryContainer : t.primary }]}>
        <Icon name="hard-hat" size={36} color={t.accent} />
      </View>
      <Text variant="headline">Site Materials</Text>
      {subtitle ? <Text variant="body" tone="muted" align="center">{subtitle}</Text> : null}
    </View>
  );
}

function Login() {
  const { signIn } = useApp();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ id?: string; pw?: string }>({});
  const submit = async () => {
    const e = { id: id.trim() ? undefined : 'Enter your email or phone number', pw: pw ? undefined : 'Enter your password or PIN' };
    setErr(e);
    if (e.id || e.pw) return;
    setBusy(true);
    try { await signIn(id, pw); } catch (x) { showError(x, 'Sign-in failed'); } finally { setBusy(false); }
  };
  return (
    <Screen band={false}>
      <View style={{ height: space[8] }} />
      <Brand subtitle="Materials management and progress tracking" />
      <Field label="Email or phone number" value={id} onChangeText={setId} autoCapitalize="none" keyboardType="email-address"
        autoComplete="username" leadingIcon="account-outline" error={err.id} returnKeyType="next" />
      <Field label="Password or PIN" value={pw} onChangeText={setPw} secureTextEntry autoComplete="password" leadingIcon="lock-outline"
        onSubmitEditing={submit} error={err.pw} submitBehavior="submit" returnKeyType="go" />
      <Button title="Sign in" onPress={submit} busy={busy} block />
      <Text variant="bodySm" tone="muted">Accounts are created by your administrator. Phone numbers use international format, e.g. +2519…</Text>
    </Screen>
  );
}

function Lock() {
  const { unlock, signOut } = useApp();
  return (
    <Screen band={false}>
      <View style={{ height: space[12] }} />
      <Brand subtitle="Locked. Unlock with your fingerprint or face to continue." />
      <Button title="Unlock" icon="fingerprint" onPress={() => void unlock()} block />
      <Button title="Sign out instead" variant="ghost" onPress={() => void signOut()} block />
    </Screen>
  );
}

function ProjectChooser() {
  const { selectProject, profile, signOut } = useApp();
  const ps = useData(() => projects());
  const s = useSyncState();
  return (
    <Screen band={false}>
      <View style={{ height: space[6] }} />
      <Text variant="headline">Choose project</Text>
      {profile ? <Text variant="body" tone="muted">{profile.full_name} · {ROLE_LABELS[profile.role]}</Text> : null}
      {ps.length ? (
        <Card flush>
          {ps.map((p) => (
            <ListRow key={p.id} id={p.id} title={p.name} subtitle={`${p.code}${p.location ? ` · ${p.location}` : ''}`}
              icon="crane" chevron onPress={selectProject} />
          ))}
        </Card>
      ) : (
        <Card>
          {s.running ? <ActivityIndicator /> : null}
          <Text variant="body">
            {s.running ? 'Downloading your projects…' : s.online ? 'You are not assigned to any project yet. Ask your coordinator to add you.' : 'Connect to the internet for the first sync.'}
          </Text>
          {s.lastError ? <Text variant="bodySm" tone="danger">{s.lastError}</Text> : null}
        </Card>
      )}
      <Button title="Sign out" variant="ghost" icon="logout" onPress={() => void signOut()} />
    </Screen>
  );
}

function Gate() {
  const t = useTheme();
  const { ready, configured, userId, locked, project, profile } = useApp();
  if (!ready) {
    return <View style={[styles.center, { backgroundColor: t.background }]}><ActivityIndicator size="large" color={t.primary} /></View>;
  }
  if (!configured) {
    return (
      <Screen band={false}>
        <Text variant="headline">Not configured</Text>
        <Text>Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in mobile/.env and restart the bundler.</Text>
      </Screen>
    );
  }
  if (!userId) return <Login />;
  if (locked) return <Lock />;
  if (!project || !profile) return <ProjectChooser />;
  const title = typeFor('title', t);
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontSize: title.fontSize, fontWeight: title.fontWeight },
        headerShadowVisible: !t.dark,
        contentStyle: { backgroundColor: t.background },
        headerRight: () => <SyncPill />,
        animation: 'slide_from_right',
        animationDuration: 250,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ presentation: 'modal', title: 'Search', headerRight: () => null }} />
    </Stack>
  );
}

function Themed() {
  const t = useTheme();
  return (
    <View style={[styles.flex, { backgroundColor: t.background }]}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Gate />
      <ToastHost />
    </View>
  );
}

function WithTheme() {
  const { ready } = useApp();
  return <ThemeProvider ready={ready}><LocaleRoot><Themed /></LocaleRoot></ThemeProvider>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <WithTheme />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  brand: { alignItems: 'center', gap: space[2], marginBottom: space[4] },
  mark: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

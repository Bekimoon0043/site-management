// Office engineer verification: schedule task progress (task_progress_verify → verify_task_progress:
// approve / adjust with comment / reject) next to the existing element progress verification.
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { dashboardCounts, scheduleCounts } from '../../lib/counts';
import { t as tr, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import { Button, Screen, Segmented } from '../../components/ui';
import { TaskVerifyList } from '../../components/schedule';

export default function VerifyTasks() {
  useLocale();
  const { profile, project } = useSession();
  const [tab, setTab] = useState<'tasks' | 'elements'>('tasks');
  const n = useData(() => ({ tasks: scheduleCounts(project.id, profile.id).tasksToVerify, elements: dashboardCounts(project.id, profile.id).toVerify }), [project.id, profile.id]);
  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: tr('sch.verifyTitle') }} />
      <View style={styles.head}>
        <Segmented value={tab} onChange={(v) => (v === 'elements' ? router.push('/progress/verify' as Href) : setTab(v))} options={[
          { value: 'tasks', label: `${tr('sch.verifyTasks')} · ${n.tasks}` },
          { value: 'elements', label: `${tr('sch.verifyElements')} · ${n.elements}` },
        ]} />
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <TaskVerifyList />
        {n.elements ? (
          <Button title={`${tr('sch.verifyElements')} · ${n.elements}`} variant="tonal" icon="pillar" onPress={() => router.push('/progress/verify' as Href)} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: space[4], paddingTop: space[3] },
  body: { padding: space[4], gap: space[3], paddingBottom: space[8] },
});

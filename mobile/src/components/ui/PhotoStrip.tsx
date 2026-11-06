// Photo / document strip: compressed offline captures, captions and evidence tags, queued/failed badges,
// geotag chip, and a full-screen viewer with Delete / Retake for pending photos or external opening for PDFs.
import React, { memo, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useData } from '../../lib/app';
import { list } from '../../lib/db';
import { ATTACHMENT_TAG_LABELS, type AttachmentRow, type AttachmentTag } from '../../lib/contract-photos';
import { capturePhotos, deleteLocalPhoto, localPhotos, signedUrl, thumbUri, type AttachmentKind, type UploadEntry } from '../../lib/photos';
import { radius, space, useTheme } from '../../theme';
import { Icon } from './Icon';
import { Text } from './Text';
import { Button, IconButton } from './Button';
import { Chip, ChipGroup } from './Chip';
import { Field, FieldLabel, FieldMessage } from './Field';
import { useFieldRef } from './Form';
import { showError, confirm } from './Feedback';

const THUMB = 80;
/** Deleted in the console (update_attachment) — hidden here too. */
const isDeleted = (a: AttachmentRow) => !!a.deleted_at;

/** Number of photos (local + uploaded) on an entity, for required-photo validation. */
export function usePhotoCount(entityId: string) {
  return useData(() => {
    const l = localPhotos(entityId);
    const ids = new Set(l.map((x) => x.id));
    return l.length + list<AttachmentRow>('attachments', { parent: entityId }).filter((a) => !ids.has(a.id) && !isDeleted(a)).length;
  }, [entityId]);
}

function TagBadge({ tag }: { tag?: AttachmentTag | null }) {
  if (!tag) return null;
  return <View style={styles.evidenceTag}><Text variant="caption" color="#FFFFFF">{ATTACHMENT_TAG_LABELS[tag]}</Text></View>;
}

const RemoteThumb = memo(function RemoteThumb({ attachment, size, onPress }: { attachment: AttachmentRow; size: number; onPress: (uri: string) => void }) {
  const t = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const path = attachment.storage_path;
  const image = (attachment.mime_type ?? '').startsWith('image/');
  useEffect(() => { let on = true; void signedUrl(path).then((u) => { if (on) setUri(u); }); return () => { on = false; }; }, [path]);
  const box = { width: size, height: size, borderRadius: radius.sm, backgroundColor: t.surfaceMuted };
  return (
    <Pressable disabled={!uri} onPress={() => uri && onPress(uri)} accessibilityRole="button"
      accessibilityLabel={`Open ${attachment.caption ?? (image ? 'photo' : attachment.file_name ?? 'document')}`}>
      {uri && image ? (
        <Image source={{ uri, cacheKey: path }} recyclingKey={path} cachePolicy="memory-disk" transition={100} contentFit="cover" style={box} />
      ) : <View style={[box, styles.document]}>{uri ? <Icon name="file-document-outline" size={30} tone="primary" /> : null}</View>}
      <TagBadge tag={attachment.tag} />
    </Pressable>
  );
});

export interface PhotoStripProps {
  projectId: string;
  entityType: string;
  entityId: string;
  kind?: AttachmentKind;
  canAdd?: boolean;
  label?: string;
  /** Evidence tags for new uploads; snags default to Before / After. */
  tags?: AttachmentTag[];
  /** Shown in the label ("1 required"); validate with usePhotoCount in the screen. */
  required?: number;
  error?: string | null;
  name?: string;
}

export function PhotoStrip({ projectId, entityType, entityId, kind = 'photo', canAdd = true, label = 'Photos', tags, required, error, name }: PhotoStripProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const wrapRef = useFieldRef(name);
  const local = useData(() => localPhotos(entityId), [entityId]);
  const remote = useData(() => {
    const ids = new Set(localPhotos(entityId).map((l) => l.id));
    return list<AttachmentRow>('attachments', { parent: entityId }).filter((a) => !ids.has(a.id) && !isDeleted(a));
  }, [entityId]);
  const availableTags = tags ?? (entityType === 'snag' ? ['before', 'after'] as AttachmentTag[] : []);
  const [tag, setTag] = useState<AttachmentTag | null>(availableTags[0] ?? null);
  const [caption, setCaption] = useState('');
  const [viewer, setViewer] = useState<{ uri: string; local?: UploadEntry; remote?: AttachmentRow } | null>(null);
  const geotagged = local.some((l) => l.lat != null) || remote.some((r) => r.latitude != null);

  const add = async (source: 'camera' | 'library') => {
    try { await capturePhotos({ projectId, entityType, entityId, kind, caption, tag }, source); } catch (e) { showError(e); }
  };
  const count = local.length + remote.length;
  const lbl = `${label}${required ? ` (${required} required)` : ''}`;

  return (
    <View ref={wrapRef} style={styles.wrap}>
      <FieldLabel label={lbl} right={geotagged ? <Chip label="Geotagged" tone="success" icon="map-marker-check-outline" small /> : null} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
        {local.map((p) => (
          <Pressable key={p.id} onPress={() => setViewer({ uri: p.local_uri, local: p })} accessibilityRole="imagebutton"
            accessibilityLabel={`Photo${p.tag ? `, ${ATTACHMENT_TAG_LABELS[p.tag]}` : ''}, ${p.status === 'uploaded' ? 'uploaded' : p.status === 'failed' ? 'upload failed' : 'waiting to upload'}`}>
            <Image source={{ uri: thumbUri(p.local_uri) }} recyclingKey={p.id} cachePolicy="memory-disk" transition={100} contentFit="cover"
              style={[styles.thumb, { backgroundColor: t.surfaceMuted }]} />
            <TagBadge tag={p.tag} />
            {p.status !== 'uploaded' ? (
              <View style={[styles.badge, { backgroundColor: p.status === 'failed' ? t.danger : t.warningContainer }]}>
                <Icon name={p.status === 'failed' ? 'cloud-alert-outline' : 'cloud-upload-outline'} size={14}
                  color={p.status === 'failed' ? t.onDanger : t.onWarningContainer} />
              </View>
            ) : null}
          </Pressable>
        ))}
        {remote.map((a) => <RemoteThumb key={a.id} attachment={a} size={THUMB} onPress={(uri) => setViewer({ uri, remote: a })} />)}
        {canAdd ? (
          <Pressable onPress={() => void add('camera')} onLongPress={() => void add('library')} accessibilityRole="button"
            accessibilityLabel="Take photo" accessibilityHint="Long-press to pick several from the gallery" android_ripple={{ color: t.ripple }}
            style={[styles.thumb, styles.add, { borderColor: error ? t.danger : t.borderStrong }]}>
            <Icon name="camera-plus-outline" size={28} tone="primary" />
            <Text variant="caption" tone="primary">Add</Text>
          </Pressable>
        ) : null}
        {!count && !canAdd ? <Text variant="bodySm" tone="muted">No photos</Text> : null}
      </ScrollView>
      {canAdd && availableTags.length ? (
        <ChipGroup<AttachmentTag> label="Tag for new photos" value={tag} onChange={setTag}
          options={availableTags.map((value) => ({ value, label: ATTACHMENT_TAG_LABELS[value] }))} />
      ) : null}
      {canAdd ? <Field label="Caption for new photos" optional value={caption} onChangeText={setCaption} maxLength={500}
        placeholder="Subject, direction or detail" /> : null}
      {canAdd ? (
        <View style={styles.actions}>
          <Button size="sm" variant="tonal" icon="camera-outline" title="Camera" onPress={() => void add('camera')} />
          <Button size="sm" variant="ghost" icon="image-outline" title="Gallery" onPress={() => void add('library')} />
        </View>
      ) : null}
      <FieldMessage error={error} />

      <Modal visible={!!viewer} onRequestClose={() => setViewer(null)} animationType="fade" statusBarTranslucent>
        <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.viewerBar}>
            <IconButton icon="close" color="#FFFFFF" onPress={() => setViewer(null)} accessibilityLabel="Close viewer" />
          </View>
          {viewer?.remote && !(viewer.remote.mime_type ?? '').startsWith('image/') ? (
            <View style={[styles.full, styles.documentViewer]}>
              <Icon name="file-document-outline" size={56} color="#FFFFFF" />
              <Text variant="titleSm" color="#FFFFFF">{viewer.remote.file_name ?? 'Document'}</Text>
              <Button title="Open document" icon="open-in-new" onPress={() => { void Linking.openURL(viewer.uri).catch(showError); }} />
            </View>
          ) : viewer ? <Image source={{ uri: viewer.uri }} contentFit="contain" style={styles.full} /> : null}
          {viewer?.local?.caption || viewer?.remote?.caption || viewer?.local?.tag || viewer?.remote?.tag ? (
            <View style={styles.viewerMeta}>
              {(viewer.local?.tag ?? viewer.remote?.tag) ? <Chip small label={ATTACHMENT_TAG_LABELS[(viewer.local?.tag ?? viewer.remote?.tag)!]} /> : null}
              {(viewer.local?.caption ?? viewer.remote?.caption) ? <Text color="#FFFFFF">{viewer.local?.caption ?? viewer.remote?.caption}</Text> : null}
            </View>
          ) : null}
          {viewer?.local && viewer.local.status !== 'uploaded' && canAdd ? (
            <View style={styles.viewerActions}>
              <Button title="Delete" variant="danger" icon="trash-can-outline" flex onPress={() => confirm('Delete photo', 'Remove this photo from the document?', () => {
                deleteLocalPhoto(viewer.local!.id); setViewer(null);
              }, 'Delete', true)} />
              <Button title="Retake" variant="tonal" icon="camera-outline" flex onPress={() => {
                deleteLocalPhoto(viewer.local!.id); setViewer(null); void add('camera');
              }} />
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
/** @deprecated alias */
export const Photos = PhotoStrip;

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  strip: { gap: space[2], paddingVertical: 2 },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm },
  add: { borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 2 },
  document: { alignItems: 'center', justifyContent: 'center' },
  evidenceTag: { position: 'absolute', left: 3, top: 3, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.72)' },
  badge: { position: 'absolute', right: 4, bottom: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: space[2] },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerBar: { flexDirection: 'row', justifyContent: 'flex-end', padding: space[2] },
  full: { flex: 1 },
  documentViewer: { alignItems: 'center', justifyContent: 'center', gap: space[4], padding: space[4] },
  viewerMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2] },
  viewerActions: { flexDirection: 'row', gap: space[3], padding: space[4] },
});

// Component library. Import everything from 'components/ui'. See components/README.md.
export { Icon, type IconName, type IconTone } from './Icon';
export { Text, ScriptContext, type TextProps, type TextTone } from './Text';
export { Button, IconButton, Fab, fabScroll, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Row, Col, Card, Section, Divider, InfoRow, KV, Banner, type CardProps } from './Layout';
export { Chip, StatusChip, PriorityChip, FilterChip, ChipGroup, Chips, type ChipOption } from './Chip';
export { Segmented, type SegmentOption } from './Segmented';
export { Field, SelectField, SearchInput, FieldLabel, FieldMessage, type FieldProps } from './Field';
export { QuantityStepper, stepFor, type QuantityStepperProps } from './Stepper';
export { Sheet, type SheetProps } from './Sheet';
export {
  SearchSheet, Picker, normalize, pushRecent, recentIds, favIds, toggleFav,
  type Option, type PickerProps, type SearchSheetProps, type ScanResolver,
} from './SearchSelect';
export { ListRow, type ListRowProps } from './ListRow';
export { Screen, ActionBar, useForm, useUnsavedGuard, type FormHandle, type ScreenProps, type BarAction } from './Screen';
export { useFieldRef, type Errors } from './Form';
export { SyncPill, OfflineBand, SyncChip, SyncBadge, SyncDot, SyncError, LastSynced, SpinningIcon, useOutboxCounts } from './SyncBand';
export { ToastHost, toast, type ToastOptions } from './Toast';
export { EmptyState, Empty, Skeleton, SuccessTick, SuccessView, showError, confirm } from './Feedback';
export { KpiTile, Grid, ActionTile, HeroAction, ProgressBar, Progress, ProgressRing } from './Dashboard';
export { PhotoStrip, Photos, usePhotoCount, type PhotoStripProps } from './PhotoStrip';
export { SignatureField, SignaturePad, SIG_W, SIG_H, type SignatureFieldProps } from './SignaturePad';
export { haptic } from './haptics';
export { ReasonSheet } from './ReasonSheet';
export { QrScanner } from './QrScanner';

import { BadgeCheck, Ban, Check, Clock, Contrast, Hourglass, Lock, OctagonX, Pencil, Send, Trophy, Truck, TriangleAlert } from 'lucide-react';
import { DELIVERY_STATUS_LABELS, PO_STATUS_LABELS, RFQ_STATUS_LABELS, type DeliveryStatus, type PoStatus, type RfqStatus } from '../../lib/contract-procurement';
import { Badge, type Tone } from '../ui';

type I = typeof Check;
const PO: Record<PoStatus, [Tone, I]> = {
  draft: ['neutral', Pencil], submitted: ['info', Hourglass], approved: ['success', BadgeCheck], rejected: ['danger', OctagonX],
  sent: ['primary', Send], partially_received: ['violet', Contrast], received: ['success', Check], closed: ['neutral', Lock], cancelled: ['neutral', Ban],
};
const RFQ: Record<RfqStatus, [Tone, I]> = {
  draft: ['neutral', Pencil], sent: ['info', Send], closed: ['warning', Lock], awarded: ['success', Trophy], cancelled: ['neutral', Ban],
};
const DEL: Record<DeliveryStatus, [Tone, I]> = {
  pending: ['neutral', Clock], confirmed: ['info', BadgeCheck], dispatched: ['primary', Truck], delayed: ['danger', TriangleAlert], delivered: ['success', Check],
};

export const PoBadge = ({ status }: { status: PoStatus }) => <Badge tone={PO[status]?.[0]} icon={PO[status]?.[1]} label={PO_STATUS_LABELS[status] ?? status} />;
export const RfqBadge = ({ status }: { status: RfqStatus }) => <Badge tone={RFQ[status]?.[0]} icon={RFQ[status]?.[1]} label={RFQ_STATUS_LABELS[status] ?? status} />;
export const DeliveryBadge = ({ status }: { status: DeliveryStatus }) => <Badge tone={DEL[status]?.[0]} icon={DEL[status]?.[1]} label={DELIVERY_STATUS_LABELS[status] ?? status} />;
export const DelayedBadge = ({ days }: { days?: number | null }) => <Badge tone="danger" icon={TriangleAlert} label={days ? `${days} d late` : 'Delayed'} outline />;

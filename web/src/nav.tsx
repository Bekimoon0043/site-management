import { lazy, type ComponentType } from 'react';
import {
  BarChart3, Boxes, CheckCheck, ClipboardList, FileClock, Hammer, LayoutDashboard, Layers, Package, Settings as SettingsIcon, TrendingUp, Users as UsersIcon,
  ShoppingCart, ChartLine, Wallet, Truck,
  BookOpen, ClipboardCheck, Cylinder, Spline, DoorOpen, TriangleAlert, Scan, CircleUser,
  ChartGantt, FileUp, FileSpreadsheet, ClipboardPen,
  Gauge, CalendarRange, CalendarCheck, Coins, Receipt,
  HandCoins, UsersRound, Landmark, Images, CalendarDays,
  HardHat, Forklift,
} from 'lucide-react';
import type { Action, AppRole } from './lib/contract';

/**
 * Route chunks. `load` is reused for hover prefetch, so hovering a nav link warms the chunk.
 * New pages: add a loader here, a NAV entry below and a <Route> in App.tsx.
 */
export const loaders = {
  Dashboard: () => import('./pages/Dashboard'),
  Approvals: () => import('./pages/Approvals'),
  Requests: () => import('./pages/Requests'),
  RequestDetail: () => import('./pages/RequestDetail'),
  Deliveries: () => import('./pages/flows/Deliveries'),
  Store: () => import('./pages/Store'),
  Progress: () => import('./pages/Progress'),
  Elements: () => import('./pages/Elements'),
  Materials: () => import('./pages/Materials'),
  Reports: () => import('./pages/Reports'),
  Setup: () => import('./pages/Setup'),
  Users: () => import('./pages/Users'),
  Settings: () => import('./pages/Settings'),
  Audit: () => import('./pages/Audit'),
  // Procurement & cost (pages/procurement/*)
  Procurement: () => import('./pages/procurement/Procurement'),
  RfqDetail: () => import('./pages/procurement/RfqDetail'),
  PoDetail: () => import('./pages/procurement/PoDetail'),
  PoEdit: () => import('./pages/procurement/PoEdit'),
  PriceIntel: () => import('./pages/procurement/PriceIntel'),
  CostControl: () => import('./pages/procurement/CostControl'),
  // Field & quality (pages/field/*) and site control & comms (pages/control/*)
  SiteDiaries: () => import('./pages/field/Diary'),
  Quality: () => import('./pages/field/Quality'),
  InspectionDetail: () => import('./pages/field/InspectionDetail'),
  Concrete: () => import('./pages/field/Concrete'),
  PourDetail: () => import('./pages/field/PourDetail'),
  Rebar: () => import('./pages/field/Rebar'),
  Safety: () => import('./pages/site/Safety'),
  Plant: () => import('./pages/site/Plant'),
  Gate: () => import('./pages/control/Gate'),
  GatePassDetail: () => import('./pages/control/GatePassDetail'),
  Alerts: () => import('./pages/control/Alerts'),
  QrLabels: () => import('./pages/control/QrLabels'),
  Preferences: () => import('./pages/control/Preferences'),
  // Planning (pages/schedule/*)
  Schedule: () => import('./pages/schedule/Schedule'),
  ScheduleImport: () => import('./pages/schedule/ScheduleImport'),
  BoqImport: () => import('./pages/boq/BoqImport'),
  DailyProgress: () => import('./pages/schedule/DailyProgress'),
  // Planning: earned value + costs (pages/evm/*) and the monthly tasks window (pages/lookahead/*)
  Evm: () => import('./pages/evm/Evm'),
  EvmPeriods: () => import('./pages/evm/Periods'),
  Costs: () => import('./pages/evm/Costs'),
  Billing: () => import('./pages/billing/Billing'),
  Subcontracts: () => import('./pages/payments/Subcontracts'),
  CertificateDetail: () => import('./pages/payments/CertificateDetail'),
  Payroll: () => import('./pages/payments/Payroll'),
  PayrollDetail: () => import('./pages/payments/PayrollDetail'),
  Finance: () => import('./pages/payments/Finance'),
  SupplierInvoices: () => import('./pages/payments/SupplierInvoices'),
  PettyCash: () => import('./pages/payments/PettyCash'),
  IpcDetail: () => import('./pages/billing/IpcDetail'),
  Lookahead: () => import('./pages/lookahead/Lookahead'),
  Photos: () => import('./pages/Photos'),
  ProjectCalendar: () => import('./pages/schedule/ProjectCalendar'),
  ContractAdmin: () => import('./pages/office/ContractAdmin'),
  Receivables: () => import('./pages/office/Receivables'),
  OfficePortfolio: () => import('./pages/office/OfficePortfolio'),
  ClientPortal: () => import('./pages/ClientPortal'),
};

/** lazy() for a named export. */
export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] as unknown as ComponentType })));
}

export type NavGroup = 'Overview' | 'Operations' | 'Planning' | 'Payments' | 'Control' | 'Data' | 'Admin';
export type CountKey = 'approvals' | 'store' | 'progress' | 'procurement' | 'alerts';

export interface NavItem {
  to: string;
  label: string;
  group: NavGroup;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  needsProject?: boolean;
  /** Visible when the role can do ANY of these (hidden, not disabled, otherwise). */
  anyOf?: Action[];
  /** Explicit role allow-list (spec §1.2) — checked in addition to anyOf. */
  roles?: AppRole[];
  count?: CountKey;
  load: () => Promise<unknown>;
  /** Extra palette entries ("Store › Bin card"). */
  tabs?: { label: string; hash: string }[];
  /** Two-key shortcut after G (G D = dashboard). */
  key?: string;
}

const ALL_BUT_FIELD: AppRole[] = ['office_engineer', 'coordinator', 'manager', 'procurement', 'admin'];
/**
 * Sidebar/route roles for the field & control pages = union of the roles allowed by contract-field
 * FIELD_PERMS (canField) / contract-control PERMS_CONTROL (canControl) for the listed actions. Kept as
 * literals so those modules (permission maps, QR/HMAC tables) stay out of the initial bundle; every page
 * re-checks each action with canField()/canControl(), and the database enforces the same rules.
 */
const MGMT_ROLES: AppRole[] = ['coordinator', 'manager', 'admin'];
const FIELD_ROLES = {
  diary: ['site_engineer', 'office_engineer', ...MGMT_ROLES], // diary.write ∪ diary.sign
  quality: ['site_engineer', 'office_engineer', ...MGMT_ROLES], // inspection.* ∪ snag.*
  concrete: ['store_keeper', 'site_engineer', 'office_engineer', ...MGMT_ROLES], // pour.write ∪ pour.receiveTruck ∪ cube.results ∪ mix.edit
  rebar: ['store_keeper', 'site_engineer', 'office_engineer', ...MGMT_ROLES], // bbs.edit ∪ pour.write, + store (issues by Ø)
} satisfies Record<string, AppRole[]>;
const CONTROL_ROLES = {
  gate: ['security', 'store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'], // gatepass.create ∪ gatepass.verify ∪ vehicle.log
  alerts: ['coordinator', 'manager', 'admin'], // alert.manage
  qr: ['store_keeper', 'office_engineer', 'coordinator', 'manager', 'admin'], // qr.register
} satisfies Record<string, AppRole[]>;

export const NAV: NavItem[] = [
  { to: '/client', label: 'Project progress', group: 'Overview', icon: LayoutDashboard, needsProject: true, load: loaders.ClientPortal,
    roles: ['client'] },
  { to: '/', label: 'Dashboard', group: 'Overview', icon: LayoutDashboard, needsProject: true, load: loaders.Dashboard, key: 'd' },
  { to: '/office/portfolio', label: 'Office portfolio', group: 'Overview', icon: LayoutDashboard, load: loaders.OfficePortfolio,
    roles: ['office_engineer', 'coordinator', 'manager', 'admin'] },
  { to: '/approvals', label: 'Approvals', group: 'Overview', icon: CheckCheck, needsProject: true, count: 'approvals', key: 'a', load: loaders.Approvals },
  { to: '/requests', label: 'Requests', group: 'Operations', icon: ClipboardList, needsProject: true, load: loaders.Requests, key: 'r' },
  { to: '/deliveries', label: 'Deliveries', group: 'Operations', icon: Truck, needsProject: true, load: loaders.Deliveries,
    roles: ['store_keeper', 'procurement', 'coordinator', 'manager', 'admin', 'security'] },
  { to: '/store', label: 'Store', group: 'Operations', icon: Boxes, needsProject: true, count: 'store', load: loaders.Store, key: 's',
    tabs: [
      { label: 'Stock balance', hash: 'balances' }, { label: 'Low stock', hash: 'low' }, { label: 'Bin card', hash: 'bincard' },
      { label: 'Incoming orders', hash: 'incoming' }, { label: 'Receipts (GRN)', hash: 'grn' }, { label: 'Issues (MIV)', hash: 'miv' }, { label: 'Returns (MRN)', hash: 'mrn' },
      { label: 'Transfers', hash: 'transfers' }, { label: 'Adjustments', hash: 'adjustments' }, { label: 'Stock counts', hash: 'counts' },
      { label: 'Emergency issues', hash: 'emergency' },
    ] },
  { to: '/progress', label: 'Progress', group: 'Operations', icon: TrendingUp, needsProject: true, count: 'progress', load: loaders.Progress,
    roles: ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
    tabs: [{ label: 'By block / level', hash: 'rollup' }, { label: 'Elements', hash: 'elements' }, { label: 'Delay report', hash: 'delays' }, { label: 'Verification', hash: 'verify' }, { label: 'S-curve', hash: 'scurve' }] },
  { to: '/procurement', label: 'Procurement', group: 'Operations', icon: ShoppingCart, needsProject: true, count: 'procurement', load: loaders.Procurement, key: 'o',
    roles: ['procurement', 'coordinator', 'manager', 'admin'],
    tabs: [{ label: 'Purchase requests to accept / source', hash: 'prs' }, { label: 'Needs sourcing', hash: 'needs' }, { label: 'RFQs', hash: 'rfqs' }, { label: 'Purchase orders', hash: 'pos' }, { label: 'Expected deliveries', hash: 'deliveries' }, { label: 'Reorder suggestions', hash: 'reorder' }] },
  // Every project member; what each one sees follows the record type (app.attachment_visible).
  { to: '/photos', label: 'Site photos', group: 'Operations', icon: Images, needsProject: true, load: loaders.Photos },
  { to: '/diary', label: 'Site diary', group: 'Operations', icon: BookOpen, needsProject: true, load: loaders.SiteDiaries, key: 'y',
    roles: FIELD_ROLES.diary },
  { to: '/quality', label: 'Quality', group: 'Operations', icon: ClipboardCheck, needsProject: true, load: loaders.Quality, key: 'q',
    roles: FIELD_ROLES.quality,
    tabs: [{ label: 'Inspections', hash: 'inspections' }, { label: 'Snag list', hash: 'snags' }, { label: 'Checklist templates', hash: 'templates' }] },
  { to: '/concrete', label: 'Concrete', group: 'Operations', icon: Cylinder, needsProject: true, load: loaders.Concrete, key: 'c',
    roles: FIELD_ROLES.concrete,
    tabs: [{ label: 'Pours', hash: 'pours' }, { label: 'Cubes due', hash: 'cubes' }, { label: 'Mix designs', hash: 'mixes' }] },
  { to: '/rebar', label: 'Rebar & BBS', group: 'Operations', icon: Spline, needsProject: true, load: loaders.Rebar,
    roles: FIELD_ROLES.rebar,
    tabs: [{ label: 'Bar bending schedules', hash: 'schedules' }, { label: 'Rebar reconciliation', hash: 'reconciliation' }, { label: 'Import BBS from Excel', hash: 'import' }] },
  // Site operations (contract-site SITE_PERMS): everyone on the project reads; incidents may be reported by anyone.
  { to: '/safety', label: 'Safety (HSE)', group: 'Operations', icon: HardHat, needsProject: true, load: loaders.Safety,
    roles: ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'security', 'finance', 'admin'],
    tabs: [{ label: 'Incidents & near misses', hash: 'incidents' }, { label: 'Permits to work', hash: 'permits' }, { label: 'Toolbox talks', hash: 'toolbox' }] },
  { to: '/plant', label: 'Plant & equipment', group: 'Operations', icon: Forklift, needsProject: true, load: loaders.Plant,
    roles: ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
    tabs: [{ label: 'Daily log', hash: 'log' }, { label: 'Register', hash: 'register' }, { label: 'Utilisation', hash: 'utilisation' }] },
  // Planning: everyone on the project reads the schedule; office engineer + management import / link / baseline (contract-schedule SCHEDULE_PERMS).
  { to: '/schedule', label: 'Schedule', group: 'Planning', icon: ChartGantt, needsProject: true, load: loaders.Schedule, key: 't',
    roles: ['site_engineer', 'store_keeper', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
    tabs: [{ label: 'Gantt', hash: 'gantt' }, { label: 'Table', hash: 'table' }, { label: 'BoQ progress', hash: 'boq' }, { label: 'Baselines', hash: 'baselines' }] },
  { to: '/schedule/import', label: 'Import schedule', group: 'Planning', icon: FileUp, needsProject: true, load: loaders.ScheduleImport,
    roles: ['office_engineer', 'coordinator', 'manager', 'admin'] },
  { to: '/boq/import', label: 'Import BoQ', group: 'Planning', icon: FileSpreadsheet, needsProject: true, load: loaders.BoqImport,
    roles: ['office_engineer', 'coordinator', 'manager', 'admin'] },
  { to: '/daily-progress', label: 'Daily progress', group: 'Planning', icon: ClipboardPen, needsProject: true, load: loaders.DailyProgress, key: 'i',
    roles: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'] },
  // Project calendar: every member reads it; editing is split by role in the RPCs (contract-calendar CALENDAR_ROLES).
  { to: '/calendar', label: 'Project calendar', group: 'Planning', icon: CalendarDays, needsProject: true, load: loaders.ProjectCalendar,
    roles: ['site_engineer', 'store_keeper', 'office_engineer', 'coordinator', 'manager', 'procurement', 'finance', 'security', 'admin'] },
  { to: '/office', label: 'Contract administration', group: 'Planning', icon: FileClock, needsProject: true, load: loaders.ContractAdmin,
    tabs: [{ label: 'RFIs & instructions', hash: 'rfis' }, { label: 'Documents', hash: 'documents' }, { label: 'Submittals', hash: 'submittals' },
      { label: 'Meetings & actions', hash: 'meetings' }, { label: 'Risks & issues', hash: 'risks' }, { label: 'EOT / delay claims', hash: 'claims' }] },
  { to: '/office/receivables', label: 'Client receivables', group: 'Payments', icon: Receipt, needsProject: true, anyOf: ['prices.view'], load: loaders.Receivables,
    roles: ['office_engineer', 'coordinator', 'manager', 'finance', 'admin'],
    tabs: [{ label: 'Receivables ageing', hash: 'ageing' }, { label: 'Retention release', hash: 'retention' }] },
  // Monthly tasks window: LA_PERMS (contract-lookahead); EVM: money for price roles, progress-only otherwise.
  { to: '/lookahead', label: 'Monthly tasks', group: 'Planning', icon: CalendarRange, needsProject: true, load: loaders.Lookahead, key: 'l',
    roles: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
    tabs: [{ label: 'Material needs', hash: 'materials' }, { label: 'Weekly plan', hash: 'weekly' }, { label: 'Reliability (PPC)', hash: 'reliability' }] },
  { to: '/evm', label: 'Earned value', group: 'Planning', icon: Gauge, needsProject: true, load: loaders.Evm, key: 'n',
    roles: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin'] },
  { to: '/evm/periods', label: 'Progress periods', group: 'Planning', icon: CalendarCheck, needsProject: true, load: loaders.EvmPeriods,
    roles: ['office_engineer', 'coordinator', 'manager', 'admin'] },
  { to: '/costs', label: 'Actual costs', group: 'Planning', icon: Coins, needsProject: true, load: loaders.Costs, anyOf: ['prices.view'],
    roles: ['office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
    tabs: [{ label: 'Resource usage', hash: 'usage' }, { label: 'Cost rates', hash: 'rates' }, { label: 'Coverage', hash: 'coverage' }] },
  { to: '/gate', label: 'Gate & vehicles', group: 'Control', icon: DoorOpen, needsProject: true, load: loaders.Gate, key: 'v',
    roles: CONTROL_ROLES.gate,
    tabs: [{ label: 'Gate passes', hash: 'passes' }, { label: 'Vehicle log', hash: 'vehicles' }, { label: 'Gate events', hash: 'events' }] },
  { to: '/alerts', label: 'Alerts', group: 'Control', icon: TriangleAlert, needsProject: true, count: 'alerts', load: loaders.Alerts, key: 'w',
    roles: CONTROL_ROLES.alerts, tabs: [{ label: 'Alert rules', hash: 'rules' }] },
  { to: '/qr-labels', label: 'QR labels', group: 'Control', icon: Scan, needsProject: true, load: loaders.QrLabels,
    roles: CONTROL_ROLES.qr },
  { to: '/elements', label: 'Elements & BoQ', group: 'Data', icon: Layers, needsProject: true, anyOf: ['master.edit'], load: loaders.Elements, key: 'e',
    tabs: [{ label: 'Take-off quantities', hash: 'takeoffs' }, { label: 'BoQ items', hash: 'boq' }, { label: 'Import from Excel', hash: 'import' }] },
  { to: '/materials', label: 'Materials', group: 'Data', icon: Package, roles: ALL_BUT_FIELD, load: loaders.Materials, key: 'm',
    tabs: [{ label: 'Prices', hash: 'prices' }, { label: 'Suppliers', hash: 'suppliers' }, { label: 'Import materials', hash: 'import' }] },
  { to: '/reports', label: 'Reports', group: 'Data', icon: BarChart3, needsProject: true, roles: ALL_BUT_FIELD, load: loaders.Reports },
  { to: '/prices', label: 'Price intelligence', group: 'Data', icon: ChartLine, needsProject: true, anyOf: ['prices.view'], load: loaders.PriceIntel },
  { to: '/cost-control', label: 'Cost control', group: 'Data', icon: Wallet, needsProject: true, anyOf: ['prices.view'], roles: ['coordinator', 'manager', 'procurement', 'admin'], load: loaders.CostControl,
    tabs: [{ label: 'By category', hash: 'category' }, { label: 'By BoQ item', hash: 'boq' }, { label: 'Open commitments', hash: 'commitments' }, { label: 'Edit budget', hash: 'budget' }] },
  // Payments (contract-payments PAYMENT_PERMS): office engineer prepares → coordinator checks → manager approves → finance pays.
  { to: '/payments/subcontracts', label: 'Subcontractor payments', group: 'Payments', icon: HandCoins, needsProject: true, load: loaders.Subcontracts,
    roles: ['office_engineer', 'coordinator', 'manager', 'finance', 'admin'],
    tabs: [{ label: 'Payment certificates', hash: 'certificates' }, { label: 'Subcontracts', hash: 'subcontracts' }, { label: 'Subcontractors', hash: 'subcontractors' }] },
  { to: '/payments/payroll', label: 'Labour payroll', group: 'Payments', icon: UsersRound, needsProject: true, load: loaders.Payroll,
    roles: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'finance', 'admin'], tabs: [{ label: 'Workers', hash: 'workers' }] },
  { to: '/payments/finance', label: 'Finance', group: 'Payments', icon: Landmark, needsProject: true, load: loaders.Finance,
    roles: ['office_engineer', 'coordinator', 'manager', 'finance', 'admin'],
    tabs: [{ label: 'Payment register', hash: 'register' }, { label: 'Subcontractor statements', hash: 'statements' }, { label: 'Cash flow', hash: 'cash-flow' }, { label: 'Tax report', hash: 'tax' }] },
  // Finance (contract-finance FINANCE_ROLES): supplier invoices (3-way match) and petty cash; server re-checks every step.
  { to: '/payments/invoices', label: 'Supplier invoices', group: 'Payments', icon: Receipt, needsProject: true, anyOf: ['prices.view'], load: loaders.SupplierInvoices,
    roles: ['procurement', 'finance', 'office_engineer', 'coordinator', 'manager', 'admin'] },
  { to: '/payments/petty-cash', label: 'Petty cash', group: 'Payments', icon: Wallet, needsProject: true, load: loaders.PettyCash,
    roles: ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'finance', 'security', 'admin'] },
  // Client billing (IPC to the client, variations): price data — roles in app_settings.price_roles; server re-checks each step.
  { to: '/billing', label: 'Client billing', group: 'Data', icon: Receipt, needsProject: true, anyOf: ['prices.view'], load: loaders.Billing,
    tabs: [{ label: 'Payment certificates', hash: 'ipcs' }, { label: 'Variations', hash: 'variations' }, { label: 'Contract terms', hash: 'terms' }] },
  { to: '/setup', label: 'Project setup', group: 'Admin', icon: Hammer, anyOf: ['mr.approve'], load: loaders.Setup },
  { to: '/users', label: 'Users', group: 'Admin', icon: UsersIcon, anyOf: ['users.manage'], load: loaders.Users },
  { to: '/settings', label: 'Settings', group: 'Admin', icon: SettingsIcon, anyOf: ['users.manage'], load: loaders.Settings },
  { to: '/audit', label: 'Audit log', group: 'Admin', icon: FileClock, needsProject: true, anyOf: ['audit.view'], load: loaders.Audit },
  { to: '/preferences', label: 'My preferences', group: 'Admin', icon: CircleUser, load: loaders.Preferences },
];

export const GROUPS: NavGroup[] = ['Overview', 'Operations', 'Planning', 'Payments', 'Control', 'Data', 'Admin'];

export function navFor(role: AppRole | null | undefined, can: (a: Action) => boolean): NavItem[] {
  if (role === 'client') return NAV.filter((n) => n.roles?.includes('client'));
  return NAV.filter((n) => (!n.anyOf || n.anyOf.some(can)) && (!n.roles || (!!role && n.roles.includes(role))));
}

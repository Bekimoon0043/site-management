import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './lib/auth';
import { configured } from './lib/supabase';
import { queryClient } from './lib/query';
import type { Action } from './lib/contract';
import { Login } from './pages/Login';
import { Empty, Loading } from './components/Page';
import { Shell } from './components/shell/Shell';
import { RouteErrorBoundary } from './components/ErrorBoundary';
import { lazyNamed, loaders, navFor } from './nav';

const Dashboard = lazyNamed(loaders.Dashboard, 'Dashboard');
const Approvals = lazyNamed(loaders.Approvals, 'Approvals');
const Setup = lazyNamed(loaders.Setup, 'Setup');
const Elements = lazyNamed(loaders.Elements, 'Elements');
const Materials = lazyNamed(loaders.Materials, 'Materials');
const Requests = lazyNamed(loaders.Requests, 'Requests');
const RequestDetail = lazyNamed(loaders.RequestDetail, 'RequestDetail');
const Deliveries = lazyNamed(loaders.Deliveries, 'Deliveries');
const StorePage = lazyNamed(loaders.Store, 'StorePage');
const Progress = lazyNamed(loaders.Progress, 'Progress');
const Reports = lazyNamed(loaders.Reports, 'Reports');
const Users = lazyNamed(loaders.Users, 'Users');
const Settings = lazyNamed(loaders.Settings, 'Settings');
const Audit = lazyNamed(loaders.Audit, 'Audit');
const Procurement = lazyNamed(loaders.Procurement, 'Procurement');
const RfqDetail = lazyNamed(loaders.RfqDetail, 'RfqDetail');
const PoDetail = lazyNamed(loaders.PoDetail, 'PoDetail');
const PoEdit = lazyNamed(loaders.PoEdit, 'PoEdit');
const PriceIntel = lazyNamed(loaders.PriceIntel, 'PriceIntel');
const CostControl = lazyNamed(loaders.CostControl, 'CostControl');
const Preferences = lazyNamed(loaders.Preferences, 'Preferences');
const Schedule = lazyNamed(loaders.Schedule, 'Schedule');
const ScheduleImport = lazyNamed(loaders.ScheduleImport, 'ScheduleImport');
const BoqImport = lazyNamed(loaders.BoqImport, 'BoqImport');
const Evm = lazyNamed(loaders.Evm, 'Evm');
const EvmPeriods = lazyNamed(loaders.EvmPeriods, 'EvmPeriods');
const Costs = lazyNamed(loaders.Costs, 'Costs');
const Billing = lazyNamed(loaders.Billing, 'Billing');
const Subcontracts = lazyNamed(loaders.Subcontracts, 'Subcontracts');
const CertificateDetail = lazyNamed(loaders.CertificateDetail, 'CertificateDetail');
const Payroll = lazyNamed(loaders.Payroll, 'Payroll');
const PayrollDetail = lazyNamed(loaders.PayrollDetail, 'PayrollDetail');
const Finance = lazyNamed(loaders.Finance, 'Finance');
const SupplierInvoices = lazyNamed(loaders.SupplierInvoices, 'SupplierInvoices');
const PettyCash = lazyNamed(loaders.PettyCash, 'PettyCash');
const IpcDetail = lazyNamed(loaders.IpcDetail, 'IpcDetail');
const DailyProgress = lazyNamed(loaders.DailyProgress, 'DailyProgress');
const Lookahead = lazyNamed(loaders.Lookahead, 'Lookahead');
const Safety = lazyNamed(loaders.Safety, 'Safety');
const Plant = lazyNamed(loaders.Plant, 'Plant');
const Photos = lazyNamed(loaders.Photos, 'Photos');
const ProjectCalendar = lazyNamed(loaders.ProjectCalendar, 'ProjectCalendar');
const ContractAdmin = lazyNamed(loaders.ContractAdmin, 'ContractAdmin');
const Receivables = lazyNamed(loaders.Receivables, 'Receivables');
const OfficePortfolio = lazyNamed(loaders.OfficePortfolio, 'OfficePortfolio');
const ClientPortal = lazyNamed(loaders.ClientPortal, 'ClientPortal');
/** Field & control routes: [path, nav entry that gates it, page]. Named export = loader key unless given. */
const FIELD_CONTROL_ROUTES = ([
  ['/diary', '/diary', 'SiteDiaries'], ['/diary/:id', '/diary', 'SiteDiaries', 'SiteDiaryDetail'],
  ['/quality', '/quality', 'Quality'], ['/quality/inspections/:id', '/quality', 'InspectionDetail'],
  ['/concrete', '/concrete', 'Concrete'], ['/concrete/pours/:id', '/concrete', 'PourDetail'], ['/rebar', '/rebar', 'Rebar'],
  ['/gate', '/gate', 'Gate'], ['/gate/:id', '/gate', 'GatePassDetail'], ['/alerts', '/alerts', 'Alerts'], ['/qr-labels', '/qr-labels', 'QrLabels'],
] as [string, string, keyof typeof loaders, string?][]).map(([path, gateTo, key, name]) => ({ path, gateTo, Page: lazyNamed(loaders[key] as () => Promise<Record<string, unknown>>, name ?? key) }));

function PageFallback() {
  return <div className="page"><div className="route-progress" /><Loading lines={6} /></div>;
}

/** First load at "/" lands each role on its most useful page (spec §1.2). */
function RoleLanding() {
  const auth = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !auth.profile) return;
    done.current = true;
    if (loc.pathname !== '/' || loc.search || loc.hash) return;
    if (auth.profile.role === 'office_engineer') nav('/approvals', { replace: true });
    else if (auth.profile.role === 'procurement') nav('/procurement#prs', { replace: true });
    else if (auth.profile.role === 'security') nav('/gate', { replace: true });
    else if (auth.profile.role === 'finance') nav('/payments/finance', { replace: true });
    else if (auth.profile.role === 'client') nav('/client', { replace: true });
  }, [auth.profile, loc, nav]);
  return null;
}

function Routed() {
  const auth = useAuth();
  if (auth.loading) return <div className="center-page"><Loading what="Starting" lines={3} /></div>;
  if (!auth.session) return <Login />;
  if (!auth.profile) {
    return <div className="center-page"><Empty title="Your account has no profile yet" action={<button onClick={() => void auth.signOut()}>Sign out</button>}>Ask an administrator to set it up.</Empty></div>;
  }
  if (!auth.profile.is_active) {
    return <div className="center-page"><Empty title="This account has been deactivated" action={<button onClick={() => void auth.signOut()}>Sign out</button>} /></div>;
  }

  const needProject = (el: ReactNode) => (auth.projectId ? el : (
    <div className="page"><Empty title="No project selected">
      {auth.can('master.edit') ? 'Create one under Project setup.' : 'Ask a coordinator to assign you to a project.'}
    </Empty></div>
  ));
  const gate = (action: Action, el: ReactNode) => (auth.can(action) ? el : <div className="page"><Empty title="No access">You don't have access to this page.</Empty></div>);
  /** Same role gating as the sidebar entry for `to` (field/control pages use canField/canControl role lists). */
  const inNav = (to: string) => navFor(auth.profile?.role, auth.can).some((n) => n.to === to);
  const noAccess = <div className="page"><Empty title="No access">You don't have access to this page.</Empty></div>;
  const byNav = (to: string, el: ReactNode) => (inNav(to) ? needProject(el) : noAccess);
  /** Like byNav for pages that work without a project (company-wide master data, project setup). */
  const navOnly = (to: string, el: ReactNode) => (inNav(to) ? el : noAccess);

  // External client accounts get a separate route surface. Database RLS also
  // blocks the internal tables, but this prevents even rendering internal pages.
  if (auth.profile.role === 'client') {
    return (
      <Shell>
        <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/client" element={needProject(<ClientPortal />)} />
              <Route path="*" element={<Navigate to="/client" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </Shell>
    );
  }

  return (
    <Shell>
      <RoleLanding />
      <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={needProject(<Dashboard />)} />
          <Route path="/approvals" element={byNav('/approvals', <Approvals />)} />
          <Route path="/requests" element={needProject(<Requests />)} />
          <Route path="/requests/:id" element={needProject(<RequestDetail />)} />
          <Route path="/deliveries" element={byNav('/deliveries', <Deliveries />)} />
          <Route path="/store" element={needProject(<StorePage />)} />
          <Route path="/progress" element={byNav('/progress', <Progress />)} />
          <Route path="/reports" element={byNav('/reports', <Reports />)} />
          <Route path="/elements" element={byNav('/elements', <Elements />)} />
          <Route path="/materials" element={navOnly('/materials', <Materials />)} />
          <Route path="/setup" element={navOnly('/setup', <Setup />)} />
          <Route path="/users" element={gate('users.manage', <Users />)} />
          <Route path="/settings" element={gate('users.manage', <Settings />)} />
          <Route path="/audit" element={gate('audit.view', needProject(<Audit />))} />
          {/* Procurement & cost — mr.viewAll = procurement + management; prices.view pages re-check auth.canSeePrices */}
          <Route path="/procurement" element={gate('mr.viewAll', needProject(<Procurement />))} />
          <Route path="/procurement/rfq/:id" element={gate('mr.viewAll', needProject(<RfqDetail />))} />
          <Route path="/procurement/po/new" element={gate('mr.viewAll', needProject(<PoEdit />))} />
          <Route path="/procurement/po/:id" element={gate('mr.viewAll', needProject(<PoDetail />))} />
          <Route path="/procurement/po/:id/edit" element={gate('mr.viewAll', needProject(<PoEdit />))} />
          <Route path="/prices" element={gate('prices.view', needProject(<PriceIntel />))} />
          <Route path="/cost-control" element={gate('prices.view', needProject(<CostControl />))} />
          {FIELD_CONTROL_ROUTES.map(({ path, gateTo, Page }) => <Route key={path} path={path} element={byNav(gateTo, <Page />)} />)}
          {/* Planning — schedule read by all project roles; import gated to office engineer + management */}
          <Route path="/schedule" element={byNav('/schedule', <Schedule />)} />
          <Route path="/schedule/import" element={byNav('/schedule/import', <ScheduleImport />)} />
          <Route path="/boq/import" element={byNav('/boq/import', <BoqImport />)} />
          <Route path="/daily-progress" element={byNav('/daily-progress', <DailyProgress />)} />
          {/* Planning — monthly tasks window, earned value (money views re-check prices), periods, actual costs */}
          <Route path="/lookahead" element={byNav('/lookahead', <Lookahead />)} />
          <Route path="/safety" element={byNav('/safety', <Safety />)} />
          <Route path="/plant" element={byNav('/plant', <Plant />)} />
          <Route path="/photos" element={byNav('/photos', <Photos />)} />
          <Route path="/calendar" element={byNav('/calendar', <ProjectCalendar />)} />
          <Route path="/office" element={byNav('/office', <ContractAdmin />)} />
          <Route path="/office/receivables" element={byNav('/office/receivables', <Receivables />)} />
          <Route path="/office/portfolio" element={navOnly('/office/portfolio', <OfficePortfolio />)} />
          <Route path="/evm" element={byNav('/evm', <Evm />)} />
          <Route path="/evm/periods" element={byNav('/evm', <EvmPeriods />)} />
          <Route path="/costs" element={gate('prices.view', byNav('/costs', <Costs />))} />
          {/* Payments — server re-checks every step (payment_action) */}
          <Route path="/payments/subcontracts" element={byNav('/payments/subcontracts', <Subcontracts />)} />
          <Route path="/payments/certificates/:id" element={byNav('/payments/subcontracts', <CertificateDetail />)} />
          <Route path="/payments/payroll" element={byNav('/payments/payroll', <Payroll />)} />
          <Route path="/payments/payroll/:id" element={byNav('/payments/payroll', <PayrollDetail />)} />
          <Route path="/payments/finance" element={byNav('/payments/finance', <Finance />)} />
          <Route path="/payments/invoices" element={byNav('/payments/invoices', <SupplierInvoices />)} />
          <Route path="/payments/petty-cash" element={byNav('/payments/petty-cash', <PettyCash />)} />
          <Route path="/billing" element={gate('prices.view', byNav('/billing', <Billing />))} />
          <Route path="/billing/ipc/:id" element={gate('prices.view', byNav('/billing', <IpcDetail />))} />
          <Route path="/preferences" element={<Preferences />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </RouteErrorBoundary>
    </Shell>
  );
}

export default function App() {
  if (!configured) {
    return (
      <div className="center-page">
        <Empty title="Supabase is not configured">
          Copy <code>web/.env.example</code> to <code>web/.env</code>, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart <code>npm run dev</code>.
        </Empty>
      </div>
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routed />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

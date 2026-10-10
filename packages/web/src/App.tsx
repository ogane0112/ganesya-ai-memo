import { lazy, type ReactNode, Suspense } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { CapturePage } from './pages/Capture';
import { LoginPage } from './pages/Login';
import { MorePage } from './pages/More';
import { NotePage } from './pages/NotePage';
import { NotesListPage } from './pages/NotesList';
import { RegisterPasskeyPage } from './pages/RegisterPasskey';
import { ReviewPage } from './pages/Review';
import { SearchPage } from './pages/Search';
import { NeedsSetupPage, SetupPage } from './pages/Setup';
import { WritePage } from './pages/Write';
import { AppProvider, useApp } from './state/app';
import { ToastProvider } from './state/toast';

const GraphPage = lazy(() => import('./pages/Graph').then((m) => ({ default: m.GraphPage })));
const HistoryPage = lazy(() => import('./pages/History').then((m) => ({ default: m.HistoryPage })));
const OAuthConsentPage = lazy(() =>
  import('./pages/OAuthConsent').then((m) => ({ default: m.OAuthConsentPage })),
);
const ProposalDetailPage = lazy(() =>
  import('./pages/ProposalDetail').then((m) => ({ default: m.ProposalDetailPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/settings/Settings').then((m) => ({ default: m.SettingsPage })),
);
const ViewsPage = lazy(() => import('./pages/Views').then((m) => ({ default: m.ViewsPage })));
const ViewPage = lazy(() => import('./pages/Views').then((m) => ({ default: m.ViewPage })));
const ViewEditPage = lazy(() => import('./pages/Views').then((m) => ({ default: m.ViewEditPage })));

/** Requires a full (passkey) session; sends everyone else to setup / login / passkey registration. */
function RequireAuth({
  children,
  allowRecovery = false,
}: {
  children: ReactNode;
  allowRecovery?: boolean;
}) {
  const { auth, signedIn } = useApp();
  const loc = useLocation();
  if (!auth) return <Loading label="起動中…" />;
  if (!signedIn) {
    if (auth.needsSetup) return <NeedsSetupPage />;
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  if (auth.session?.via === 'recovery' && !allowRecovery)
    return <Navigate to="/register-passkey" replace />;
  return <>{children}</>;
}

function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      /* no service worker (dev, private mode): the app still works online */
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="update-prompt" role="status">
      <span>新しいバージョンがあります。</span>
      <button
        type="button"
        className="btn btn-small btn-primary"
        onClick={() => void updateServiceWorker(true)}
      >
        更新
      </button>
      <button type="button" className="btn btn-small" onClick={() => setNeedRefresh(false)}>
        あとで
      </button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState icon="file" title="ページが見つかりません">
        <Link to="/" className="btn">
          ホームへ
        </Link>
      </EmptyState>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route
                path="/register-passkey"
                element={
                  <RequireAuth allowRecovery>
                    <RegisterPasskeyPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/oauth/consent"
                element={
                  <RequireAuth>
                    <OAuthConsentPage />
                  </RequireAuth>
                }
              />
              <Route
                element={
                  <RequireAuth>
                    <Layout />
                  </RequireAuth>
                }
              >
                <Route index element={<WritePage />} />
                <Route path="notes" element={<NotesListPage />} />
                <Route path="n/*" element={<NotePage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="review" element={<ReviewPage />} />
                <Route path="review/:id" element={<ProposalDetailPage />} />
                <Route path="views" element={<ViewsPage />} />
                <Route path="views/new" element={<ViewEditPage />} />
                <Route path="views/:id" element={<ViewPage />} />
                <Route path="views/:id/edit" element={<ViewEditPage />} />
                <Route path="graph" element={<GraphPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="settings/:section" element={<SettingsPage />} />
                <Route path="more" element={<MorePage />} />
                <Route path="capture" element={<CapturePage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
          <UpdatePrompt />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

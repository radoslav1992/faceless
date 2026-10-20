import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { api, AuthContext, type User } from "./lib";
import { pageMeta } from "../shared/seo";
import { PublicLayout } from "./public/PublicLayout";
import { Landing } from "./public/Landing";
import { Pricing } from "./public/Pricing";
import { NotFound } from "./public/NotFound";

// The home and pricing pages stay in the entry chunk; everything signed-in loads on demand.
function named<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const Tools = named(() => import("./public/Pages"), "Tools");
const ToolPage = named(() => import("./public/Pages"), "ToolPage");
const Styles = named(() => import("./public/Pages"), "Styles");
const FaqPage = named(() => import("./public/Pages"), "FaqPage");
const About = named(() => import("./public/Pages"), "About");
const Business = named(() => import("./public/Pages"), "Business");
const Mcp = named(() => import("./public/Pages"), "Mcp");
const Legal = named(() => import("./public/Legal"), "Legal");
const Contact = named(() => import("./public/Contact"), "Contact");
const AuthPage = named(() => import("./public/Auth"), "AuthPage");
const AppLayout = named(() => import("./app/Layout"), "AppLayout");
const Home = named(() => import("./app/Home"), "Home");
const Create = named(() => import("./app/Create"), "Create");
const Videos = named(() => import("./app/Videos"), "VideosPage");
const VideoPage = named(() => import("./app/VideoPage"), "VideoPage");
const SeriesList = named(() => import("./app/Series"), "SeriesList");
const SeriesWizard = named(() => import("./app/SeriesWizard"), "SeriesWizard");
const SeriesPage = named(() => import("./app/Series"), "SeriesPage");
const Schedule = named(() => import("./app/Schedule"), "SchedulePage");
const Clips = named(() => import("./app/Clips"), "ClipsPage");
const ClipSource = named(() => import("./app/Clips"), "SourcePage");
const Channels = named(() => import("./app/Channels"), "ChannelsPage");
const Billing = named(() => import("./app/Billing"), "BillingPage");
const Settings = named(() => import("./app/Settings"), "SettingsPage");
const Admin = named(() => import("./app/Admin"), "AdminPage");
const Affiliate = named(() => import("./app/Affiliate"), "Affiliate");

/** Keeps the title current and moves focus to the new page's heading for screen readers. */
function RouteChange() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const navigation = useRef(type);
  navigation.current = type;
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const meta = pageMeta(pathname);
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
    const first = previous.current === undefined, same = previous.current === pathname;
    previous.current = pathname;
    if (first || same || navigation.current === "REPLACE") return;
    window.scrollTo(0, 0);
    const target = document.querySelector<HTMLElement>("main h1") || document.querySelector<HTMLElement>("main");
    if (target) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  }, [pathname]);
  return null;
}
// A deploy replaces hashed chunks: reload once to fetch the new ones instead of showing a blank page.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem("hss-chunk-reload") || 0) < 60_000) return;
    sessionStorage.setItem("hss-chunk-reload", String(Date.now()));
  } catch { /* storage unavailable */ }
  event.preventDefault();
  window.location.reload();
});
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Page failed to render", error); }
  componentDidUpdate(previous: { resetKey: string }) { if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="loading-page" role="alert">
        <div className="stack center">
          <p>This page couldn't load.</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
const loading = <div className="loading-page" role="status">Loading…</div>;
function Boundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}><Suspense fallback={loading}>{children}</Suspense></ErrorBoundary>;
}
/** Signed-in pages: the visitor is sent to sign in, and back here afterwards. */
function RequireUser({ user, loading: busy, children }: { user: User | null; loading: boolean; children: ReactNode }) {
  const { pathname, search } = useLocation();
  if (busy) return loading;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <>{children}</>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setUser((await api<{ user: User | null }>("/auth/me")).user);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <AuthContext.Provider value={{ user, loading: busy, failed, refresh }}>
      <RouteChange />
      <Boundary>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route index element={<Landing />} />
            <Route path="tools" element={<Tools />} />
            <Route path="tools/:slug" element={<ToolPage />} />
            <Route path="styles" element={<Styles />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="mcp" element={<Mcp />} />
            <Route path="business" element={<Business />} />
            <Route path="about" element={<About />} />
            <Route path="faq" element={<FaqPage />} />
            <Route path="terms" element={<Legal page="terms" />} />
            <Route path="privacy" element={<Legal page="privacy" />} />
            <Route path="contact" element={<Contact />} />
          </Route>
          {(["login", "register", "forgot", "reset", "verify"] as const).map((mode) => (
            <Route key={mode} path={mode} element={<AuthPage mode={mode} />} />
          ))}
          <Route path="app" element={<RequireUser user={user} loading={busy}><AppLayout /></RequireUser>}>
            <Route index element={<Home />} />
            <Route path="create" element={<Create />} />
            <Route path="videos" element={<Videos />} />
            <Route path="videos/:id" element={<VideoPage />} />
            <Route path="series" element={<SeriesList />} />
            <Route path="series/new" element={<SeriesWizard />} />
            <Route path="series/:id" element={<SeriesPage />} />
            <Route path="clips" element={<Clips />} />
            <Route path="clips/:id" element={<ClipSource />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="channels" element={<Channels />} />
            <Route path="billing" element={<Billing />} />
            <Route path="settings" element={<Settings />} />
            <Route path="affiliate" element={<Affiliate />} />
            <Route path="admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Route>
          <Route path="*" element={<PublicLayout />}>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Boundary>
    </AuthContext.Provider>
  );
}

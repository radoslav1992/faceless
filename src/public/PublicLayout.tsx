import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { rememberReferral } from "../referral";
import { Menu, X } from "lucide-react";
import { Logo } from "../ui";
import { api, useAuth } from "../lib";
import { PRODUCT } from "../../shared/brand";
import "./public.css";

// The public site's frame (navigation, the mobile menu, footer) and the small helpers its pages share.

/** GET /api/public/config */
export type PublicConfig = {
  turnstileSiteKey: string | null;
  registrationEnabled: boolean;
  billingEnabled: boolean;
  mediaEnabled: boolean;
  company: { name: string | null; address: string | null; email: string | null };
};
let cachedConfig: PublicConfig | null = null;
let pendingConfig: Promise<PublicConfig> | null = null;
function loadPublicConfig() {
  pendingConfig ??= api<PublicConfig>("/public/config").then(
    (c) => (cachedConfig = c),
    (e) => {
      pendingConfig = null;
      throw e;
    },
  );
  return pendingConfig;
}
/** The site's public settings (sign-ups open, security check, company details), loaded once per visit. */
export function usePublicConfig() {
  const [config, setConfig] = useState<PublicConfig | null>(cachedConfig);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (cachedConfig) {
      setConfig(cachedConfig);
      return;
    }
    let live = true;
    loadPublicConfig().then(
      (c) => { if (live) { setConfig(c); setFailed(false); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [attempt]);
  return { config, failed, retry: () => { setFailed(false); setAttempt((a) => a + 1); } };
}

/** A form's error, announced to screen readers when it appears. */
export function FormError({ error }: { error: string | null }) {
  return (
    <div aria-live="assertive" aria-atomic="true">
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}

const links = [
  { to: "/tools", label: "Tools" },
  { to: "/pricing", label: "Pricing" },
  { to: "/mcp", label: "MCP Connection" },
  { to: "/business", label: "Business" },
  { to: "/about", label: "About" },
  { to: "/faq", label: "FAQ" },
];

export function PublicLayout() {
  const { user } = useAuth();
  const { config } = usePublicConfig();
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => setOpen(false), [pathname]);
  // An affiliate's link: the code is carried to the sign-up form in memory only.
  useEffect(() => rememberReferral(new URLSearchParams(search).get("ref")), [search]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", key);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = ""; };
  }, [open]);
  const owner = config?.company.name || PRODUCT.name;
  return (
    <div className="public">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="pub-header">
        <div className="pub-wrap pub-nav">
          <button
            ref={toggle}
            type="button"
            className="btn icon menu-toggle"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
            <span className="sr-only">{open ? "Close menu" : "Menu"}</span>
          </button>
          <Logo />
          <nav className="pub-links" aria-label="Main">
            {links.map((l) => <NavLink key={l.to} to={l.to}>{l.label}</NavLink>)}
          </nav>
          <div className="pub-actions">
            {user ? (
              <Link className="btn primary" to="/app">Dashboard</Link>
            ) : (
              <>
                <Link className="btn ghost" to="/login">Log in</Link>
                <Link className="btn primary" to="/register">Free trial</Link>
              </>
            )}
          </div>
        </div>
      </header>
      {open && <div className="menu-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <nav id={menuId} className="mobile-menu" aria-label="Mobile" hidden={!open}>
        <p className="menu-title">Menu</p>
        <ul>
          {links.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
          <li><Link to="/contact">Contact</Link></li>
        </ul>
        <div className="menu-actions">
          {user ? (
            <Link className="btn primary" to="/app">Open dashboard</Link>
          ) : (
            <>
              <Link className="menu-login" to="/login">Log in</Link>
              <Link className="btn primary" to="/register">Free trial</Link>
            </>
          )}
        </div>
        <div className="menu-legal"><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link></div>
      </nav>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="pub-footer">
        <div className="pub-wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <Logo />
              <p>{PRODUCT.tagline}. Pick a style once; new videos are written, made and posted on your schedule.</p>
            </div>
            <nav aria-label="Product">
              <h2>Product</h2>
              <ul>
                <li><Link to="/tools">Video tools</Link></li>
                <li><Link to="/styles">Art styles</Link></li>
                <li><Link to="/pricing">Pricing</Link></li>
                <li><Link to="/mcp">MCP Connection</Link></li>
                <li><Link to="/mcp#api">API access</Link></li>
              </ul>
            </nav>
            <nav aria-label="Company">
              <h2>Company</h2>
              <ul>
                <li><Link to="/about">About</Link></li>
                <li><Link to="/business">Business</Link></li>
                <li><Link to="/faq">FAQ</Link></li>
                <li><Link to="/contact">Contact</Link></li>
              </ul>
            </nav>
            <nav aria-label="Legal">
              <h2>Legal</h2>
              <ul>
                <li><Link to="/terms">Terms of Use</Link></li>
                <li><Link to="/privacy">Privacy Policy</Link></li>
                {config?.company.email && <li><a href={`mailto:${config.company.email}`}>{config.company.email}</a></li>}
              </ul>
            </nav>
          </div>
          <div className="foot-base">
            <p>© {new Date().getFullYear()} {owner}</p>
            <p>TikTok, YouTube and Instagram are trademarks of their owners. {PRODUCT.name} is not affiliated with them.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  House, PenSquare, Repeat, Clapperboard, CalendarDays, Share2, CircleDollarSign, Settings, Shield, PanelLeftClose, PanelLeftOpen, Clock, Menu, LogOut, Coins, Scissors,
  Download, Share, SquarePlus, HandCoins,
} from "lucide-react";
import { post, timeLeft, useAuth, number } from "../lib";
import { planById } from "../../shared/plans";
import { Logo, LogoMark, Modal, useToast } from "../ui";
import { useInstall } from "../install";
import "./app.css";

/** The dashboard: sidebar, the credits bar and the current page. */
export function AppLayout() {
  const { user, refresh } = useAuth();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("hss-nav") === "collapsed"; } catch { return false; } });
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  if (!user) return null;
  const plan = planById(user.plan);
  const free = user.plan === "free";
  const left = Math.max(0, user.limit - user.used);
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem("hss-nav", collapsed ? "open" : "collapsed"); } catch { /* private mode */ }
  };
  const item = (to: string, Icon: typeof House, label: string, extra: { className?: string; end?: boolean } = {}) => (
    <NavLink to={to} end={extra.end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}${extra.className ? " " + extra.className : ""}`} title={collapsed ? label : undefined}>
      <Icon size={20} aria-hidden="true" />
      <span className="text">{label}</span>
    </NavLink>
  );
  const logout = async () => {
    await post("/auth/logout").catch(() => {});
    await refresh();
    navigate("/");
  };
  return (
    <div className={`app-shell${collapsed ? " collapsed" : ""}`}>
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Main">
        <div className="sidebar-head">
          {collapsed ? <Link to="/app" className="logo" aria-label="Home"><span className="logo-mark"><LogoMark /></span></Link> : <Logo to="/app" />}
          <button className="btn icon ghost collapse" onClick={toggle} aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <Link to="/app/create" className="btn primary block new-video" title={collapsed ? "Create video" : undefined}><PenSquare size={18} aria-hidden="true" /><span className="text">Create video</span></Link>
        {item("/app", House, "Home", { end: true })}
        {item("/app/series", Repeat, "Series")}
        {item("/app/clips", Scissors, "Clips")}
        {item("/app/videos", Clapperboard, "Videos")}
        {item("/app/schedule", CalendarDays, "Schedule")}
        {item("/app/channels", Share2, "Channels")}
        <div className="nav-sep" />
        {item("/app/billing", CircleDollarSign, free ? "Upgrade" : "Billing", { className: free ? "upgrade" : "" })}
        {item("/app/settings", Settings, "Settings")}
        {item("/app/affiliate", HandCoins, "Earn 30%")}
        {user.admin && item("/app/admin", Shield, "Admin")}
        <div style={{ flex: 1 }} />
        <div className="credits-card">
          <div className="row between"><span className="small muted">Credits</span><Coins size={16} className="accent-text" aria-hidden="true" /></div>
          <strong>{number(left)}</strong>
          <div className="meter" aria-hidden="true"><span style={{ width: `${user.limit ? Math.min(100, (left / user.limit) * 100) : 0}%` }} /></div>
          <Link to="/app/billing" className="small text-link">{free ? "Upgrade" : "Add credits"}</Link>
        </div>
        <InstallItem collapsed={collapsed} />
        <button className="nav-item" style={{ background: "none", border: 0, cursor: "pointer", width: "100%" }} onClick={logout}><LogOut size={20} /><span className="text">Log out</span></button>
      </aside>
      {open && <div className="sidebar-scrim" role="presentation" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn icon ghost mobile-only" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}><Menu size={20} /></button>
            {free ? (
              <span className="trial"><Clock size={18} aria-hidden="true" /> Free trial <span className="muted">· {user.trialEnded || !user.trialEndsAt ? "ended" : timeLeft(user.trialEndsAt)}</span></span>
            ) : (
              <span className="small muted"><strong style={{ color: "var(--text)" }}>{plan.name}</strong> · {number(left)} credits left</span>
            )}
          </div>
          <Link to="/app/billing" className="upgrade-pill">{free ? "Upgrade" : "Add credits"}</Link>
        </header>
        {!user.verified && (
          <div className="banner">
            Confirm your email to make videos and subscribe. <button className="link" onClick={() => post("/auth/resend").then(() => toast("We sent the link again.", "good")).catch((e) => toast(e.message, "bad"))}>Send the link again</button>
          </div>
        )}
        {user.paymentIssue && <div className="banner bad">Your last payment didn't go through. <Link to="/app/billing">Update your card</Link> to keep your plan.</div>}
        {user.trialEnded && <div className="banner bad">Your free trial has ended. Your videos are still here — <Link to="/app/billing">choose a plan</Link> to keep creating.</div>}
        <Outlet />
      </div>
    </div>
  );
}

/** "Install app" while the app runs in a browser that can install it: the browser's own dialog, or the steps on iPhone and iPad. */
function InstallItem({ collapsed }: { collapsed: boolean }) {
  const { way, install } = useInstall();
  const toast = useToast();
  const [steps, setSteps] = useState(false);
  if (!way) return null;
  const go = async () => {
    if (way === "steps") return setSteps(true);
    if (await install()) toast("Installed. Open Hookstreak from your home screen or app list.", "good");
  };
  return (
    <>
      <button type="button" className="nav-item" style={{ background: "none", border: 0, cursor: "pointer", width: "100%" }} onClick={() => void go()} title={collapsed ? "Install app" : undefined}>
        <Download size={20} aria-hidden="true" /><span className="text">Install app</span>
      </button>
      {steps && (
        <Modal title="Install the app" onClose={() => setSteps(false)}>
          <ol className="install-steps">
            <li><Share size={18} aria-hidden="true" /><span>Tap <strong>Share</strong> in Safari's toolbar.</span></li>
            <li><SquarePlus size={18} aria-hidden="true" /><span>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</span></li>
          </ol>
          <p className="muted small" style={{ marginTop: 12 }}>Hookstreak then opens from your home screen like any app, full screen and signed in.</p>
        </Modal>
      )}
    </>
  );
}

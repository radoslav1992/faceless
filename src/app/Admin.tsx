import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Mail, RefreshCw } from "lucide-react";
import { number, useApi, useAuth } from "../lib";
import { Empty, Tabs, ago, formatDate, tabPanel } from "./pickers";
import { BillingTab, OperationsTab } from "./AdminOps";
import { VoicesTab } from "./AdminVoices";
import { LibraryTab } from "./AdminLibrary";
import { ExamplesTab } from "./AdminExamples";
import { AvatarsTab } from "./AdminAvatars";
import { GrowthTab } from "./AdminGrowth";
import "./pages.css";

type Overview = {
  users: number; newUsers: number; paying: number; granted: number; videos: number; series: number; failedRuns: number; activeRuns: number; published: number; failedPublications: number;
  config: Record<string, boolean>;
};
type Message = { id: string; name: string; email: string; topic: string; message: string; created_at: number };
type Tab = "overview" | "operations" | "billing" | "growth" | "voices" | "avatars" | "library" | "examples" | "messages";
const tabIds: Tab[] = ["overview", "operations", "billing", "growth", "voices", "avatars", "library", "examples", "messages"];
const topics: Record<string, string> = { question: "Question", billing: "Billing", withdrawal: "Withdrawal (14 days)", partnership: "Partnership", abuse: "Report abuse", other: "Other" };
const flagNames: Record<string, string> = {
  media: "Media pipeline", fal: "fal.ai (AI images & clips)", elevenlabs: "ElevenLabs (voices)", heygen: "HeyGen (presenters)", stripe: "Stripe keys",
  billing: "Billing open", tokens: "Token encryption", tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube",
};

/** Administration (admins only): health, operations, billing tools, voices and presenters, the shared library, style examples and contact messages. */
export function AdminPage() {
  const { user } = useAuth();
  if (!user?.admin) return <Navigate to="/app" replace />;
  return <AdminConsole />;
}

function AdminConsole() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && tabIds.includes(requested) ? requested : "overview";
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Service health and operations, withdrawals and free months, affiliates and calls, narration voices, presenters, the shared library, style examples and contact messages.</p>
        </div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <Tabs label="Admin sections" idBase="admin" value={tab} onChange={(t) => setParams(t === "overview" ? {} : { tab: t }, { replace: true })} items={[
          { id: "overview", label: "Overview" }, { id: "operations", label: "Operations" }, { id: "billing", label: "Billing" }, { id: "growth", label: "Growth" },
          { id: "voices", label: "Voices" }, { id: "avatars", label: "Presenters" }, { id: "library", label: "Library" }, { id: "examples", label: "Examples" }, { id: "messages", label: "Messages" },
        ]} />
      </div>
      <div {...tabPanel("admin", tab)}>
        {tab === "overview" && <OverviewTab />}
        {tab === "operations" && <OperationsTab />}
        {tab === "billing" && <BillingTab />}
        {tab === "growth" && <GrowthTab />}
        {tab === "voices" && <VoicesTab />}
        {tab === "avatars" && <AvatarsTab />}
        {tab === "library" && <LibraryTab />}
        {tab === "examples" && <ExamplesTab />}
        {tab === "messages" && <MessagesTab />}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------------------------------------ helpers */

function Loading() {
  return <div className="stack" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>;
}
function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={retry}>Try again</button></div>;
}
/* ------------------------------------------------------------------------------------------------ overview */

function OverviewTab() {
  const { data, loading, error, reload } = useApi<Overview>("/admin/overview");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  const stats: { label: string; value: number; sub?: string; bad?: boolean }[] = [
    { label: "Users", value: data.users, sub: `+${number(data.newUsers)} in the last 24 h` },
    { label: "Paying", value: data.paying, sub: `Active subscriptions${data.granted ? ` · ${number(data.granted)} free month${data.granted === 1 ? "" : "s"}` : ""}` },
    { label: "Videos made", value: data.videos, sub: "Last 24 h" },
    { label: "Active series", value: data.series, sub: "On autopilot" },
    { label: "Runs in progress", value: data.activeRuns, sub: "Queued or running" },
    { label: "Failed runs", value: data.failedRuns, sub: "Last 24 h", bad: data.failedRuns > 0 },
    { label: "Published", value: data.published, sub: "Last 24 h" },
    { label: "Failed publications", value: data.failedPublications, sub: "Last 24 h", bad: data.failedPublications > 0 },
  ];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between">
        <h2 style={{ fontSize: 20 }}>Activity</h2>
        <button type="button" className="btn sm" onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
      </div>
      <div className="grid four">
        {stats.map((s) => (
          <div key={s.label} className={`card stat-card${s.bad ? " bad" : ""}`}>
            <span className="label">{s.label}</span>
            <strong>{number(s.value)}</strong>
            {s.sub && <span className="sub">{s.sub}</span>}
          </div>
        ))}
      </div>
      <section className="card" aria-labelledby="config-title">
        <h2 id="config-title" style={{ marginBottom: 12 }}>Configuration</h2>
        <ul className="list-plain flag-grid">
          {Object.entries(data.config).map(([key, on]) => (
            <li key={key} className={`chip ${on ? "green" : "red"}`}>{on ? "On" : "Off"} · {flagNames[key] || key}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ messages */

function MessagesTab() {
  const { data, loading, error, reload } = useApi<{ messages: Message[] }>("/admin/messages");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  if (!data.messages.length) return <Empty icon={<Mail size={24} />} title="No messages">Messages from the contact form show up here.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Contact messages, newest first</caption>
        <thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Topic</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {data.messages.map((m) => (
            <tr key={m.id} style={{ verticalAlign: "top" }}>
              <td className="small" style={{ whiteSpace: "nowrap" }} title={formatDate(m.created_at, true)}>{ago(m.created_at)}</td>
              <td>
                <strong>{m.name}</strong>
                <div className="small"><a href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${topics[m.topic] || "Your message"}`)}`} className="link">{m.email}</a></div>
              </td>
              <td><span className={`chip${m.topic === "abuse" ? " red" : m.topic === "billing" || m.topic === "withdrawal" ? " orange" : ""}`}>{topics[m.topic] || m.topic}</span></td>
              <td><MessageText text={m.message} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 240) return <p className="msg-text">{text}</p>;
  return (
    <div>
      <p className="msg-text">{open ? text : `${text.slice(0, 220).trimEnd()}…`}</p>
      <button type="button" className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : "Show all"}</button>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Check, CircleAlert, Coins, ExternalLink, Pencil, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { ApiError, api, del, errorText, fileUrl, post, put, seconds, useApi, usePoll } from "../lib";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { t } from "../../shared/i18n";
import { creditsLabel } from "../../shared/credits";
import {
  AGENT_MESSAGE_MAX, SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX,
  type Card, type ChatItem, type DraftCard, type MediaItem, type PendingAction, type SkillView, type Step, type TurnEvent,
} from "../../shared/agent";
import "./agent.css";

// The assistant (shared/agent.ts): a chat with an agent that makes videos with the app's tools. What it suggests is
// shown to look at and play; what spends credits waits here for a Confirm.

type ChatInfo = { id: string; title: string; updatedAt: number };
type ChatView = { id: string; title: string; items: ChatItem[]; waiting: boolean; busy: boolean };
/** What a turn has sent so far, shown until its last word replaces it with the chat as it stands. */
type Live = { texts: string[]; steps: { tool: string; state: "start" | "done" | "failed" }[]; cards: Card[]; actions: PendingAction[] };

/** What each tool is doing, in words. */
const STEPS: Record<string, string> = {
  write_draft: "Writing the draft", edit_draft: "Changing the draft", get_draft: "Reading the draft", search_library: "Searching the library",
  list_my_files: "Looking at your files", list_voices: "Looking at the voices", show_media: "Showing media", make_video: "Making the video",
  get_video: "Checking the video", list_videos: "Looking at your videos", list_video_types: "Looking at the video types", get_account: "Checking your credits",
  load_skill: "Loading a skill", list_series: "Looking at your series", set_series_status: "Updating the series", list_long_videos: "Looking at your long videos",
  import_video: "Importing the video", find_clips: "Finding clips", get_long_video: "Reading the long video", make_clip: "Cutting the clip",
};
const stepLabel = (tool: string) => STEPS[tool] ?? "Working";
/** What a confirmation is for, in words. */
const ACTIONS: Record<string, string> = { make_video: "Make the video", make_clip: "Cut the clip", find_clips: "Transcribe the video to find clips in it" };

/** A turn's events as they arrive (one JSON object per line). */
async function stream(path: string, body: unknown, on: (e: TurnEvent) => void) {
  const r = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const data: any = await r.json().catch(() => ({}));
    throw new ApiError(data.error || "Something went wrong. Please try again.", r.status, data);
  }
  const reader = r.body.getReader(), decoder = new TextDecoder();
  let rest = "";
  const read = (line: string) => { if (line.trim()) { try { on(JSON.parse(line)); } catch { /* half a line */ } } };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(read);
  }
  read(rest);
}

/** The model's words: paragraphs, short lists and **bold**; never translated (they are already the owner's language). */
function Words({ text }: { text: string }) {
  const bold = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <strong key={i} translate="no">{part.slice(2, -2)}</strong> : part));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { const items = list; blocks.push(<ul key={blocks.length} translate="no">{items.map((x, i) => <li key={i} translate="no">{bold(x)}</li>)}</ul>); list = []; } };
  for (const line of text.split("\n")) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { list.push(item[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length} translate="no">{bold(line.replace(/^#+\s*/, ""))}</p>);
  }
  flush();
  return <div className="agent-words" translate="no">{blocks}</div>;
}

function Media({ items }: { items: MediaItem[] }) {
  return (
    <div className="agent-media">
      {items.map((m) => (
        <figure key={`${m.source}:${m.id}`} className={`agent-medium ${m.show}`}>
          {m.show === "image" && m.url && <a href={m.url} target="_blank" rel="noreferrer"><img src={m.thumb || m.url} alt={m.name} loading="lazy" /></a>}
          {m.show === "video" && m.url && <video src={m.url} poster={m.thumb || undefined} controls preload={m.thumb ? "none" : "metadata"} playsInline />}
          {m.show === "audio" && (m.url ? <audio src={m.url} controls preload="none" /> : <span className="hint">No sample to play.</span>)}
          <figcaption>
            <strong translate="no">{m.name}</strong>
            <span className="muted small">{KINDS[m.kind] ?? "File"}{m.duration ? ` · ${seconds(m.duration)}` : ""}</span>
            {m.note && <span className="small" translate="no">{m.note}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
const KINDS: Record<string, string> = { music: "Music", sfx: "Sound effect", clip: "Clip", image: "Picture", voice: "Voice", file: "Your file" };

function Draft({ card, onMake, disabled }: { card: DraftCard; onMake: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const scenes = open ? card.scenes : card.scenes.slice(0, 3);
  return (
    <div className="agent-card agent-draft">
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <div className="small muted">Draft · {card.templateName}</div>
          <h3 translate="no">{card.title || t("Untitled")}</h3>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">{card.style}</span>
          {card.voice && <span className="chip" translate="no">{card.voice}</span>}
          <span className="chip">{seconds(card.seconds)}</span>
        </div>
      </div>
      <ol className="agent-scenes">
        {scenes.map((s, i) => (
          <li key={i}>
            <span translate="no">{s.text}</span>
            <span className="muted small" translate="no">{s.picture}</span>
          </li>
        ))}
      </ol>
      {card.scenes.length > 3 && <button type="button" className="link small" onClick={() => setOpen(!open)}>{open ? "Show fewer scenes" : `Show all ${card.scenes.length} scenes`}</button>}
      <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
        <button type="button" className="btn primary" disabled={disabled} onClick={onMake}><Wand2 size={16} aria-hidden="true" /> Make video · {creditsLabel(card.credits)}</button>
        <Link className="btn" to={`/app/create?template=${encodeURIComponent(card.template)}&agentDraft=${encodeURIComponent(card.id)}`}><Pencil size={16} aria-hidden="true" /> Open in editor</Link>
      </div>
    </div>
  );
}

/** A video being made, then the video: it asks how it stands until it is ready. */
function VideoCard({ id, title }: { id: string; title: string }) {
  const { data, reload } = useApi<{ video: { renderStatus: string; renderError: string | null; phase: string | null; videoAssetId: string | null; coverAssetId: string | null; title: string } }>(`/videos/${id}`);
  const v = data?.video;
  const making = !v || v.renderStatus === "queued" || v.renderStatus === "running";
  usePoll(reload, 6000, making);
  return (
    <div className="agent-card agent-video">
      {v?.renderStatus === "ready" && v.videoAssetId
        ? <video src={fileUrl(v.videoAssetId)} poster={fileUrl(v.coverAssetId) || undefined} controls preload="metadata" playsInline />
        : (
          <div className="agent-video-wait">
            {v?.renderStatus === "failed" ? <><CircleAlert size={22} aria-hidden="true" /><span>This video couldn't be made.</span></> : <><Spinner /><span>Making the video. This takes a few minutes.</span></>}
          </div>
        )}
      <div className="row between wrap" style={{ gap: 8 }}>
        <strong translate="no">{v?.title || title || t("Video")}</strong>
        <Link className="link small" to={`/app/videos/${id}`}>Open the video <ExternalLink size={13} aria-hidden="true" /></Link>
      </div>
    </div>
  );
}

function Action({ action, onDecide, disabled }: { action: PendingAction; onDecide: (decision: "confirm" | "decline") => void; disabled: boolean }) {
  return (
    <div className={`agent-card agent-action ${action.status}`}>
      <div>
        <strong>{ACTIONS[action.tool] ?? "Go ahead"}</strong>{action.summary && <>: <span translate="no">“{action.summary}”</span></>}
        <div className="row small muted" style={{ gap: 6, marginTop: 4 }}><Coins size={14} aria-hidden="true" /> {creditsLabel(action.credits)}</div>
      </div>
      {action.status === "pending"
        ? (
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn primary" disabled={disabled} onClick={() => onDecide("confirm")}><Check size={16} aria-hidden="true" /> Confirm</button>
            <button type="button" className="btn" disabled={disabled} onClick={() => onDecide("decline")}>Cancel</button>
          </div>
        )
        : <span className={`chip ${action.status === "confirmed" ? "green" : ""}`}>{action.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>}
    </div>
  );
}

function Steps({ steps }: { steps: (Step | { tool: string; state: string })[] }) {
  if (!steps.length) return null;
  return (
    <ul className="agent-steps">
      {steps.map((s, i) => {
        const state = "state" in s ? s.state : s.ok ? "done" : "failed";
        return <li key={i} className={state}>{state === "start" ? <span className="spinner" aria-hidden="true" /> : state === "failed" ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} {stepLabel(s.tool)}{state === "failed" && <span className="muted"> · didn't work</span>}</li>;
      })}
    </ul>
  );
}

function Cards({ cards, send, busy }: { cards: Card[]; send: (text: string) => void; busy: boolean }) {
  return (
    <>
      {cards.map((c, i) => (c.type === "media" ? <Media key={i} items={c.items} />
        : c.type === "draft" ? <Draft key={i} card={c} disabled={busy} onMake={() => send(t("Make this video"))} />
        : <VideoCard key={i} id={c.id} title={c.title} />))}
    </>
  );
}

const IDEAS = [
  "A 30-second scary story about a lighthouse keeper",
  "Find calm music for a bedtime story and let me hear it",
  "A product ad for my handmade candles: what do you need from me?",
  "Which voices do you have? Let me hear three",
];

export function Agent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const chats = useApi<{ chats: ChatInfo[] }>("/agent");
  const [chat, setChat] = useState<ChatView | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [live, setLive] = useState<Live | null>(null);
  const [text, setText] = useState("");
  const [skills, setSkills] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const busy = !!live;

  useEffect(() => {
    setLive(null);
    if (!id) { setChat(null); setLoading(false); return; }
    let stale = false;
    setLoading(true);
    api<ChatView>(`/agent/chats/${id}`).then((c) => { if (!stale) setChat(c); }).catch((e) => { if (!stale) { toast(errorText(e), "bad"); navigate("/app/assistant", { replace: true }); } }).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another chat is opened
  }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat, live]);

  /** A turn: its events are shown as they come, then the chat as it stands. */
  const turn = useCallback(async (chatId: string, path: string, body: unknown, shown: ChatItem[]) => {
    setLive({ texts: [], steps: [], cards: [], actions: [] });
    setChat((c) => ({ id: chatId, title: c?.id === chatId ? c.title : "", items: shown, waiting: false, busy: true }));
    try {
      await stream(`/agent/chats/${chatId}/${path}`, body, (e) => {
        if (e.event === "done") { setChat({ id: chatId, title: e.title, items: e.items, waiting: e.waiting, busy: false }); setLive(null); }
        else if (e.event === "error") toast(e.message, "bad");
        else setLive((l) => {
          if (!l) return l;
          if (e.event === "text") return { ...l, texts: [...l.texts, e.text] };
          if (e.event === "card") return { ...l, cards: [...l.cards, e.card] };
          if (e.event === "action") return { ...l, actions: [...l.actions, e.action] };
          // A step that ends replaces its start.
          if (e.state === "start") return { ...l, steps: [...l.steps, { tool: e.tool, state: e.state }] };
          let at = -1;
          l.steps.forEach((s, i) => { if (s.tool === e.tool && s.state === "start") at = i; });
          return { ...l, steps: l.steps.map((s, i) => (i === at ? { tool: e.tool, state: e.state } : s)) };
        });
      });
    } catch (e) {
      toast(errorText(e), "bad");
      // What was stored is the truth: read the chat again.
      await api<ChatView>(`/agent/chats/${chatId}`).then(setChat).catch(() => {});
    } finally {
      setLive(null);
      chats.reload();
    }
  }, [chats, toast]);

  const send = async (words: string) => {
    const said = words.trim();
    if (!said || busy) return;
    setText("");
    try {
      let chatId = chat?.id ?? id;
      if (!chatId) {
        chatId = (await post<{ id: string }>("/agent/chats")).id;
        navigate(`/app/assistant/${chatId}`, { replace: true });
      }
      await turn(chatId, "messages", { text: said }, [...(chat?.id === chatId ? chat.items : []), { kind: "user", id: `new-${Date.now()}`, text: said }]);
    } catch (e) {
      toast(errorText(e), "bad");
      setText(said);
    }
  };
  const decide = (action: PendingAction, decision: "confirm" | "decline") => {
    if (!chat || busy) return;
    void turn(chat.id, "actions", { id: action.id, decision }, chat.items);
  };
  const remove = async () => {
    if (!chat || busy || !window.confirm(t("Delete this chat? Its drafts go with it; videos you made stay."))) return;
    try {
      await del(`/agent/chats/${chat.id}`);
      chats.reload();
      navigate("/app/assistant", { replace: true });
    } catch (e) {
      toast(errorText(e), "bad");
    }
  };

  const list = chats.data?.chats ?? [];
  const items = chat?.items ?? [];
  return (
    <div className="page agent">
      <div className="page-head">
        <div>
          <h1>Assistant <span className="chip violet" style={{ verticalAlign: 6 }}>Test</span></h1>
          <p>Say what you want to make. It drafts, suggests media you can play here, and asks before it spends credits.</p>
        </div>
        <div className="toolbar">
          {list.length > 0 && (
            <select className="input" aria-label="Chats" value={chat?.id ?? id ?? ""} onChange={(e) => navigate(e.target.value ? `/app/assistant/${e.target.value}` : "/app/assistant")} disabled={busy}>
              <option value="">New chat</option>
              {list.map((c) => <option key={c.id} value={c.id} translate="no">{c.title || t("Untitled")}</option>)}
            </select>
          )}
          <button type="button" className="btn" onClick={() => setSkills(true)}><Sparkles size={16} aria-hidden="true" /> Skills</button>
          {chat && <button type="button" className="btn" disabled={busy} onClick={() => navigate("/app/assistant")}><Plus size={16} aria-hidden="true" /> New chat</button>}
          {chat && <button type="button" className="btn icon" disabled={busy} onClick={remove} aria-label="Delete this chat"><Trash2 size={16} aria-hidden="true" /></button>}
        </div>
      </div>

      <div className="agent-thread" aria-live="polite">
        {loading && <Spinner big />}
        {!loading && !items.length && !live && (
          <div className="agent-empty">
            <Sparkles size={28} className="accent-text" aria-hidden="true" />
            <h2>What shall we make?</h2>
            <div className="agent-ideas">{IDEAS.map((idea) => <button key={idea} type="button" className="chip button" onClick={() => setText(t(idea))}>{idea}</button>)}</div>
          </div>
        )}
        {items.map((item) => (item.kind === "user"
          ? <div key={item.id} className="agent-msg user"><div className="agent-bubble" translate="no">{item.text}</div></div>
          : (
            <div key={item.id} className="agent-msg assistant">
              {item.text && <Words text={item.text} />}
              <Steps steps={item.steps} />
              {/* What was confirmed, then what it made; what still waits comes last, by the box to write in. */}
              {item.actions.filter((a) => a.status !== "pending").map((a) => <Action key={a.id} action={a} disabled onDecide={() => {}} />)}
              <Cards cards={item.cards} send={send} busy={busy} />
              {item.actions.filter((a) => a.status === "pending").map((a) => <Action key={a.id} action={a} disabled={busy} onDecide={(d) => decide(a, d)} />)}
            </div>
          )))}
        {live && (
          <div className="agent-msg assistant">
            {live.texts.map((x, i) => <Words key={i} text={x} />)}
            <Steps steps={live.steps} />
            <Cards cards={live.cards} send={send} busy />
            {live.actions.map((a) => <Action key={a.id} action={a} disabled onDecide={() => {}} />)}
            {!live.actions.length && !live.steps.some((s) => s.state === "start") && <div className="agent-thinking"><span className="spinner" aria-hidden="true" /> Thinking</div>}
          </div>
        )}
      </div>

      <form className="agent-composer" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea
          className="input" rows={2} maxLength={AGENT_MESSAGE_MAX} value={text} placeholder={t(chat?.waiting ? "Confirm above, or say what to change" : "Describe the video you want, or ask for media")}
          onChange={(e) => setText(e.target.value)} aria-label="Message"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }}
        />
        <button type="submit" className="btn primary icon" disabled={busy || !text.trim()} aria-label="Send">{busy ? <span className="spinner" aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}</button>
      </form>
      <div ref={end} />
      {skills && <Skills onClose={() => setSkills(false)} />}
    </div>
  );
}

type SkillForm = { id: string | null; name: string; description: string; body: string; enabled: boolean; site: boolean };
const blank: SkillForm = { id: null, name: "", description: "", body: "", enabled: true, site: false };

/** Skills: named instructions the assistant loads when a request fits. A person's own, and the site's for everyone. */
function Skills({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data, reload } = useApi<{ skills: SkillView[]; max: number; canEditSite: boolean }>("/agent/skills");
  const [form, setForm] = useState<SkillForm | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const body = { name: form.name, description: form.description, body: form.body, enabled: form.enabled, site: form.site };
      if (form.id) await put(`/agent/skills/${form.id}`, body); else await post("/agent/skills", body);
      reload();
      setForm(null);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (s: SkillView) => {
    if (!window.confirm(t("Delete this skill?"))) return;
    try { await del(`/agent/skills/${s.id}`); reload(); } catch (e) { toast(errorText(e), "bad"); }
  };
  const ready = !!form && form.name.trim().length >= 2 && form.description.trim().length >= 2 && form.body.trim().length >= 2;
  return (
    <Modal
      title={form ? (form.id ? "Edit the skill" : "New skill") : "Skills"} onClose={onClose} wide
      footer={form
        ? <><button type="button" className="btn" onClick={() => setForm(null)}>Back</button><button type="button" className="btn primary" disabled={!ready || saving} onClick={save}>{saving && <span className="spinner" aria-hidden="true" />} Save</button></>
        : <button type="button" className="btn primary" onClick={() => setForm(blank)}><Plus size={16} aria-hidden="true" /> New skill</button>}
    >
      {form ? (
        <div className="stack" style={{ display: "grid", gap: 14 }}>
          <label className="field"><span>Name</span>
            <input className="input" maxLength={SKILL_NAME_MAX} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("My channel's tone")} />
          </label>
          <label className="field"><span>When to use it</span>
            <input className="input" maxLength={SKILL_DESCRIPTION_MAX} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("Whenever a script is written for my channel")} />
            <span className="hint">The assistant reads this line to decide when the skill fits.</span>
          </label>
          <label className="field"><span>Instructions</span>
            <textarea className="input" rows={10} maxLength={SKILL_BODY_MAX} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={t("Write as you would brief a person: the tone, the structure, what to always or never do.")} />
          </label>
          <Switch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label="In use" />
          {data?.canEditSite && !form.id && <Switch checked={form.site} onChange={(site) => setForm({ ...form, site })} label="For everyone on the site" />}
        </div>
      ) : !data ? <Spinner /> : (
        <>
          <p className="muted" style={{ marginBottom: 14 }}>A skill is a set of instructions the assistant follows when a request fits it: your channel's tone, how you like an ad built, a format you repeat.</p>
          {!data.skills.length && <div className="empty">No skills yet.</div>}
          <ul className="agent-skills">
            {data.skills.map((s) => {
              const mine = !s.site || data.canEditSite;
              return (
                <li key={s.id}>
                  <div>
                    <strong translate="no">{s.name}</strong> {s.site && <span className="chip">For everyone</span>} {!s.enabled && <span className="chip">Off</span>}
                    <div className="muted small" translate="no">{s.description}</div>
                  </div>
                  {mine && (
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn icon" aria-label="Edit the skill" onClick={() => setForm({ id: s.id, name: s.name, description: s.description, body: s.body, enabled: s.enabled, site: s.site })}><Pencil size={15} aria-hidden="true" /></button>
                      <button type="button" className="btn icon" aria-label="Delete the skill" onClick={() => remove(s)}><Trash2 size={15} aria-hidden="true" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}

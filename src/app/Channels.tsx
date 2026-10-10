import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Info, Plus, RefreshCw, Unlink } from "lucide-react";
import { del, errorText, post, useApi, type Account } from "../lib";
import { Spinner, useToast } from "../ui";
import { ConfirmDialog } from "./pickers";
import { PlatformBadge } from "./video-ui";
import { isPlatform, platformIds, platforms, type PlatformId } from "../../shared/social";

// Connected TikTok, YouTube and Instagram channels: connect (OAuth), reconnect, disconnect. The OAuth callback lands
// back here (or on the page that started it) with ?connected= or ?error=.

const beforeYouConnect: Record<PlatformId, string> = {
  tiktok: "Until our TikTok app passes TikTok's audit, videos may post as private (visible only to you).",
  youtube: "Videos post as Shorts (vertical, up to 3 minutes). The Google account needs a YouTube channel.",
  instagram: "Needs an Instagram professional account (Business or Creator). You can switch for free in the Instagram app's settings.",
};
export const callbackErrors: Record<string, string> = {
  expired: "The connection took too long or its link was already used. Please connect again.",
  denied: "Access wasn't granted, so nothing was connected. Connect again and approve access to continue.",
  permissions: "Some permissions weren't granted. Connect again and allow everything we ask for, including posting. Instagram also needs a professional account.",
  no_channel: "That Google account has no YouTube channel yet. Create one on YouTube, then connect again.",
  unavailable: "Connecting this network isn't available right now. Please try again later.",
  limit: "You've connected as many channels as your plan includes. Disconnect one or upgrade to connect more.",
  failed: "We couldn't connect the account. Please try again.",
};
type Response = { accounts: Account[]; platforms: { id: PlatformId; configured: boolean }[]; limit: { max: number; used: number } };

/** Shows what the network's consent screen came back with, once, and cleans the address. */
export function useConnectOutcome() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const handled = useRef("");
  useEffect(() => {
    const connected = params.get("connected"), failed = params.get("error");
    if ((!connected && !failed) || handled.current === params.toString()) return;
    handled.current = params.toString();
    if (connected) toast(`${isPlatform(connected) ? platforms[connected].name : "Social"} account connected.`, "good");
    else toast(callbackErrors[failed || ""] || callbackErrors.failed, "bad");
    const rest = new URLSearchParams(params);
    rest.delete("connected");
    rest.delete("error");
    setParams(rest, { replace: true });
  }, [params, setParams, toast]);
}
/** Starts connecting a network: the browser leaves for its consent screen and comes back to `back`. */
export async function connectPlatform(platform: PlatformId, back: string) {
  const { url } = await post<{ url: string }>("/accounts/connect", { platform, back });
  window.location.assign(url);
}

export function ChannelsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Response>("/accounts");
  const [connecting, setConnecting] = useState<PlatformId | null>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  useConnectOutcome();
  const accounts = data?.accounts || [];
  const limit = data?.limit ?? { max: 1, used: 0 };
  const full = limit.used >= limit.max;
  const connect = async (platform: PlatformId) => {
    setConnecting(platform);
    try {
      await connectPlatform(platform, "/app/channels");
    } catch (e) {
      toast(errorText(e), "bad");
      setConnecting(null);
    }
  };
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Channels</h1>
          <p>The accounts your videos post to. Series post to the channels you pick for them; any video can be posted from its page.</p>
        </div>
        {data && <span className="chip">{limit.used} of {limit.max} channel{limit.max === 1 ? "" : "s"} on your plan</span>}
      </div>
      {data && full && (
        <p className="notice" style={{ marginBottom: 16 }}>
          You've connected all the channels your plan includes. Expired ones can still be reconnected. <Link className="link" to="/app/billing">Upgrade for more</Link>
        </p>
      )}
      {loading && !data ? <div className="loading-page"><Spinner big label="Loading channels" /></div> : error && !data ? (
        <div className="empty"><p>{error}</p><button type="button" className="btn" onClick={() => void reload()}>Try again</button></div>
      ) : (
        <div className="grid two">
          {platformIds.map((id) => {
            const configured = data?.platforms.find((p) => p.id === id)?.configured ?? false;
            const mine = accounts.filter((a) => a.platform === id);
            const reason = !configured ? `Posting to ${platforms[id].name} isn't set up on this site yet.` : full ? "Your plan's channels are in use." : null;
            return (
              <section key={id} className="card stack" aria-labelledby={`channel-${id}`}>
                <div className="row" style={{ gap: 12 }}>
                  <PlatformBadge platform={id} />
                  <div className="grow">
                    <h2 id={`channel-${id}`} style={{ fontSize: 18 }}>{platforms[id].name}</h2>
                    <p className="small muted">{platforms[id].note}</p>
                  </div>
                  <button type="button" className="btn primary sm" onClick={() => void connect(id)} disabled={!!reason || !!connecting}>
                    {connecting === id ? <Spinner label="Opening" /> : <Plus size={14} aria-hidden="true" />} Connect{mine.length ? " another" : ""}
                  </button>
                </div>
                {reason && <p className="small muted">{reason} {full && configured && <Link className="link" to="/app/billing">See plans</Link>}</p>}
                <p className="small muted row" style={{ gap: 6, alignItems: "flex-start" }}><Info size={14} aria-hidden="true" style={{ flex: "none", marginTop: 3 }} /> {beforeYouConnect[id]}</p>
                {mine.map((a) => {
                  const active = a.status === "active";
                  return (
                    <div key={a.id} className="account-row">
                      {a.avatarUrl ? <img src={a.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="avatar" style={{ background: platforms[id].color }} aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>}
                      <div className="grow" style={{ minWidth: 0 }}>
                        <strong className="truncate" style={{ display: "block", maxWidth: "none" }}>{a.name}</strong>
                        <span className="small muted">{a.handle ? `@${a.handle}` : platforms[id].name}</span>
                      </div>
                      {active ? <span className="chip green">Connected</span> : (
                        <button type="button" className="btn sm primary" onClick={() => void connect(id)} disabled={!configured || !!connecting}>
                          <RefreshCw size={14} aria-hidden="true" /> Reconnect
                        </button>
                      )}
                      <button type="button" className="btn icon ghost danger" onClick={() => setConfirm(a)} aria-label={`Disconnect ${a.name}`} title="Disconnect"><Unlink size={16} /></button>
                    </div>
                  );
                })}
                {!mine.length && <p className="small muted">No {platforms[id].name} account connected.</p>}
              </section>
            );
          })}
        </div>
      )}
      {confirm && (
        <ConfirmDialog title={`Disconnect ${confirm.name}?`} confirmLabel="Disconnect" onClose={() => setConfirm(null)}
          onConfirm={async () => { await del(`/accounts/${confirm.id}`); toast(`${confirm.name} was disconnected.`, "good"); await reload(); }}>
          <p>Videos scheduled to it are canceled and series stop posting to it. Videos already posted stay on {platforms[confirm.platform].name}.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

import { useState } from "react";
import { PhoneCall, X } from "lucide-react";
import { useToast } from "../ui";
import { del, errorText, post, useApi } from "../lib";
import { formatDate } from "./pickers";

// A call with the founders for credits (server/calls.ts): offered on Home (with "Not now") and in Billing, while the
// customer can use the credits and hasn't had their call.

type Offer = { enabled: boolean; eligible: boolean; credits: number; minutes: number; status: "requested" | "done" | "missed" | "dismissed" | null; trialEndsAt: number | null };

export function CallOffer({ place }: { place: "home" | "billing" }) {
  const toast = useToast();
  const { data, reload } = useApi<Offer>("/calls");
  const [busy, setBusy] = useState(false);
  if (!data?.eligible || (place === "home" && data.status === "dismissed")) return null;
  const book = async () => {
    // Opened right away (a window opened after an await is blocked as a pop-up), then pointed at the booking page.
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const { url } = await post<{ url: string }>("/calls");
      if (tab) { tab.opener = null; tab.location.href = url; } else location.href = url;
      await reload();
    } catch (e) {
      tab?.close();
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const later = async () => {
    try { await del("/calls"); await reload(); } catch { /* it simply stays */ }
  };
  const requested = data.status === "requested";
  return (
    <section className={`card call-offer${place === "home" ? " glow" : ""}`} aria-labelledby={`call-${place}`}>
      <PhoneCall className="accent-text" size={22} aria-hidden="true" />
      <div className="grow" style={{ minWidth: 0 }}>
        <h2 id={`call-${place}`} style={{ fontSize: 17, margin: 0 }}>{requested ? "Booked your call?" : `Talk to us for ${data.minutes} minutes, get ${data.credits} credits`}</h2>
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          {requested
            ? `We add your ${data.credits} credits after the call and email you. Need another time? Book again.`
            : `Tell the founders what you make and what gets in your way. We'll add ${data.credits} credits after the call.`}
          {data.trialEndsAt && ` Your trial runs until ${formatDate(data.trialEndsAt)}, so book before then.`}
        </p>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        <button type="button" className={`btn${requested ? "" : " primary"}`} onClick={() => void book()} disabled={busy}>{requested ? "Book again" : "Book a call"}</button>
        {place === "home" && !requested && <button type="button" className="btn icon ghost" onClick={() => void later()} aria-label="Not now" title="Not now"><X size={16} /></button>}
      </div>
    </section>
  );
}

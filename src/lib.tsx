import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Interval, PlanId } from "../shared/plans";
import type { Spec } from "../shared/formats";
import type { SpeechStatus } from "../shared/speech";
import type { SeriesSettings } from "../shared/series";
import type { TemplateId, VideoKind } from "../shared/templates";
import type { PlatformId } from "../shared/social";
import type { Moment, MomentRequest } from "../shared/highlights";
import type { Voice } from "../shared/voices";
import type { Avatar } from "../shared/presenter";

// The app's API client, signed-in state and shared types. Every request goes to /api on this site.

export type User = {
  id: string; name: string; email: string; verified: boolean; admin: boolean;
  plan: PlanId; interval: Interval; used: number; limit: number; carried: number; topped: number;
  trialEndsAt: number | null; trialEnded: boolean; renewsAt: number | null; periodEnd: number | null; hasSubscription: boolean; paymentIssue: boolean;
  /** The plan is an administrator's free month (until periodEnd), not a paid subscription. */
  granted?: boolean;
};
export type Publication = {
  id: string; platform: PlatformId; accountName: string; scheduledAt: number; status: "scheduled" | "publishing" | "published" | "failed" | "canceled";
  url: string | null; error: string | null; views: number | null; likes: number | null; private?: number;
  /** 1: sent to the person's TikTok inbox as a draft, for them to post in TikTok. */
  draft?: number;
};
export type Video = {
  id: string; seriesId: string | null; seriesName: string | null; slotAt: number | null; status: "pending" | "approved" | "rejected";
  renderStatus: "queued" | "running" | "ready" | "failed"; renderError: string | null; phase: string | null;
  hook: string; caption: string; title: string; hashtags: string[]; topic: string; style: string | null;
  duration: number; videoAssetId: string | null; coverAssetId: string | null; revision: number;
  createdAt: number; updatedAt: number; reviewedAt: number | null; publications?: Publication[]; spec?: Spec;
};
export type Series = {
  id: string; name: string; template: TemplateId; status: "active" | "paused"; settings: SeriesSettings; nextSlot: number | null;
  blocked: string | null; credits: number; createdAt: number; updatedAt: number; videos?: number; review?: number; coverAssetId?: string | null;
};
export type Account = { id: string; platform: PlatformId; name: string; handle: string | null; avatarUrl: string | null; status: "active" | "expired" | "revoked"; createdAt: number };
export type Asset = {
  id: string; kind: string; name: string; mime: string; bytes: number; duration: number; width: number; height: number;
  status: "uploading" | "checking" | "ready" | "failed"; videoId: string | null; hasAudio: boolean | null; error: string | null; createdAt: number; url: string;
  /** A video imported from a link that is still being downloaded (it is checked next). */
  importing?: boolean;
  /** Speech found in an own video or track (null: never looked for), and the language it was heard in. */
  speech?: SpeechStatus | null; speechLanguage?: string | null;
};
/** One of the owner's videos as a source of clips (server/highlights.ts): what was found in it, and its clips. */
export type Source = Asset & {
  moments: Moment[]; momentsAt: number | null;
  /** A search waiting for the video's speech to be found. */
  wanted: (MomentRequest & { at: number }) | null;
  momentsError: string | null;
  /** What transcribing it costs (a long video), or 0. */
  transcribeCredits: number;
  clips: number;
};
export type LibraryKind = "music" | "clip" | "image";
/** An item of the shared library (server/library.ts); `ai`: made with AI (videos using it are disclosed as AI-made). */
export type LibraryItem = {
  id: string; kind: LibraryKind; name: string; description: string; category: string; tags: string[]; duration: number; width: number; height: number; ai: boolean;
  url: string; thumb: string | null;
};
export type { VideoKind };

const NETWORK_ERROR = "We can't reach the server. Check your connection and try again.";
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api" + path, {
      ...options,
      headers: { ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
  } catch (e) {
    if (options.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    // Still a TypeError, which callers read as "the request may not have arrived" (they keep the idempotency key).
    throw new TypeError(NETWORK_ERROR);
  }
  const data: any = await r.json().catch(() => ({ error: "Unexpected answer from the server. Please try again." }));
  if (!r.ok) throw new ApiError(data.error || "Something went wrong. Please try again.", r.status, data);
  return data as T;
}
export const post = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(data) });

let voicesRequest: Promise<Voice[]> | null = null;
/** The narration voices offered (Admin → Voices), loaded once per page; `reloadVoices` after an admin changes them. */
export function useVoices() {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  useEffect(() => {
    let live = true;
    voicesRequest ??= api<{ voices: Voice[] }>("/public/voices").then((r) => r.voices).catch((e) => { voicesRequest = null; throw e; });
    voicesRequest.then((v) => { if (live) setVoices(v); }).catch(() => { if (live) setVoices([]); });
    return () => { live = false; };
  }, []);
  const list = voices || [];
  return { voices: list, loading: voices === null, byId: (id: string) => list.find((v) => v.id === id), fallback: list.find((v) => v.default)?.id ?? list[0]?.id ?? null };
}
export const reloadVoices = () => { voicesRequest = null; };
let avatarsRequest: Promise<Avatar[]> | null = null;
/** The presenters' avatars offered (Admin → Presenters; none while presenters aren't set up), loaded once per page. */
export function useAvatars() {
  const [avatars, setAvatars] = useState<Avatar[] | null>(null);
  useEffect(() => {
    let live = true;
    avatarsRequest ??= api<{ avatars: Avatar[] }>("/public/avatars").then((r) => r.avatars).catch((e) => { avatarsRequest = null; throw e; });
    avatarsRequest.then((a) => { if (live) setAvatars(a); }).catch(() => { if (live) setAvatars([]); });
    return () => { live = false; };
  }, []);
  const list = avatars || [];
  return { avatars: list, loading: avatars === null, byId: (id: string) => list.find((a) => a.id === id) };
}
export const reloadAvatars = () => { avatarsRequest = null; };
export const put = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const patch = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const del = <T = any,>(path: string, data?: unknown) => api<T>(path, { method: "DELETE", ...(data !== undefined && { body: JSON.stringify(data) }) });
export const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");
export const fileUrl = (assetId: string | null | undefined) => (assetId ? `/api/media/${assetId}/file` : "");

/** Uploads a file in the server's 8 MiB parts and returns the asset once it is ready (or failed its check). */
export async function uploadFile(file: File, onProgress?: (share: number) => void): Promise<Asset> {
  const mime = file.type || (file.name.endsWith(".mov") ? "video/quicktime" : "");
  const start = await post<{ id: string; partSize: number; parts: number }>("/media/uploads", { name: file.name.slice(0, 160), mime, bytes: file.size });
  for (let n = 1; n <= start.parts; n++) {
    const chunk = file.slice((n - 1) * start.partSize, Math.min(file.size, n * start.partSize));
    await api(`/media/uploads/${start.id}/parts/${n}`, { method: "PUT", body: chunk, headers: { "Content-Type": "application/octet-stream" } });
    onProgress?.(n / start.parts);
  }
  let { asset } = await post<{ asset: Asset }>(`/media/uploads/${start.id}/complete`);
  // Videos and tracks are checked by the server; wait for the result (usually a few seconds).
  for (let i = 0; i < 90 && asset.status === "checking"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    asset = (await api<{ asset: Asset }>(`/media/${asset.id}`)).asset;
  }
  return asset;
}

export const AuthContext = createContext<{ user: User | null; loading: boolean; failed?: boolean; refresh: () => Promise<void> }>({
  user: null, loading: true, refresh: async () => {},
});
export const useAuth = () => useContext(AuthContext);

/** Runs `fn` every `ms` while `active` (and once at start), stopping when the component unmounts. */
export function usePoll(fn: () => unknown, ms: number, active = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
/** Loads `path` (re-loading when it changes); `reload` fetches again. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
  }, [reload, path]);
  return { data, error, loading, reload, setData };
}
export const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const seconds = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** "6d 23h left" */
export function timeLeft(until: number) {
  const s = Math.max(0, until - Date.now() / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}
export const newKey = () => crypto.randomUUID();
/** "Mon, Oct 12, 6:00 PM" in the viewer's time zone. */
export const when = (at: number) => new Date(at * 1000).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** "in 3h", "in 2d", "5m ago". */
export function relative(at: number) {
  const d = at - Date.now() / 1000, a = Math.abs(d);
  const text = a < 3600 ? `${Math.max(1, Math.round(a / 60))}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return d >= 0 ? `in ${text}` : `${text} ago`;
}

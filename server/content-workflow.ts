import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { MB, now, uid } from "./types";
import { withDefaults, siteUrl } from "./config";
import { json } from "./db";
import { safeEqual, token } from "./security";
import { extOf, head, imageInfo, mediaKey, serveObject, storedDuration, storeStream } from "./storage";
import { fetchOutput } from "./providers/http";
import { falResult, falStatus, submitFal, type FalTicket } from "./providers/fal";
import { forcedAlignment, speak } from "./providers/elevenlabs";
import { releaseRender, renderFailures, renderFile, renderStatus, submitRender } from "./renderer";
import { planRender, type Media, type Plan, type PlanContext } from "./render-plan";
import { failAsset } from "./media";
import { claimSpeech, mayHaveSpeech, storedTranscript, transcribe } from "./speech";
import { momentsAfterSpeech } from "./highlights";
import { downloadImport, importFailure } from "./imports";
import { storeYoutube, youtubeJob } from "./youtube-import";
import { narrationContext } from "./story";
import { runEpisode, videoReady, videoFailed } from "./series";
import { LONG_VIDEO_SECONDS, SPEECH_MAX_SECONDS, speechTurns } from "../shared/speech";
import {
  isHighlight, narrationCurrent, pendingMedia, referencedAssets, referencedLibrary, specSchema, trackKey, type HighlightSpec, type PendingMedia, type Spec, type StorySpec,
} from "../shared/formats";
import { trackSchema, type Track } from "../shared/track";
import { narrationKey, storyScript, textWords } from "../shared/story";
import { PRODUCT } from "../shared/brand";
import type { RenderPayload, RenderStatus } from "../shared/render";

// A run makes a video ready: the AI pictures and clips it asks for, its AI voice (a clip of a long video: where its
// people are), then the render (the video and its cover). A run of kind "speech" transcribes a long video for credits.
// Paid provider calls are made once: a claim is stored before each call and its ticket right after, so a retried step
// polls the existing job instead of paying again; a claim without a ticket (the answer was lost) fails the run and
// refunds the credits. The same workflow checks uploads (`inspectId`; videos imported from a link are downloaded first,
// `importId`) and finds the speech in them, and the moments for clips asked for before it was found.

type RunState = {
  token?: string;
  inputs?: string[];
  claims?: Record<string, boolean>;
  tickets?: Record<string, unknown>;
  assets?: Record<string, string>;
  slots?: Record<string, number>;
  jobs?: Record<string, string>;
};
const readState = async (e: Env, id: string) => json<RunState>((await e.DB.prepare("SELECT provider FROM runs WHERE id=?").bind(id).first<{ provider: string }>())?.provider, {});
async function patchState(e: Env, id: string, patch: (s: RunState) => void) {
  const s = await readState(e, id);
  patch(s);
  await e.DB.prepare("UPDATE runs SET provider=?,updated_at=? WHERE id=?").bind(JSON.stringify(s), now(), id).run();
  return s;
}
/** A capability link for one stored file, valid while the run works (the renderer and fal fetch these). */
async function inputUrl(e: Env, runId: string, key: string) {
  const s = await patchState(e, runId, (s) => {
    s.inputs ||= [];
    if (!s.inputs.includes(key)) s.inputs.push(key);
  });
  return `${siteUrl(e)}/api/render-inputs/${runId}/${s.inputs!.indexOf(key)}?token=${s.token}`;
}

const messages: Record<string, string> = {
  ...renderFailures,
  GENERATION_REJECTED: "An AI picture or clip was refused by the content filter. Describe it differently.",
  GENERATION_UNAVAILABLE: "AI pictures are temporarily unavailable. Try again later.",
  GENERATION_TIMEOUT: "An AI picture or clip took too long. Try again.",
  GENERATION_UNCERTAIN: "We lost track of an AI picture request. Try again.",
  VOICE_UNAVAILABLE: "AI voices are temporarily unavailable. Try again later.",
  VOICE_FAILED: "The voice couldn't be recorded. Try again.",
  VIDEO_INVALID: "This video's settings aren't valid any more. Open it and save it again.",
};
/** Fails a run exactly once (the trigger refunds its credits) and tells its video why. */
export async function failRun(e: Env, id: string, code = "INTERNAL") {
  const run = await e.DB.prepare("SELECT video_id,credits,status FROM runs WHERE id=?").bind(id).first<any>();
  if (!run || !["queued", "running"].includes(run.status)) return;
  const message = `${messages[code] || "This video couldn't be made. Please try again."}${run.credits > 0 ? " Your credits were refunded." : ""}`;
  await e.DB.batch([
    e.DB.prepare("UPDATE runs SET status='failed',phase='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(/^[A-Z_]{2,40}$/.test(code) ? code : "INTERNAL", now(), id),
    ...(run.video_id ? [e.DB.prepare("UPDATE videos SET render_status='failed',render_error=?,updated_at=? WHERE id=? AND render_status IN ('queued','running')").bind(message, now(), run.video_id)] : []),
  ]);
  if (run.video_id) await videoFailed(e, run.video_id).catch((error) => console.error("Failure notice failed", { videoId: run.video_id, error: (error as Error)?.name }));
}

const once = { retries: { limit: 0, delay: "1 second" as const }, timeout: "10 minutes" as const };
const safe = { retries: { limit: 2, delay: "10 seconds" as const }, timeout: "5 minutes" as const };
/** Finding moments reads a long transcript in parallel parts (a minute or two); one more try if it fails outright. */
const momentsStep = { retries: { limit: 1, delay: "30 seconds" as const }, timeout: "6 minutes" as const };

type Job = { runId?: string; inspectId?: string; importId?: string; episode?: { seriesId: string; slot: number; first?: boolean } };
export class ContentGeneration extends WorkflowEntrypoint<Env, Job> {
  async run(event: WorkflowEvent<Job>, step: WorkflowStep) {
    const e = withDefaults(this.env);
    if (event.payload.inspectId) return inspectUpload(e, step, event.payload.inspectId);
    if (event.payload.importId) return importVideo(e, step, event.payload.importId);
    // A series' episode: written (the text model, slow) and created once; the video's own run makes it.
    if (event.payload.episode) {
      const { seriesId, slot } = event.payload.episode;
      await step.do("episode", { retries: { limit: 2, delay: "30 seconds" }, timeout: "5 minutes" }, () => runEpisode(e, seriesId, slot));
      return;
    }
    const id = event.payload.runId!;
    const run = await step.do("load", async () => {
      const r = await e.DB.prepare("SELECT * FROM runs WHERE id=? AND status IN ('queued','running')").bind(id).first<any>();
      if (!r) return null;
      await e.DB.batch([
        e.DB.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").bind(now(), id),
        ...(r.video_id ? [e.DB.prepare("UPDATE videos SET render_status='running',updated_at=? WHERE id=? AND render_status='queued'").bind(now(), r.video_id)] : []),
      ]);
      await patchState(e, id, (s) => { s.token ||= token(); s.jobs ||= { compose: uid() }; });
      return { id: r.id as string, user_id: r.user_id as string, video_id: r.video_id as string, kind: r.kind as string, payload: json<any>(r.payload, {}) };
    });
    if (!run) return;
    const phase = (value: string) => e.DB.prepare("UPDATE runs SET phase=?,updated_at=? WHERE id=?").bind(value, now(), id).run();
    try {
      if (run.kind === "speech") await findSpeech(e, step, String(run.payload.assetId), true);
      else await makeVideo(e, step, run, phase);
      await step.do("complete", async () => {
        await e.DB.prepare("UPDATE runs SET status='completed',phase='done',updated_at=? WHERE id=? AND status='running'").bind(now(), id).run();
      });
      // The clips asked for once the speech was found (free; never a reason to fail the paid transcription).
      if (run.kind === "speech") await step.do("moments", momentsStep, () => momentsAfterSpeech(e, String(run.payload.assetId)));
      // Scheduling on the series' channels and the "it's ready" e-mail: never a reason to fail the made video.
      else await step.do("ready", safe, () => videoReady(e, run.video_id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^[A-Z][A-Z_]{2,40}$/.test(message) ? message : "INTERNAL";
      console.error("Run failed", { runId: id, code });
      await step.do("stop-renders", async () => {
        const s = await readState(e, id);
        for (const [name, job] of Object.entries(s.jobs || {})) if (s.slots?.[name] !== undefined) await releaseRender(e, s.slots[name], job);
      });
      await step.do("fail", () => failRun(e, id, code));
    }
  }
}

type Phase = (value: string) => Promise<unknown>;
type RunInfo = { id: string; user_id: string; video_id: string; kind: string; payload: any };

/**
 * One AI picture or clip, paid once; returns the stored asset's ID. A clip `from` a picture gets that picture's
 * capability link (read when it is submitted) and is `seconds` long.
 */
async function generateMedia(e: Env, step: WorkflowStep, run: RunInfo, name: string, m: PendingMedia, phase: Phase, from?: () => Promise<string>) {
  const kind = m.kind;
  const ticket = await step.do(`${name}-submit`, once, async () => {
    const s = await readState(e, run.id);
    if (s.tickets?.[name]) return s.tickets[name] as FalTicket;
    if (s.claims?.[name]) throw new Error("GENERATION_UNCERTAIN");
    const image = from ? await from() : undefined;
    await patchState(e, run.id, (s) => { (s.claims ||= {})[name] = true; });
    await phase(kind === "clip" ? "clip" : "images");
    const t = await submitFal(e, kind, m.prompt, { image, seconds: m.seconds });
    await patchState(e, run.id, (s) => { (s.tickets ||= {})[name] = t; });
    return t;
  });
  let done = false;
  for (let i = 0; i < 150 && !done; i++) {
    done = (await step.do(`${name}-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "1 minute" }, () => falStatus(e, ticket))) === "done";
    if (!done) await step.sleep(`${name}-wait-${i}`, kind === "image" ? "4 seconds" : "10 seconds");
  }
  if (!done) throw new Error("GENERATION_TIMEOUT");
  return step.do(`${name}-save`, safe, async () => {
    const s = await readState(e, run.id);
    const existing = s.assets?.[name] && await e.DB.prepare("SELECT id FROM media_assets WHERE id=? AND status='ready'").bind(s.assets[name]).first();
    if (existing) return s.assets![name];
    const url = await falResult(e, kind, ticket);
    const assetId = s.assets?.[name] || uid();
    await patchState(e, run.id, (s) => { (s.assets ||= {})[name] = assetId; });
    const mime = kind === "image" ? "image/jpeg" : "video/mp4";
    const key = mediaKey(run.user_id, assetId, kind === "image" ? "jpg" : "mp4");
    const bytes = await storeStream(e, key, await fetchOutput(url, AbortSignal.timeout(180000)), kind === "image" ? 30 * MB : 150 * MB, mime);
    let width = 0, height = 0, duration = 0, actual = mime;
    if (kind === "image") {
      const info = imageInfo((await head(e, key)) || new Uint8Array());
      if (!info) throw new Error("GENERATION_FAILED");
      ({ width, height } = info);
      actual = info.mime;
    } else {
      duration = (await storedDuration(e, key, bytes)) ?? 5;
    }
    await e.DB.prepare(
      "INSERT OR REPLACE INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)",
    ).bind(assetId, run.user_id, run.video_id, kind === "clip" ? "ai_clip" : "ai_image", `AI ${kind === "clip" ? "clip" : "picture"}: ${m.prompt}`.slice(0, 160), key, actual, bytes, duration, width, height,
      JSON.stringify({ prompt: m.prompt.slice(0, 400), ai: true }), now(), now()).run();
    return assetId;
  });
}

/** Writes a value into the stored spec (the video may have been edited meanwhile only by this run). */
async function updateSpec(e: Env, videoId: string, change: (spec: any) => void) {
  const row = await e.DB.prepare("SELECT spec FROM videos WHERE id=?").bind(videoId).first<{ spec: string }>();
  const spec = json<any>(row?.spec, null);
  if (!spec) throw new Error("VIDEO_INVALID");
  change(spec);
  await e.DB.prepare("UPDATE videos SET spec=?,updated_at=? WHERE id=?").bind(JSON.stringify(spec), now(), videoId).run();
}
async function loadSpec(e: Env, videoId: string): Promise<Spec> {
  const row = await e.DB.prepare("SELECT spec FROM videos WHERE id=?").bind(videoId).first<{ spec: string }>();
  const parsed = specSchema.safeParse(json(row?.spec, null));
  if (!row || !parsed.success) throw new Error("VIDEO_INVALID");
  return parsed.data;
}

async function makeVideo(e: Env, step: WorkflowStep, run: RunInfo, phase: Phase) {
  const videoId = run.video_id;
  const first = await step.do("spec", () => loadSpec(e, videoId));
  // A clip of a long video: where its people are (once per moment), then the render.
  if (isHighlight(first)) {
    if (needsTracking(first)) await trackMoment(e, step, run, first, phase);
    return renderAndSave(e, step, run, phase);
  }
  // AI pictures and clips the video asks for (clips are made from their pictures, made first).
  const pending = pendingMedia(first);
  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    const assetId = await generateMedia(e, step, run, `ai-${i}`, m, phase, m.from ? () => sourcePicture(e, run, m) : undefined);
    await step.do(`ai-${i}-apply`, async () => updateSpec(e, videoId, (spec) => {
      let target = spec;
      for (const part of m.path) target = target[part];
      target[m.key] = assetId;
    }));
  }
  // The AI voice, after the pictures (a refused picture stops the run before the voice is paid for).
  if (first.narration.kind === "voice" && !narrationCurrent(first)) await makeNarration(e, step, run, first, phase);
  await renderAndSave(e, step, run, phase);
}

/** The render of the video's final spec, then its files saved and the ones it no longer uses deleted. */
async function renderAndSave(e: Env, step: WorkflowStep, run: RunInfo, phase: Phase) {
  const videoId = run.video_id;
  const spec = await step.do("spec-final", () => loadSpec(e, videoId));
  const ctx = await step.do("resolve", () => resolveContext(e, run, spec));
  const plan = planRender(spec, ctx);
  const output = await renderJob(e, step, run, plan.compose, phase);
  await step.do("save", safe, async () => {
    await phase("saving");
    const s = await readState(e, run.id);
    const saved = s.assets || {};
    // Files with AI pictures, clips or voices in them carry {"ai":true}, so publishing can disclose them.
    const store = async (name: string, n: number, mime: string, kind: "render" | "cover", label: string, duration = 0) => {
      if (saved[name] && await e.DB.prepare("SELECT 1 FROM media_assets WHERE id=?").bind(saved[name]).first()) return saved[name];
      const assetId = uid(), key = mediaKey(run.user_id, assetId, extOf(mime));
      const bytes = await storeStream(e, key, await renderFile(e, s.slots!.compose, s.jobs!.compose, n), mime === "video/mp4" ? 400 * MB : 20 * MB, mime);
      await e.DB.prepare(
        "INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)",
      ).bind(assetId, run.user_id, videoId, kind, label, key, mime, bytes, duration, plan.compose.width, plan.compose.height, plan.compose.synthetic ? '{"ai":true}' : "{}", now(), now()).run();
      await patchState(e, run.id, (st) => { (st.assets ||= {})[name] = assetId; });
      saved[name] = assetId;
      return assetId;
    };
    const duration = output.duration || 0;
    const video = await store("video", 0, "video/mp4", "render", "Video", duration);
    const cover = (output.files || 1) > 1 ? await store("cover", 1, "image/jpeg", "cover", "Cover") : null;
    // Files of earlier versions of this video that the new one no longer uses are deleted (R2 cleanup follows).
    const current = await loadSpec(e, videoId);
    const keep = new Set([video, cover, ...referencedAssets(current), isHighlight(current) ? null : current.generated?.voiceAssetId].filter(Boolean) as string[]);
    const owned = (await e.DB.prepare("SELECT id FROM media_assets WHERE video_id=?").bind(videoId).all<{ id: string }>()).results;
    const stale = owned.map((r) => r.id).filter((x) => !keep.has(x));
    await e.DB.batch([
      e.DB.prepare("UPDATE videos SET video_asset=?,cover_asset=?,duration=?,render_status='ready',render_error=NULL,updated_at=? WHERE id=?")
        .bind(video, cover, duration, now(), videoId),
      ...stale.map((x) => e.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(x)),
    ]);
  });
  await step.do("release", async () => {
    const s = await readState(e, run.id);
    await releaseRender(e, s.slots!.compose, s.jobs!.compose);
  });
}

/** Whether a clip's layout needs to know where its people are, and they were not measured for its moment yet. */
const needsTracking = (spec: HighlightSpec) =>
  (spec.layout.kind === "follow" || (spec.layout.kind === "split" && spec.layout.auto)) && spec.tracked?.key !== trackKey(spec);
/**
 * Where a clip's people are in its moment: the renderer follows whoever is talking (the path of "Speaker focus": the
 * transcript says when someone speaks, the lips say who) and finds the two people seen most (for "Two speakers"), for
 * free. Kept with the clip (`tracked`); a failure only leaves the picture centred (and the speakers where the layout
 * put them), and the next render tries again.
 */
async function trackMoment(e: Env, step: WorkflowStep, run: RunInfo, spec: HighlightSpec, phase: Phase) {
  const source = await step.do("track-source", async () =>
    e.DB.prepare("SELECT object_key,width,height,duration FROM media_assets WHERE id=? AND user_id=? AND status='ready'").bind(spec.source.assetId, run.user_id).first<any>());
  if (!source) throw new Error("MEDIA_INPUT");
  let track: Track | null = { v: 1, points: [] };
  // A video no wider than the 9:16 frame is never cropped: there is nobody to follow.
  if (source.width > (source.height * 9) / 16 * 1.01) {
    const payload = await step.do("track-payload", async (): Promise<RenderPayload> => {
      const start = Math.min(spec.source.start, Math.max(0, source.duration - 1)), length = Math.max(1, Math.min(spec.source.end, source.duration) - start);
      // Who talks when in the moment (speakers told apart by the transcription, or just when someone talks): the crop
      // cuts to the face whose lips move with it.
      const meta = await e.DB.prepare("SELECT meta FROM media_assets WHERE id=? AND user_id=?").bind(spec.source.assetId, run.user_id).first<{ meta: string | null }>();
      const turns = speechTurns(storedTranscript(meta?.meta ?? null, start, start + length), start, start + length);
      return { id: uid(), operation: "track", url: await inputUrl(e, run.id, source.object_key), start, length, ...(turns.length && { turns }) };
    });
    try {
      await phase("tracking");
      const { slot, result } = await rendererJob(e, step, "track", payload, 150, "8 seconds");
      await step.do("track-release", () => releaseRender(e, slot, payload.id));
      const parsed = trackSchema.safeParse(result.track);
      track = parsed.success ? parsed.data : null;
    } catch (error) {
      console.warn("Speaker not tracked", { runId: run.id, code: error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "INTERNAL" });
      track = null;
    }
  }
  if (track) {
    const measured = track;
    await step.do("track-apply", () => updateSpec(e, run.video_id, (s) => { s.tracked = { key: trackKey(spec), track: measured }; }));
  }
}

/** The capability link of the picture a clip is made from: the asset in field `from` of the same scene. */
async function sourcePicture(e: Env, run: RunInfo, m: PendingMedia) {
  const row = await e.DB.prepare("SELECT spec FROM videos WHERE id=?").bind(run.video_id).first<{ spec: string }>();
  let target = json<any>(row?.spec, null);
  for (const part of m.path) target = target?.[part];
  const id = target?.[m.from!];
  const a = typeof id === "string" && await e.DB.prepare("SELECT object_key FROM media_assets WHERE id=? AND user_id=? AND status='ready'").bind(id, run.user_id).first<{ object_key: string }>();
  if (!a) throw new Error("GENERATION_FAILED");
  return inputUrl(e, run.id, a.object_key);
}

/**
 * The AI voice, paid once, timed by the words as written. Timings that are missing, or that do not match the script
 * word for word, are asked of forced alignment (rech-bg's fallback); its failure never costs the paid voice: the render
 * then spreads the scenes over it without subtitles.
 */
async function makeNarration(e: Env, step: WorkflowStep, run: RunInfo, spec: StorySpec, phase: Phase) {
  if (spec.narration.kind !== "voice") return;
  const voiceId = spec.narration.voiceId, script = storyScript(spec.scenes);
  const voice = await step.do("narration", once, async () => {
    const s = await readState(e, run.id);
    if (s.assets?.voice && s.tickets?.words) return { assetId: s.assets.voice, seconds: Number(s.tickets.voiceSeconds) || 0, words: s.tickets.words as any[] };
    if (s.claims?.voice) throw new Error("VOICE_FAILED");
    await patchState(e, run.id, (s) => { (s.claims ||= {}).voice = true; });
    await phase("voice");
    const result = await speak(e, voiceId, script, spec.language || "en", "original");
    const assetId = uid(), key = mediaKey(run.user_id, assetId, "wav");
    await e.MEDIA.put(key, result.audio, { httpMetadata: { contentType: "audio/wav" } });
    await e.DB.prepare(
      "INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,duration,status,meta,created_at,updated_at) VALUES (?,?,?,'voice','Voiceover',?,'audio/wav',?,?,'ready','{\"ai\":true}',?,?)",
    ).bind(assetId, run.user_id, run.video_id, key, result.audio.length, result.seconds, now(), now()).run();
    await patchState(e, run.id, (s) => { (s.assets ||= {}).voice = assetId; (s.tickets ||= {}).words = result.words; s.tickets.voiceSeconds = result.seconds; });
    return { assetId, seconds: result.seconds, words: result.words };
  });
  const words = await step.do("narration-timing", { retries: { limit: 0, delay: "1 second" }, timeout: "3 minutes" }, async () => {
    if (voice.words.length === textWords(script).length) return voice.words;
    try {
      const key = (await e.DB.prepare("SELECT object_key FROM media_assets WHERE id=?").bind(voice.assetId).first<{ object_key: string }>())?.object_key;
      const wav = key && await e.MEDIA.get(key);
      if (!wav) return voice.words;
      return await forcedAlignment(e, new Blob([await wav.arrayBuffer()], { type: "audio/wav" }), script, voice.seconds);
    } catch (error) {
      console.warn("Narration timing unavailable", { runId: run.id, code: error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "INTERNAL" });
      return voice.words;
    }
  });
  await step.do("narration-apply", () => updateSpec(e, run.video_id, (s) => {
    s.generated = { key: narrationKey(voiceId, script), voiceAssetId: voice.assetId, words };
  }));
}

/** Every file the render reads, resolved to its R2 key and length (owner's files, library items, the voice). */
async function resolveContext(e: Env, run: RunInfo, spec: Spec): Promise<PlanContext> {
  const media: Record<string, Media> = {};
  const assets = referencedAssets(spec);
  // A clip's video brings the words said in its moment (captions and cuts) — only those: a long video's whole
  // transcript would not fit in a step's result.
  const moment = isHighlight(spec) ? spec.source : null;
  if (assets.length)
    for (const a of (await e.DB.prepare(`SELECT id,object_key,mime,duration,width,height,kind,meta FROM media_assets WHERE user_id=? AND status='ready' AND id IN (${assets.map(() => "?").join(",")})`)
      .bind(run.user_id, ...assets).all<any>()).results)
      media[a.id] = {
        key: a.object_key, kind: a.mime.split("/")[0], duration: a.duration, width: a.width, height: a.height, ai: ["ai_image", "ai_clip"].includes(a.kind),
        ...(moment && moment.assetId === a.id && { words: storedTranscript(a.meta, Math.max(0, moment.start - 2), moment.end + 2)?.words || [] }),
      };
  const items = referencedLibrary(spec);
  if (items.length)
    for (const l of (await e.DB.prepare(`SELECT id,object_key,mime,duration,ai FROM library_items WHERE id IN (${items.map(() => "?").join(",")})`).bind(...items).all<any>()).results)
      // A library item made with AI is disclosed like the owner's AI pictures.
      media[l.id] = { key: l.object_key, kind: l.mime.split("/")[0], duration: l.duration, ai: !!l.ai };
  for (const id of [...assets, ...items]) if (!media[id]) throw new Error("MEDIA_INPUT");
  // Free-trial videos carry a small mark with the product's name.
  return { media, narration: isHighlight(spec) ? undefined : await narrationContext(e, run.user_id, spec), watermark: run.payload.watermark ? PRODUCT.name : "" };
}

/** Submits the render (to a free container), waits for it and returns its final status. */
async function renderJob(e: Env, step: WorkflowStep, run: RunInfo, part: Plan["compose"], phase: Phase): Promise<RenderStatus> {
  const payload = await step.do("compose-payload", async () => {
    const urls: string[] = [];
    for (const key of part.keys) urls.push(await inputUrl(e, run.id, key));
    const { keys: _keys, ...rest } = part;
    return { ...rest, id: (await readState(e, run.id)).jobs!.compose, urls } as unknown as RenderPayload;
  });
  // Up to ~40 minutes: renders take a minute or two, plus waiting for a free container.
  for (let i = 0; i < 240; i++) {
    const status = await step.do(`compose-render-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async (): Promise<RenderStatus> => {
      await phase("rendering");
      const s = await readState(e, run.id);
      let slot = s.slots?.compose ?? null;
      if (slot === null || !(s.claims?.["compose-accepted"])) {
        slot = await submitRender(e, payload, slot, (n) => patchState(e, run.id, (st) => { (st.slots ||= {}).compose = n; }).then(() => undefined));
        if (slot === null) return { status: "running" };
        await patchState(e, run.id, (st) => { (st.claims ||= {})["compose-accepted"] = true; });
      }
      return renderStatus(e, slot, payload.id);
    });
    if (status.status === "completed") return status;
    if (status.status === "failed") throw new Error(typeof status.error === "string" && /^MEDIA_[A-Z_]+$/.test(status.error) ? status.error : "MEDIA_PROCESSING_FAILED");
    await step.sleep(`compose-wait-${i}`, "8 seconds");
  }
  throw new Error("MEDIA_TIMEOUT");
}

/** Waits for a renderer job (on a free container) and returns its final status and the slot that holds it. */
async function rendererJob(e: Env, step: WorkflowStep, name: string, payload: RenderPayload, rounds: number, wait: "4 seconds" | "8 seconds" | "15 seconds") {
  let slot: number | null = null, result: RenderStatus | null = null;
  for (let i = 0; i < rounds && !result; i++) {
    const r = await step.do(`${name}-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
      if (slot === null) {
        const accepted = await submitRender(e, payload, null, async () => {});
        if (accepted === null) return { slot: null, status: { status: "running" } as RenderStatus };
        return { slot: accepted, status: await renderStatus(e, accepted, payload.id) };
      }
      return { slot, status: await renderStatus(e, slot, payload.id) };
    });
    slot = r.slot;
    if (r.status.status === "completed") result = r.status;
    else if (r.status.status === "failed") throw new Error(r.status.error || "MEDIA_FORMAT");
    else await step.sleep(`${name}-wait-${i}`, wait);
  }
  if (!result || slot === null) throw new Error("MEDIA_TIMEOUT");
  return { slot, result };
}

/**
 * Checks an uploaded video or track with the renderer (length, picture size, sound) before it can be used, then
 * looks for speech in it. A ready file with speech pending ("Find speech") only has its speech looked for.
 */
async function inspectUpload(e: Env, step: WorkflowStep, assetId: string) {
  const asset = await step.do("load", async () => e.DB.prepare("SELECT id,user_id,kind,mime,meta,status,duration FROM media_assets WHERE id=? AND status IN ('checking','ready')").bind(assetId).first<any>());
  if (!asset) return;
  if (asset.status === "ready") return findSpeech(e, step, asset.id);
  const meta = json<any>(asset.meta, {});
  // Videos as long as the plan allowed when they were uploaded (long videos on paid plans), tracks up to 10 minutes.
  const longest = asset.mime.startsWith("video/") && Number(meta.maxSeconds) > SPEECH_MAX_SECONDS ? Math.min(Number(meta.maxSeconds), LONG_VIDEO_SECONDS) : SPEECH_MAX_SECONDS;
  const payload: RenderPayload = { id: asset.id, operation: "inspect", url: `${siteUrl(e)}/api/upload-inputs/${asset.id}?token=${meta.token}`, maxSeconds: longest };
  let speech = false;
  try {
    const { slot, result } = await rendererJob(e, step, "inspect", payload, 90, "4 seconds");
    if (!result.meta) throw new Error("MEDIA_TIMEOUT");
    const m = result.meta, expected = asset.mime.split("/")[0];
    if (m.kind !== expected) throw new Error("MEDIA_FORMAT");
    speech = await step.do("ready", async () => {
      // Files that may hold speech are transcribed next, for free while the day's allowance lasts (Scribe reads them
      // with a new capability token).
      const checked = { hasAudio: m.hasAudio };
      const listen = mayHaveSpeech({ ...asset, duration: result.duration || 0 }, m.hasAudio) ? await claimSpeech(e, asset.user_id, checked, result.duration || 0) : null;
      await e.DB.prepare("UPDATE media_assets SET status='ready',duration=?,width=?,height=?,meta=?,updated_at=? WHERE id=? AND status='checking'")
        .bind(result.duration || 0, m.width || 0, m.height || 0, JSON.stringify(listen || checked), now(), asset.id).run();
      await releaseRender(e, slot, asset.id);
      return !!listen;
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    await step.do("failed", () => failAsset(e, asset.id, ({
      MEDIA_TOO_LARGE: "This video is too large (over 4096 pixels or 9 megapixels per frame).",
      MEDIA_TOO_LONG: longest > SPEECH_MAX_SECONDS ? `Videos can be up to ${Math.round(longest / 3600)} hours long.` : asset.mime.startsWith("video/") ? "Videos can be up to 10 minutes long on the free trial; paid plans take videos up to 2 hours." : "Tracks can be up to 10 minutes long.",
      MEDIA_FORMAT: "This file can't be read. Use MP4, MOV or WebM videos and MP3, WAV, M4A or OGG tracks.",
      MEDIA_TIMEOUT: "Checking this file took too long. Try uploading it again.",
    } as Record<string, string>)[code] || "This file couldn't be checked. Try uploading it again."));
  }
  if (speech) await findSpeech(e, step, asset.id);
}

/** Downloading an imported video: one more try after a minute (a dropped connection), 40 minutes each at most. */
const importOnce = { retries: { limit: 1, delay: "1 minute" as const }, timeout: "45 minutes" as const };
/**
 * A video imported from a link (server/imports.ts): downloaded into storage, then checked and transcribed like an
 * upload. A video of the person's own YouTube channel (server/youtube-import.ts) is downloaded by the renderer's
 * download container first (up to 30 minutes, waiting its turn). A failed download fails the file with the reason;
 * nothing is charged.
 */
async function importVideo(e: Env, step: WorkflowStep, assetId: string) {
  let youtube: RenderPayload | null = null;
  try {
    youtube = await step.do("import-youtube", safe, () => youtubeJob(e, assetId));
    if (youtube) {
      const job = youtube;
      const { slot } = await rendererJob(e, step, "youtube", job, 120, "15 seconds");
      if (!(await step.do("youtube-store", importOnce, () => storeYoutube(e, assetId, slot, job.id)))) return;
    } else if (!(await step.do("import", importOnce, () => downloadImport(e, assetId)))) return;
  } catch (error) {
    console.warn("Import failed", { assetId, code: error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : error instanceof Error ? error.name : "INTERNAL" });
    await step.do("import-failed", () => failAsset(e, assetId, importFailure(error, !!youtube)));
    return;
  }
  await inspectUpload(e, step, assetId);
}

/** Changes a file's meta (read fresh, so other changes are kept). */
async function patchMeta(e: Env, assetId: string, change: (meta: any) => void) {
  const row = await e.DB.prepare("SELECT meta FROM media_assets WHERE id=?").bind(assetId).first<{ meta: string }>();
  if (!row) return;
  const meta = json<any>(row.meta, {});
  change(meta);
  await e.DB.prepare("UPDATE media_assets SET meta=?,updated_at=? WHERE id=?").bind(JSON.stringify(meta), now(), assetId).run();
}
/** Calls to Scribe: once (each is billed), and long enough for two hours of sound. */
const scribeOnce = { retries: { limit: 0, delay: "1 second" as const }, timeout: "50 minutes" as const };
/**
 * Transcribes a ready file whose speech is pending: it is uploaded to ElevenLabs Scribe from storage. A free
 * transcription that fails leaves the file usable, without subtitles ("failed"; it can be tried again); a paid one
 * (`paid`: a run of kind "speech") also fails its run, which refunds the credits. A free one then finds the moments
 * asked for meanwhile (a paid run does that after it completes).
 */
async function findSpeech(e: Env, step: WorkflowStep, assetId: string, paid = false) {
  const job = await step.do("speech-start", async () => {
    const a = await e.DB.prepare("SELECT meta,status,duration FROM media_assets WHERE id=?").bind(assetId).first<any>();
    const meta = json<any>(a?.meta, {});
    if (a?.status !== "ready" || meta.speech?.status !== "pending" || !meta.listen) return null;
    return { duration: Number(a.duration) || 0, claim: uid() };
  });
  if (!job) {
    if (paid) throw new Error("SPEECH_INVALID");
    return;
  }
  try {
    await step.do("speech-transcribe", scribeOnce, async () => {
      // Paid once: the claim is stored before the call, so a step that runs again after it (its answer lost) stops.
      const before = await e.DB.prepare("SELECT meta FROM media_assets WHERE id=?").bind(assetId).first<{ meta: string }>();
      if (json<any>(before?.meta, {}).speech?.claim) throw new Error("SPEECH_UNCERTAIN");
      const a = await e.DB.prepare("SELECT object_key,mime FROM media_assets WHERE id=?").bind(assetId).first<{ object_key: string; mime: string }>();
      const stored = a && await e.MEDIA.get(a.object_key);
      if (!a || !stored) throw new Error("SPEECH_INVALID");
      await patchMeta(e, assetId, (meta) => { meta.speech = { ...meta.speech, claim: job.claim }; });
      const transcript = await transcribe(e, { body: stored.body, size: stored.size, type: a.mime, name: `upload.${extOf(a.mime)}` }, job.duration);
      await patchMeta(e, assetId, (meta) => {
        const found = transcript.words.length > 0;
        meta.speech = { status: found ? "found" : "none", at: now(), ...(found && transcript.language && { language: transcript.language }) };
        if (found) meta.transcript = transcript;
        else delete meta.transcript;
        delete meta.listen;
      });
    });
  } catch (error) {
    // Never a failed upload: the file stays ready, only without subtitles. The code says why (shown to the owner).
    const code = error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : "INTERNAL";
    console.error("Speech not found", { assetId, code });
    await step.do("speech-failed", () => patchMeta(e, assetId, (meta) => {
      meta.speech = { status: "failed", at: now(), code };
      delete meta.listen;
    }));
    if (paid) {
      await step.do("speech-failed-moments", () => momentsAfterSpeech(e, assetId));
      throw error;
    }
  }
  if (!paid) await step.do("moments", momentsStep, () => momentsAfterSpeech(e, assetId));
}

/** Files a run's renderer and providers read: capability links, valid while the run works (and 6 hours at most). */
export const renderInputs = new Hono<{ Bindings: Env }>();
renderInputs.get("/:id/:n", async (c) => {
  const run = await c.env.DB.prepare("SELECT user_id,provider FROM runs WHERE id=? AND status='running' AND created_at>?")
    .bind(c.req.param("id"), now() - 6 * 3600).first<{ user_id: string; provider: string }>();
  const s = json<RunState>(run?.provider, {});
  const n = Number(c.req.param("n"));
  const key = Number.isInteger(n) && n >= 0 ? s.inputs?.[n] : undefined;
  if (!run || !s.token || !safeEqual(s.token, c.req.query("token") || "") || !key) throw new HTTPException(404, { message: "Not found." });
  // Only this owner's files and the shared library are ever listed.
  if (!(key.startsWith(`media/${run.user_id}/`) || key.startsWith("library/"))) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, key, c.req.header("Range"), "no-store");
});

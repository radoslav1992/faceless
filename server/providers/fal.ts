import type { Env } from "../types";
import { CLIP_SECONDS, clipModels, isClipModel, type ClipModel, type ClipQuality } from "../../shared/credits";
import { failureCode, falQueueUrl, providerFetch, ProviderError } from "./http";

// AI pictures (a video's scenes) and short AI video clips through fal's queue API. A clip is made from a scene's
// picture with an image-to-video model (one per clip quality, the same request shape), as rech-bg's "Раздвижи снимка".
/** Scene pictures by default: OpenAI's GPT Image 2.5 (Flare, the fast variant) on fal. */
export const IMAGE_MODEL = "openai/gpt-image-2.5/flare/text-to-image";
/** Pictures an operator can choose instead with FAL_IMAGE_MODEL (the Sunburst variant of GPT Image 2.5 works too). */
export const NANO_BANANA_MODEL = "fal-ai/nano-banana-2";
/** Google's Nano Banana 2.1, in its own namespace on fal; chosen, it draws the later pictures too (its edit endpoint). */
export const NANO_BANANA_21_MODEL = "google/nano-banana-2.1";
export const FAST_IMAGE_MODEL = "fal-ai/flux/schnell";
/**
 * A video's scene pictures, drawn from its reference sheets (its characters, its places) so the characters, palette,
 * light, style and places stay the same from scene to scene: Nano Banana 2's edit endpoint (up to 14 reference
 * pictures). FAL_REFERENCE_MODEL can name another Nano Banana edit endpoint, or "off" to draw every picture from its
 * text alone (and no sheets).
 */
export const REFERENCE_MODEL = "fal-ai/nano-banana-2/edit";
/** GPT Image 2.5's quality levels (price rises with each); FAL_IMAGE_QUALITY picks one, "high" by default. */
export const imageQualities = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof imageQualities)[number];
const CLIP_MODEL = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
/** Clips from a scene's picture: Kling 2.5 Turbo, Standard (720p) at regular quality and Pro (1080p) at high. */
export const IMAGE_CLIP_MODELS: Record<ClipQuality, string> = {
  regular: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
  high: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
};
const NEGATIVE = "blur, distortion, low quality, text, captions, subtitles, watermark, logo";
export type FalTicket = { request_id: string; status_url: string; response_url: string };

const auth = (e: Env) => {
  const key = e.FAL_KEY?.trim();
  if (!key) throw new ProviderError("GENERATION_UNAVAILABLE");
  return { Authorization: `Key ${key}` };
};
/**
 * How a picture or clip is made: a clip from `image` (a capability link to the picture it starts from), `seconds`
 * long (5 or 10) and of `clipQuality` (regular unless said); a picture with `model` and, for GPT Image, `quality`.
 */
// The clip models (shared/credits.ts clipModels), each from the scene's picture in its own request: Kling 2.5 Turbo
// (Standard at regular quality, Pro at high), MiniMax H3 (768P at both: its 2K is an upscale at about twice the price)
// and FLUX 3 Max (720p at regular, 1080p at high). The clips' own sound, which H3 and FLUX 3 Max can make, is never
// played: the render takes only their picture.
const H3_CLIP_MODEL = "minimax/h3/image-to-video";
const FLUX_CLIP_MODEL = "blackforestlabs/flux-3-max/image-to-video";
/** Everyone's clip model (FAL_CLIP_MODEL), Kling unless set. */
const everyoneClipModel = (e: Env): ClipModel => {
  const m = e.FAL_CLIP_MODEL?.trim().toLowerCase();
  return isClipModel(m) ? m : "kling";
};
/** The models administrators can choose per scene: Kling, everyone's and those FAL_CLIP_MODEL_ADMIN lists (comma-separated). */
export function adminClipModels(e: Env): ClipModel[] {
  const listed = (e.FAL_CLIP_MODEL_ADMIN || "").toLowerCase().split(",").map((m) => m.trim()).filter(isClipModel);
  return clipModels.filter((m) => m === "kling" || m === everyoneClipModel(e) || listed.includes(m));
}
/** A scene's clip model: the one an administrator chose for it, when it is one they may choose; else everyone's. */
export function clipModelFor(e: Env, admin: boolean, chosen?: ClipModel): ClipModel {
  return admin && chosen && adminClipModels(e).includes(chosen) ? chosen : everyoneClipModel(e);
}

export type FalOptions = {
  image?: string; seconds?: number; clipQuality?: ClipQuality; model?: string; quality?: ImageQuality;
  /** The family a clip from a picture is made with (Kling unless said). */
  clipModel?: ClipModel;
  /** A picture drawn from these (capability links to the video's earlier pictures) with `referenceModel`. */
  references?: Reference[]; referenceModel?: string;
  /** Drawn with the fallback models (Nano Banana 2), after the operator's model refused the picture. */
  fallback?: boolean;
};
/**
 * A reference sheet of the video a picture is drawn from (shared/formats.ts pictureSheets): what its recurring
 * characters look like ("character"), or how the place the scene is set in is built ("place").
 */
export type Reference = { url: string; role: "character" | "place" };
const referenceUse: Record<Reference["role"], string> = {
  character: "shows only what the recurring characters look like: draw the ones this scene shows with exactly these faces, hair, bodies, clothing and colours, but in the pose, action and place this scene describes, never standing as in the reference; leave out any it does not mention.",
  place: "shows only how the place is built: keep its layout, walls, floor, furniture, objects, light and colours, but put the camera where this scene says and frame the picture anew; never copy the reference's view.",
};
/** How the references are used, after the scene: each only for what it shows, never as the picture to draw. */
export function referencePrompt(references: Reference[]) {
  const uses = references.length === 1 ? [`The reference picture ${referenceUse[references[0].role]}`]
    : references.map((r, i) => `Reference picture ${i + 1} ${referenceUse[r.role]}`);
  return `${uses.join(" ")} Match the art style and colours of the reference${references.length === 1 ? "" : "s"}.`;
}
/**
 * Nano Banana's input (2 and 2.1 alike): one 9:16 picture at 1K (768 × 1376). Nano Banana 2.1's filter is one step
 * less strict than fal's default (4 of 1–6): it refused ordinary scenes of the scripts' dark stories.
 */
const nanoBanana = (model: string, prompt: string, imageUrls?: string[]) => ({
  prompt, ...(imageUrls && { image_urls: imageUrls }), num_images: 1, aspect_ratio: "9:16", resolution: "1K", output_format: "jpeg", limit_generations: true,
  ...(model.startsWith(NANO_BANANA_21_MODEL) && { safety_tolerance: "5" }),
});
/** The model and its input (pure, for tests). Pictures are portrait 9:16 for short-form; no text is drawn in them. */
export function falRequest(kind: "image" | "clip", prompt: string, options: FalOptions = {}) {
  const text = `${prompt.trim()} No text, captions, logos or watermarks in the picture.`;
  if (kind === "image") {
    if (options.references?.length) {
      const model = options.referenceModel || REFERENCE_MODEL;
      return { model, body: nanoBanana(model, `Draw a new picture of this scene: ${text} ${referencePrompt(options.references)}`, options.references.map((r) => r.url)) };
    }
    const model = options.model || IMAGE_MODEL;
    if (model === NANO_BANANA_MODEL || model === NANO_BANANA_21_MODEL) return { model, body: nanoBanana(model, text) };
    if (model === FAST_IMAGE_MODEL)
      return { model, body: { prompt: text, num_images: 1, image_size: { width: 1088, height: 1920 }, num_inference_steps: 4, output_format: "jpeg", enable_safety_checker: true } };
    // GPT Image 2.5 (Flare or Sunburst): exactly 9:16 in multiples of 16; the renderer scales it to the 1080 × 1920 frame.
    const gpt = model.startsWith("openai/gpt-image-2.5/") ? model : IMAGE_MODEL;
    return { model: gpt, body: { prompt: text, num_images: 1, image_size: { width: 864, height: 1536 }, quality: options.quality || "high", output_format: "jpeg" } };
  }
  // Clips are silent: the post's music and voice play over them. From a picture, the clip keeps its shape.
  const seconds = options.seconds === 10 ? 10 : CLIP_SECONDS, quality = options.clipQuality ?? "regular";
  if (options.image && options.clipModel === "minimax-h3")
    return { model: H3_CLIP_MODEL, body: { prompt: text, image_url: options.image, duration: seconds, resolution: "768P" } };
  if (options.image && options.clipModel === "flux-3-max")
    return { model: FLUX_CLIP_MODEL, body: { prompt: text, image_url: options.image, duration: seconds, resolution: quality === "high" ? "1080p" : "720p", generate_audio: false } };
  const common = { prompt: text, duration: String(seconds), negative_prompt: NEGATIVE, cfg_scale: 0.5 };
  if (options.image) return { model: IMAGE_CLIP_MODELS[quality], body: { ...common, image_url: options.image } };
  return { model: CLIP_MODEL, body: { ...common, aspect_ratio: "9:16" } };
}
/**
 * The model scene pictures are drawn with from the reference sheets: FAL_REFERENCE_MODEL, else Nano Banana 2.1's edit
 * endpoint when it draws the sheets (one model for the whole video), else Nano Banana 2's; null when switched off.
 */
export function referenceModel(e: Env) {
  const name = e.FAL_REFERENCE_MODEL?.trim();
  if (name?.toLowerCase() === "off") return null;
  return name || (e.FAL_IMAGE_MODEL?.trim() === NANO_BANANA_21_MODEL ? `${NANO_BANANA_21_MODEL}/edit` : REFERENCE_MODEL);
}
/** The model a picture is drawn with: the operator's (FAL_IMAGE_MODEL, FAL_REFERENCE_MODEL), or the fallback. */
function pictureModels(e: Env, fallback = false) {
  return fallback ? { model: NANO_BANANA_MODEL, referenceModel: REFERENCE_MODEL } : { model: e.FAL_IMAGE_MODEL?.trim() || IMAGE_MODEL, referenceModel: referenceModel(e) || undefined };
}
/**
 * Whether a picture the operator's model refused can be drawn once more with Nano Banana 2 (its edit endpoint with
 * references), the model videos were drawn with before: only when another model refused it.
 */
export function canFallBack(e: Env, references: boolean) {
  const drawn = (fallback: boolean) => falRequest("image", "", { ...pictureModels(e, fallback), references: references ? [{ url: "", role: "character" }] : undefined }).model;
  return drawn(false) !== drawn(true);
}
/** The operator's picture quality (FAL_IMAGE_QUALITY), when it is one GPT Image knows. */
const imageQuality = (e: Env) => imageQualities.find((q) => q === e.FAL_IMAGE_QUALITY?.trim().toLowerCase());
/** Submits once; the caller stores the ticket before anything else so a retry polls instead of paying again. */
export async function submitFal(e: Env, kind: "image" | "clip", prompt: string, options: FalOptions = {}): Promise<FalTicket> {
  const { model, body } = falRequest(kind, prompt, { ...options, ...pictureModels(e, options.fallback), quality: imageQuality(e) });
  const r = await providerFetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: { ...auth(e), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new ProviderError(await failureCode(r, "GENERATION"));
  const t = (await r.json()) as any;
  if (!t?.request_id) throw new ProviderError("GENERATION_FAILED");
  return { request_id: String(t.request_id), status_url: falQueueUrl(String(t.status_url)), response_url: falQueueUrl(String(t.response_url)) };
}
/** "pending" while queued or running, "done" when the result can be read. */
export async function falStatus(e: Env, ticket: FalTicket): Promise<"pending" | "done"> {
  const r = await providerFetch(falQueueUrl(ticket.status_url), { headers: auth(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(r.status >= 500 ? "GENERATION_STATUS" : await failureCode(r, "GENERATION"));
  const status = ((await r.json()) as any)?.status;
  if (status === "COMPLETED") return "done";
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") return "pending";
  throw new ProviderError("GENERATION_FAILED");
}
/** The output file's URL (image or video). */
export async function falResult(e: Env, kind: "image" | "clip", ticket: FalTicket) {
  const r = await providerFetch(falQueueUrl(ticket.response_url), { headers: auth(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(r.status >= 500 ? "GENERATION_RESULT" : await failureCode(r, "GENERATION"));
  const result = (await r.json()) as any;
  const url = kind === "image" ? result?.images?.[0]?.url : result?.video?.url;
  if (typeof url !== "string") throw new ProviderError("GENERATION_FAILED");
  return url;
}

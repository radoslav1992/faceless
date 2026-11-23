import { z } from "zod";
import type { Env } from "./types";

// Text generation (scripts, picture descriptions, sound and clip choices) through the Workers AI binding, always as
// JSON. What people typed is sent as data, never as instructions. Two request shapes: OpenAI's Responses API with a
// strict JSON schema, and Google's generateContent (the `google/` models), which answers in JSON to a schema given
// in its instructions.
export const DEFAULT_TEXT_MODEL = "openai/gpt-6-luna";
/** The model that writes scripts and plans their pictures (server/story.ts). */
export const DEFAULT_WRITER_MODEL = "google/gemini-4-carbon";
const textModel = (env: Env) => env.TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
export const writerModel = (env: Env) => env.WRITER_MODEL?.trim() || DEFAULT_WRITER_MODEL;

/** The most a request is ever allowed to write, thinking included. */
const MAX_OUTPUT_TOKENS = 32000;
/** Room for a Google model's thinking, which its bound counts with the answer (as server/describe.ts gives it). */
const THINKING_ROOM = 8192;
const google = (model: string) => model.startsWith("google/");
/** The request for a model: `tokens` bounds its answer. */
function request(model: string, instructions: string, input: unknown, schema: object, tokens: number) {
  if (!google(model)) {
    return {
      instructions,
      input: JSON.stringify(input),
      max_output_tokens: Math.min(tokens, MAX_OUTPUT_TOKENS),
      text: { format: { type: "json_schema", name: "answer", strict: true, schema } },
    };
  }
  return {
    contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
    systemInstruction: { parts: [{ text: `${instructions}\nAnswer with one JSON object that fits this JSON Schema, with every required field, and nothing else:\n${JSON.stringify(schema)}` }] },
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: Math.min(tokens + THINKING_ROOM, MAX_OUTPUT_TOKENS) },
  };
}
/**
 * One model's JSON answer, or null when it failed, timed out or did not complete. `maxTokens` bounds the answer and
 * the model's thinking together, and the thinking grows with the rules it is given: an answer cut off at the bound is
 * asked for once more with twice the room, within the same time. An answer that can't be used is logged with why
 * (never with its words).
 */
async function askJson(env: Env, model: string, instructions: string, input: unknown, schema: object, maxTokens: number, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ask = (tokens: number) => env.AI.run(model, request(model, instructions, input, schema, tokens));
    const answered = async () => {
      const first = await ask(maxTokens);
      if (unusable(first)?.reason !== "max_output_tokens" || maxTokens >= MAX_OUTPUT_TOKENS) return first;
      console.error("Text model ran out of room", { model, tokens: maxTokens });
      return ask(maxTokens * 2);
    };
    const result = await Promise.race([
      answered(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AI_TIMEOUT")), ms); }),
    ]);
    const answer = readJson(result);
    if (answer === null) console.error("Text model gave no answer", { model, ...(unusable(result) ?? { status: "unreadable" }) });
    return answer;
  } catch (e) {
    // Never log the input or the provider's message.
    console.error("Text model failed", { model, name: e instanceof Error ? e.name : "UnknownError", timeout: e instanceof Error && e.message === "AI_TIMEOUT" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
/**
 * The JSON answer of the text model, or null when it failed, timed out or did not complete. With a `model` of its
 * own (the writer's), a request that model could not answer is asked of the text model, so a model that is down,
 * refuses or is renamed costs time and not the answer.
 */
export async function aiJson(env: Env, instructions: string, input: unknown, schema: object, maxTokens: number, ms: number, model?: string): Promise<unknown> {
  const usual = textModel(env);
  if (!model || model === usual) return askJson(env, usual, instructions, input, schema, maxTokens, ms);
  const answer = await askJson(env, model, instructions, input, schema, maxTokens, ms);
  if (answer !== null) return answer;
  console.error("Text model fell back", { from: model, to: usual });
  return askJson(env, usual, instructions, input, schema, maxTokens, Math.min(ms, 90000));
}
const parts = z.array(z.object({ type: z.string().optional(), text: z.string().optional(), thought: z.boolean().optional() }));
/** Both shapes of an answer: the Responses API's, and generateContent's candidates. */
const resultShape = z.object({
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  output_text: z.string().optional(),
  output: z.array(z.object({ content: parts.optional() })).optional(),
  candidates: z.array(z.object({ finishReason: z.string().optional(), content: z.object({ parts: parts.optional() }).nullish() })).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).nullish(),
});
/** The text of an answer, without a Google model's thoughts. */
function answerText(r: z.infer<typeof resultShape>) {
  if (r.candidates) return (r.candidates[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  return r.output_text || r.output?.flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text || "").join("") || "";
}
/** Why a Google model stopped without an answer to use: a filter of its own. */
const GOOGLE_REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);
/**
 * Why a result has no answer to read, without any of its words: its status, why it stopped (an answer cut off at
 * its bound), whether the model refused. Undefined for a completed answer with text.
 */
function unusable(result: unknown): { status: string; reason?: string; refused?: true } | undefined {
  const r = resultShape.safeParse(result);
  if (!r.success) return { status: "unreadable" };
  const text = answerText(r.data);
  if (r.data.candidates || r.data.promptFeedback) {
    const finish = r.data.candidates?.[0]?.finishReason || "";
    const refused = !!r.data.promptFeedback?.blockReason || GOOGLE_REFUSALS.has(finish);
    if ((!finish || finish === "STOP") && text && !refused) return undefined;
    return { status: (finish || "none").slice(0, 40), ...(finish === "MAX_TOKENS" && { reason: "max_output_tokens" }), ...(refused && { refused: true as const }) };
  }
  const refused = (r.data.output?.flatMap((o) => o.content || []) ?? []).some((c) => c.type === "refusal");
  if ((!r.data.status || r.data.status === "completed") && text && !refused) return undefined;
  return { status: r.data.status || "none", ...(r.data.incomplete_details?.reason && { reason: r.data.incomplete_details.reason.slice(0, 40) }), ...(refused && { refused: true as const }) };
}
/** The JSON in a model's answer (the Responses API's output_text or output parts, or generateContent's candidates). */
export function readJson(result: unknown): unknown {
  const r = resultShape.safeParse(result);
  if (!r.success || unusable(result)) return null;
  try {
    return JSON.parse(answerText(r.data).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  } catch {
    return null;
  }
}
/** A text a model wrote, made safe to store and show: no markup, no control characters, bounded. */
export function clean(text: unknown, max: number) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, "")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, max);
}

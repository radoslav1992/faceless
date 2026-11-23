import { z } from "zod";
import type { Env } from "./types";

// Text generation (scripts, picture descriptions) through the Workers AI binding, in the Responses API shape, always
// with a strict JSON schema. What people typed is sent as data, never as instructions.
export const DEFAULT_TEXT_MODEL = "openai/gpt-6-luna";

/** The most a request is ever allowed to write, thinking included. */
const MAX_OUTPUT_TOKENS = 32000;
/**
 * The model's JSON answer, or null when it failed, timed out or did not complete. `maxTokens` bounds the answer and
 * the model's thinking together, and the thinking grows with the rules it is given: an answer cut off at the bound is
 * asked for once more with twice the room, within the same time. An answer that can't be used is logged with why
 * (never with its words).
 */
export async function aiJson(env: Env, instructions: string, input: unknown, schema: object, maxTokens: number, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ask = (tokens: number) => env.AI.run(env.TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL, {
      instructions,
      input: JSON.stringify(input),
      max_output_tokens: tokens,
      text: { format: { type: "json_schema", name: "answer", strict: true, schema } },
    });
    const answered = async () => {
      const first = await ask(Math.min(maxTokens, MAX_OUTPUT_TOKENS));
      if (unusable(first)?.reason !== "max_output_tokens" || maxTokens >= MAX_OUTPUT_TOKENS) return first;
      console.error("Text model ran out of room", { tokens: maxTokens });
      return ask(Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS));
    };
    const result = await Promise.race([
      answered(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AI_TIMEOUT")), ms); }),
    ]);
    const answer = readJson(result);
    if (answer === null) console.error("Text model gave no answer", unusable(result) ?? { status: "unreadable" });
    return answer;
  } catch (e) {
    // Never log the input or the provider's message.
    console.error("Text model failed", { name: e instanceof Error ? e.name : "UnknownError", timeout: e instanceof Error && e.message === "AI_TIMEOUT" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Why a Responses API result has no answer to read, without any of its words: its status, why it stopped (an answer
 * cut off at `max_output_tokens`), whether the model refused. Undefined for a completed answer with text.
 */
function unusable(result: unknown): { status: string; reason?: string; refused?: true } | undefined {
  const r = z.object({
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
    output_text: z.string().optional(),
    output: z.array(z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })).optional(),
  }).safeParse(result);
  if (!r.success) return { status: "unreadable" };
  const parts = r.data.output?.flatMap((o) => o.content || []) ?? [];
  const refused = parts.some((c) => c.type === "refusal");
  const text = r.data.output_text || parts.some((c) => c.type === "output_text" && c.text);
  if ((!r.data.status || r.data.status === "completed") && text && !refused) return undefined;
  return { status: r.data.status || "none", ...(r.data.incomplete_details?.reason && { reason: r.data.incomplete_details.reason.slice(0, 40) }), ...(refused && { refused: true as const }) };
}
/** The JSON in a Responses API result (output_text, or the output_text parts of the output). */
export function readJson(result: unknown): unknown {
  const r = z.object({
    status: z.string().optional(),
    output_text: z.string().optional(),
    output: z.array(z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })).optional(),
  }).safeParse(result);
  if (!r.success || (r.data.status && r.data.status !== "completed")) return null;
  const text = r.data.output_text || r.data.output?.flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text || "").join("") || "";
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
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

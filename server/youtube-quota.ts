import type { Env } from "./types";
import { now } from "./types";
import { readState, writeState } from "./ops-state";
import { sendMail } from "./security";
import { recipients } from "./operations";
import { PRODUCT } from "../shared/brand";

// YouTube gives the API project an upload allowance: videos.insert calls a day for all customers together (100 until
// Google raises it through the audit and quota extension form), counted from midnight Pacific time. Google offers no
// running count to read, so we count the upload sessions YouTube opens for us, and e-mail ADMIN_EMAILS once a day when
// they reach 80% of YOUTUBE_UPLOADS_DAILY, and once more if YouTube refuses an upload for quota: time to ask for more
// before posts start failing. Every five minutes from maintenance.
const COUNT = "youtube-uploads", SENT = "youtube-uploads-alert";
export const UPLOAD_WARNING = 0.8;
export const DEFAULT_UPLOADS_DAILY = 100;
export const QUOTA_FORM = "https://support.google.com/youtube/contact/yt_api_form";

const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
/** The day YouTube's quota counts, in Pacific time: "2026-11-02". */
export function quotaDay(at = Date.now()) {
  const part = (type: string) => pacific.formatToParts(at).find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The project's uploads a day as Google set them (YOUTUBE_UPLOADS_DAILY), 100 by default. */
export function uploadsDaily(e: Env) {
  const n = Number(e.YOUTUBE_UPLOADS_DAILY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_UPLOADS_DAILY;
}

type Uploads = { day: string; count: number; refused: number };

/**
 * Counts one videos.insert call for today, or (`refused`) notes that YouTube turned one down for quota, which made no
 * upload. One statement, so parallel uploads are all counted; never throws: posting must not depend on it.
 */
export async function countUpload(e: Env, refused = false) {
  try {
    await e.DB.prepare(
      `INSERT INTO operations_state(key,value,updated_at) VALUES (?1,json_object('day',?2,'count',?3,'refused',?4),?5)
       ON CONFLICT(key) DO UPDATE SET updated_at=?5, value=CASE WHEN json_extract(value,'$.day')=?2
         THEN json_set(value,'$.count',json_extract(value,'$.count')+?3,'$.refused',MAX(json_extract(value,'$.refused'),?4))
         ELSE json_object('day',?2,'count',?3,'refused',?4) END`,
    ).bind(COUNT, quotaDay(), refused ? 0 : 1, refused ? 1 : 0, now()).run();
  } catch {
    console.error("YouTube upload not counted");
  }
}

/** Today's count: uploads, the allowance, and whether YouTube refused one for quota. */
export async function uploadsToday(e: Env) {
  const u = await readState<Uploads>(e, COUNT);
  const today = u?.day === quotaDay();
  return { count: today ? Number(u!.count) || 0 : 0, limit: uploadsDaily(e), refused: today && Number(u!.refused) > 0 };
}

/**
 * E-mails ADMIN_EMAILS when today's uploads reach 80% of the allowance, and when YouTube refused one for quota: each
 * once a Pacific day. A mail failure is logged and retried on the next pass, never thrown.
 */
export async function reportUploads(e: Env) {
  const { count, limit, refused } = await uploadsToday(e);
  const level = refused ? "refused" : count >= Math.ceil(limit * UPLOAD_WARNING) ? "warning" : null;
  if (!level) return;
  const day = quotaDay(), sent = await readState<{ day: string; level: string }>(e, SENT);
  if (sent?.day === day && (sent.level === level || sent.level === "refused")) return;
  console.warn("YouTube upload quota", { count, limit, refused });
  const to = recipients(e.ADMIN_EMAILS);
  if (!to.length) return;
  const [subject, opening] = refused
    ? [`${PRODUCT.name}: YouTube refused uploads, daily limit reached`,
      `YouTube refused an upload today because the project's daily upload limit is used up (${count} uploads counted today; YOUTUBE_UPLOADS_DAILY is ${limit}). ` +
      "Posts to YouTube fail until midnight Pacific time, and people have to post them again."]
    : [`${PRODUCT.name}: YouTube uploads at ${Math.floor((count * 100) / limit)}% of today's limit`,
      `YouTube uploads today: ${count} of the ${limit} a day Google allows ${PRODUCT.name}, for all customers together. The count restarts at midnight Pacific time. ` +
      "Once the limit is reached, YouTube refuses uploads until then: those posts fail after three retries (about 20 minutes) and people have to post them again."];
  const text = [
    opening,
    "",
    "To raise the limit:",
    "1. Check the exact usage in the Google Cloud console: APIs & Services > YouTube Data API v3 > Quotas.",
    `2. Send the YouTube API Services audit and quota extension form with that usage: ${QUOTA_FORM}`,
    "3. Once Google raises it, set YOUTUBE_UPLOADS_DAILY in Cloudflare to the new limit, so these e-mails follow it.",
    "",
    "We count the upload sessions YouTube opened for us, so Google's own number can differ slightly. See docs/SOCIAL.md.",
  ].join("\n");
  let delivered = 0;
  for (const address of to) {
    try {
      await sendMail(e, address, subject, text);
      delivered++;
    } catch {
      console.error("YouTube quota alert not sent", { recipients: to.length });
    }
  }
  if (delivered) await writeState(e, SENT, { day, level });
}

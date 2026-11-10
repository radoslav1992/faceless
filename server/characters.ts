import type { Env } from "./types";
import { now, uid } from "./types";
import { json } from "./db";
import { extOf, mediaKey } from "./storage";
import { seriesSettingsSchema } from "../shared/series";
import { characterSheetKey } from "../shared/story";

// A series' main character, drawn once. Every video draws its recurring characters on a reference sheet first and
// every scene from that sheet (content-workflow.ts makeSheets), which keeps them the same within one video. Episodes
// of a series share the character's description, but a sheet drawn again for each episode is a new drawing: the same
// words, another face. So the sheet of the first episode that draws the series' character is kept with the series, as
// a file of its own (it outlives that episode), and every later episode is drawn from it.
//
// The sheet belongs to the character as the series describes it now: its key is the fingerprint of the description
// and the art style, so a changed character or style simply finds no sheet and the next episode draws (and keeps) a
// new one. An episode whose own character was changed in the editor is not the series' character and is left alone.

/** Before migrations/0015 the columns are missing: the series then works as it did, each episode with its own sheet. */
const unavailable = (what: string, videoId: string) => (error: unknown) => {
  console.warn(`Series character ${what}`, { videoId, error: (error as Error)?.name });
  return null;
};

/** The stored sheet an episode's character (the sheet's `key`) is drawn from: its series', when it is this character's. */
export async function seriesCharacter(env: Env, videoId: string, userId: string, key: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT a.object_key FROM videos v JOIN series s ON s.id=v.series_id JOIN media_assets a ON a.id=s.character_asset WHERE v.id=? AND v.user_id=? AND s.character_key=? AND a.user_id=v.user_id AND a.status='ready'",
  ).bind(videoId, userId, key).first<{ object_key: string }>().catch(unavailable("not read", videoId));
  return row?.object_key ?? null;
}

/**
 * Keeps the character sheet an episode has just drawn (`assetId`, of `key`) with its series, when it shows the
 * series' own character: a copy that belongs to no video. Safe to repeat (a retried step finds its copy), and never
 * fails the episode: a sheet that could not be kept (storage full) is drawn again by the next episode.
 */
export async function keepSeriesCharacter(env: Env, videoId: string, userId: string, key: string, assetId: string): Promise<void> {
  try {
    const s = await env.DB.prepare("SELECT s.id,s.name,s.settings,s.character_asset,s.character_key FROM videos v JOIN series s ON s.id=v.series_id WHERE v.id=? AND v.user_id=?")
      .bind(videoId, userId).first<{ id: string; name: string; settings: string; character_asset: string | null; character_key: string | null }>();
    if (!s) return;
    const settings = seriesSettingsSchema.safeParse(json(s.settings, {}));
    if (!settings.success || !settings.data.subject.trim() || characterSheetKey(settings.data.subject, settings.data.style) !== key) return;
    // Another episode made at the same time kept its sheet first: the series has one look, the first one.
    if (s.character_asset && s.character_key === key) return;
    const copies = "user_id=?1 AND video_id IS NULL AND kind='ai_image' AND json_extract(meta,'$.series')=?2";
    let copy = (await env.DB.prepare(`SELECT id FROM media_assets WHERE ${copies} AND json_extract(meta,'$.sheet')=?3 AND status='ready' LIMIT 1`).bind(userId, s.id, key).first<{ id: string }>())?.id;
    if (!copy) {
      const drawn = await env.DB.prepare("SELECT object_key,mime,bytes,width,height FROM media_assets WHERE id=? AND user_id=? AND status='ready'")
        .bind(assetId, userId).first<{ object_key: string; mime: string; bytes: number; width: number; height: number }>();
      const file = drawn && await env.MEDIA.get(drawn.object_key);
      if (!drawn || !file) return;
      copy = uid();
      const object = mediaKey(userId, copy, extOf(drawn.mime));
      await env.MEDIA.put(object, await file.arrayBuffer(), { httpMetadata: { contentType: drawn.mime } });
      try {
        await env.DB.prepare(
          "INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,width,height,status,meta,created_at,updated_at) VALUES (?,?,NULL,'ai_image',?,?,?,?,?,?,'ready',?,?,?)",
        ).bind(copy, userId, `Main character of “${s.name}”`.slice(0, 160), object, drawn.mime, drawn.bytes, drawn.width, drawn.height,
          JSON.stringify({ ai: true, sheet: key, series: s.id }), now(), now()).run();
      } catch (error) {
        // No row will ever delete the stored copy, so it goes now (the usual reason: the owner's storage is full).
        await env.MEDIA.delete(object).catch(() => {});
        throw error;
      }
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE series SET character_asset=?,character_key=? WHERE id=?").bind(copy, key, s.id),
      // The look before (another character or style), and copies no series points to.
      env.DB.prepare(`DELETE FROM media_assets WHERE ${copies} AND id<>?3`).bind(userId, s.id, copy),
    ]);
  } catch (error) {
    unavailable("not kept", videoId)(error);
  }
}

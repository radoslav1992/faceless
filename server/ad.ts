import type { Env } from "./types";
import { heygenEnabled } from "./providers/heygen";
import { adModels, type AdModel } from "../shared/ad";

// Which video model films a product ad (shared/ad.ts). Everyone's ads are filmed with the site's one model;
// administrators choose among all of them, to compare.

/** The models this site can run: HeyGen's only with its key. */
const runnable = (env: Env): AdModel[] => adModels.filter((m) => m !== "heygen" || heygenEnabled(env));
/** The model everyone's ads are filmed with: AD_MODEL when the site can run it, else MiniMax (shot by shot). */
export function siteAdModel(env: Env): AdModel {
  const wanted = env.AD_MODEL?.trim().toLowerCase();
  return runnable(env).find((m) => m === wanted) ?? "minimax";
}
/** The models a person may choose for an ad: all the site can run for an administrator, the site's one for anyone else. */
export const adModelsFor = (env: Env, admin: boolean): AdModel[] => (admin ? runnable(env) : [siteAdModel(env)]);

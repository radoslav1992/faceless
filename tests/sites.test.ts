import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { plans } from "../shared/plans";
import { CURRENCY, price } from "../shared/money";
import { PRODUCT } from "../shared/brand";
import { IMMEDIATE_START_TEXT, IMMEDIATE_START_VERSION } from "../shared/withdrawal";

// Two sites from one codebase (docs/SITES.md): what Hookstreak is must not move, and Реч БГ's setup must follow the code.
it("is Hookstreak in name, currency and consent wording", () => {
  expect(PRODUCT.name).toBe("Hookstreak Shorts");
  expect(CURRENCY).toEqual({ code: "usd", symbol: "$" });
  expect([price(19), price(7.5)]).toEqual(["$19", "$7.50"]);
  expect(IMMEDIATE_START_VERSION).toBe("2026-10-09");
  expect(IMMEDIATE_START_TEXT).toMatch(/^I want my plan to start straight after payment/);
});

it("creates Реч БГ's Stripe prices from the plans' own prices", () => {
  const script = readFileSync("scripts/stripe-prices-rechbg.mjs", "utf8");
  const listed = [...script.matchAll(/\{ id: "(\w+)", monthly: (\d+) \}/g)].map((m) => [m[1], Number(m[2])]);
  const paid = plans.filter((p) => p.monthly > 0);
  expect(listed).toEqual(paid.map((p) => [p.id, p.monthly]));
  // A year is ten months' price on every plan, as the script assumes.
  for (const p of paid) expect(p.yearly).toBe(p.monthly * 10);
});

it("gives each site its own Worker, database, bucket and workflows", () => {
  const config = (file: string) => readFileSync(file, "utf8");
  const hookstreak = config("wrangler.jsonc"), rechbg = config("wrangler.rechbg.jsonc");
  const value = (text: string, key: string) => [...text.matchAll(new RegExp(`"${key}": "([^"]+)"`, "g"))].map((m) => m[1]);
  // Реч БГ's own come first; Hookstreak's are there once more, only to be read for the library (server/library-import.ts).
  for (const key of ["database_id", "database_name", "bucket_name"]) {
    const [own, borrowed, ...more] = value(rechbg, key);
    expect(own).not.toBe(value(hookstreak, key)[0]);
    expect([borrowed, more]).toEqual([value(hookstreak, key)[0], []]);
  }
  expect(rechbg).toContain('{ "binding": "HOOKSTREAK_DB", "database_name": "faceless"');
  expect(rechbg).toContain('{ "binding": "HOOKSTREAK_MEDIA", "bucket_name": "faceless-media" }');
  expect(hookstreak).not.toContain("HOOKSTREAK_");
  // Реч БГ deploys into the earlier Реч БГ app's Worker, to keep its secrets; never into Hookstreak's.
  expect(value(rechbg, "name")[0]).toBe("rech-bg");
  expect(value(hookstreak, "name")[0]).toBe("faceless");
  expect(value(rechbg, "name").filter((name) => value(hookstreak, "name").includes(name))).toEqual(["EMAIL", "MEDIA_RENDERER"]);
  // That Worker's renderer class was created under this tag; a different one would be refused as a second creation.
  expect(rechbg).toContain('"migrations": [{ "tag": "media-v1", "new_sqlite_classes": ["MediaRenderer"] }]');
  expect(hookstreak).toContain(String.raw`"define": { "__SITE__": "\"hookstreak\"" }`);
  expect(rechbg).toContain(String.raw`"define": { "__SITE__": "\"rechbg\"" }`);
  expect(rechbg).toContain('"routes": [{ "pattern": "rechbg.com", "custom_domain": true }]');
  // Nothing deploys Реч БГ by itself: its workflow runs only by hand.
  const deploy = readFileSync(".github/workflows/deploy-rechbg.yml", "utf8");
  expect(deploy).toContain("\non:\n  workflow_dispatch:\n");
  expect(deploy).not.toContain("\n  push:");
});

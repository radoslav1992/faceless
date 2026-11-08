import { describe, expect, it, vi } from "vitest";
import { answerOrder, onPageRestored } from "../src/lib";
import { safeNext } from "../src/public/safe-next";
import { sceneIndex } from "../src/app/story-model";

// The web client's logic that runs without a page: which answers to show, the sign-in redirect, the editor's selection
// and the return from the back/forward cache.

const ORIGIN = "https://hookstreak.com";

describe("safeNext", () => {
  it("refuses anything that could leave the site or loop back to sign-in", () => {
    const bad = [
      // "?next=/%09/evil.com", decoded: browsers drop the tab and read "//evil.com".
      decodeURIComponent("/%09/evil.com"),
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/\t\t/evil.com",
      "/\u0000/evil.com",
      "/ /evil.com",
      "/app x",
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/app\\..\\..\\evil",
      "/.//evil.com",
      "https://evil.com",
      "http:/evil.com",
      "javascript:alert(1)",
      "evil.com",
      "",
      null,
      "/login",
      "/login?next=/app",
      "/LOGIN",
      "/register/",
      "/app/../login",
    ];
    for (const next of bad) expect([next, safeNext(next, ORIGIN)]).toEqual([next, null]);
  });
  it("keeps a page of this site, with its query and fragment", () => {
    const good: [string, string][] = [
      ["/app", "/app"],
      ["/app/videos?x=1", "/app/videos?x=1"],
      ["/app/create?template=facts&x=%2F%2Fevil.com", "/app/create?template=facts&x=%2F%2Fevil.com"],
      ["/terms#withdrawal", "/terms#withdrawal"],
      ["/verify", "/verify"],
      ["/loginhelp", "/loginhelp"],
      ["/app/./videos", "/app/videos"],
    ];
    for (const [next, kept] of good) expect(safeNext(next, ORIGIN)).toBe(kept);
  });
});

describe("answerOrder", () => {
  it("drops an answer for what was asked before (Videos: Failed, then All)", () => {
    const order = answerOrder("/videos?view=all");
    const all = order.ask();
    expect(order.fresh(all, "/videos?view=all")).toBe(true);
    order.want("/videos?view=failed");
    const failed = order.ask();
    order.want("/videos?view=all");
    const again = order.ask();
    // The Failed tab's answer arrives after All was asked for again: either order, the failed list is not shown.
    expect(order.fresh(failed, "/videos?view=failed")).toBe(false);
    expect(order.fresh(again, "/videos?view=all")).toBe(true);
    expect(order.fresh(failed, "/videos?view=failed")).toBe(false);
  });
  it("drops an earlier request's answer for the same address once a later one is shown", () => {
    const order = answerOrder("/library?kind=clip&q=ca");
    order.want("/library?kind=clip&q=cat");
    const first = order.ask(), second = order.ask();
    expect(order.fresh(second, "/library?kind=clip&q=cat")).toBe(true);
    expect(order.fresh(first, "/library?kind=clip&q=cat")).toBe(false);
  });
  it("shows answers that arrive in order, even when each was asked before the last one answered (polling)", () => {
    const order = answerOrder("/publications");
    const first = order.ask(), second = order.ask(), third = order.ask();
    expect(order.fresh(first, "/publications")).toBe(true);
    expect(order.fresh(second, "/publications")).toBe(true);
    expect(order.fresh(third, "/publications")).toBe(true);
  });
  it("drops an answer for an address returned to after asking elsewhere (A, B, then A again)", () => {
    const order = answerOrder<string | null>("a");
    const a1 = order.ask();
    order.want("b");
    order.ask();
    order.want("a");
    const a2 = order.ask();
    expect(order.fresh(a1, "a")).toBe(false);
    expect(order.fresh(a2, "a")).toBe(true);
  });
  it("drops every answer once nothing is asked for (a search cleared)", () => {
    const order = answerOrder<string | null>("/admin/grants/accounts?q=ann");
    const n = order.ask();
    order.want(null);
    expect(order.fresh(n, "/admin/grants/accounts?q=ann")).toBe(false);
  });
});

describe("onPageRestored", () => {
  const pageshow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });
  it("runs when the page comes back from the back/forward cache, not on a fresh load, and stops when removed", () => {
    const target = new EventTarget(), fn = vi.fn();
    const stop = onPageRestored(target, fn);
    target.dispatchEvent(pageshow(false));
    expect(fn).not.toHaveBeenCalled();
    target.dispatchEvent(pageshow(true));
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(pageshow(true));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("sceneIndex", () => {
  it("keeps the selection on a scene when the list is replaced by fewer", () => {
    // Scene 7 of 8 selected, then Write again makes 6: the last one is selected, not a seventh that isn't there.
    expect(sceneIndex(6, 8)).toBe(6);
    expect(sceneIndex(6, 6)).toBe(5);
    expect(sceneIndex(3, 1)).toBe(0);
    expect(sceneIndex(0, 6)).toBe(0);
    expect(sceneIndex(-1, 6)).toBe(0);
  });
});

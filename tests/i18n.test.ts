import { expect, it } from "vitest";
import { catalogOf, localized, t, translator, type Catalog } from "../shared/i18n";
import { SITE, SITE_ID } from "../shared/site";
import { bg } from "../shared/locales/bg";
import { translateProps } from "../src/i18n/translate";

// Two sites from one codebase (docs/SITES.md): Hookstreak is the default and must stay exactly as it is.
it("is Hookstreak, in English, unless the build says otherwise", () => {
  expect(SITE_ID).toBe("hookstreak");
  expect(SITE).toEqual({ id: "hookstreak", lang: "en", locale: "en-US", narration: "en" });
  expect(t("Create video")).toBe("Create video");
  const data = { name: "Starter", features: ["30 credits a month"], price: 19 };
  expect(localized(data)).toBe(data);
});

const catalog: Catalog = catalogOf({
  exact: { "Create video": "Създай видео", "credits left": "оставащи кредита", "Search styles": "Търсене на стилове" },
  templates: { "This needs {1} credit{2} and you have {3} left.": "Нужни кредити: {1}{2}, а ви остават {3}.", "Remove {1}": "Премахнете {1}", "{1} of {2}: {3}": "{1} от {2}: {3}", "${1} a year, {2} credits for {3}": "{2} кредита за {3}, ${1} на година" },
  patterns: [[/^(\d+) credits$/, "$1 кредита"]],
});
it("translates a text, a piece of a sentence and a text with a changing part", () => {
  const missed: string[] = [], say = translator(catalog, (text) => missed.push(text));
  expect(say("Create video")).toBe("Създай видео");
  // The spaces that join it to its neighbours stay.
  expect(say(" credits left")).toBe(" оставащи кредита");
  expect(say("12 credits")).toBe("12 кредита");
  // Templates: the changing parts go where the translation puts them, and a "$" stays a "$".
  expect(say("Remove Fun facts")).toBe("Премахнете Fun facts");
  expect(say("2 of 6: Scary stories")).toBe("2 от 6: Scary stories");
  expect(say("$190 a year, 30 credits for Starter")).toBe("30 кредита за Starter, $190 на година");
  // English grammar glued to a word (the plural's "s") is not carried into the translation.
  expect(say("This needs 5 credits and you have 2 left.")).toBe("Нужни кредити: 5, а ви остават 2.");
  expect(say("This needs 1 credit and you have 0 left.")).toBe("Нужни кредити: 1, а ви остават 0.");
  // Without a translation the English stays, and is reported once it has words; numbers, codes and addresses are not.
  expect(say("Make it a series")).toBe("Make it a series");
  expect(say("1080 × 1920")).toBe("1080 × 1920");
  expect(say("hello@example.com")).toBe("hello@example.com");
  expect(say("constructor")).toBe("constructor");
  expect(missed).toEqual(["Make it a series"]);
});

it("leaves an element's props alone on Hookstreak", () => {
  const props = { children: ["Create video", 3], placeholder: "Search styles", title: "Create video" };
  expect(translateProps("button", props)).toBe(props);
  expect(translateProps("code", props)).toBe(props);
});

it("keeps the catalog's keys as the code writes them", () => {
  for (const [english, bulgarian] of Object.entries(bg.exact)) {
    expect(english, english).toBe(english.trim());
    expect(bulgarian.trim().length, english).toBeGreaterThan(0);
  }
});

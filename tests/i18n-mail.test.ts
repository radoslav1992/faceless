import { expect, it } from "vitest";
import { catalogOf, mailWords, translator } from "../shared/i18n";
import { bg } from "../shared/locales/bg";
import { IMMEDIATE_START_TEXT, WITHDRAWAL_DAYS } from "../shared/withdrawal";

// Реч БГ's e-mails (docs/SITES.md): sendMail translates the subject and each line. These are the e-mails as the
// server writes them (server/auth.ts, billing.ts, series.ts, notices.ts, calls.ts), with Реч БГ's name and prices
// in place: every line must come out in Bulgarian.
const say = translator(catalogOf(bg));
const bulgarian = (subject: string, text: string) => ({ subject: say(subject), text: text.split("\n").map(say).join("\n") });
/** Latin words left in a text, apart from names, addresses and the values the server fills in. */
const english = (text: string) =>
  (text.replace(/https?:\S+|\S+@\S+|YouTube|TikTok|Instagram|Stripe|GMT|Wed|Nov|Наука за котки|Ocean facts|@\w+/g, "").match(/[A-Za-z]{3,}/g) || []);
const site = "https://rechbg.com", name = "Реч БГ";

it("leaves Hookstreak's e-mails as they are", () => {
  expect(mailWords("Confirm your email — Hookstreak Shorts", "Hi,\n\nConfirm your email address with this link:")).toEqual({
    subject: "Confirm your email — Hookstreak Shorts", text: "Hi,\n\nConfirm your email address with this link:",
  });
});

it("writes the sign-up, password and existing-account e-mails in Bulgarian", () => {
  const verify = bulgarian(`Confirm your email — ${name}`, `Hi,\n\nConfirm your email address with this link:\n${site}/verify?token=abc\n\nIf you did not ask for this, you can ignore this email.\n${name}`);
  expect(verify.subject).toBe("Потвърдете имейла си — Реч БГ");
  expect(verify.text).toBe(`Здравейте,\n\nПотвърдете имейл адреса си чрез тази връзка:\n${site}/verify?token=abc\n\nАко не сте поискали това, просто пренебрегнете този имейл.\n${name}`);
  const reset = bulgarian(`Reset your password — ${name}`, `Hi,\n\nChoose a new password with this link:\n${site}/reset?token=abc\n\nIf you did not ask for this, you can ignore this email.\n${name}`);
  expect(english(reset.subject + reset.text)).toEqual([]);
  const existing = bulgarian(`Sign-up attempt with your email — ${name}`,
    `Hi,\n\nSomeone tried to create a new ${name} account with this email address, but it already has one.\n\nIf that was you, sign in at ${site}/login. Forgot your password? Choose a new one at ${site}/forgot.\n\nIf it wasn't you, there is nothing to do — your account has not changed.\n${name}`);
  expect(english(existing.subject + existing.text)).toEqual([]);
  expect(existing.text).toContain(`влезте на ${site}/login`);
});

it("confirms a plan in Bulgarian, with the consent given and the right of withdrawal", () => {
  const lines = (price: string, every: "year" | "month", contact: string) => [
    "Hi,", "",
    `This confirms your subscription to the Creator plan${price ? ` at ${price}, plus any tax shown at checkout` : ""}. ` + `It renews every ${every} until you cancel it in Billing.`,
    "", "When you ordered (Wed, 18 Nov 2026 14:00:00 GMT) you asked:", `"${IMMEDIATE_START_TEXT}"`, "",
    `Right of withdrawal: you can withdraw from this contract within ${WITHDRAWAL_DAYS} days of subscribing without giving a reason. ` +
      `Tell us ${contact}through ${site}/contact?topic=withdrawal. You can use the model withdrawal form at ${site}/terms#withdrawal-form. ` +
      "We refund within 14 days of your message what you paid, less the share of the plan you used.",
    "", `Terms of Service: ${site}/terms`, "Примерна фирма ЕООД, гр. София",
  ].join("\n");
  const monthly = bulgarian(`Your Creator plan — ${name}`, lines("€35 a month", "month", "by email to hello@rechbg.com or "));
  // The plan's name and the price are translated inside the sentence.
  expect(monthly.subject).toBe("Вашият план Създател — Реч БГ");
  expect(monthly.text).toContain("абонамента ви за план Създател на цена €35 на месец, с включен ДДС. Той се подновява всеки месец");
  expect(monthly.text).toContain("Съобщете ни по имейл на hello@rechbg.com или чрез https://rechbg.com/contact?topic=withdrawal.");
  expect(monthly.text).toContain("в срок от 14 дни");
  // The English consent sentence is only in this test: Реч БГ's own is Bulgarian (shared/withdrawal.ts).
  expect(english(monthly.text.replace(IMMEDIATE_START_TEXT, ""))).toEqual([]);
  const yearly = bulgarian(`Your Creator plan — ${name}`, lines("€350 a year", "year", ""));
  expect(yearly.text).toContain("на цена €350 на година, с включен ДДС. Той се подновява всяка година");
  expect(yearly.text).toContain("Съобщете ни чрез https://rechbg.com/contact?topic=withdrawal.");
  expect(english(yearly.text.replace(IMMEDIATE_START_TEXT, ""))).toEqual([]);
  expect(english(bulgarian("x", lines("", "month", "")).text.replace(IMMEDIATE_START_TEXT, "").replace("x", ""))).toEqual([]);
});

it("writes a series' notices in Bulgarian", () => {
  const sign = ["", `— ${name}`];
  const all = [
    bulgarian("“Наука за котки” is complete", ["Every episode of your series “Наука за котки” has been made, so it has stopped.", "",
      "The season is complete: its last episode has been made. To go on with the story, raise the number of episodes in Settings and resume.", "", `Open the series: ${site}/app/series/1`, ...sign].join("\n")),
    bulgarian("Your series “Наука за котки” skipped an episode", ["Skipped: not enough credits left. Add a credit pack or upgrade, and the next episode goes ahead.", "", `Open the series: ${site}/app/series/1`, ...sign].join("\n")),
    bulgarian("Your series “Наука за котки” skipped an episode", ["Paused: your free trial has ended. Choose a plan to keep the series going.", "", `Open the series: ${site}/app/series/1`, ...sign].join("\n")),
    bulgarian("Your series “Наука за котки” skipped an episode", ["Skipped: your storage is full. Delete some files or videos, or upgrade, and the next episode goes ahead.", "", `Open the series: ${site}/app/series/1`, ...sign].join("\n")),
    bulgarian("New episode of “Наука за котки”: your video", ["A new video of your series “Наука за котки” is ready.", "", "", "", "It's waiting for your review: approve it to post it, edit it, or reject it.", "", `Watch and edit it: ${site}/app/videos/1`, ...sign].join("\n")),
    bulgarian("New episode of “Наука за котки”: Защо котките мъркат", ["A new video of your series “Наука за котки” is ready.", "", "Защо котките мъркат", "", "It posts on 18.11.2026 г., 18:00 ч.. You can still edit it before then.", "", `Watch and edit it: ${site}/app/videos/1`, ...sign].join("\n")),
    bulgarian("New episode of “Наука за котки”: Защо котките мъркат", ["A new video of your series “Наука за котки” is ready.", "", "Защо котките мъркат", "", "It's ready to download or post.", "", `Watch and edit it: ${site}/app/videos/1`, ...sign].join("\n")),
    bulgarian("An episode of “Наука за котки” couldn't be made", ["This video couldn't be made.", "", `Try it again: ${site}/app/videos/1`, ...sign].join("\n")),
  ];
  for (const mail of all) expect(english(mail.subject + "\n" + mail.text), mail.subject).toEqual([]);
  expect(all[0].subject).toBe("„Наука за котки“ е завършена");
  expect(all[4].subject).toBe("Нов епизод на „Наука за котки“: вашето видео");
  expect(all[5].text).toContain("Ще бъде публикувано на 18.11.2026 г., 18:00 ч.. Дотогава");
});

it("writes the channel notices and the thanks for a call in Bulgarian", () => {
  const sign = ["", `— ${name}`];
  const reconnect = (series: string[], youtube: boolean) => bulgarian("Reconnect your YouTube channel “Ocean facts”", [
    `${name} can no longer post to your YouTube channel Ocean facts (@oceanfacts): its access expired or was withdrawn.`, "",
    series.length ? `Your series ${series.join(", ")} ${series.length === 1 ? "posts" : "post"} to it. New episodes are still made, but they are not posted there until you reconnect the channel.` : "Videos scheduled for it are not posted until you reconnect it.",
    ...(youtube ? ["", "A YouTube channel that is not reconnected within 14 days is removed, with its posts' YouTube links and stats."] : []),
    "", `Reconnect it: ${site}/app/channels`, ...sign,
  ].join("\n"));
  const one = reconnect(["“Наука за котки”"], true), many = reconnect(["“Наука за котки”", "“Ocean facts”"], false), none = reconnect([], false);
  for (const mail of [one, many, none]) expect(english(mail.subject + "\n" + mail.text), mail.text).toEqual([]);
  expect(one.text).toContain("Вашата поредица “Наука за котки” публикува в него.");
  expect(many.text).toContain("Вашите поредици “Наука за котки”, “Ocean facts” публикуват в него.");
  const failed = bulgarian("“Your video” wasn't posted to YouTube", ["Your video could not be posted to YouTube.", "", `Open the video to post it again: ${site}/app/videos/1`, ...sign].join("\n"));
  expect(failed.subject).toBe("„Вашето видео“ не беше публикувано в YouTube");
  expect(english(failed.text)).toEqual([]);
  const call = bulgarian("10 credits added — thanks for the call", ["Hi Радо,", "", `Thank you for talking with us. We've added 10 credits to your ${name} account.`, "What you told us goes straight into what we build next.", "", `— The ${name} team`].join("\n"));
  expect(call.subject).toBe("Добавени са 10 кредита — благодарим за разговора");
  expect(call.text).toBe("Здравейте, Радо,\n\nБлагодарим ви, че разговаряхте с нас. Добавихме 10 кредита към вашия профил в Реч БГ.\nТова, което ни казахте, отива направо в следващото, което ще създадем.\n\n— Екипът на Реч БГ");
});

<!-- Реч БГ's legal texts (src/public/legal-bg.ts): how they were made from the earlier Реч БГ site's texts, and what the owner or a lawyer still has to check. -->

# Notes on `legal-bg.ts` (Реч БГ: Общи условия, Политика за поверителност)

Sources:

- **Base (wording):** `(the earlier Реч БГ repository) src/Legal.tsx`, `legalContent` — "old terms / privacy / cookies / refunds" below.
- **Facts about the product:** `src/public/Legal.tsx` ("HS terms", "HS privacy"),
  `shared/plans.ts`, `shared/credits.ts`, `shared/withdrawal.ts`.
- Looked at only for vocabulary or to check a statement, never as a source of facts in the text:
  `shared/locales/bg.ts` (the app's Bulgarian names: „Плащане“, „Настройки“, „Канали“, „Клипове“, „Поредици“,
  „Печелете 30%“, „Сигнал за злоупотреба“, „Отказ от договора за моя план (14 дни)“), `shared/growth.ts`,
  `shared/social.ts`, `shared/brand.ts`, `docs/PRIVACY.md`, `src/public/LegalBg.tsx`, `src/public/Contact.tsx`.

Result: **terms 19 sections, privacy 10 sections.** 

## 0. For whoever wires the file in

- `src/public/LegalBg.tsx` imports `LEGAL_BG_UPDATED` and `summaries` from `./legal-bg`. The file was ordered with
  exactly three exports (`LegalSection`, `terms`, `privacy`), so those two are **not** in it. Suggested texts for
  `summaries` (they follow HS's "The short version" and say nothing the sections do not):
  - terms: „запазвате правата върху това, което подавате, и можете да използвате създадените видеа и с търговска
    цел. Вие отговаряте за видеата, които публикувате, включително за тези, които поредица публикува вместо вас —
    включете преглед, ако искате да виждате всяко предварително. Не използвайте Реч БГ, за да заблуждавате хората
    или да имитирате реални хора. Плановете са месечни или годишни и можете да спрете подновяването по всяко време.“
  - privacy: „използваме данните ви, за да създаваме и публикуваме вашите видеа, и за нищо друго. Не ги продаваме,
    не показваме реклами и не използваме проследяващи бисквитки. Можете да изтеглите видеата си и да изтриете
    профила си по всяко време.“
- The texts rely on three things the page does: the provider box at the top („имейлът, посочен в началото на тази
  страница“, „доставчикът, посочен в началото на тази страница“), the withdrawal form right under the section
  `withdrawal` („стандартния формуляр по-долу“), and the link to the contact form for abuse reports. `LegalBg.tsx`
  does all three. If the provider box is ever hidden (no `COMPANY_NAME`), those sentences point at nothing.
- Cross-references are by section title in „…“, never by number (the page numbers the sections). If a title
  changes, search the file for it. Titles referred to: „API ключове и MCP“, „Сигнали за незаконно съдържание и
  deepfake“, „Прекратяване и промени“, „Право на отказ“, „Възстановяване на плащане“, „Доставчици и получатели“,
  „Бисквитки: само необходимото“, „Хранилище на браузъра и вашият контрол“.
- The list of a section is shown after all its paragraphs, so a few sections end with a lead-in paragraph
  („Забранено е също:“, „При публикуването важи следното:“, „Сроковете са следните:“).
- The terms version recorded at sign-up (`TERMS_VERSION`), `AFFILIATE_TERMS_VERSION` and `IMMEDIATE_START_VERSION`
  should get the date these texts go live on Реч БГ.

## (a) Kept verbatim from the current Реч БГ

By a mechanical check, 71 of the 136 sentences of the old pages are in the new text word for word (old terms 8,
„Цени и абонаменти“, is not in that count: its tariffs were built from code). The rest were changed or dropped
for the reasons in (b).

Whole sections, word for word:

- Terms „Вашият профил“, first paragraph (old terms 2).
- Terms „Възстановяване на плащане“ (old refunds 5) — except „Тази политика не ограничава“ → „Тези правила не
  ограничават“ (it is no longer a page of its own).
- Terms „Приложимо право и спорове“ (old terms 11) — except the last sentence, which pointed to the refunds page
  and now names the two sections.

Sentences kept word for word inside adapted sections:

- „Услугата е за лица на 18 или повече години. Регистрацията изисква валиден имейл, парола и приемане на настоящите
  условия.“ (old terms 1)
- Old terms 3: „Можете да използвате … в лични и търговски проекти при спазване на приложимите права и закона.“
  (only „изтеглените записи“ → „създадените видеа“).
- Old terms 4: first sentence („Забранени са измами … множество профили.“) and the enforcement sentence („При
  установено нарушение … когато законът позволява“).
- Old terms 5: „Не премахвайте и не променяйте това обозначение …“, „Когато публикувате съдържание, което
  изобразява или имитира реални хора …“; the machine-readable-mark sentence with a new subject.
- Old terms 7 (reports, DSA): everything except the three changes listed in (b).
- Old terms 8: „Сумата се показва преди плащане.“, „Управлението на плащанията и фактурите е достъпно от профила.“,
  „Преди първото плащане изрично заявявате … започне веднага“, „не изисква банкова карта и не се превръща
  автоматично в платен“, „Клониране на глас е позволено само за собствения ви глас или с изричното съгласие на
  човека“ (moved to „Обозначаване на съдържание, създадено с ИИ“).
- Old terms 9: all five sentences (the last one moved to the end of the section).
- Old terms 10: all three sentences, unchanged; the notice period and the right to cancel are a new sentence.
- Old terms 12: all sentences („Абонамент“ → „Плащане“, the reference to the refunds page → „Право на отказ“);
  one new sentence (the accepted version is recorded).
- Old refunds 1 („Прекратяване на подновяването“): all three sentences (in the first, „Абонамент“ в профила →
  „Плащане“ в приложението); two new sentences after them.
- Old refunds 2 („Право на отказ“): all five sentences, unchanged; one new sentence says which topic to pick in
  the contact form.
- Old refunds 3 („Начало на услугата“): all sentences, with one change („месечно подновяване“ → „подновяване“,
  since plans can be yearly); new sentences around them (what the share is measured against, a yearly example,
  no further charges, credit packs). It is now paragraphs 2–4 of `withdrawal`, so that the form the page renders comes after
  everything about withdrawal.
- Old privacy 1: the trial-hash sentence and „Не съхраняваме пълни данни за банкови карти.“
- Old privacy 2: the legal bases (contract / legal obligation / legitimate interest with the right to object;
  the contract's examples are new, and „и измами“ and „отстраняване на грешки“ were added to the legitimate
  interests), the explicit-consent sentences for the cloned voice (only „Вашия образ и глас — снимката … и гласа,
  който клонирате —“ → „Гласа, който клонирате,“ and „аватара“ → „гласа“), „Лице или глас на друг човек можете да качите само с неговото
  изрично съгласие …“, „Данните за профила и плащането са необходими …“, „Не вземаме автоматизирани решения …“,
  „Не изпращаме маркетингови писма без отделно основание.“, „Администратор на личните данни е доставчикът …“.
- Old privacy 3: the transfers sentence (Data Privacy Framework or standard contractual clauses) and „Не продаваме
  личните ви данни.“
- Old privacy 4: „Сесиите изтичат до 30 дни. Линковете за потвърждение важат 24 часа, а тези за възстановяване —
  1 час.“, „Незавършените качвания се почистват след 24 часа.“, „Запитванията и сигналите се изтриват след 12
  месеца.“
- Old privacy 5: the sentence with the GDPR rights, „За допълнителни искания използвайте контактната форма.“, the
  КЗЛД sentence with its address.
- Old privacy 6: „Не включвайте чужди чувствителни данни в текстовете без подходящо основание.“
- Old cookies 2: „Платежните страници на Stripe могат да използват собствени необходими технологии за сигурност.“
- Old cookies 3: „Можете да изтриете бисквитките и хранилището … Ако добавим незадължителни технологии, ще
  предоставим отделен избор преди активирането им.“

## (b) Changed, removed, added — and what supports it

### Terms

| Section (id) | What | Support |
| --- | --- | --- |
| `service` | Product description replaced (was text-to-speech, audio conversations, talking avatars). Four new paragraphs: what a video is, Clips, series and API keys, changes to features. | HS terms "The service", all four paragraphs. The presenter half-sentence: HS privacy, processors table (HeyGen row) and `plans.ts` tariffs "On-screen presenter". |
| `account` | Second paragraph added: one person per account, keep the e-mail current, connect only your own channels. | HS terms "Your account". |
| `content` (old "Текстове и записи") | Title changed. „подадените текстове“ → topics, prompts, scripts, uploads. Examples of what the permission is for; it covers the videos made and ends on deletion (with the two exceptions). „качения портрет и съгласието на изобразения човек“ → the people, voices, music, pictures and footage in uploads. „Не гарантираме изключителност на синтетичните гласове“ → „…на резултатите — подобни резултати може да бъдат създадени и за други потребители“ (a cloned voice *is* the customer's alone, so the old wording would be wrong). | HS terms "Your content and ownership". |
| `acceptable-use` | Removed the „Създай с AI“ sentence (no such tool). „съдържание с непълнолетни“ → „съдържание, което представя непълнолетни по сексуализиран или вреден начин“ (the product makes kids' stories; a blanket ban would forbid the product's own templates). „съдържание със сексуален характер с реални лица“ → „…със сексуален характер“ (HS bans all sexual content). „(вижте т. 7)“ → section titles. Added a list of eight further prohibitions. | HS terms "Acceptable use", all bullets. |
| `ai-content` | First sentence rewritten (what AI makes). The mark is on „видеата с AI глас, AI картини или AI клипове“ instead of „файловете, които създавате“ (clips from the customer's own footage are not AI-made). Removed „Това важи и за преведени с дублаж и преозвучени видеа“. Added: platform disclosure (TikTok, YouTube; TikTok drafts); cloned voices. | HS terms "AI-generated content", paragraphs 2 and 3; "The service" paragraph 2 for clips. |
| `library` (old "Музикална библиотека и готови аватари") | Music → the whole library (music, background clips, pictures, sound effects). Added how missing sound effects are made, and that published videos may stay online. **Kept** the old ban on registering library content in Content ID and on using it in other libraries (HS does not have it). Avatars → „AI водещите на екрана“: the old restrictions are kept; **removed** „Готовите видео аватари … може да са създадени по образа на реални хора“ (HS does not say it) and reworded the last sentence accordingly. | HS terms "Library content". Presenters: HS privacy, processors table. See open questions 4 and 5. |
| `channels` | **New section.** Connecting accounts, what is read, TikTok drafts, the six rules, the platforms' own terms, and the YouTube Terms of Service sentence (Google requires it). The half-sentence „за всяка мрежа, щом публикуването в нея е отворено в приложението“ is added because `shared/brand.ts` and `shared/social.ts` say TikTok and Instagram are "coming soon". | HS terms "Connected social accounts", complete. |
| `api-keys` | **New section.** | HS terms "API keys and MCP", complete. |
| `reports` | Topic of the contact form: „Сигнал за злоупотреба или deepfake“ → „Сигнал за злоупотреба“ (the new form's label). „линк, име на файла или проекта“ → „линк, име на видеото или профила“. „Потвърждаваме получаването с номер на сигнала“ → „Потвърждаваме получаването на сигнала“: the new contact form gives no number. Split into three paragraphs. | `src/public/Contact.tsx` topics and its notice for abuse reports. HS terms only say "To report misuse, contact us", so the DSA procedure is the old Реч БГ text. See open question 6. |
| `plans` | Rewritten around the old sentences. Removed: 1 000 trial credits, the per-tool tariffs, „Всяка започната секунда или минута … цената се показва и потвърждава преди всяка заявка“ (series make episodes without a confirmation each time; HS does not promise it), the plans avatars were limited to, „Цената за видео е допълнителна към вече създаденото аудио“, „Изтриването на готов аватар не връща кредити“, „Неизползваните месечни кредити не се прехвърлят“ (now they do). Added: trial once per person and mailbox, watermark; monthly or yearly, paid in advance; Stripe; what credits pay for (no numbers); credits every month also on yearly billing; rollover with a cap; no cash value, end with the plan; plan change; credit packs; failed payments; 30 days' notice of a price change. No price, credit or trial number is in the text: all point to „Цени“ (/pricing). | HS terms "Free trial, plans and payment" (all sub-headings); `plans.ts` (limits per plan, `PRICE_NOTE`, packs for subscribers); `credits.ts` (what is charged, "per started …"). Euro and VAT included: the task, `shared/money.ts`. |
| `plans` | „резервираните за нея кредити се връщат автоматично“ → „Ако работата не успее по причина при нас, кредитите за нея се връщат“. | HS: "If work fails on our side, its credits are returned." (No "reserved", no "automatically".) |
| `cancellation` | Added the month-or-year clause and „Не възстановяваме суми за частично използван период, освен когато законът го изисква“. | HS terms "Cancelling". |
| `withdrawal` | Old "Право на отказ" + "Начало на услугата" merged. Added: the form topic; what the share is measured against on monthly and yearly plans; the yearly example (percentages only); „повече суми не се удържат“; credit packs are separate purchases. | HS terms "Your right to withdraw"; `withdrawal.ts`. |
| `failed-work` (old "Проблем с генерацията") | „запис“ → „видео или друга работа“; „името на проекта“ → „заглавието на видеото“. | HS terms "Credits", last sentence. |
| `affiliates` | **New section**, HS's four bullets translated. "$50" → „50 евро“; "without tax" → „без данъците (ДДС)“; "#ad or affiliate link" → „#реклама или „партньорски линк““. The menu name is the app's: „Печелете 30%“. | HS terms "Affiliate program"; `shared/growth.ts` (30%, 12 months, 30 days, 5000 cents). |
| `quality` | Added a paragraph: AI output can be wrong; responsibility for auto-posted episodes; turn on review; no promise of reach. | HS terms "AI-generated content" paragraph 1, "Disclaimers". |
| `termination` | Added: notice of changes by e-mail or in the app at least 30 days ahead, and the right to cancel before; deleting the account (ends the plan at once, no refund of the rest; ask to withdraw first); when we suspend or close an account, with reasons, a chance to respond and a refund of the unused part if the customer is not at fault. | HS terms "Changes to these terms", "Suspension and termination". |
| `contract` | „Абонамент“ → „Плащане“; added „записваме коя версия на условията сте приели“. | HS terms "Changes to these terms", last sentence. |

### Privacy

| Section (id) | What | Support |
| --- | --- | --- |
| `data` | The old one-sentence list became thirteen list items. Removed „текстове на проекти, качени снимки … гласови записи“, „краткотрайни хеширани идентификатори“ (HS names sign-in attempts and rate-limit counters, not hashes). | HS privacy "The data we process", every bullet. |
| `purposes` | Contract purposes rewritten for videos, series, API keys. Removed the avatar photo and „Създай с AI“. Added: fixing errors; the cloned voice is never used to identify anyone; framing clips only locates faces; affiliate programme and calls; service e-mails. | HS privacy "Why we use it"; "The data we process" (cloned voices); HS terms "The service" paragraph 2. |
| `processors` | List replaced. **Removed** (not in HS): „включително модели на Google и OpenAI“, the model makers behind fal.ai (Google, Kuaishou), WaveSpeedAI, HeyGen's translation/dubbing and custom avatars, the temporary ElevenLabs clone for dubbing, „Времената на думите се пазят със записа; локалният експорт се извършва във вашия браузър“. **Added:** Cloudflare's database and text model, fal.ai for pictures and clips, ElevenLabs' transcription, sound effects and cloned voices, HeyGen presenters and clips (its copy deleted once saved), the social networks, disclosure by law or on a sale of the business, „Не показваме реклами“. „Не използваме проектите ви за собствено обучение на модели“ → „…вашето съдържание…“: kept, see open question 9. | HS privacy "Who processes data for us" (table and the paragraph under it), "Who we are" ("we don't sell it, we don't show ads"). |
| `youtube` | **New section**, HS's text translated in full: two paragraphs, four bullets, the contact line. Names and URLs kept in English. | HS privacy "YouTube API Services". |
| `retention` | Replaced. Removed: 100 projects, 7/30/90/180 days of files per plan, 100 MB–20 GB and 300 files, product variants, saved images, „при първото включване в медийната библиотека“, dubbing parameters, „Резервни копия и ограничени технически логове могат да имат отделни срокове според доставчика“ (HS says nothing about backups or logs). Changed: unconfirmed sign-ups 7 → **30 days**; evidence records „до изтичане на давностния срок“ → **5 years**; trial hash „до 24 месеца след пробата“ → 24 months after it was last needed. Added: hourly clean-up, security data (one day), AI work details (30 days), failed publications (30 days), uploads that failed their check (7 days), cloned voices, affiliate records, what deleting the account removes, published videos stay on the networks. | HS privacy "How long we keep data", every bullet. |
| `rights` | Removed the description of the data export (the new app has none: videos are downloaded in the app). Added withdrawing consent and the one-month answer. | HS privacy "Your rights". |
| `security` | „хеширани пароли и сесии, както и проверка на собствеността при достъп до записи“ → hashed passwords and API keys, encrypted tokens, sign-in limits, need-to-know access. Removed „Изтриването на профила изисква повторно въвеждане на паролата и предварително прекратяване на активен абонамент“: deleting now ends the plan itself. Added the breach sentence. | HS privacy "Security"; HS terms "Suspension and termination". |
| `cookies` | Removed the cookie's name (`rech_session`) and its attributes (HttpOnly, SameSite=Lax, Secure): HS's text has neither. Added: lasts until log-out, no third-party pixels, no cookie banner, referral links set no cookie. | HS privacy "Cookies and local storage", paragraph 1. |
| `turnstile` (old "Защита на регистрацията") | „автоматизирани регистрации“ → „автоматизирани заявки … в нашите форми“. | HS privacy "Cookies and local storage", last sentence. |
| `browser-storage` (old "Вашият контрол") | „настройки на редакторите и запазени визии на субтитрите; те не се изпращат към нас“ → the four things the new app keeps, and the app's cached files. | HS privacy "Cookies and local storage", paragraph 2. |

## (c) Open questions — for the owner and a lawyer

Most important first.

1. **Legal basis for a cloned voice.** The old Реч БГ text is kept: explicit consent under Art. 9(2)(a) GDPR, „което
   давате при заявката“. In the new app the box the customer ticks is a statement about rights („Това е моят
   собствен глас или имам разрешението на говорещия …“), and HS calls it "your statement that the voice is yours to
   use", adding that the voice is "never used to identify anyone" (which reads as an argument that it is not
   biometric data at all). Either the box on Реч БГ must also ask for consent to the processing, or this paragraph
   of the privacy policy must change. The same paragraph keeps „Лице или глас на друг човек можете да качите само с
   неговото изрично съгласие“, which now also covers every guest in an uploaded podcast or interview.
2. **Credit packs and the right of withdrawal.** Neither text says whether a consumer can withdraw from a credit
   pack within 14 days, and the checkout request to start straight away is described only for plans. The text only
   says packs are separate purchases and that unused pack credits are taken back on a refund. Also to confirm:
   whether moving from monthly to yearly billing, or to a bigger plan, starts a new 14-day period.
3. **Minimum age.** Kept from the old Реч БГ: 18. HS says 16 "and old enough to enter into this agreement where you
   live", and its privacy policy has a "Children" section (16+) that has no Bulgarian counterpart. Nothing in the
   sign-up form asks for an age.
4. **AI presenters.** The old sentence that library avatars „може да са създадени по образа на реални хора“ was
   removed because HS does not state it, although the presenters are the same HeyGen avatars
   (`shared/presenter.ts`). The old usage limits (no adult, political, defamatory or misleading content; no implied
   endorsement) were kept and are stricter than HS's terms. Decide whether to restore the sentence and whether the
   political-content ban for presenters should stay.
5. **Library licence.** The ban on Content ID registration and on reuse in other libraries is the old Реч БГ's rule
   for its music. Check it against the licences of the music, clips and sound effects in the new library
   (`docs/SITES.md` lists the libraries as still to be set up).
6. **Abuse reports (DSA).** The text promises that receipt is confirmed, the reporter is told the decision and how
   to contest it, and the uploader gets reasons. The new contact form saves the message and e-mails the operator;
   it sends no acknowledgement and no number. This has to be done by hand, or built.
7. **КЗП's address.** „пл. „Славейков“ 4А, 1000 София“ is kept from the old text. КЗП may since have moved (ул.
   „Врабча“ 1): check on kzp.bg. КЗЛД's address is unchanged.
8. **Changes to the terms.** HS says that using the service after a change means accepting it. That sentence was
   not carried over; the Bulgarian text keeps „не променят със задна дата платен период“ and adds the 30 days'
   notice and the right to cancel. Check against чл. 147б ЗЗП (notice within 7 days, the consumer may leave or keep
   the old terms).
9. **„Не използваме вашето съдържание за собствено обучение на модели.“** Kept from the old text; HS has no such
   sentence, only "we use your data to make and publish your videos, and for nothing else". Confirm it is true for
   the new product, and whether the AI providers' terms allow the same to be said of them.
10. **Processors and transfers.** (a) The transfers sentence (Data Privacy Framework or standard contractual
    clauses) is the old one: confirm it for fal.ai, ElevenLabs and HeyGen. (b) Who runs the models behind fal.ai
    is no longer named. (c) Two recipients appear in the text but not in the list of providers, as in HS: the
    scheduling service for calls, and PayPal for affiliate payouts.
11. **Retention periods.** 5 years for the terms acceptance, the checkout request and withdrawals comes from HS.
    `docs/PRIVACY.md` notes that Bulgarian accounting law may ask for 10 years if these count as accounting
    records, and that credit pack purchases have no period in code yet.
12. **Affiliates.** (a) The minimum payout is written as „50 евро“ (HS: $50; the code holds 5000 cents). (b) „Вие
    отговаряте за данъците върху спечеленото“: for affiliates who are private persons a Bulgarian company may have
    its own duties (withholding, a statement of sums paid); ask the accountant. (c) Commission is counted on
    payments without VAT, while customers see prices with VAT.
13. **TikTok and Instagram.** The terms describe all three networks as HS does, with the proviso „щом публикуването
    в нея е отворено в приложението“. If Реч БГ launches with YouTube only, that is still accurate; if TikTok and
    Instagram will never be offered, shorten `channels`, the list item on platform rules and the processors list.
14. **What „Цени“ must show**, because the text sends readers there: the trial's length and credits, the rollover
    cap (HS's pricing FAQ says three months' worth), plan prices, pack prices, the credit tariffs, the 10-minute
    free transcription limit. Storage and upload limits per plan are shown only in the app.
15. **E-mails.** „Потвърждение на договора, включително тази заявка и указания за отказ, както и фактурите
    получавате по имейл“ is kept. `docs/SITES.md` lists the server's e-mails as still English and the Bulgarian
    Stripe checkout (language, tax and address) as still to set: both have to be done for this sentence, and for
    „Договорът се сключва на български език“, to hold.
16. **YouTube disclosure in Bulgarian.** Google's reviewers look for the Limited Use sentence. It is translated,
    with the policy's name and URL in English. If verification is refused, add the English sentence as well.
17. **Session cookie.** The text names no cookie. In code it is `hss_session` (`server/auth.ts`), not
    `rech_session`. The old text's HttpOnly / SameSite / Secure description can be restored once confirmed.
18. **Deleting the account.** `docs/PRIVACY.md` says deletion asks for the password and is refused while a video
    is being made or published. HS's legal text says neither, so the Bulgarian text does not.
19. **„Кредитите нямат парична стойност и спират, когато планът приключи“** is HS's rule. A lawyer should read it
    next to the withdrawal refund and the refund of the unused period when we close an account.
20. **Business customers.** HS has a clause for people who sign up for a company. The Bulgarian text has none (the
    old one had none); consumer rules are marked with „Ако сте потребител“ only in `withdrawal`.

## (d) In Hookstreak's English texts, with no counterpart in the Bulgarian result

Terms:

- **"About these terms"**: who the parties are (the page shows the provider), acceptance of the Privacy Policy by
  using the service, and acting for a company or organisation.
- **"Your account"**: "at least 16 years old" (the Bulgarian text says 18).
- **Every price and number** in "Free trial, plans and payment" and "Your right to withdraw": 7 days, 4 credits,
  the credit rates, 3 months of rollover, the 60- and 720-credit examples, "in US dollars", "taxes may be added"
  (replaced by euro with VAT included).
- **"Your content and ownership"**: the statement that the customer *owns* the outputs, and the "worldwide,
  non-exclusive licence" wording (the Bulgarian text keeps the old „ограничено разрешение“ and the right to use
  the videos commercially).
- **"Our service and brand"**: our rights in the software, design, name and logo; free use of feedback.
- **"Disclaimers"**: "as is" and "as available". Only "no promise of availability, accuracy or reach" was carried
  over, into `quality`.
- **"Limitation of liability"**: no liability for indirect loss, the cap (12 months' payments or 100 US dollars),
  and the customer covering our costs of third-party claims. Left out on purpose: the old Реч БГ terms have no such
  clauses, and under Bulgarian consumer law they need a lawyer's wording.
- **"Changes to these terms"**: "If you keep using the service after that, the new terms apply."
- **"Governing law and disputes"**: "the laws of the country where the operator is established" and the consumer's
  home courts — replaced by the old Bulgarian section (Bulgarian law, КЗП, conciliation commissions, court).
- **"Contact"**: the page's own closing line does this.

Privacy:

- **"Who we are"**: as a section (the controller sentence is in `purposes`, the provider box is the page's).
- **"International transfers"**: as a section; the old Bulgarian sentence in `processors` covers it. HS's "or an
  adequacy decision" is covered by the Data Privacy Framework wording.
- **"Children"** (16+) and **"Changes to this policy"**: not carried over; the old Реч БГ policy has neither.
- **"Your rights"**: "Depending on where you live" (the Bulgarian text states the GDPR rights outright).

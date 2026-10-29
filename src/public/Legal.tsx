import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { PRODUCT } from "../../shared/brand";
import { CLIP_CREDITS, CLIP_SECONDS, HIGHLIGHT_SECONDS_PER_CREDIT, NARRATION_SECONDS_PER_CREDIT, PICTURES_PER_CREDIT, SECONDS_PER_CREDIT, SPEECH_CREDIT_SECONDS } from "../../shared/credits";
import { planById, ROLLOVER_MONTHS, TRIAL_DAYS } from "../../shared/plans";
import { WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { publicPages } from "../../shared/seo";
import { usePublicConfig } from "./PublicLayout";
import "./public.css";

// Terms of Service and Privacy Policy.
// NOTE FOR THE OPERATOR: have these reviewed by a lawyer before launch (jurisdiction, consumer law, data protection).
// The "last updated" date is the terms version recorded with every sign-up (TERMS_VERSION in server/auth.ts): change
// both together, and the date in shared/seo.ts, whenever the text changes.

/** Who runs the service, from the site configuration (COMPANY_NAME, COMPANY_ADDRESS, CONTACT_EMAIL). */
type Operator = { name: ReactNode; address: string | null; contact: ReactNode; plain: string };
type Section = { id: string; title: string; body: ReactNode };

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

function terms(op: Operator): Section[] {
  const name = PRODUCT.name;
  return [
    {
      id: "about",
      title: "About these terms",
      body: (
        <>
          <p>
            These terms are an agreement between you and {op.name}
            {op.address ? `, ${op.address}` : ""} (“we”, “us”), who provides {name} (the “service”). By creating an account or using the service you
            accept these terms and our <Link to="/privacy">Privacy Policy</Link>.
          </p>
          <p>
            If you use {name} for a company or another organisation, you accept these terms on its behalf and confirm that you are allowed to do so. In that
            case “you” means that organisation as well as you.
          </p>
        </>
      ),
    },
    {
      id: "service",
      title: "The service",
      body: (
        <>
          <p>
            {name} makes faceless short vertical videos. AI writes the script, an AI voice narrates it, the scenes get AI pictures — and, if you choose,
            short AI video clips — and the video is finished with word-by-word subtitles, transitions and background music from our library. You
            can make narrated stories and facts in an art style of your choice, POV videos, mashup (“brainrot”) videos, videos from your own script, and
            storytime videos (a title card, then the story narrated over a looping background clip from our library or your own upload). You can also use
            your own pictures, video clips and narration recording.
          </p>
          <p>
            With Clips you can upload your own longer videos — a podcast, interview, stream or webinar — or import them from a link to the file. We
            transcribe what is said in them, an AI picks and scores moments that could work as short videos (a score is an estimate, never a promise
            of views), and the moments you choose become vertical clips: cut from your video, framed on the people in it, with captions. To frame a
            clip we find the faces in it and see whose lips move while someone talks; this only locates people in the picture — we never recognise who
            they are. Clips are made from your own footage; nothing in them is AI-generated.
          </p>
          <p>
            You can make videos one at a time, edit them, download them, and post them straight away or schedule them. A series (“autopilot”) uses the
            template, voice, language, art style, length and posting schedule you choose: a new episode is written and made ahead of each slot and posted
            automatically to the accounts you pick, or waits for your approval if you turn review on. With personal API keys, AI assistants and your own
            scripts can also make and fetch your videos (see <a href="#api-keys">API keys and MCP</a>).
          </p>
          <p>
            We keep improving {name}, so features may change. If we remove a major feature of a paid plan, we will tell you in advance where we reasonably can.
            Parts of the service depend on other companies (for example AI providers and the social networks), and their services can change or be
            unavailable.
          </p>
        </>
      ),
    },
    {
      id: "account",
      title: "Your account",
      body: (
        <ul>
          <li>You must be at least 16 years old, and old enough to enter into this agreement where you live.</li>
          <li>Give us accurate details and keep your email address up to date; we use it for important messages about your account.</li>
          <li>
            Keep your password secret. You are responsible for what happens in your account. Tell us straight away if you think someone else has access to it.
          </li>
          <li>An account is for one person. Only connect social accounts that you own or are allowed to post to.</li>
        </ul>
      ),
    },
    {
      id: "plans",
      title: "Free trial, plans and payment",
      body: (
        <>
          <h3>Free trial</h3>
          <p>
            New accounts start with a free trial of {TRIAL_DAYS} days with {planById("free").credits} credits. You don't need to give payment details. The
            trial is available once per person and email mailbox; we may decline a trial that we believe is being repeated. Videos made during the trial
            carry a small {name} watermark and stay in your account.
          </p>
          <h3>Paid plans</h3>
          <p>
            Paid plans are subscriptions billed in advance, monthly or yearly, in US dollars through our payment provider Stripe. Prices are shown on the{" "}
            <Link to="/pricing">pricing page</Link> and at checkout; taxes may be added where they apply. Your subscription renews automatically at the end of
            each month or year until you cancel it.
          </p>
          <h3>Cancelling</h3>
          <p>
            You can cancel at any time from Billing in the app. Your plan keeps working until the end of the month or year you have paid for and then is not
            renewed. We don't refund partly used periods, except where the law requires it — such as a withdrawal within {WITHDRAWAL_DAYS} days (see{" "}
            <a href="#withdrawal">Your right to withdraw</a>). If a payment is refunded in full or disputed, the paid plan ends at once.
          </p>
          <h3>Credits</h3>
          <p>
            Credits pay for the AI work in your videos. Each plan adds its credits every month, also when it is billed yearly. A new video costs 1 credit
            per started {SECONDS_PER_CREDIT} seconds, with its script, narration and pictures included. Bringing a scene to life as a short AI clip costs{" "}
            {CLIP_CREDITS.regular} credit per {CLIP_SECONDS} seconds of clip, or {CLIP_CREDITS.high} credits in high quality. In a video already made, new narration costs 1 credit per started{" "}
            {NARRATION_SECONDS_PER_CREDIT} seconds (your own recording is free) and new pictures 1 credit for every {PICTURES_PER_CREDIT} pictures or part of that;
            changes to text, subtitles, music and timing are free. A clip of one of your videos costs 1 credit per started{" "}
            {HIGHLIGHT_SECONDS_PER_CREDIT} seconds of it, and editing it is free unless you move it mostly onto other footage. Videos up to 10 minutes
            are transcribed for free; transcribing a longer one costs 1 credit per started {SPEECH_CREDIT_SECONDS / 60} minutes of it. The{" "}
            <Link to="/pricing">pricing page</Link> shows the current rates. If work fails on our side, its credits are returned.
          </p>
          <p>
            Unused credits roll over from month to month while your plan runs, up to {ROLLOVER_MONTHS} months' worth of your plan's credits plus the credit
            packs you bought. Credits have no cash value and end when your plan ends. If you change plans during a month, your credits for that month are
            adjusted.
          </p>
          <h3>Credit packs</h3>
          <p>
            While you have a paid plan, you can buy one-time credit packs at the prices shown on the pricing page and in the app. Their credits are added
            once the payment has gone through, and roll over in the same way as your plan's credits. If the payment for a credit pack is refunded, the
            pack's credits that are still unused are taken back.
          </p>
          <h3>Late payments and price changes</h3>
          <p>
            If a payment fails, Stripe will try again and we may limit paid features until it succeeds. We will tell you at least 30 days before a price
            change applies to your subscription, and you can cancel before it does.
          </p>
        </>
      ),
    },
    {
      id: "withdrawal",
      title: "Your right to withdraw",
      body: (
        <>
          <p>
            If you are a consumer, you can withdraw from a paid plan within {WITHDRAWAL_DAYS} days of subscribing, without giving a reason. The right
            applies to the start of the contract, not to each renewal.
          </p>
          <h3>How to withdraw</h3>
          <p>
            Tell us clearly that you withdraw: use our <Link to="/contact?topic=withdrawal">contact form</Link> with the topic “Withdraw from my plan”, or
            write to us, from your account's email or mentioning it. You can use the model form below, but you don't have to. It is enough to send your
            message before the {WITHDRAWAL_DAYS} days are over.
          </p>
          <h3>Starting straight away</h3>
          <p>
            A paid plan starts within the {WITHDRAWAL_DAYS} days only at your express request: before payment you confirm that you want it to start
            straight away, so you can use its credits during the withdrawal period, and that if you withdraw in that period you get back what you paid less
            the share of the plan's credits you used. We confirm this request by email after payment.
          </p>
          <h3>What you get back</h3>
          <p>
            What you paid for the plan, less the share of the paid period's credits that you used — for a monthly plan, the month's credits; for a yearly
            plan, the year's credits (twelve months' worth). For example, if your monthly plan gives 60 credits and you used 15 of them (25%), you get back
            75% of what you paid; on a yearly plan with 720 credits for the year, using 72 of them (10%) means you get back 90%. If you used nothing, you
            get back everything. We refund within 14 days of receiving your withdrawal, to the payment method you used. Your plan ends at once: there are no
            further charges, and its remaining credits stop. The refund is worked out from your payments for the plan; credit packs are separate purchases.
          </p>
          <section id="withdrawal-form" className="model-form" aria-labelledby="withdrawal-form-title">
            <h3 id="withdrawal-form-title">Model withdrawal form</h3>
            <p className="small">(Complete and return this form only if you wish to withdraw from the contract.)</p>
            <ul>
              <li>To: {op.plain}</li>
              <li>I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract for the provision of the following service: the {PRODUCT.name} … plan</li>
              <li>Ordered on (*) / received on (*): …</li>
              <li>Name of consumer(s) and the account's email: …</li>
              <li>Address of consumer(s): …</li>
              <li>Signature of consumer(s) (only if this form is notified on paper): …</li>
              <li>Date: …</li>
            </ul>
            <p className="small">(*) Delete as appropriate.</p>
          </section>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>You are responsible for what you create and publish with {name}. You must not use it to:</p>
          <ul>
            <li>
              impersonate any person or organisation, imitate a real person's voice or likeness, or suggest an endorsement or affiliation that doesn't
              exist;
            </li>
            <li>
              present AI-made pictures, clips or narration as real footage or real events in a way that misleads people — such as made-up news, invented
              quotes from real people, fake testimonials or reviews, or misleading election content;
            </li>
            <li>make sexual content, content involving minors in any sexualised or harmful way, or content that is hateful, harassing, violent or threatening;</li>
            <li>make illegal or defamatory content, or false or misleading claims about products, health, money or politics;</li>
            <li>
              upload, import or use pictures, footage, music or recordings that you don't have the rights to, or otherwise infringe anyone's copyright,
              trademark, privacy or other rights;
            </li>
            <li>send spam, or break the rules of TikTok, Instagram, YouTube or any other platform you publish to;</li>
            <li>
              disrupt or attack the service, get around its limits or security checks, scrape it, resell it without our permission, or use it to build a
              competing product.
            </li>
          </ul>
          <p>
            We may remove content or suspend accounts that break these rules (see <a href="#termination">Suspension and termination</a>). To report misuse,{" "}
            {op.contact}.
          </p>
        </>
      ),
    },
    {
      id: "ai-content",
      title: "AI-generated content",
      body: (
        <>
          <p>
            {name} uses AI to write scripts, titles and captions and to make pictures, video clips and narration. AI output can be wrong, out of date,
            similar to other people's output, or unsuitable for your audience. <strong>You are responsible for the videos you publish</strong>, including
            the episodes a series posts for you automatically. Check facts, names, claims and spelling, and turn on review for a series if you want to
            approve each episode before it posts.
          </p>
          <p>
            Videos with an AI voice, AI pictures or AI clips are marked as AI-generated in their file metadata. When we publish such a video to a platform
            that offers an AI-content disclosure through its API (currently TikTok and YouTube), we switch it on. A TikTok draft can't carry it: turn on
            TikTok's AI-generated content label when you post it. Where a platform or the law asks you to label AI content yourself, you must do so.
            Don't remove or hide these markers to make AI content look real.
          </p>
        </>
      ),
    },
    {
      id: "social-accounts",
      title: "Connected social accounts",
      body: (
        <>
          <p>
            You can connect TikTok, YouTube and Instagram accounts through each platform's own sign-in. By connecting an account you allow us to publish
            videos to it on your behalf and to read the details needed for that: the account's name, handle and picture, the status of the videos we
            published, and the views, likes, comments, shares and saves the platform reports for them. Until TikTok approves our app for posting
            directly, we send videos to your TikTok inbox as drafts instead, and you post them yourself in the TikTok app.
          </p>
          <ul>
            <li>
              We only publish videos that you post or schedule yourself, and the episodes of a series that you set to post to that account — automatically,
              or once you approve them when review is on.
            </li>
            <li>
              On YouTube, and on TikTok when we post there directly, you can choose to post privately, so that only the account can see the video. For a
              TikTok draft, you choose who can see it when you post it.
            </li>
            <li>
              YouTube asks every creator whether their videos are made for kids. You answer it for each video you post to YouTube, and once for the
              episodes of a series; we never answer it for you.
            </li>
            <li>You can cancel or move a scheduled post until it starts publishing.</li>
            <li>The access tokens the platforms give us are stored encrypted and used only to provide the service.</li>
            <li>
              You can disconnect an account at any time in the app or in the platform's own settings. Disconnecting it in the app cancels the posts still
              scheduled to it.
            </li>
          </ul>
          <p>
            Each platform's own terms apply to what you publish there. The platforms decide on reach, moderation and account status; we are not responsible
            for their decisions or for posts they reject, delay or remove.
          </p>
          <p>
            Our YouTube features use YouTube API Services. By connecting a YouTube channel or using {name} to post to YouTube, you agree to be bound by
            the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a>.
          </p>
        </>
      ),
    },
    {
      id: "api-keys",
      title: "API keys and MCP",
      body: (
        <p>
          In Settings you can create personal API keys for our REST API and MCP server, so that AI assistants or your own scripts can make and fetch your
          videos with your credits. A key acts as you, and these terms apply to everything done with it. Keep your keys secret — don't share them or put
          them in public code — because you are responsible for what is done with your keys. If a key leaks, delete it in Settings straight away: it stops
          working at once.
        </p>
      ),
    },
    {
      id: "affiliates",
      title: "Affiliate program",
      body: (
        <>
          <p>
            You can join our affiliate program from “Earn 30%” in the app. These terms apply to it, in addition to the rest of these Terms.
          </p>
          <ul>
            <li>
              <strong>What you earn:</strong> 30% of what each customer who signed up with your code pays us for plans and credit packs, without tax, for 12
              months from their first payment. Someone who already had an account, or who removes your code at sign-up, isn't your customer.
            </li>
            <li>
              <strong>When it's paid:</strong> each commission is held for 30 days. A refund or chargeback lowers it or cancels it; if it was already paid out,
              we take the difference from your next payout. We pay available balances of $50 or more by PayPal, to the address you give us, once a month.
            </li>
            <li>
              <strong>What's not allowed:</strong> referring yourself or your own other accounts; spam or unsolicited messages; ads that bid on our name or
              pretend to be us; promising earnings, views or monetization; and misleading claims about {name}. Say that you earn a commission where the law
              or the platform asks you to (for example #ad or "affiliate link").
            </li>
            <li>
              <strong>Our part:</strong> we may pause an affiliate account, and keep commissions earned against these rules. Commissions are earned only
              while your account exists: deleting it forfeits any balance not yet paid out. You are responsible for any taxes on what you earn. We may change
              the program with 30 days' notice; what you earned before a change stays as agreed.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "ownership",
      title: "Your content and ownership",
      body: (
        <>
          <p>
            You keep all rights to what you put into {name} — your topics, prompts and scripts, and the pictures, video clips and recordings you upload
            (“inputs”). As between you and us, you also own the videos, scripts, pictures, clips and narration the service makes for you (“outputs”), and you
            may use them commercially. In some countries purely AI-generated material may not be protected by copyright, and similar outputs may be made for
            other users.
          </p>
          <p>
            You give us a worldwide, non-exclusive licence to host, copy, process, change the format of and publish your inputs and outputs only as needed to
            run the service for you — for example to render videos, send work to our AI providers, and publish to the accounts you connect. The licence ends
            when you delete the content or your account, except for videos already published on other platforms and copies we must keep by law.
          </p>
          <p>
            You confirm that you have the rights needed for your inputs, including for any people, voices, music, pictures or footage in your uploads.
          </p>
        </>
      ),
    },
    {
      id: "library",
      title: "Library content",
      body: (
        <p>
          {name} includes a library of background music and background video clips. You may use library items in videos made with the service and publish
          those videos on social networks and elsewhere, including for commercial purposes. You may not extract, download, sell or share library items on
          their own, or use them outside videos made with {name}. Videos you published while your account was active may stay online after you stop using{" "}
          {name}.
        </p>
      ),
    },
    {
      id: "our-rights",
      title: "Our service and brand",
      body: (
        <p>
          The service, its software, design, templates and the {name} name and logo belong to us or our licensors. These terms don't give you any rights to
          them except to use the service as described here. If you send us feedback or ideas, we may use them without any obligation to you.
        </p>
      ),
    },
    {
      id: "termination",
      title: "Suspension and termination",
      body: (
        <>
          <p>
            You can stop using {name} at any time and delete your account in Settings. Deleting your account cancels any paid plan at once, without a refund
            of the rest of the period, and deletes your data as described in the <Link to="/privacy">Privacy Policy</Link>; download anything you want to
            keep first. To withdraw within {WITHDRAWAL_DAYS} days with a refund, contact us before you delete your account.
          </p>
          <p>
            We may suspend or close your account, or remove content, if you seriously or repeatedly break these terms, if you don't pay, if the law or a
            platform requires it, or if your use puts other people or the service at risk. Unless the law or the situation prevents it, we will tell you
            why and give you a chance to respond. If we close your account without you being at fault, we will refund the unused part of your current
            billing period.
          </p>
        </>
      ),
    },
    {
      id: "disclaimers",
      title: "Disclaimers",
      body: (
        <p>
          We work hard to keep {name} running well, but we provide it “as is” and “as available”. We don't promise that it will always be available or free of
          errors, that AI output will be accurate, or that your videos will reach a particular number of people or bring particular results. Nothing in these
          terms limits rights you have under consumer protection laws that cannot be excluded.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <>
          <p>
            To the extent the law allows, we are not liable for indirect or consequential losses, such as lost profits, revenue, followers, data or goodwill,
            or for the decisions of social networks. Our total liability for all claims relating to the service is limited to the greater of the amounts you
            paid us in the 12 months before the claim arose and 100 US dollars.
          </p>
          <p>
            These limits don't apply to liability that cannot be limited by law, such as for death or personal injury caused by negligence, or for fraud.
          </p>
          <p>
            If someone makes a claim against us because of content you created or published with {name}, or because you broke these terms, you will cover our
            reasonable costs of dealing with that claim, to the extent the law allows.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms, for example when we add features or the law changes. For important changes we will tell you by email or in the app at
          least 30 days before they apply. If you keep using {name} after that, the new terms apply; if you don't agree, you can cancel and delete your account
          before then. We record which version of the terms you accepted.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: (
        <p>
          These terms are governed by the laws of the country where the operator is established. If you are a consumer, you also keep the protection of the
          mandatory laws of the country where you live and can bring claims in your local courts. Please contact us first — most problems can be solved
          quickly.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms? Please {op.contact}.
        </p>
      ),
    },
  ];
}

function privacy(op: Operator): Section[] {
  const name = PRODUCT.name;
  return [
    {
      id: "who",
      title: "Who we are",
      body: (
        <>
          <p>
            {name} is provided by {op.name}
            {op.address ? `, ${op.address}` : ""} (“we”, “us”). We are responsible (the “controller”) for the personal data described here. This policy
            explains what we collect, why, who helps us process it, and the choices you have.
          </p>
          <p>
            In short: we use your data to run {name} for you. We don't sell it, we don't show ads, and we don't use advertising or analytics trackers.
          </p>
        </>
      ),
    },
    {
      id: "data",
      title: "The data we process",
      body: (
        <ul>
          <li>
            <strong>Account:</strong> your name, email address, a securely hashed version of your password (never the password itself), whether you confirmed
            your email, and when you accepted our terms.
          </li>
          <li>
            <strong>Series:</strong> each series' name and template, the topic or prompt you give it, its voice, language, art style, music, length,
            posting schedule and the accounts it posts to, and your choices such as review and email notices.
          </li>
          <li>
            <strong>Uploads:</strong> pictures, videos and audio you upload, such as your own narration recording or a long video you make clips from
            (or import from a link: we keep the link only until the video is downloaded);
            for uploads with speech, the words and their timings, when each speaker talks (speakers are numbered, never identified) and sounds such as
            laughter or applause; and for videos you find clips in, the moments found (their times, titles, scores and suggested post text) and where
            the people in a clip appear in the picture and which of them is talking.
          </li>
          <li>
            <strong>Generated content:</strong> scripts, titles, captions, scene descriptions, AI pictures and clips, narration, subtitles and finished
            videos, your edits, and whether you approved or rejected a video.
          </li>
          <li>
            <strong>Connected social accounts:</strong> access tokens (stored encrypted), the account's name, ID, handle and picture, and information about
            videos we publish for you (schedule, whether posted privately, status, links, error messages, and the views, likes, comments, shares and saves
            the network reports for them).
          </li>
          <li>
            <strong>API keys:</strong> only a hash of each key (never the key itself), with its name, its prefix (the first few characters, so you can tell
            keys apart), when it was created and when it was last used.
          </li>
          <li>
            <strong>Billing:</strong> your plan, subscription status, invoices, the credit packs you buy and the credits you use. Card details are collected
            and stored by Stripe; we never see your full card number.
          </li>
          <li>
            <strong>Contract records:</strong> your request at checkout for the plan to start straight away (its time and wording), and any withdrawal (the
            amounts paid and refunded, the credits used, and the dates).
          </li>
          <li>
            <strong>Referrals and affiliates:</strong> if you sign up with an affiliate's referral code, which affiliate referred you (they never see your
            name or email: only counts and the commissions your payments earn them). If you're an affiliate, your code, your payout email, the number of
            visits through your link (counted without cookies), your commissions and payouts.
          </li>
          <li>
            <strong>Calls with us:</strong> if you book a call for credits, that you booked it, our notes from the call and the credits added. You book it on
            a scheduling service's page, which receives what you enter there.
          </li>
          <li>
            <strong>Messages:</strong> what you send us through the contact form or by email.
          </li>
          <li>
            <strong>Technical and security data:</strong> IP address, browser details, timestamps, sign-in attempts, rate-limit counters, security check results
            and error reports.
          </li>
        </ul>
      ),
    },
    {
      id: "use",
      title: "Why we use it",
      body: (
        <>
          <ul>
            <li>
              <strong>To provide the service</strong> you signed up for — making, storing and publishing your videos, running your series, answering requests
              made with your API keys, billing and support (necessary to perform our contract with you).
            </li>
            <li>
              <strong>To keep {name} safe</strong> — preventing abuse, fraud and repeated free trials, securing accounts and fixing errors (our legitimate
              interests).
            </li>
            <li>
              <strong>To send service emails</strong> — confirming your email, password resets, security alerts, notices about your series' episodes (which
              you can switch off for each series) and important changes. We don't send marketing emails without your consent.
            </li>
            <li>
              <strong>To run the affiliate program</strong> — crediting the affiliate who referred a customer and paying them (our contract with the
              affiliate, and our legitimate interest in knowing who brought a customer), and to learn from calls you book with us (your request).
            </li>
            <li>
              <strong>To meet legal obligations</strong> — such as tax and accounting records.
            </li>
          </ul>
          <p>We don't use your data to make decisions about you that have legal or similarly significant effects.</p>
        </>
      ),
    },
    {
      id: "processors",
      title: "Who processes data for us",
      body: (
        <>
          <p>We share data only with providers that help us run {name}, and only what each needs for its job:</p>
          <div className="table-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">What for</th>
                  <th scope="col">Data involved</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Cloudflare</th>
                  <td>Hosting, database, file storage, email sending, the AI text model that writes scripts, titles and captions and finds moments for clips, and Turnstile security checks</td>
                  <td>All service data; your topics, prompts and scripts for writing; the transcripts of videos you find clips in; technical data for security checks</td>
                </tr>
                <tr>
                  <th scope="row">Stripe</th>
                  <td>Payments and invoices</td>
                  <td>Name, email, payment details, plan and billing history</td>
                </tr>
                <tr>
                  <th scope="row">fal.ai</th>
                  <td>AI pictures and AI video clips</td>
                  <td>The scene descriptions (prompts) and any picture a clip starts from</td>
                </tr>
                <tr>
                  <th scope="row">ElevenLabs</th>
                  <td>AI narration, word timings for subtitles, and transcription</td>
                  <td>The narration text, and audio whose words are timed or transcribed — the AI narration, or a recording or video with sound that you upload</td>
                </tr>
                <tr>
                  <th scope="row">HeyGen</th>
                  <td>AI presenters that speak your video's narration on camera — only when you add a presenter</td>
                  <td>The AI narration of that video (HeyGen deletes its copy of the presenter video once we have saved it)</td>
                </tr>
                <tr>
                  <th scope="row">TikTok, Meta (Instagram), Google (YouTube)</th>
                  <td>Publishing your videos and reading their stats — only when you connect an account</td>
                  <td>The videos you post, their titles and captions, and the account tokens</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            These providers process data under their own security and privacy commitments. We may also disclose data when the law requires it, to protect
            people's safety or our rights, or to a buyer if our business is sold (you will be told first, and this policy will keep applying).
          </p>
        </>
      ),
    },
    {
      id: "youtube",
      title: "YouTube API Services",
      body: (
        <>
          <p>
            {name} uses YouTube API Services when you connect a YouTube channel. Google's handling of your data is described in the{" "}
            <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google Privacy Policy</a>.
          </p>
          <p>
            {name}'s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>,
            including the Limited Use requirements.
          </p>
          <ul>
            <li>
              <strong>What we access:</strong> when you connect, your channel's ID, name, handle and picture, read again every week while it stays
              connected (which also checks that you still allow our access); then we upload the videos you post or schedule to it, with their titles,
              descriptions and your answer to whether they are made for kids, and read the views, likes and comment counts of those videos: often in their
              first 30 days, then weekly while the channel stays connected. We never download videos from YouTube.
            </li>
            <li>
              <strong>What we store and why:</strong> the access tokens (encrypted), the channel's details and, for each video we post, its YouTube ID,
              link, status and those counts — to post for you and to show you how your videos do. We use this data only to provide {name} to you, and
              keep it only while we can refresh it: a video's YouTube ID, link and counts that could not be refreshed for 30 days (for example because the
              video was deleted on YouTube) are deleted.
            </li>
            <li>
              <strong>Who we share it with:</strong> Google, to post your videos, and the providers that host {name} (see above). We don't sell it, don't
              use it for advertising, and don't let third parties serve ads through {name}. The cookie and browser storage we use are described under
              “Cookies and local storage” below.
            </li>
            <li>
              <strong>How to remove our access:</strong> disconnect the channel on the Channels page, or delete your account. We then delete its tokens
              and the YouTube data of the videos we posted (their YouTube IDs, links and counts, and the channel's name), and ask Google to revoke our
              access; your posting history keeps only that a video was posted. You can also revoke it at any time in your{" "}
              <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google account's security settings</a>;
              the channel then shows as needing to be connected again, and if you don't reconnect it within 14 days we remove it and its YouTube data
              the same way.
            </li>
          </ul>
          <p>Questions about how we use your YouTube data? Please {op.contact}.</p>
        </>
      ),
    },
    {
      id: "transfers",
      title: "International transfers",
      body: (
        <p>
          Our providers operate worldwide, so your data may be processed outside the country where you live, including in the United States. Where data
          protection law requires it, we rely on safeguards such as the European Commission's standard contractual clauses or an adequacy decision.
        </p>
      ),
    },
    {
      id: "retention",
      title: "How long we keep data",
      body: (
        <>
          <p>We keep data only as long as we need it. Our maintenance job removes what has expired every hour.</p>
          <ul>
            <li>
              Account and content data (series, videos, uploads, connected accounts and API keys): for as long as you have an account. You can delete
              videos, series, uploads and API keys, and disconnect accounts, at any time.
            </li>
            <li>Sessions: up to 30 days. Email confirmation links: 24 hours; password reset links: 1 hour.</li>
            <li>Accounts whose email address was never confirmed: deleted with everything in them after 30 days.</li>
            <li>Security data such as sign-in attempts and rate-limit counters: until their time window ends, at most a day.</li>
            <li>
              Details of AI work — the AI providers' request references, temporary file links and working copies of the narration's word timings: 30 days
              after the work finished. What was made, including each video's script and scene descriptions, stays in your account until you delete it.
            </li>
            <li>Failed or cancelled publications: the temporary media link and the network's request reference go after 30 days; the record stays.</li>
            <li>Uploads that failed their check: 7 days. Unfinished uploads: 1 day.</li>
            <li>Contact messages: 12 months.</li>
            <li>
              Free trial: a keyed one-way hash of your mailbox with the trial usage, so the trial can't be restarted with the same mailbox — 24 months after
              it was last needed (the trial or a sign-in), also after your account is deleted. Not your email address itself.
            </li>
            <li>
              Your acceptance of the terms and your request at checkout to start straight away: while you have an account and 5 years after it is deleted,
              as evidence of the contract. Withdrawals: 5 years.
            </li>
            <li>Billing records: as long as tax and accounting law requires. Stripe keeps its own records under its policies.</li>
            <li>
              Referrals, commissions and call notes: while you have an account. Payouts to affiliates (amount, date, the PayPal address paid to): as long as
              accounting law requires, also after the affiliate's account is deleted.
            </li>
            <li>
              When you delete your account (Settings › Delete account), we cancel any paid plan and delete your account, series, videos, uploads, social
              connections and API keys straight away; stored files are removed by our clean-up job shortly after. Only the records named above are kept.
            </li>
            <li>Videos you published stay on the social networks until you remove them there.</li>
          </ul>
        </>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>Depending on where you live, you can ask us to:</p>
          <ul>
            <li>give you a copy of your personal data (access), and download your content in a portable format (export);</li>
            <li>correct data that is wrong;</li>
            <li>delete your data — you can delete your account yourself in Settings;</li>
            <li>restrict or object to some processing, such as processing based on our legitimate interests;</li>
            <li>withdraw consent where we rely on it.</li>
          </ul>
          <p>
            You can download your videos from the app at any time. For anything else, {op.contact}; we answer within one month. You can also complain to your
            data protection authority.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and local storage",
      body: (
        <>
          <p>
            We use a single cookie: a session cookie that keeps you signed in (it lasts up to 30 days, or until you log out). We don't use advertising
            cookies, analytics trackers or third-party pixels, so there is no cookie banner. Referral links don't set cookies either: the code stays in the
            page's address and memory until you sign up, where you see it and can remove it.
          </p>
          <p>
            The app also keeps a few things in your browser's storage: whether the sidebar is collapsed; a draft from the “try it” demo on our home page, so
            it can be carried into the app after you sign up; the new-series wizard's answers while you connect a channel (only for that browser session);
            and a marker that lets the app reload once after we release an update (also only for that session). The app also keeps a copy of its own
            files (code, icons, fonts and an offline page) in your browser's cache, so it opens quickly and can be installed; your videos, files and
            account details are never kept there. Cloudflare Turnstile may run a short check in your browser to tell people from bots on our forms.
          </p>
        </>
      ),
    },
    {
      id: "security",
      title: "Security",
      body: (
        <p>
          We protect your data with encryption in transit, hashed passwords and API keys, encrypted social account tokens, limits on sign-in attempts and
          access only for those who need it. No system is perfectly secure; if a breach affects your data, we will tell you and the authorities as the law
          requires.
        </p>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: <p>{name} is for people aged 16 and over. We don't knowingly collect data from children; if you think a child has signed up, please tell us and we will delete the account.</p>,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: <p>If we change this policy in a way that matters, we will tell you by email or in the app before the change applies. The date at the top shows the latest version.</p>,
    },
    {
      id: "contact",
      title: "Contact",
      body: <p>For privacy questions or requests, {op.contact}.</p>,
    },
  ];
}

export function Legal({ page }: { page: "terms" | "privacy" }) {
  const { config } = usePublicConfig();
  const { hash } = useLocation();
  // A link to a section from another page (e.g. /terms#withdrawal-form) lands on it once the page has been shown.
  useEffect(() => {
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(timer);
  }, [hash, page]);
  const company = config?.company;
  const op: Operator = {
    name: company?.name ? <strong>{company.name}</strong> : `the operator of ${PRODUCT.name}`,
    plain: [company?.name || `the operator of ${PRODUCT.name}`, company?.address, company?.email].filter(Boolean).join(", "),
    address: company?.address || null,
    contact: company?.email ? (
      <>write to <a href={`mailto:${company.email}`}>{company.email}</a> or use our <Link to="/contact">contact form</Link></>
    ) : (
      <>use our <Link to="/contact">contact form</Link></>
    ),
  };
  const isTerms = page === "terms";
  const sections = isTerms ? terms(op) : privacy(op);
  const updated = formatDate(publicPages[isTerms ? "/terms" : "/privacy"].updated);
  return (
    <div className="pub-wrap narrow">
      <header className="pub-head">
        <span className="kicker">Legal</span>
        <h1>{isTerms ? "Terms of Service" : "Privacy Policy"}</h1>
        <p className="lead">Last updated {updated}</p>
        <nav className="legal-switch" aria-label="Legal documents">
          <Link to="/terms" aria-current={isTerms ? "page" : undefined}>Terms of Service</Link>
          <Link to="/privacy" aria-current={!isTerms ? "page" : undefined}>Privacy Policy</Link>
        </nav>
      </header>
      {/* Have these reviewed by a lawyer before launch. */}
      <article className="legal-doc" aria-label={isTerms ? "Terms of Service" : "Privacy Policy"}>
        <div className="summary">
          {isTerms ? (
            <p>
              <strong>The short version:</strong> you own what you put in and what you make. You are responsible for the videos you publish, including those
              a series posts for you — turn on review if you want to see each one first. Don't use {PRODUCT.name} to deceive people or to imitate real people.
              Plans are monthly or yearly and you can cancel any time.
            </p>
          ) : (
            <p>
              <strong>The short version:</strong> we use your data to make and publish your videos, and for nothing else. We don't sell it, show ads or use
              tracking cookies. You can download your videos and delete your account at any time.
            </p>
          )}
        </div>
        <nav className="toc" aria-labelledby="toc-title">
          <h2 id="toc-title">Contents</h2>
          <ol>
            {sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}
          </ol>
        </nav>
        {sections.map((s, i) => (
          <section key={s.id} aria-labelledby={s.id}>
            <h2 id={s.id}>{i + 1}. {s.title}</h2>
            {s.body}
          </section>
        ))}
      </article>
    </div>
  );
}

import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { PRODUCT } from "../../shared/brand";
import { usePublicConfig } from "./PublicLayout";
import { LEGAL_BG_UPDATED, privacy, summaries, terms } from "./legal-bg";

// Реч БГ's legal pages (docs/SITES.md): its own Bulgarian texts in place of Hookstreak's English ones (Legal.tsx),
// on the same two addresses and with the same anchors the app links to (#withdrawal, #withdrawal-form, #affiliates).
// The texts are in legal-bg.ts; this page adds who the provider is, from the site's settings, and the standard
// withdrawal form.

const months = ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"];
// Written out rather than formatted by the browser, so the prerendered page and the browser always agree.
const [year, month, day] = LEGAL_BG_UPDATED.split("-").map(Number);
const updated = `${day} ${months[month - 1]} ${year} г.`;

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
  const isTerms = page === "terms";
  const sections = isTerms ? terms : privacy;
  const title = isTerms ? "Общи условия" : "Политика за поверителност";
  const recipient = [company?.name, company?.address, company?.email].filter(Boolean).join(", ") || PRODUCT.name;
  return (
    <div className="pub-wrap narrow" translate="no">
      <header className="pub-head">
        <span className="kicker">Ясни правила</span>
        <h1>{title}</h1>
        <p className="lead">Последна актуализация: <time dateTime={LEGAL_BG_UPDATED}>{updated}</time></p>
        <nav className="legal-switch" aria-label="Правни документи">
          <Link to="/terms" aria-current={isTerms ? "page" : undefined}>Общи условия</Link>
          <Link to="/privacy" aria-current={!isTerms ? "page" : undefined}>Политика за поверителност</Link>
        </nav>
      </header>
      <article className="legal-doc" aria-label={title}>
        <div className="summary">
          <p><strong>Накратко:</strong> {summaries[page]}</p>
        </div>
        {/* Who the provider is: from the site's settings, so the texts never go out of date with them. */}
        {company?.name && (
          <div className="summary">
            <p>
              <strong>Доставчик: {company.name}</strong>
              {company.id && <><br />ЕИК: {company.id}</>}
              {company.address && <><br />Адрес: {company.address}</>}
              {company.email && <><br />Имейл: <a href={`mailto:${company.email}`}>{company.email}</a></>}
            </p>
          </div>
        )}
        <nav className="toc" aria-labelledby="toc-title">
          <h2 id="toc-title">Съдържание</h2>
          <ol>
            {sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}
          </ol>
        </nav>
        {sections.map((s, i) => (
          <section key={s.id} aria-labelledby={s.id}>
            <h2 id={s.id}>{i + 1}. {s.title}</h2>
            {s.paragraphs.map((text, n) => <p key={n}>{text}</p>)}
            {s.list && <ul>{s.list.map((item, n) => <li key={n}>{item}</li>)}</ul>}
            {isTerms && s.id === "withdrawal" && (
              <section id="withdrawal-form" className="model-form" aria-labelledby="withdrawal-form-title">
                <h3 id="withdrawal-form-title">Стандартен формуляр за упражняване на право на отказ</h3>
                <p>(попълнете и изпратете настоящия формуляр единствено ако желаете да се откажете от договора)</p>
                <ul>
                  <li>До: {recipient}</li>
                  <li>С настоящото уведомявам/уведомяваме*, че се отказвам/отказваме* от сключения от мен/нас* договор за предоставяне на следната услуга: абонамент за план … в {PRODUCT.name}</li>
                  <li>Поръчано на: …</li>
                  <li>Име на потребителя/потребителите и имейл на профила: …</li>
                  <li>Адрес на потребителя/потребителите: …</li>
                  <li>Подпис на потребителя/потребителите (само в случай че настоящият формуляр е на хартиен носител): …</li>
                  <li>Дата: …</li>
                </ul>
                <p>(*) Ненужното се зачертава.</p>
              </section>
            )}
          </section>
        ))}
        <p>
          За въпроси и упражняване на права: <Link to="/contact">свържете се с нас</Link>
          {company?.email && <> или пишете на <a href={`mailto:${company.email}`}>{company.email}</a></>}.
          {isTerms && <> За сигнал за незаконно съдържание или deepfake използвайте <Link to="/contact?topic=abuse">контактната форма</Link>.</>}
        </p>
      </article>
    </div>
  );
}

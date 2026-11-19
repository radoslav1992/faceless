// The currency a site charges in (shared/site.ts): US dollars on Hookstreak, euro on Реч БГ. Plan prices are the same
// numbers on both (shared/plans.ts); on Реч БГ they include VAT (its Stripe prices are tax-inclusive).
declare const __SITE__: string | undefined;

export const CURRENCY: { code: "usd" | "eur"; symbol: string } =
  typeof __SITE__ === "string" && __SITE__ === "rechbg" ? { code: "eur", symbol: "€" } : { code: "usd", symbol: "$" };
/** An amount of whole currency units as it is shown: "$19", "$7.50". */
export const price = (amount: number) => `${CURRENCY.symbol}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

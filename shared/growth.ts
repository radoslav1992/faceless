// Growth programs: affiliates (people who bring paying customers earn a share of what those customers pay) and a
// call with the founders in exchange for credits (what customers tell us decides what is built next).

/** Affiliates earn this share of what a referred customer pays, without tax. */
export const AFFILIATE_RATE = 0.3;
/** …for this long after the customer's first payment. */
export const AFFILIATE_MONTHS = 12;
/** A commission is paid out once this many days have passed (refunds and chargebacks come in before). */
export const AFFILIATE_HOLD_DAYS = 30;
/** The smallest balance paid out, in cents. */
export const AFFILIATE_MIN_PAYOUT = 5000;
/** The version of the affiliate terms an affiliate accepted (the Terms of Service, "Affiliate program"). */
export const AFFILIATE_TERMS_VERSION = "2026-10-20";
/** A referral code: lowercase letters, digits and dashes. */
export const REFERRAL_CODE = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/;
/** Codes nobody can take (they would read as ours). */
export const RESERVED_CODES = ["admin", "hookstreak", "support", "team", "official", "staff", "help", "billing"];
/** The commission on a payment of `amount` cents. */
export const commissionOn = (amount: number) => Math.floor(Math.max(0, amount) * AFFILIATE_RATE);

/** A call with the founders: its length, and the credits it earns once it took place. */
export const CALL_MINUTES = 15;
export const CALL_CREDITS = 30;

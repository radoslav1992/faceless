// The consumer's right of withdrawal from a subscription (Consumer Rights Directive Art. 9, 14(3) and 16(m);
// Bulgarian ЗЗП чл. 50–57). The plan starts within the 14 days only at the consumer's express request, given before
// checkout; a withdrawal within 14 days then returns what was paid, less the share of the plan that was used.

export const WITHDRAWAL_DAYS = 14;
/** Change the version whenever the text changes: each consent records the version it was given for. */
export const IMMEDIATE_START_VERSION = "2026-10-09";
export const IMMEDIATE_START_TEXT =
  "I want my plan to start straight after payment, so I can use its credits during the 14-day withdrawal period. " +
  "I understand that if I withdraw in that period, I get back what I paid less the share of the plan's credits I used.";

/** A paid period's credits: what the plan gives for the whole period (`quota`) and how many of them were used. */
export type Usage = { used: number; quota: number };

/**
 * Refund (in cents) on withdrawal: what was paid, less the used share of the period's credits.
 * floor(paid × unused / quota) in integer arithmetic, so 30% used of $29.00 refunds exactly $20.30.
 */
export function withdrawalRefund(paid: number, u: Usage) {
  const quota = Math.max(0, u.quota), used = Math.min(Math.max(0, u.used), quota);
  if (!(paid > 0) || !(quota > 0)) return 0;
  return Math.floor((paid * (quota - used)) / quota);
}

// The referral code from an affiliate's link (?ref=… on any public page): kept only in this page's memory, never in
// cookies or browser storage, until the visitor signs up. The sign-up form shows it, and they can remove it.

let code = "";
const pattern = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/;
export function rememberReferral(value: string | null) {
  const v = (value || "").trim().toLowerCase();
  if (pattern.test(v)) code = v;
}
export const referralCode = () => code;

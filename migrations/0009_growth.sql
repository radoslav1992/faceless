-- Growth programs (shared/growth.ts).
--
-- Affiliates: a user who joined the affiliate program, with their referral code and where commissions are paid.
-- A customer who signed up with a code is `users.referred_by`; each of their payments in their first 12 months gives
-- the affiliate a commission (one row per Stripe invoice or Checkout session), held for 30 days, then paid out by an
-- administrator (affiliate_payouts, kept for the accounts when the affiliate's account is deleted, with whom it was
-- paid to). A refund or chargeback lowers or voids the commission; one already paid out is taken back by a reversal
-- row (negative, `reverses` = the commission) from the next payout.
CREATE TABLE affiliates (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  payout_email TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN referred_by TEXT REFERENCES affiliates(user_id) ON DELETE SET NULL;
CREATE INDEX users_referred_by ON users(referred_by) WHERE referred_by IS NOT NULL;
CREATE TABLE affiliate_payouts (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT REFERENCES affiliates(user_id) ON DELETE SET NULL,
  paid_to TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX affiliate_payouts_affiliate ON affiliate_payouts(affiliate_id, created_at DESC);
CREATE TABLE commissions (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates(user_id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plan','pack','reversal')),
  reverses TEXT,
  payment_intent TEXT,
  amount INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','void')),
  payout_id TEXT REFERENCES affiliate_payouts(id),
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX commissions_affiliate ON commissions(affiliate_id, created_at DESC);
CREATE INDEX commissions_customer ON commissions(customer_id, created_at);
CREATE INDEX commissions_intent ON commissions(payment_intent) WHERE payment_intent IS NOT NULL;
CREATE INDEX commissions_reverses ON commissions(reverses) WHERE reverses IS NOT NULL;

-- A call with the founders for credits: asked for by the customer (they book it on the scheduling page), then marked
-- done by an administrator, which adds the credits once per account; or marked missed (they can book again).
CREATE TABLE call_offers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','done','missed','dismissed')),
  credits INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL,
  done_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX call_offers_status ON call_offers(status, requested_at);

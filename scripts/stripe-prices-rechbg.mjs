// Реч БГ's plans in Stripe (docs/SITES.md): one product per paid plan, each with a monthly and a yearly price in euro,
// VAT included. The amounts come from shared/plans.ts, the same numbers Hookstreak charges in US dollars.
//
//   STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-prices-rechbg.mjs            shows what it would create
//   STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-prices-rechbg.mjs --create   creates what is missing
//
// Run it with the secret key of Реч БГ's Stripe account (a test key first). It can be run again: a price that
// already exists (found by its lookup key) is left as it is. It prints the price IDs as the variables the Worker
// reads: set them as variables of the Worker rech-bg (dashboard → Workers → rech-bg → Settings → Variables and Secrets).
import Stripe from "stripe";

// The paid plans' monthly prices, as in shared/plans.ts (tests/sites.test.ts keeps the two alike). A year costs ten months.
const plans = [
  { id: "starter", monthly: 19 }, { id: "daily", monthly: 35 }, { id: "double", monthly: 59 }, { id: "studio", monthly: 149 },
].map((plan) => ({ ...plan, yearly: plan.monthly * 10 }));

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("Set STRIPE_SECRET_KEY to the secret key of Реч БГ's Stripe account."); process.exit(1); }
const create = process.argv.includes("--create");
const stripe = new Stripe(key);
/** The plans' names on Реч БГ (shared/locales/bg.ts) and the variable each price ID goes into (server/billing.ts). */
const names = { starter: "Начало", daily: "Създател", double: "Про", studio: "Студио" };
const variables = { starter: "STRIPE_PRICE_STARTER", daily: "STRIPE_PRICE_DAILY", double: "STRIPE_PRICE_DOUBLE", studio: "STRIPE_PRICE_STUDIO" };

const out = [];
for (const plan of plans) {
  for (const [interval, amount, suffix] of [["month", plan.monthly, ""], ["year", plan.yearly, "_YEARLY"]]) {
    const lookup = `rechbg_${plan.id}_${interval}`;
    const found = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
    if (found) {
      const fits = found.currency === "eur" && found.unit_amount === amount * 100 && found.recurring?.interval === interval;
      console.log(`${fits ? "exists " : "DIFFERS"} ${names[plan.id]} · €${amount} / ${interval} · ${found.id}${fits ? "" : " (not €" + amount + " a " + interval + ": archive it in Stripe and run again)"}`);
      out.push([variables[plan.id] + suffix, found.id]);
      continue;
    }
    if (!create) { console.log(`missing ${names[plan.id]} · €${amount} / ${interval}`); continue; }
    // One product per plan, named as the plan: Checkout, receipts and the billing portal show the product's name.
    const product = (await stripe.products.search({ query: `metadata['rechbg_plan']:'${plan.id}' AND active:'true'`, limit: 1 })).data[0]
      ?? await stripe.products.create({ name: `Реч БГ · ${names[plan.id]}`, metadata: { rechbg_plan: plan.id } });
    const price = await stripe.prices.create({
      product: product.id, currency: "eur", unit_amount: amount * 100, recurring: { interval, interval_count: 1 },
      // The price shown is the price paid: VAT is inside it.
      tax_behavior: "inclusive", lookup_key: lookup, metadata: { plan: plan.id },
    });
    console.log(`created ${names[plan.id]} · €${amount} / ${interval} · ${price.id}`);
    out.push([variables[plan.id] + suffix, price.id]);
  }
}
if (out.length) {
  console.log("\nVariables for the Worker rech-bg:");
  for (const [name, id] of out) console.log(`${name}=${id}`);
} else console.log("\nNothing exists yet. Run again with --create to make the products and prices.");

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

let dashRejectionRates = {};
try { dashRejectionRates = JSON.parse(fs.readFileSync('/home/ec2-user/apps/raketa/dashboard/rejections.json', 'utf8')); } catch(e) {}

const DASH_SHIPPING = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };

const orders = db.prepare("SELECT id, country, gross_eur, net_revenue, product_cost, shipping_cost, profit, product_type FROM wc_orders WHERE order_date = '2026-03-30' ORDER BY id").all();

console.log('Verifying formula: should profit = net_revenue - product_cost - shipping_cost?');
for (const o of orders) {
  const computed = +(o.net_revenue - o.product_cost - o.shipping_cost).toFixed(2);
  const match = Math.abs(computed - o.profit) < 0.02;
  console.log(`${o.id} | stored=${o.profit} | computed(net-prod-ship)=${computed} | match=${match} | net=${o.net_revenue} prod=${o.product_cost} ship=${o.shipping_cost}`);
}

// Now verify: if we fix shipping to ALWAYS apply, what's the total?
console.log('\n--- If we ALWAYS apply dash shipping ---');
let fixedTotal = 0;
for (const o of orders) {
  const rejRate = (dashRejectionRates[o.country] || 15) / 100;
  const vatRate = VAT_RATES[o.country] || 0;
  const effectiveGrossEur = o.gross_eur * (1 - rejRate);
  const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
  const dashShipping = DASH_SHIPPING[o.country] || 4;
  // product_cost in DB is already effective (adjusted for rejection)
  const fixedProfit = effectiveNetEur - o.product_cost - dashShipping;
  fixedTotal += fixedProfit;
  console.log(`${o.id} | ${o.country} | oldProfit=${o.profit} | fixedProfit=${fixedProfit.toFixed(2)} | diff=${(o.profit - fixedProfit).toFixed(2)}`);
}
console.log(`Fixed total (before spend): €${fixedTotal.toFixed(2)}`);

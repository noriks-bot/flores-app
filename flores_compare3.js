const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

let dashRejectionRates = {};
try { dashRejectionRates = JSON.parse(fs.readFileSync('/home/ec2-user/apps/raketa/dashboard/rejections.json', 'utf8')); } catch(e) {}

const DASH_SHIPPING = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };

const orders = db.prepare("SELECT id, country, gross_eur, net_revenue, product_cost, shipping_cost, profit, product_type FROM wc_orders WHERE order_date = '2026-03-30' ORDER BY id").all();

console.log('id | country | grossEur | storedNetRev | storedProdCost | storedShip | storedProfit | dashProfit | diff');
let floresTotal = 0, dashTotal = 0;

for (const o of orders) {
  const rejRate = (dashRejectionRates[o.country] || 15) / 100;
  const vatRate = VAT_RATES[o.country] || 0;
  
  // Dash formula (per order, no spend):
  const effectiveGrossEur = o.gross_eur * (1 - rejRate);
  const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
  // Dash uses per-order shipping cost from shipping-costs.json (ALWAYS applied, every order pays shipping)
  const dashShipping = DASH_SHIPPING[o.country] || 4;
  // product_cost in DB is already the raw cost (before rejection adjustment)
  // Dash: effectiveProductCost = productCost * (1 - rejRate)
  const effectiveProductCost = o.product_cost * (1 - rejRate);
  // Actually wait - flores stores product_cost already adjusted? Let me check
  
  const dashProfit = effectiveNetEur - effectiveProductCost - dashShipping;
  dashTotal += dashProfit;
  floresTotal += o.profit;
  
  const diff = o.profit - dashProfit;
  console.log(`${o.id} | ${o.country} | ${o.gross_eur} | ${o.net_revenue?.toFixed(2)} | ${o.product_cost?.toFixed(2)} | ${o.shipping_cost} | ${o.profit?.toFixed(2)} | ${dashProfit.toFixed(2)} | ${diff.toFixed(2)}`);
}

console.log(`\nFlores: €${floresTotal.toFixed(2)}, Dash: €${dashTotal.toFixed(2)}, Diff: €${(floresTotal-dashTotal).toFixed(2)}`);

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

// Load rejection rates (same as flores does)
let dashRejectionRates = {};
try {
  dashRejectionRates = JSON.parse(fs.readFileSync('/home/ec2-user/apps/raketa/dashboard/rejections.json', 'utf8'));
} catch(e) {}
console.log('Rejection rates:', JSON.stringify(dashRejectionRates));

// Dash shipping costs (from shipping-costs.json)
const DASH_SHIPPING = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
const EUR_RATES = { HR: 1, CZ: 0.041, PL: 0.232, GR: 1, IT: 1, HU: 0.00256, SK: 1 };
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };
const PRODUCT_COSTS = { tshirt: 3.5, boxers: 2.25 };

// Get orders with raw_meta for line items
const orders = db.prepare("SELECT * FROM wc_orders WHERE order_date = '2026-03-30' ORDER BY id").all();
console.log('\nOrders today:', orders.length);

let floresTotal = 0, dashTotal = 0;

for (const o of orders) {
  const country = o.country;
  const rejRate = (dashRejectionRates[country] || 15) / 100;
  const vatRate = VAT_RATES[country] || 0;
  
  // Flores stored profit
  const floresProfit = o.profit;
  floresTotal += floresProfit;
  
  // Dash formula per order:
  // effectiveGrossEur = grossEur * (1 - rejRate)
  // effectiveNetEur = effectiveGrossEur / (1 + vatRate)
  // effectiveProductCost = productCost * (1 - rejRate)
  // profit = effectiveNetEur - effectiveProductCost - shippingCost
  // (spend is subtracted at aggregate level)
  
  const grossEur = o.gross_eur;
  const effectiveGrossEur = grossEur * (1 - rejRate);
  const effectiveNetEur = effectiveGrossEur / (1 + vatRate);
  
  // Parse raw_meta for line items to get product cost
  let productCost = 0;
  let items = [];
  try {
    const meta = JSON.parse(o.raw_meta || '{}');
    items = meta.line_items || [];
    const shirtWords = /shirt|majic|μπλουζ|koszulk|tričko|tričk|póló|magliett|tshirt|t-shirt/i;
    for (const item of items) {
      const qty = item.quantity || 1;
      const isShirt = shirtWords.test(item.name || '') || shirtWords.test(item.sku || '');
      productCost += (isShirt ? PRODUCT_COSTS.tshirt : PRODUCT_COSTS.boxers) * qty;
    }
  } catch(e) {}
  
  const effectiveProductCost = productCost * (1 - rejRate);
  
  // DASH always charges shipping per order
  const dashShipping = DASH_SHIPPING[country] || 4;
  
  // FLORES only charges shipping if shipping_total > 0
  const floresShipping = o.shipping_cost;
  
  const dashProfit = effectiveNetEur - effectiveProductCost - dashShipping;
  dashTotal += dashProfit;
  
  const diff = floresProfit - dashProfit;
  if (Math.abs(diff) > 0.01) {
    console.log(`\nOrder ${o.id} [${country}] DIFF=${diff.toFixed(2)}`);
    console.log(`  grossEur=${grossEur}, rejRate=${rejRate}, vatRate=${vatRate}`);
    console.log(`  floresProfit=${floresProfit.toFixed(2)}, dashProfit=${dashProfit.toFixed(2)}`);
    console.log(`  floresShipping=${floresShipping}, dashShipping=${dashShipping}`);
    console.log(`  effectiveNet=${effectiveNetEur.toFixed(2)}, effectiveProdCost=${effectiveProductCost.toFixed(2)}`);
    console.log(`  items: ${items.map(i => i.name + ' x' + i.quantity).join(', ')}`);
  }
}

console.log(`\n=== TOTALS ===`);
console.log(`Flores DB profit total: €${floresTotal.toFixed(2)}`);
console.log(`Dash formula profit total: €${dashTotal.toFixed(2)}`);
console.log(`Difference: €${(floresTotal - dashTotal).toFixed(2)}`);

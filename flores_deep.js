const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

let dashRejectionRates = {};
try { dashRejectionRates = JSON.parse(fs.readFileSync('/home/ec2-user/apps/raketa/dashboard/rejections.json', 'utf8')); } catch(e) {}

const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };
const SHIPPING_COSTS = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
const PRODUCT_COSTS = { tshirt: 3.5, boxers: 2.25 };

// Get per-country stats for today
const countries = db.prepare("SELECT country, COUNT(*) as orders, SUM(gross_eur) as revenue, SUM(product_cost) as prod_cost FROM wc_orders WHERE order_date = '2026-03-30' GROUP BY country").all();

// Read dash cache for spend  
const dashCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'dash-cache.json'), 'utf8'));
const todayCache = (dashCache.data || {})['2026-03-30'] || {};

let totalProfit = 0;
for (const c of countries) {
  const rejRate = (dashRejectionRates[c.country] || 15) / 100;
  const vatRate = VAT_RATES[c.country] || 0;
  const spend = todayCache[c.country]?.spend || 0;
  
  const effectiveGross = c.revenue * (1 - rejRate);
  const effectiveNet = effectiveGross / (1 + vatRate);
  const effectiveProdCost = c.prod_cost; // already effective in DB after our fix? NO - stored as effective from calculateOrderProfit
  const shipping = (SHIPPING_COSTS[c.country] || 4) * c.orders;
  const profit = effectiveNet - spend - effectiveProdCost - shipping;
  totalProfit += profit;
  
  console.log(`${c.country}: orders=${c.orders} rev=${c.revenue.toFixed(2)} effNet=${effectiveNet.toFixed(2)} prodCost=${c.prod_cost.toFixed(2)} ship=${shipping.toFixed(2)} spend=${spend.toFixed(2)} profit=${profit.toFixed(2)}`);
}
console.log(`\nTotal profit (aggregate dash style): ${totalProfit.toFixed(2)}`);

// Now let's see what dash would compute for SAME orders
// Dash counts tshirts and boxers from line_items, not from stored product_cost
// Let me check what dash gets for HR today
console.log('\n--- Checking dash data for today ---');
for (const [ctry, v] of Object.entries(todayCache)) {
  if (v && typeof v === 'object') {
    console.log(`${ctry}: orders=${v.orders||'?'} revenue=${v.revenue_gross_eur||v.revenue||'?'} profit=${v.profit||'?'} spend=${v.spend||0} prodCost=${v.product_cost||v.effective_product_cost||'?'} shipping=${v.shipping_cost||'?'}`);
  }
}

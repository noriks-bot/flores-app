// Quick recalculate profits for all orders using the new formula
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

let dashRejectionRates = {};
try { dashRejectionRates = JSON.parse(fs.readFileSync('/home/ec2-user/apps/raketa/dashboard/rejections.json', 'utf8')); } catch(e) {}

const EUR_RATES = { HR: 1, CZ: 0.041, PL: 0.232, GR: 1, IT: 1, HU: 0.00256, SK: 1 };
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };
const PRODUCT_COSTS = { tshirt: 3.5, boxers: 2.25 };
const SHIPPING_COSTS = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
const shirtWords = /shirt|majic|\u03bc\u03c0\u03bb\u03bf\u03c5\u03b6|koszulk|tri\u010dko|tri\u010dk|p\u00f3l\u00f3|magliett|tshirt|t-shirt/i;

const orders = db.prepare('SELECT * FROM wc_orders').all();
console.log('Recalculating profits for', orders.length, 'orders...');

const update = db.prepare('UPDATE wc_orders SET net_revenue = ?, product_cost = ?, shipping_cost = ?, profit = ? WHERE id = ?');

let updated = 0;
const txn = db.transaction(() => {
  for (const o of orders) {
    const country = o.country;
    const rejRate = (dashRejectionRates[country] || 15) / 100;
    const vatRate = VAT_RATES[country] || 0;
    
    const grossEur = o.gross_eur;
    const effectiveGrossEur = grossEur * (1 - rejRate);
    const netRevenue = effectiveGrossEur / (1 + vatRate);
    
    // Product cost stays as-is (already stored correctly from line_items during sync)
    // But we need to recalc shipping: ALWAYS apply
    const shippingCost = SHIPPING_COSTS[country] || 4;
    
    // profit = netRevenue - productCost - shippingCost (spend subtracted at aggregate)
    const profit = netRevenue - o.product_cost - shippingCost;
    
    const newNet = Math.round(netRevenue * 100) / 100;
    const newProfit = Math.round(profit * 100) / 100;
    
    if (Math.abs(newProfit - o.profit) > 0.01 || Math.abs(shippingCost - o.shipping_cost) > 0.01) {
      update.run(newNet, o.product_cost, shippingCost, newProfit, o.id);
      updated++;
    }
  }
});

txn();
console.log('Updated', updated, 'orders');

// Verify today's profit
const today = db.prepare("SELECT COUNT(*) as orders, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date = '2026-03-30'").get();
console.log('Today:', today.orders, 'orders, profit:', today.profit.toFixed(2));

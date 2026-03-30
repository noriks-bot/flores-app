// Recalculate profits for ALL orders using updated formula + sharedDetectProduct
// But we don't have line_items in DB. We need to re-fetch from WC or use what's stored.
// The product_cost in DB was calculated at sync time. Since sync uses calculateOrderProfit
// which now uses sharedDetectProduct, any NEW sync will be correct.
// For EXISTING orders, we need a full resync.

// Strategy: clear sync_state, then trigger sync via API or restart
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

// Clear sync state to force full re-fetch from WC
db.prepare('DELETE FROM sync_state').run();
console.log('Sync state cleared - next sync will refetch all orders from WC');

// Check current state
const cnt = db.prepare('SELECT COUNT(*) as cnt FROM wc_orders').get();
console.log('Current orders in DB:', cnt.cnt);
const today = db.prepare("SELECT COUNT(*) as orders, COALESCE(SUM(profit),0) as profit, COALESCE(SUM(product_cost),0) as prodcost FROM wc_orders WHERE order_date = '2026-03-30'").get();
console.log('Today before resync:', today.orders, 'orders, profit:', today.profit.toFixed(2), 'prodcost:', today.prodcost.toFixed(2));

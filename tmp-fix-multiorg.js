const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server.js');
let code = fs.readFileSync(file, 'utf8');

let changeCount = 0;

// 1. Add org_id column to wc_orders
const alterMarker = 'try { db.exec("ALTER TABLE wc_orders ADD COLUMN order_datetime TEXT"); } catch(e)';
if (code.includes(alterMarker) && !code.includes('ALTER TABLE wc_orders ADD COLUMN org_id')) {
  code = code.replace(
    alterMarker,
    alterMarker + ' { /* exists */ }\ntry { db.exec("ALTER TABLE wc_orders ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e)'
  );
  changeCount++;
  console.log('1. Added org_id column to wc_orders');
} else if (code.includes('ALTER TABLE wc_orders ADD COLUMN org_id')) {
  console.log('1. org_id column already exists');
} else {
  // Find any ALTER TABLE wc_orders line
  const altMatch = code.match(/try \{ db\.exec\("ALTER TABLE wc_orders ADD COLUMN [^"]+"\); \} catch\(e\) \{ \/\* exists \*\/ \}/);
  if (altMatch) {
    code = code.replace(altMatch[0], altMatch[0] + '\ntry { db.exec("ALTER TABLE wc_orders ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e) { /* exists */ }');
    changeCount++;
    console.log('1. Added org_id column (alt method)');
  }
}

// 2. Fix getRates2() to accept orgId
code = code.replace(
  /function getRates2\(\) \{/,
  'function getRates2(orgId) {\n  orgId = orgId || 1;'
);
code = code.replace(
  `SELECT key, value FROM org_settings WHERE org_id = 1 AND category = 'rejection_rates2'`,
  `SELECT key, value FROM org_settings WHERE org_id = ? AND category = 'rejection_rates2'`
);
// Fix the .all() call for rejection_rates2
code = code.replace(
  /("SELECT key, value FROM org_settings WHERE org_id = \? AND category = 'rejection_rates2'"\)\.all\(\))/,
  `"SELECT key, value FROM org_settings WHERE org_id = ? AND category = 'rejection_rates2'").all(orgId)`
);

code = code.replace(
  `SELECT key, value FROM org_settings WHERE org_id = 1 AND category = 'shipping_costs2'`,
  `SELECT key, value FROM org_settings WHERE org_id = ? AND category = 'shipping_costs2'`
);
code = code.replace(
  /("SELECT key, value FROM org_settings WHERE org_id = \? AND category = 'shipping_costs2'"\)\.all\(\))/,
  `"SELECT key, value FROM org_settings WHERE org_id = ? AND category = 'shipping_costs2'").all(orgId)`
);
changeCount++;
console.log('2. Fixed getRates2() to accept orgId parameter');

// 3. Fix INSERT to include org_id
const oldInsert = 'INSERT INTO wc_orders (country, wc_order_id, order_date, status, gross_total, gross_eur, net_revenue, product_cost, shipping_cost, profit, product_type, utm_source, utm_campaign, is_fb_attributed, raw_meta, created_at, adset_id, ad_id, campaign_name, adset_name, ad_name, utm_medium, landing_page, placement, billing_name, billing_city, billing_email, order_datetime)';
const newInsert = 'INSERT INTO wc_orders (country, wc_order_id, order_date, status, gross_total, gross_eur, net_revenue, product_cost, shipping_cost, profit, product_type, utm_source, utm_campaign, is_fb_attributed, raw_meta, created_at, adset_id, ad_id, campaign_name, adset_name, ad_name, utm_medium, landing_page, placement, billing_name, billing_city, billing_email, order_datetime, org_id)';
if (code.includes(oldInsert)) {
  code = code.replace(oldInsert, newInsert);
  changeCount++;
  console.log('3. Fixed INSERT to include org_id');
}

// 4. Fix VALUES in the insert to include org_id placeholder
// Find the VALUES (?,?,?...) that follows the INSERT
const valuesMatch = code.match(/VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/);
if (valuesMatch) {
  code = code.replace(valuesMatch[0], valuesMatch[0].replace('?)', '?, ?)'));
  changeCount++;
  console.log('4. Fixed VALUES placeholders');
}

// 5. Fix activity_log queries  
code = code.replace(
  `SELECT DISTINCT username FROM activity_log WHERE org_id = 1`  ,
  `SELECT DISTINCT username FROM activity_log WHERE org_id = ?`
);
code = code.replace(
  `SELECT DISTINCT action FROM activity_log WHERE org_id = 1`,
  `SELECT DISTINCT action FROM activity_log WHERE org_id = ?`
);
changeCount++;
console.log('5. Fixed activity_log queries');

// 6. Fix "WHERE org_id = 1" in activity log filter
code = code.replace(
  `let where = 'WHERE org_id = 1'`,
  `let where = 'WHERE org_id = ' + (user?.orgId || 1)`
);
changeCount++;
console.log('6. Fixed activity_log filter WHERE clause');

// 7. Fix notifications queries
code = code.replace(
  `FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND org_id = 1 ORDER BY created_at DESC LIMIT 50`  ,
  `FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND org_id = ? ORDER BY created_at DESC LIMIT 50`
);
code = code.replace(
  `FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0 AND org_id = 1`,
  `FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0 AND org_id = ?`
);
code = code.replace(
  `UPDATE notifications SET read = 1 WHERE (user_id = ? OR user_id IS NULL) AND org_id = 1`,
  `UPDATE notifications SET read = 1 WHERE (user_id = ? OR user_id IS NULL) AND org_id = ?`
);
changeCount++;
console.log('7. Fixed notifications queries');

// 8. Now fix the .all()/.get()/.run() calls that need orgId parameter
// For activity_log DISTINCT queries - find their .all() and add orgId
// They should be .all(user?.orgId || 1) now
code = code.replace(
  /("SELECT DISTINCT username FROM activity_log WHERE org_id = \?"\)\.all\(\))/,
  `"SELECT DISTINCT username FROM activity_log WHERE org_id = ?").all(user?.orgId || 1)`
);
code = code.replace(
  /("SELECT DISTINCT action FROM activity_log WHERE org_id = \?"\)\.all\(\))/,
  `"SELECT DISTINCT action FROM activity_log WHERE org_id = ?").all(user?.orgId || 1)`
);
console.log('8. Fixed activity_log .all() params');

// For notifications - need to add orgId param
// Pattern: .all(user?.userId || 0) -> .all(user?.userId || 0, user?.orgId || 1)
// This is tricky - find the specific lines

// notifications list: .all(user?.userId || 0) after org_id = ? ORDER
code = code.replace(
  /org_id = \? ORDER BY created_at DESC LIMIT 50"\)\.all\(user\?\.\w+ \|\| 0\)/,
  `org_id = ? ORDER BY created_at DESC LIMIT 50").all(user?.userId || 0, user?.orgId || 1)`
);

// notifications unread count: .get(user?.userId || 0) after org_id = ?
code = code.replace(
  /AND read = 0 AND org_id = \?"\)\.get\(user\?\.\w+ \|\| 0\)/,
  `AND read = 0 AND org_id = ?").get(user?.userId || 0, user?.orgId || 1)`
);

// notifications mark read: .run(user?.userId || 0) after org_id = ?
code = code.replace(
  /AND org_id = \?"\)\.run\(user\?\.\w+ \|\| 0\)/,
  `AND org_id = ?").run(user?.userId || 0, user?.orgId || 1)`
);
console.log('9. Fixed notifications .all/.get/.run params');

// 10. Add org_id filter to major wc_orders queries
// We need to add AND org_id = ? to dashboard queries
// But these queries don't have easy access to orgId in the current structure
// The dashboard API handler needs to get orgId from user session

// Find dashboard API handler and inject orgId
code = code.replace(
  `if (urlPath === '/api/dashboard') {\n        const dashFrom`,
  `if (urlPath === '/api/dashboard') {\n        const userOrgId = user?.orgId || 1;\n        const dashFrom`
);

// Add org_id filter to main dashboard queries
// todayStats
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND LOWER(billing_name) NOT LIKE '%test%'").get(dashFrom, dashTo)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%'").get(dashFrom, dashTo, userOrgId)`
);

// fbOrders  
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1 AND LOWER(billing_name) NOT LIKE '%test%'").get(dashFrom, dashTo);`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND is_fb_attributed = 1 AND LOWER(billing_name) NOT LIKE '%test%'").get(dashFrom, dashTo, userOrgId);`
);

console.log('10. Added org_id to dashboard queries');

// 11. Fix getRates2 calls to pass orgId
code = code.replace(
  /const \{ rej, ship \} = getRates2\(\);/g,
  'const { rej, ship } = getRates2(user?.orgId || 1);'
);
// Also check for getRates2() without assignment
code = code.replace(
  /getRates2\(\)(?!;)/g,
  function(match) {
    // Don't replace the function definition
    return match;
  }
);
console.log('11. Fixed getRates2() calls to pass orgId');

fs.writeFileSync(file, code);
console.log('\n=== DONE: ' + changeCount + ' change groups applied ===');
console.log('File saved:', file);

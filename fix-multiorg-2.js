const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Make fetchWcOrdersForCountry accept optional storeOverride
code = code.replace(
  'function fetchWcOrdersForCountry(country, modifiedAfter) {\n  const store = WC_STORES[country];',
  'function fetchWcOrdersForCountry(country, modifiedAfter, storeOverride) {\n  const store = storeOverride || WC_STORES[country];'
);
console.log('1. fetchWcOrdersForCountry accepts storeOverride');

// 2. Make syncCountry pass storeOverride to fetch
code = code.replace(
  'const orders = await fetchWcOrdersForCountry(country, modifiedAfter);',
  'const orders = await fetchWcOrdersForCountry(country, modifiedAfter, storeOverride);'
);
console.log('2. syncCountry passes storeOverride');

// 3. Add multi-org sync block before return in syncAllCountries
const syncReturn = "  return { synced: results, totalNew };\n}";
const multiOrgSync = `  // === Multi-org sync ===
  try {
    const orgs = db.prepare('SELECT id, name FROM organizations WHERE id != 1 AND active = 1').all();
    for (const org of orgs) {
      const orgStores = getOrgWcStores(org.id);
      if (!Object.keys(orgStores).length) continue;
      console.log('[FLORES] Syncing org ' + org.name + ' (' + Object.keys(orgStores).length + ' stores)...');
      for (const [cc, store] of Object.entries(orgStores)) {
        try {
          const count = await syncCountry(cc, org.id, store);
          totalNew += count;
          console.log('[FLORES] Org ' + org.name + ' ' + cc + ': ' + count + ' orders');
        } catch(e) {
          console.error('[FLORES] Org ' + org.name + ' sync failed for ' + cc + ':', e.message);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch(e) { console.error('[FLORES] Multi-org sync error:', e.message); }

`;
code = code.replace(syncReturn, multiOrgSync + syncReturn);
console.log('3. Added multi-org sync block');

// 4. Add org_id filter to remaining dashboard queries
// chartData
code = code.replace(
  `FROM wc_orders WHERE order_date >= ?  AND LOWER(billing_name) NOT LIKE '%test%' GROUP BY order_date ORDER BY order_date").all(d7ago)`,
  `FROM wc_orders WHERE order_date >= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%' GROUP BY order_date ORDER BY order_date").all(d7ago, userOrgId)`
);
console.log('4a. chartData org filter');

// topProducts
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? GROUP BY product_type ORDER BY orders DESC").all(dashFrom, dashTo)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? GROUP BY product_type ORDER BY orders DESC").all(dashFrom, dashTo, userOrgId)`
);
console.log('4b. topProducts org filter');

// byCountry
code = code.replace(
  `FROM wc_orders WHERE order_date = ? GROUP BY country ORDER BY orders DESC').all(today)`,
  `FROM wc_orders WHERE order_date = ? AND org_id = ? GROUP BY country ORDER BY orders DESC').all(today, userOrgId)`
);
console.log('4c. byCountry org filter');

// weekStats
code = code.replace(
  `FROM wc_orders WHERE order_date >= ?').get(d7ago)`,
  `FROM wc_orders WHERE order_date >= ? AND org_id = ?').get(d7ago, userOrgId)`
);
console.log('4d. weekStats org filter');

// 5. Add org_id filter to orders list query
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? ORDER BY order_datetime DESC, wc_order_id DESC").all(dashFrom, dashTo)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? ORDER BY order_datetime DESC, wc_order_id DESC").all(dashFrom, dashTo, userOrgId)`
);
console.log('5. orders list org filter');

// 6. Add org_id filter to Google Ads orders query
code = code.replace(
  `FROM wc_orders\n           WHERE order_date >= ? AND order_date <= ?\n           AND (raw_meta LIKE '%gclid%' OR raw_meta LIKE '%gad_source%' OR utm_campaign LIKE '%google_cpc%')\n           ORDER BY order_date DESC, wc_order_id DESC`,
  `FROM wc_orders\n           WHERE order_date >= ? AND order_date <= ? AND org_id = ?\n           AND (raw_meta LIKE '%gclid%' OR raw_meta LIKE '%gad_source%' OR utm_campaign LIKE '%google_cpc%')\n           ORDER BY order_date DESC, wc_order_id DESC`
);
console.log('6. google ads orders org filter');

// Fix the .all() for google ads query
code = code.replace(
  /\).all\(dateFrom, dateTo\);\s*const orders = rows\.map/,
  ').all(dateFrom, dateTo, user?.orgId || 1);\n        const orders = rows.map'
);
console.log('6b. google ads .all() params');

// 7. Add userOrgId to the remaining FB-related queries in dashboard
// These all use dashFrom, dashTo - add org_id filter
const fbQueries = [
  // Each pattern: [search, replace]
];

// 8. Fix totalOrders count queries
code = code.replace(
  `SELECT COUNT(*) as cnt FROM wc_orders').get().cnt`,
  `SELECT COUNT(*) as cnt FROM wc_orders WHERE org_id = ?').get(user?.orgId || 1).cnt`
);
// There might be two of these
code = code.replace(
  `SELECT COUNT(*) as cnt FROM wc_orders').get().cnt`,
  `SELECT COUNT(*) as cnt FROM wc_orders WHERE org_id = ?').get(user?.orgId || 1).cnt`
);
console.log('8. totalOrders org filter');

// 9. Add org_id to country-level FB queries in dashboard
// These are complex but all within the /api/dashboard handler
// Add org_id = userOrgId to queries that filter is_fb_attributed
const fbPattern1 = `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1`;
const fbReplace1 = `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND is_fb_attributed = 1`;
// Replace all occurrences
let fbCount = 0;
while (code.includes(fbPattern1)) {
  code = code.replace(fbPattern1, fbReplace1);
  fbCount++;
}
console.log('9. Fixed ' + fbCount + ' FB attributed queries with org_id');

// Now fix the .all() and .get() calls for these - they need userOrgId param
// Pattern: AND org_id = ? AND is_fb_attributed = 1 ... .all(dashFrom, dashTo)
// Need to add userOrgId after dashTo
// This is tricky because some use .all() and some .get()
// Let me handle the specific ones

// 10. Fix ordersBySource query
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ?").all(dashFrom, dashTo); const m = {}`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ?").all(dashFrom, dashTo, userOrgId); const m = {}`
);
console.log('10. ordersBySource org filter');

// 11. Fix country breakdown query
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ?  AND LOWER(billing_name) NOT LIKE '%test%' GROUP BY country").all(start, end)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%' GROUP BY country").all(start, end, userOrgId || 1)`
);
console.log('11. country breakdown org filter');

// 12. Fix the financial breakdown query
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND LOWER(billing_name) NOT LIKE '%test%'").all(dashFrom, dashTo)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%'").all(dashFrom, dashTo, userOrgId)`
);
console.log('12. financial breakdown org filter');

fs.writeFileSync('server.js', code);
console.log('\n=== All fixes applied ===');

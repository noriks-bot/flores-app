const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Fix activity-log handler - add user definition
code = code.replace(
  `if (urlPath === '/api/activity-log') {\n        const page`,
  `if (urlPath === '/api/activity-log') {\n        const user = getSessionUser(req);\n        const page`
);
console.log('1. Added user to activity-log handler');

// 2. Fix FB queries in dashboard that have org_id = ? but missing userOrgId param
// These are inline IIFEs with .get(dashFrom, dashTo) that now need userOrgId

// fbMeasuredOrders
code = code.replace(
  /org_id = \? AND is_fb_attributed = 1 AND utm_campaign IS NOT NULL AND utm_campaign != ''"\)\.get\(dashFrom, dashTo\)\?\.cnt/g,
  `org_id = ? AND is_fb_attributed = 1 AND utm_campaign IS NOT NULL AND utm_campaign != ''").get(dashFrom, dashTo, userOrgId)?.cnt`
);
console.log('2. Fixed fbMeasuredOrders params');

// fbUnmeasuredOrders - has two queries
code = code.replace(
  /org_id = \? AND is_fb_attributed = 1"\)\.get\(dashFrom, dashTo\)\?\.cnt/g,
  `org_id = ? AND is_fb_attributed = 1").get(dashFrom, dashTo, userOrgId)?.cnt`
);
console.log('3. Fixed fbUnmeasuredOrders params');

// 4. Fix all remaining FB-attributed queries in dashboard that have org_id = ? 
// but still use .all(dashFrom, dashTo) without userOrgId
// Pattern: AND org_id = ? AND is_fb_attributed = 1 ... .all(dashFrom, dashTo)
const fbAllPattern = /org_id = \? AND is_fb_attributed = 1[^"]*"\)\.all\(dashFrom, dashTo\)/g;
let match;
let fbFixCount = 0;
while ((match = fbAllPattern.exec(code)) !== null) {
  const orig = match[0];
  const fixed = orig.replace('.all(dashFrom, dashTo)', '.all(dashFrom, dashTo, userOrgId)');
  code = code.replace(orig, fixed);
  fbFixCount++;
}
console.log('4. Fixed ' + fbFixCount + ' FB .all() queries with userOrgId');

// Also fix .get() variants
const fbGetPattern = /org_id = \? AND is_fb_attributed = 1[^"]*"\)\.get\(dashFrom, dashTo\)/g;
let fbGetCount = 0;
code = code.replace(fbGetPattern, (match) => {
  fbGetCount++;
  return match.replace('.get(dashFrom, dashTo)', '.get(dashFrom, dashTo, userOrgId)');
});
console.log('5. Fixed ' + fbGetCount + ' FB .get() queries with userOrgId');

// 6. Fix the fbByDay query that uses d7ago instead of dashFrom
code = code.replace(
  /org_id = \? AND is_fb_attributed = 1 AND LOWER\(billing_name\) NOT LIKE '%test%' GROUP BY order_date"\)\.all\(d7ago\)/,
  `org_id = ? AND is_fb_attributed = 1 AND LOWER(billing_name) NOT LIKE '%test%' GROUP BY order_date").all(d7ago, userOrgId)`
);
console.log('6. Fixed fbByDay query');

// 7. Fix ad-level WC queries that use dashFrom, dashTo
code = code.replace(
  /FROM wc_orders WHERE order_date >= \? AND order_date <= \? AND ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id"\)\.all\(dashFrom, dashTo\)/,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id").all(dashFrom, dashTo, userOrgId)`
);
console.log('7. Fixed ad-level WC query');

// 8. Fix campaign-level WC queries that use campaignId
// These are in campaign detail handlers - check if they have user
// Pattern: FROM wc_orders WHERE utm_campaign = ? AND order_date >= ? AND order_date <= ?
// These need org_id filter too
code = code.replace(
  /FROM wc_orders WHERE utm_campaign = \? AND order_date >= \? AND order_date <= \?/g,
  `FROM wc_orders WHERE utm_campaign = ? AND order_date >= ? AND order_date <= ? AND org_id = ?`
);
console.log('8. Added org_id to campaign WC queries');

// Fix the .all() params for campaign queries - they use (campaignId, range.from, range.to) or (campaignId, dashFrom, dashTo)
code = code.replace(
  /AND org_id = \?"\)\.all\(campaignId, range\.from, range\.to\)/g,
  `AND org_id = ?").all(campaignId, range.from, range.to, (getSessionUser(req))?.orgId || 1)`
);
code = code.replace(
  /AND org_id = \? GROUP BY adset_id"\)\.all\(campaignId, range\.from, range\.to\)/g,
  `AND org_id = ? GROUP BY adset_id").all(campaignId, range.from, range.to, (getSessionUser(req))?.orgId || 1)`
);
code = code.replace(
  /AND org_id = \? AND ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id"\)\.all\(campaignId, range\.from, range\.to\)/g,
  `AND org_id = ? AND ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id").all(campaignId, range.from, range.to, (getSessionUser(req))?.orgId || 1)`
);
console.log('9. Fixed campaign query params');

// 10. Fix the country-level query that uses (start, end, userOrgId || 1)
// This is already fixed but has wrong var name
code = code.replace(
  '.all(start, end, userOrgId || 1)',
  '.all(start, end, (getSessionUser(req))?.orgId || 1)'
);
console.log('10. Fixed country breakdown query params');

// 11. Fix campaign_name lookup query
code = code.replace(
  `FROM wc_orders WHERE utm_campaign = ? AND campaign_name IS NOT NULL AND campaign_name != '' LIMIT 1`,
  `FROM wc_orders WHERE utm_campaign = ? AND org_id = ? AND campaign_name IS NOT NULL AND campaign_name != '' LIMIT 1`
);
code = code.replace(
  /org_id = \? AND campaign_name IS NOT NULL AND campaign_name != '' LIMIT 1"\)\.get\(campaignId\)/,
  `org_id = ? AND campaign_name IS NOT NULL AND campaign_name != '' LIMIT 1").get(campaignId, (getSessionUser(req))?.orgId || 1)`
);
console.log('11. Fixed campaign_name lookup');

fs.writeFileSync('server.js', code);
console.log('\n=== All fixes applied ===');

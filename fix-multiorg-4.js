const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Fix fetchActualWcOrders - add orgId param
code = code.replace(
  'function fetchActualWcOrders(dateFrom, dateTo) {',
  'function fetchActualWcOrders(dateFrom, dateTo, orgId) {\n  orgId = orgId || 1;'
);
// Fix .all() to include orgId
code = code.replace(
  `GROUP BY country, product_type
  \`).all(dateFrom, dateTo);`,
  `GROUP BY country, product_type
  \`).all(dateFrom, dateTo, orgId);`
);
console.log('1. fetchActualWcOrders fixed');

// 2. Fix fetchWcOrdersByCampaign - add orgId param
code = code.replace(
  'function fetchWcOrdersByCampaign(dateFrom, dateTo, catalogCampaignByCountry) {',
  'function fetchWcOrdersByCampaign(dateFrom, dateTo, catalogCampaignByCountry, orgId) {\n  orgId = orgId || 1;'
);
// Fix .all()
code = code.replace(
  `AND utm_campaign IS NOT NULL AND utm_campaign != ''
  \`).all(dateFrom, dateTo);`,
  `AND utm_campaign IS NOT NULL AND utm_campaign != ''
  \`).all(dateFrom, dateTo, orgId);`
);
console.log('2. fetchWcOrdersByCampaign fixed');

// 3. getCampaigns needs orgId parameter
code = code.replace(
  'async function getCampaigns(dateFrom, dateTo) {',
  'async function getCampaigns(dateFrom, dateTo, orgId) {\n  orgId = orgId || 1;'
);
console.log('3. getCampaigns accepts orgId');

// 4. Pass orgId through getCampaigns internal calls
code = code.replace(
  'const wcOrders = fetchActualWcOrders(dateFrom, dateTo);',
  'const wcOrders = fetchActualWcOrders(dateFrom, dateTo, orgId);'
);
code = code.replace(
  /fetchWcOrdersByCampaign\(dateFrom, dateTo, catalogCampaignByCountry\)/,
  'fetchWcOrdersByCampaign(dateFrom, dateTo, catalogCampaignByCountry, orgId)'
);
console.log('4. Passed orgId to sub-functions in getCampaigns');

// 5. Fix all getCampaigns callers
code = code.replace(
  /await getCampaigns\(dateFrom, dateTo\)/g,
  `await getCampaigns(dateFrom, dateTo, (getSessionUser(req))?.orgId || 1)`
);
code = code.replace(
  /await getCampaigns\(dashFrom, dashTo\)/g,
  'await getCampaigns(dashFrom, dashTo, userOrgId)'
);
console.log('5. Fixed getCampaigns callers');

// 6. Fix dbName lookup that uses getSessionUser inside getCampaigns
// getCampaigns doesn't have req, so use orgId parameter
code = code.replace(
  `.get(campaignId, (getSessionUser(req))?.orgId || 1)`,
  '.get(campaignId, orgId || 1)'
);
console.log('6. Fixed dbName lookup in getCampaigns');

fs.writeFileSync('server.js', code);
console.log('\n=== All fixes applied ===');

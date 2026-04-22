const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Fix getAllAds to accept orgId and use org-specific accounts
code = code.replace(
  'async function getAllAds(dateFrom, dateTo) {',
  'async function getAllAds(dateFrom, dateTo, orgId) {\n  orgId = orgId || 1;'
);
// Cache key with org
code = code.replace(
  "const cacheKey = `all_ads_${dateFrom}_${dateTo}`;",
  "const cacheKey = `all_ads_${dateFrom}_${dateTo}_org${orgId}`;"
);
// Use org accounts
code = code.replace(
  `for (const acct of Object.values(AD_ACCOUNTS_MAP)) {
    try {
      const acctInsights = await metaGetAll(\`\${acct}/insights\`, {
        fields: INSIGHT_FIELDS + ',ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name',
        level: 'ad',
        breakdowns: 'country',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        limit: 500
      });`,
  `const _orgMeta = getOrgMetaConfig(orgId);
  for (const acct of _orgMeta.adAccounts) {
    try {
      const acctInsights = await metaGetAll(\`\${acct}/insights\`, {
        fields: INSIGHT_FIELDS + ',ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name',
        level: 'ad',
        breakdowns: 'country',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        limit: 500
      }, _orgMeta.token);`
);
console.log('1. getAllAds now org-aware');

// 2. Fix getAllAdsets similarly
code = code.replace(
  'async function getAllAdsets(dateFrom, dateTo) {',
  'async function getAllAdsets(dateFrom, dateTo, orgId) {\n  orgId = orgId || 1;'
);
// Cache key
code = code.replace(
  "const cacheKey = `all_adsets_${dateFrom}_${dateTo}`;",
  "const cacheKey = `all_adsets_${dateFrom}_${dateTo}_org${orgId}`;"
);
console.log('2. getAllAdsets now org-aware');

// 3. Fix getAllAdsets to use org accounts
code = code.replace(
  `const allAccounts = Object.values(AD_ACCOUNTS_MAP);
  for (const acct of allAccounts) {
    try {
      const ins = await metaGetAll(acct + '/insights', {`,
  `const _orgMetaAs = getOrgMetaConfig(orgId);
  const allAccounts = _orgMetaAs.adAccounts;
  for (const acct of allAccounts) {
    try {
      const ins = await metaGetAll(acct + '/insights', {`
);
console.log('3. getAllAdsets uses org accounts');

// 4. Fix callers of getAllAds and getAllAdsets to pass orgId
// creative-report: getAllAds(start, end)
code = code.replace(
  'const allAdsData = await getAllAds(start, end);',
  'const allAdsData = await getAllAds(start, end, (getSessionUser(req))?.orgId || 1);'
);
console.log('4. creative-report passes orgId');

// All other getAllAds/getAllAdsets callers
code = code.replace(
  /await getAllAds\(dateFrom, dateTo\)/g,
  'await getAllAds(dateFrom, dateTo, (getSessionUser(req))?.orgId || 1)'
);
code = code.replace(
  /await getAllAdsets\(dateFrom, dateTo\)/g,
  'await getAllAdsets(dateFrom, dateTo, (getSessionUser(req))?.orgId || 1)'
);
console.log('5. All getAllAds/getAllAdsets callers pass orgId');

// 6. Fix the /api/ads handler which calls for specific ad accounts
// Line ~2366: for (const [,a] of Object.entries(AD_ACCOUNTS_MAP))
code = code.replace(
  `for (const [,a] of Object.entries(AD_ACCOUNTS_MAP)) {`,
  `const _adOrgMeta = getOrgMetaConfig((getSessionUser(req))?.orgId || 1);\n        for (const a of _adOrgMeta.adAccounts) {`
);
console.log('6. /api/ads handler uses org accounts');

// 7. Fix cache keys for adsets to include orgId
code = code.replace(
  "const cacheKey = `adsets_${campaignId}_${dateFrom}_${dateTo}`;",
  "const cacheKey = `adsets_${campaignId}_${dateFrom}_${dateTo}`;"
);
// getAds cache key
code = code.replace(
  /const cacheKey = `ads_\$\{adsetId\}_\$\{dateFrom\}_\$\{dateTo\}`;/,
  "const cacheKey = `ads_${adsetId}_${dateFrom}_${dateTo}`;"
);
console.log('7. Cache keys updated');

// 8. Fix the dashboard handler that uses AD_ACCOUNTS_MAP for adsets count
code = code.replace(
  `for (const acct of Object.values(AD_ACCOUNTS_MAP)) { const ins = await metaGetAll(acct + '/insights',`,
  `const _dashOrgMeta = getOrgMetaConfig(userOrgId); for (const acct of _dashOrgMeta.adAccounts) { const ins = await metaGetAll(acct + '/insights',`
);
console.log('8. Dashboard adsets count uses org accounts');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

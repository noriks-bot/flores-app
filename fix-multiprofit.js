const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Make getMultiPeriodProfit accept orgId parameter
code = code.replace(
  'async function getMultiPeriodProfit() {',
  'async function getMultiPeriodProfit(orgId) {\n  orgId = orgId || 1;'
);
console.log('1. getMultiPeriodProfit accepts orgId');

// 2. Use org-specific accounts
code = code.replace(
  `const allAccounts = Object.values(AD_ACCOUNTS_MAP);
  for (const [period, range] of Object.entries(periods)) {
    let allInsights = [];
    for (const acct of allAccounts) {
      try {
        const ins = await metaGetAll(\`\${acct}/insights\`, {`,
  `const _mpOrgMeta = getOrgMetaConfig(orgId);
  const allAccounts = _mpOrgMeta.adAccounts;
  for (const [period, range] of Object.entries(periods)) {
    let allInsights = [];
    for (const acct of allAccounts) {
      try {
        const ins = await metaGetAll(\`\${acct}/insights\`, {`
);
console.log('2. Uses org-specific ad accounts');

// 3. Pass orgMeta.token to metaGetAll
code = code.replace(
  `fields: 'spend,campaign_id,campaign_name',
          level: 'campaign',
          time_range: JSON.stringify({ since: range.from, until: range.to }),
          limit: 500
        });`,
  `fields: 'spend,campaign_id,campaign_name',
          level: 'campaign',
          time_range: JSON.stringify({ since: range.from, until: range.to }),
          limit: 500
        }, _mpOrgMeta.token);`
);
console.log('3. Uses org-specific token');

// 4. Fix enrichCampaignsWithProfit call - use orgId instead of getSessionUser(req)
code = code.replace(
  `enrichCampaignsWithProfit(camps, range.from, range.to, (getSessionUser(req))?.orgId || 1);`,
  `enrichCampaignsWithProfit(camps, range.from, range.to, orgId);`
);
console.log('4. Fixed enrichCampaignsWithProfit orgId');

// 5. Fix cache key to include orgId
code = code.replace(
  "const cacheKey = 'multiprofit_' + new Date().toISOString().slice(0,10);",
  "const cacheKey = 'multiprofit_' + new Date().toISOString().slice(0,10) + '_org' + orgId;"
);
console.log('5. Cache key includes orgId');

// 6. Fix all callers of getMultiPeriodProfit to pass orgId
code = code.replace(
  /await getMultiPeriodProfit\(\)/g,
  'await getMultiPeriodProfit((getSessionUser(req))?.orgId || 1)'
);
console.log('6. All callers pass orgId');

// Verify syntax
fs.writeFileSync('server.js', code);
try {
  require('child_process').execSync('node -c server.js', { cwd: process.cwd() });
  console.log('\n✅ Syntax OK');
} catch(e) {
  console.error('\n❌ SYNTAX ERROR:', e.stderr?.toString()?.split('\n')[0]);
}

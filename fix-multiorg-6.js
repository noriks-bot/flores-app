const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Fix the two main metaGetAll calls in getCampaigns to pass orgMeta.token
code = code.replace(
  `const insights = await metaGetAll(\`\${orgMeta.adAccount}/insights\`, {
    fields: INSIGHT_FIELDS + ',campaign_id,campaign_name',
    level: 'campaign',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });`,
  `const insights = await metaGetAll(\`\${orgMeta.adAccount}/insights\`, {
    fields: INSIGHT_FIELDS + ',campaign_id,campaign_name',
    level: 'campaign',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  }, orgMeta.token);`
);
console.log('1. insights call passes orgMeta.token');

code = code.replace(
  `const campaigns = await metaGetAll(\`\${orgMeta.adAccount}/campaigns\`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,bid_strategy',
    limit: 500
  });`,
  `const campaigns = await metaGetAll(\`\${orgMeta.adAccount}/campaigns\`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,bid_strategy',
    limit: 500
  }, orgMeta.token);`
);
console.log('2. campaigns call passes orgMeta.token');

// 3. Fix the second accounts loop in getCampaigns to use orgMeta
code = code.replace(
  `for (const acct of allAccounts) {
    if (acct === orgMeta.adAccount) continue;
    try {
      const ins2 = await metaGetAll(acct + '/insights', {`,
  `for (const acct of allAccounts) {
    if (acct === orgMeta.adAccount) continue;
    try {
      const ins2 = await metaGetAll(acct + '/insights', {`
);

// Find the metaGetAll calls in the loop and add token
// ins2 call
code = code.replace(
  `const ins2 = await metaGetAll(acct + '/insights', {
        fields: INSIGHT_FIELDS + ',campaign_id,campaign_name', level: 'campaign',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }), limit: 500
      });`,
  `const ins2 = await metaGetAll(acct + '/insights', {
        fields: INSIGHT_FIELDS + ',campaign_id,campaign_name', level: 'campaign',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }), limit: 500
      }, orgMeta.token);`
);
console.log('3. ins2 call passes orgMeta.token');

// camps2 call
code = code.replace(
  `const camps2 = await metaGetAll(acct + '/campaigns', {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget,bid_strategy', limit: 500
      });`,
  `const camps2 = await metaGetAll(acct + '/campaigns', {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget,bid_strategy', limit: 500
      }, orgMeta.token);`
);
console.log('4. camps2 call passes orgMeta.token');

// 5. Fix campaign name resolve metaGet call
code = code.replace(
  `const m = await metaGet(c.id, { fields: 'id,name' });`,
  `const m = await metaGet(c.id, { fields: 'id,name' }, orgMeta.token);`
);
console.log('5. campaign name resolve passes orgMeta.token');

// 6. Also need to fix the Ads Manager API handlers that call metaGet/metaGetAll
// These need to get org token from session user
// Find getAdsets, getAds functions
// For now, add orgMeta to all metaGetAll/metaGet calls in adset/ad handlers

// getAdsetLevelData function
code = code.replace(
  'async function getAdsetLevelData(campaignId, dateFrom, dateTo) {',
  'async function getAdsetLevelData(campaignId, dateFrom, dateTo, orgToken) {'
);
// Its metaGetAll calls need token
code = code.replace(
  "const insights = await metaGetAll(`${campaignId}/insights`, {\n    fields:",
  "const insights = await metaGetAll(`${campaignId}/insights`, {\n    fields:"
);

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

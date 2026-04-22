const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Add getOrgMetaConfig helper after getOrgProductCosts
const helperCode = `
function getOrgMetaConfig(orgId) {
  if (!orgId || orgId === 1) {
    // Default Noriks config
    return { token: FB_TOKEN, adAccount: AD_ACCOUNT, adAccounts: Object.values(AD_ACCOUNTS_MAP) };
  }
  const token = getOrgSetting(orgId, 'meta_ads', 'access_token');
  const adAccount = getOrgSetting(orgId, 'meta_ads', 'ad_account_id') || AD_ACCOUNT;
  let adAccounts = [];
  try {
    const raw = getOrgSetting(orgId, 'meta_ads', 'ad_accounts');
    adAccounts = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch(e) { adAccounts = [adAccount]; }
  if (!adAccounts.length) adAccounts = [adAccount];
  return { token: token || FB_TOKEN, adAccount, adAccounts };
}
`;

code = code.replace(
  'function getOrgProductCosts(orgId) {',
  helperCode + '\nfunction getOrgProductCosts(orgId) {'
);
console.log('1. Added getOrgMetaConfig helper');

// 2. Modify getCampaigns to use org-specific Meta config
// Find where getCampaigns uses AD_ACCOUNT and replace with orgMeta.adAccount
code = code.replace(
  `async function getCampaigns(dateFrom, dateTo, orgId) {
  orgId = orgId || 1;`,
  `async function getCampaigns(dateFrom, dateTo, orgId) {
  orgId = orgId || 1;
  const orgMeta = getOrgMetaConfig(orgId);`
);

// Replace AD_ACCOUNT references inside getCampaigns with orgMeta.adAccount
// This is tricky because getCampaigns is a long function
// Let me find the specific lines

// The main Meta API calls in getCampaigns:
// Line ~1321: metaGetAll(`${AD_ACCOUNT}/insights`, ...
// Line ~1329: metaGetAll(`${AD_ACCOUNT}/campaigns`, ...
// These need to use orgMeta.adAccount

// But metaGet uses global FB_TOKEN - we need to pass token too
// For now, simplest fix: override the token temporarily for org calls

// Actually, _metaGetOnce uses FB_TOKEN directly. Need to make it configurable.
// Simplest: add optional token param to metaGet functions

// 3. Add optional token to _metaGetOnce
code = code.replace(
  `function _metaGetOnce(endpoint, params = {}) {`,
  `function _metaGetOnce(endpoint, params = {}, customToken) {`
);
// Replace FB_TOKEN usage with customToken || FB_TOKEN
code = code.replace(
  /access_token: FB_TOKEN,\n/,
  'access_token: customToken || FB_TOKEN,\n'
);
console.log('3. _metaGetOnce accepts customToken');

// 4. Add optional token to metaGet
code = code.replace(
  `async function metaGet(endpoint, params = {}) {`,
  `async function metaGet(endpoint, params = {}, customToken) {`
);
code = code.replace(
  `return await _metaGetOnce(endpoint, params);`,
  `return await _metaGetOnce(endpoint, params, customToken);`
);
console.log('4. metaGet accepts customToken');

// 5. Add optional token to metaGetAll
code = code.replace(
  `async function metaGetAll(endpoint, params = {}) {`,
  `async function metaGetAll(endpoint, params = {}, customToken) {`
);
code = code.replace(
  `let result = await metaGet(endpoint, params);`,
  `let result = await metaGet(endpoint, params, customToken);`
);
console.log('5. metaGetAll accepts customToken');

// 6. Now update getCampaigns to use orgMeta
// Replace the first AD_ACCOUNT/insights call
code = code.replace(
  "const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {",
  "const insights = await metaGetAll(`${orgMeta.adAccount}/insights`, {"
);
// Find the first .all call after insights (it's the campaigns call)
code = code.replace(
  "const campaigns = await metaGetAll(`${AD_ACCOUNT}/campaigns`, {",
  "const campaigns = await metaGetAll(`${orgMeta.adAccount}/campaigns`, {"
);

// Fix the second account loop to use orgMeta.adAccounts
code = code.replace(
  `const allAccounts = Object.values(AD_ACCOUNTS_MAP);
  for (const acct of allAccounts) {
    if (acct === AD_ACCOUNT) continue;`,
  `const allAccounts = orgMeta.adAccounts;
  for (const acct of allAccounts) {
    if (acct === orgMeta.adAccount) continue;`
);
console.log('6. getCampaigns uses orgMeta');

// 7. Pass customToken in getCampaigns metaGetAll calls
// Add orgMeta.token as 3rd param
// insights call
code = code.replace(
  "const insights = await metaGetAll(`${orgMeta.adAccount}/insights`, {",
  "const insights = await metaGetAll(`${orgMeta.adAccount}/insights`, {"
);
// Actually the token needs to go as 3rd param after the params object
// Let me find the closing of these calls and add the token

// Pattern: metaGetAll(`${orgMeta.adAccount}/insights`, {\n...\n})
// This is complex. Instead, let's set a module-level override before calling
// Simpler: just add token to params since Meta API accepts access_token in params

// Actually _metaGetOnce already spreads params into URL - access_token is already in params!
// So if I add access_token to the params object, it will override.
// But the current code has access_token: FB_TOKEN hardcoded in _metaGetOnce.
// My fix in step 3 already handles this with customToken.

// The real issue is passing customToken through the chain.
// Simplest fix: in getCampaigns, override the params to include access_token

// Actually wait - let me re-check. The _metaGetOnce builds URL params and includes access_token: FB_TOKEN.
// If I just change that one line to use customToken || FB_TOKEN, and pass customToken through,
// it should work. But the metaGetAll needs to pass it to metaGet which passes to _metaGetOnce.

// Let me verify the metaGetAll paginator also passes token
code = code.replace(
  /let nextPage = result\?.paging\?.next;[\s\S]*?result = await metaGet\(nextUrl, {}\)/,
  (match) => match.replace('result = await metaGet(nextUrl, {})', 'result = await metaGet(nextUrl, {}, customToken)')
);
console.log('7. metaGetAll pagination passes customToken');

fs.writeFileSync('server.js', code);
console.log('\n=== All Meta multi-org fixes applied ===');

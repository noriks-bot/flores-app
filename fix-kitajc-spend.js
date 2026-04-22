const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Add a helper function to get spend by country using Meta API country breakdown
// This is the correct approach for orgs without cc: in campaign names
const helperCode = `
async function getSpendByCountryFromMeta(dateFrom, dateTo, orgId) {
  const orgMeta = getOrgMetaConfig(orgId);
  const result = {};
  try {
    for (const acct of orgMeta.adAccounts) {
      const data = await metaGetAll(acct + '/insights', {
        fields: 'spend',
        breakdowns: 'country',
        level: 'account',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        time_increment: 1,
        limit: 5000
      }, orgMeta.token);
      for (const row of data) {
        const cc = (row.country || '').toUpperCase();
        if (!cc) continue;
        result[cc] = (result[cc] || 0) + parseFloat(row.spend || 0);
      }
    }
  } catch(e) { console.warn('[getSpendByCountry] Error:', e.message); }
  // Round
  for (const cc of Object.keys(result)) result[cc] = Math.round(result[cc] * 100) / 100;
  return result;
}
`;

// Insert before getOrgMetaConfig
code = code.replace(
  'function getOrgMetaConfig(orgId) {',
  helperCode + '\nfunction getOrgMetaConfig(orgId) {'
);
console.log('1. Added getSpendByCountryFromMeta helper');

// 2. In base-report, for non-Noriks orgs, use country breakdown instead of campaign parsing
// Find where byCountry spend is calculated
// Current flow: iterate campaigns → parse country from name → split spend
// For Kitajc: use direct country breakdown from Meta

// Find the spend splitting section in base-report
// After "// 3. Spend by country:" comment
const spendSection = `// 3. Spend by country: sum campaign spend per country using DB order distribution
        // (same basis as overall: overall = sum campaignData.insights.spend)
        const byCountry = {};
        const byType = {};
        const byCountryAndType = {};`;

const newSpendSection = `// 3. Spend by country
        const _reportOrgId = (getSessionUser(req))?.orgId || 1;
        const _useCountryBreakdown = _reportOrgId !== 1; // Non-Noriks orgs use Meta country breakdown
        let _metaSpendByCountry = {};
        if (_useCountryBreakdown) {
          _metaSpendByCountry = await getSpendByCountryFromMeta(start, end, _reportOrgId);
        }
        const byCountry = {};
        const byType = {};
        const byCountryAndType = {};`;

code = code.replace(spendSection, newSpendSection);
console.log('2. Added country breakdown fetch for non-Noriks orgs');

// 3. After DB orders are loaded, override spend with Meta country breakdown for non-Noriks
// Find where spend is assigned to byCountry
// Current: iterates campaigns and splits spend by parsed country
// For Kitajc: skip campaign iteration, use direct Meta spend

// Find the part that fills byCountry with DB data
const fillSection = `for (const [cc, dbData] of Object.entries(dbOrdersByCountry)) {
          if (!byCountry[cc]) byCountry[cc] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
          byCountry[cc].orders = dbData.orders;
          byCountry[cc].revenue = Math.round(dbData.revenue * 100) / 100;
          byCountry[cc].profit = Math.round(dbData.profit * 100) / 100;
          byCountry[cc].spend = Math.round(byCountry[cc].spend * 100) / 100;`;

const newFillSection = `for (const [cc, dbData] of Object.entries(dbOrdersByCountry)) {
          if (!byCountry[cc]) byCountry[cc] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
          byCountry[cc].orders = dbData.orders;
          byCountry[cc].revenue = Math.round(dbData.revenue * 100) / 100;
          byCountry[cc].profit = Math.round(dbData.profit * 100) / 100;
          // For non-Noriks orgs, use Meta country breakdown for spend
          if (_useCountryBreakdown && _metaSpendByCountry[cc] !== undefined) {
            byCountry[cc].spend = _metaSpendByCountry[cc];
          } else {
            byCountry[cc].spend = Math.round(byCountry[cc].spend * 100) / 100;
          }`;

code = code.replace(fillSection, newFillSection);
console.log('3. Override spend with Meta country breakdown for non-Noriks');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

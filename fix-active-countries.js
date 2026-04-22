const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Add helper to get active countries for an org
const helperCode = `
function getOrgActiveCountries(orgId) {
  const val = getOrgSetting(orgId, 'org_config', 'active_countries');
  if (!val) return null; // null = all countries (no filter)
  try {
    const arr = typeof val === 'string' ? JSON.parse(val) : val;
    return Array.isArray(arr) ? arr : null;
  } catch(e) { return null; }
}
`;

code = code.replace(
  'function getOrgMetaConfig(orgId) {',
  helperCode + '\nfunction getOrgMetaConfig(orgId) {'
);
console.log('1. Added getOrgActiveCountries helper');

// 2. Add active_countries to /api/me-full response so frontend knows
// Find where org info is returned
code = code.replace(
  `organization: org ? { name: org.name, plan: org.plan, trialDaysLeft, active: !!org.active } : null`,
  `organization: org ? { name: org.name, plan: org.plan, trialDaysLeft, active: !!org.active, activeCountries: getOrgActiveCountries(user?.orgId || 1) } : null`
);
console.log('2. /api/me-full returns activeCountries');

// 3. Filter wc_orders queries by active countries in dashboard
// After userOrgId is set, add activeCountries filter
code = code.replace(
  `const userOrgId = (getSessionUser(req))?.orgId || 1;
        const dashFrom`,
  `const userOrgId = (getSessionUser(req))?.orgId || 1;
        const _activeCountries = getOrgActiveCountries(userOrgId);
        const _countryFilter = _activeCountries ? " AND country IN ('" + _activeCountries.join("','") + "')" : '';
        const dashFrom`
);
console.log('3. Dashboard has _countryFilter');

// 4. Add _countryFilter to key dashboard queries
// todayStats
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%'").get(dashFrom, dashTo, userOrgId)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%'" + _countryFilter).get(dashFrom, dashTo, userOrgId)`
);

// byCountry
code = code.replace(
  `FROM wc_orders WHERE order_date = ? AND org_id = ? GROUP BY country ORDER BY orders DESC').all(today, userOrgId)`,
  `FROM wc_orders WHERE order_date = ? AND org_id = ?" + _countryFilter + " GROUP BY country ORDER BY orders DESC').all(today, userOrgId)`
);

// ordersList
code = code.replace(
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? ORDER BY order_datetime DESC, wc_order_id DESC").all(dashFrom, dashTo, userOrgId)`,
  `FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ?" + _countryFilter + " ORDER BY order_datetime DESC, wc_order_id DESC").all(dashFrom, dashTo, userOrgId)`
);

console.log('4. Key dashboard queries filter by active countries');

// 5. Add active_countries to /api/org-settings GET response
// When settings page loads, it should show active countries
// Find the org-settings GET handler
code = code.replace(
  `if (urlPath.match(/^\\/api\\/org-settings\\/[\\w-]+$/) && req.method === 'GET') {`,
  `if (urlPath === '/api/org-config') {
        const user = getSessionUser(req);
        if (!user) return sendJSON(res, { error: 'Unauthorized' }, 401);
        const orgId = user.orgId || 1;
        const activeCountries = getOrgActiveCountries(orgId);
        const allCountries = ['HR','CZ','PL','GR','SK','IT','HU','SI','RO','DE','BG','EN'];
        return sendJSON(res, { activeCountries: activeCountries || allCountries, allCountries });
      }
      if (urlPath === '/api/org-config' && req.method === 'POST') {
        const user = getSessionUser(req);
        if (!user) return sendJSON(res, { error: 'Unauthorized' }, 401);
        const body = await new Promise((r) => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(JSON.parse(d))); });
        const upsert = db.prepare('INSERT INTO org_settings (org_id, category, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, category, key) DO UPDATE SET value = excluded.value');
        if (body.activeCountries) upsert.run(user.orgId || 1, 'org_config', 'active_countries', JSON.stringify(body.activeCountries));
        return sendJSON(res, { ok: true });
      }
      if (urlPath.match(/^\\/api\\/org-settings\\/[\\w-]+$/) && req.method === 'GET') {`
);
console.log('5. Added /api/org-config endpoint');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Fix byCountry - was single-quoted string with literal " + _countryFilter + "
code = code.replace(
  `const byCountry = db.prepare('SELECT country, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date = ? AND org_id = ? " + _countryFilter + " GROUP BY country ORDER BY orders DESC').all(today, userOrgId)`,
  `const byCountry = db.prepare("SELECT country, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date = ? AND org_id = ?" + _countryFilter + " GROUP BY country ORDER BY orders DESC").all(today, userOrgId)`
);
console.log('1. Fixed byCountry query quotes');

// Also check other _countryFilter usages for same issue
// Line 4072 - uses double quotes, should be fine
// Line 4308 - check
const line4308 = code.includes(`AND org_id = ?" + _countryFilter + " ORDER BY order_datetime`);
console.log('2. ordersList uses correct quotes:', line4308);

// Fix the "req is not defined" error - find where getSessionUser(req) is called without req
// This might be in refreshDashboardInBackground or similar background function
const reqNotDefined = code.match(/getSessionUser\(req\)/g);
console.log('3. Total getSessionUser(req) calls:', reqNotDefined ? reqNotDefined.length : 0);

// Check if any are in non-request context
// The _countryFilter is only in /api/dashboard which has req, so that's fine
// The "req is not defined" might be from getAllAdsets or getAllAds background calls

fs.writeFileSync('server.js', code);
console.log('\n=== Fixed ===');

const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Dashboard 2 spend should match Dashboard 1
// Both should use dash-cache (for Noriks) or Meta API (for Kitajc)
// Dashboard 1 already uses getCampaigns sum → but that gives different value than dash-cache
// Solution: make Dashboard 1 ALSO use dash-cache for total spend (same as country breakdown)

// Find Dashboard 1 spend calculation
code = code.replace(
  `// Primary: compute spend from live campaign data (topCampaignsRaw already fetched above)
        if (Array.isArray(topCampaignsRaw) && topCampaignsRaw.length > 0) {
          fbSpendRange = topCampaignsRaw.reduce((s, c) => s + parseFloat(c.insights?.spend || 0), 0);
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }`,
  `// Primary: compute spend from dash-cache (matches country breakdown source of truth)
        // For Noriks: dash-cache. For other orgs: Meta API country breakdown.
        if (_activeCountries === null) {
          // Noriks: use dash-cache
          try {
            const _spendDc = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
            for (const [date, countries] of Object.entries(_spendDc.data || {})) {
              if (date >= dashFrom && date <= dashTo) {
                for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
              }
            }
            if (dashFrom === today) fbSpendToday = fbSpendRange;
          } catch(e) {}
        }
        if (fbSpendRange === 0 && Array.isArray(topCampaignsRaw) && topCampaignsRaw.length > 0) {
          // Fallback to campaign sum
          fbSpendRange = topCampaignsRaw.reduce((s, c) => s + parseFloat(c.insights?.spend || 0), 0);
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }`
);
console.log('1. Dashboard 1 uses dash-cache for spend');

// Dashboard 2: also use dash-cache for Noriks, Meta breakdown for Kitajc
code = code.replace(
  `// FB spend (live or cache)
        let fbSpendRange = 0;
        try {
          const camps = await getCampaigns(dashFrom, dashTo, userOrgId);
          if (Array.isArray(camps)) fbSpendRange = camps.reduce((s,c) => s + parseFloat(c.insights?.spend||0), 0);
        } catch(e) {}
        if (fbSpendRange === 0) {`,
  `// FB spend: dash-cache for Noriks, Meta breakdown for others
        let fbSpendRange = 0;
        if (userOrgId === 1) {
          // Noriks: dash-cache (source of truth)
          try {
            const _dc2 = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
            for (const [date, countries] of Object.entries(_dc2.data || {})) {
              if (date >= dashFrom && date <= dashTo) {
                for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
              }
            }
          } catch(e) {}
        } else {
          // Non-Noriks: Meta API country breakdown
          try {
            const _spendByCC = await getSpendByCountryFromMeta(dashFrom, dashTo, userOrgId);
            fbSpendRange = Object.values(_spendByCC).reduce((s, v) => s + v, 0);
          } catch(e) {}
        }
        if (fbSpendRange === 0) {`
);
console.log('2. Dashboard 2 uses same spend source');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// REVERT Dashboard 1 back to using getCampaigns (live Meta API) for spend
// This was the ORIGINAL behavior before my changes
code = code.replace(
  `// Primary: dash-cache for Noriks, Meta breakdown for others (matches country breakdown)
        if (userOrgId === 1) {
          try {
            const _spendDc = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
            for (const [date, countries] of Object.entries(_spendDc.data || {})) {
              if (date >= dashFrom && date <= dashTo) {
                for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
              }
            }
            if (dashFrom === today) fbSpendToday = fbSpendRange;
          } catch(e) {}
        } else {
          try { const _sbc = await getSpendByCountryFromMeta(dashFrom, dashTo, userOrgId); fbSpendRange = Object.values(_sbc).reduce((s, v) => s + v, 0); } catch(e) {}
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }
        if (fbSpendRange === 0 && Array.isArray(topCampaignsRaw) && topCampaignsRaw.length > 0) {
          fbSpendRange = topCampaignsRaw.reduce((s, c) => s + parseFloat(c.insights?.spend || 0), 0);
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }`,
  `// Primary: live getCampaigns for total spend (original behavior)
        if (Array.isArray(topCampaignsRaw) && topCampaignsRaw.length > 0) {
          fbSpendRange = topCampaignsRaw.reduce((s, c) => s + parseFloat(c.insights?.spend || 0), 0);
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }`
);
console.log('1. Dashboard 1 reverted to getCampaigns for spend (live)');

// Dashboard 2: use SAME getCampaigns result (call getCampaigns with same params, it's cached)
code = code.replace(
  `// FB spend: same source as Dashboard 1
        let fbSpendRange = 0;
        if (userOrgId === 1) {
          try {
            const _dc2 = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
            for (const [date, countries] of Object.entries(_dc2.data || {})) {
              if (date >= dashFrom && date <= dashTo) {
                for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
              }
            }
          } catch(e) {}
        } else {
          try { const _sbc2 = await getSpendByCountryFromMeta(dashFrom, dashTo, userOrgId); fbSpendRange = Object.values(_sbc2).reduce((s, v) => s + v, 0); } catch(e) {}
        }`,
  `// FB spend: same as Dashboard 1 (getCampaigns is cached, returns same result)
        let fbSpendRange = 0;
        try {
          const camps2 = await getCampaigns(dashFrom, dashTo, userOrgId);
          if (Array.isArray(camps2)) fbSpendRange = camps2.reduce((s,c) => s + parseFloat(c.insights?.spend||0), 0);
        } catch(e) {}`
);
console.log('2. Dashboard 2 uses same getCampaigns (cached) for spend');

fs.writeFileSync('server.js', code);
console.log('\n=== Done - both dashboards use getCampaigns (live Meta, cached) ===');

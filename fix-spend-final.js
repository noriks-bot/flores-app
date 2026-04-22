const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Dashboard 1: change spend source to dash-cache for Noriks
code = code.replace(
  `// Primary: compute spend from live campaign data (topCampaignsRaw already fetched above)
        if (Array.isArray(topCampaignsRaw) && topCampaignsRaw.length > 0) {
          fbSpendRange = topCampaignsRaw.reduce((s, c) => s + parseFloat(c.insights?.spend || 0), 0);
          if (dashFrom === today) fbSpendToday = fbSpendRange;
        }`,
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
        }`
);
console.log('1. Dashboard 1 spend from dash-cache/Meta breakdown');

// 2. Dashboard 2: change spend source to match Dashboard 1
code = code.replace(
  `// FB spend (live or cache)
        let fbSpendRange = 0;
        try {
          const camps = await getCampaigns(dashFrom, dashTo, userOrgId);
          if (Array.isArray(camps)) fbSpendRange = camps.reduce((s,c) => s + parseFloat(c.insights?.spend||0), 0);
        } catch(e) {}
        if (fbSpendRange === 0) {
          try {
            const dc = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
            for (const [date, countries] of Object.entries(dc.data || {})) {
              if (date >= dashFrom && date <= dashTo) {
                for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
              }
            }
          } catch(e) {}
        }`,
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
        }`
);
console.log('2. Dashboard 2 spend matches Dashboard 1');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

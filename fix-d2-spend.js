const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const marker = `const rows = db.prepare("SELECT country, gross_eur, product_cost, shipping_cost, profit, is_fb_attributed FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND org_id = ? AND LOWER(billing_name) NOT LIKE '%test%'").all(dashFrom, dashTo, userOrgId);`;

const replacement = `// FB spend: same source as Dashboard 1
        let fbSpendRange = 0;
        if (userOrgId === 1) {
          try { const _dc2 = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8')); for (const [date, countries] of Object.entries(_dc2.data || {})) { if (date >= dashFrom && date <= dashTo) { for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; } } } } catch(e) {}
        } else {
          try { const _sbc = await getSpendByCountryFromMeta(dashFrom, dashTo, userOrgId); fbSpendRange = Object.values(_sbc).reduce((s, v) => s + v, 0); } catch(e) {}
        }
        ${marker}`;

if (code.includes(marker)) {
  code = code.replace(marker, replacement);
  console.log('Added fbSpendRange to dashboard2');
} else {
  console.log('Marker not found!');
}

fs.writeFileSync('server.js', code);

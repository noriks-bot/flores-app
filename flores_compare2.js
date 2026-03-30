const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

// Check what raw_meta contains
const orders = db.prepare("SELECT id, country, gross_eur, profit, shipping_cost, product_type, raw_meta FROM wc_orders WHERE order_date = '2026-03-30' ORDER BY id LIMIT 3").all();

for (const o of orders) {
  console.log(`Order ${o.id} [${o.country}]:`);
  try {
    const meta = JSON.parse(o.raw_meta || '{}');
    console.log('  Keys:', Object.keys(meta).join(', '));
    if (meta.line_items) {
      console.log('  line_items:', meta.line_items.length);
      meta.line_items.forEach(i => console.log('    -', i.name, 'x', i.quantity, 'sku:', i.sku));
    } else {
      console.log('  NO line_items in raw_meta');
      // Show first 200 chars
      console.log('  raw_meta preview:', o.raw_meta?.substring(0, 300));
    }
  } catch(e) {
    console.log('  raw_meta parse error or null:', o.raw_meta?.substring(0, 100));
  }
}

// Also check: how is product cost stored? Is there a product_cost column?
const cols = db.prepare("PRAGMA table_info(wc_orders)").all();
console.log('\nColumns:', cols.map(c => c.name).join(', '));

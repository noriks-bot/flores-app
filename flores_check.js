const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'flores.db'));

const orders = db.prepare("SELECT id, country, gross_eur, profit, shipping_cost, product_type FROM wc_orders WHERE order_date = '2026-03-30' ORDER BY id").all();
console.log('Orders today:', orders.length);
console.log('Total profit in DB:', orders.reduce((s,o) => s + o.profit, 0).toFixed(2));
orders.forEach(o => console.log(JSON.stringify(o)));

const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Fix POST /api/log to include org_id
code = code.replace(
  "db.prepare('INSERT INTO change_log (change_type, entity_id, entity_name, country, old_value, new_value, user, spend_at_change, orders_at_change, profit_at_change, cpa_at_change, roas_at_change, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(changeType, entityId, entityName || '', country || '', oldValue || '', newValue || '', actualUser, spendAtChange || 0, ordersAtChange || 0, profitAtChange || 0, cpaAtChange, roasAtChange, ljNow());",
  "db.prepare('INSERT INTO change_log (change_type, entity_id, entity_name, country, old_value, new_value, user, spend_at_change, orders_at_change, profit_at_change, cpa_at_change, roas_at_change, timestamp, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(changeType, entityId, entityName || '', country || '', oldValue || '', newValue || '', actualUser, spendAtChange || 0, ordersAtChange || 0, profitAtChange || 0, cpaAtChange, roasAtChange, ljNow(), sessionUser?.orgId || 1);"
);
console.log('1. POST /api/log now writes org_id');

// 2. Fix GET /api/log to filter by org_id
code = code.replace(
  `if (isAdmin) {
          rows = db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(limit);
        } else {
          rows = db.prepare('SELECT * FROM change_log WHERE user = ? ORDER BY id DESC LIMIT ?').all(sessionUser?.username || '', limit);
        }`,
  `const logOrgId = sessionUser?.orgId || 1;
        if (isAdmin) {
          rows = db.prepare('SELECT * FROM change_log WHERE org_id = ? ORDER BY id DESC LIMIT ?').all(logOrgId, limit);
        } else {
          rows = db.prepare('SELECT * FROM change_log WHERE org_id = ? AND user = ? ORDER BY id DESC LIMIT ?').all(logOrgId, sessionUser?.username || '', limit);
        }`
);
console.log('2. GET /api/log now filters by org_id');

fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');

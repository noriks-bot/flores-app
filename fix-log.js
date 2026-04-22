const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Replace activity-log WHERE clause to use parameterized query
code = code.replace(
  `let where = 'WHERE org_id = ' + (user?.orgId || 1);
        const params = [];`,
  `const userOrgId = Number(user.orgId) || 1;
        console.log('[ACTIVITY] User:', user.username, 'orgId:', userOrgId);
        let where = 'WHERE org_id = ?';
        const params = [userOrgId];`
);

// Fix filter queries
code = code.replace(
  ".all(user?.orgId || 1).map(r => r.username)",
  ".all(Number(user?.orgId) || 1).map(r => r.username)"
);
code = code.replace(
  ".all(user?.orgId || 1).map(r => r.action)",
  ".all(Number(user?.orgId) || 1).map(r => r.action)"
);

fs.writeFileSync('server.js', code);
console.log('Fixed activity log handler');

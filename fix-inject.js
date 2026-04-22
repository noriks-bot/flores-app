const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Replace the appHtml line to inject org config synchronously
const oldLine = `const appHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('</head>', '<meta http-equiv="Pragma" content="no-cache"><meta http-equiv="Expires" content="0"></head>').replace('</body>', '<script>/* v' + Date.now() + ' */</script></body>');`;

const newLine = `const _appUser = getSessionUser(req);
    const _appOrgId = _appUser ? _appUser.orgId || 1 : 1;
    const _appManipDisabled = getOrgSetting(_appOrgId, 'adv_config', 'manipulation_enabled') === '0';
    const _appActiveCountries = getOrgActiveCountries(_appOrgId);
    const _appInject = '<script>window._manipDisabled=' + JSON.stringify(!!_appManipDisabled) + ';window._activeCountries=' + JSON.stringify(_appActiveCountries) + ';<\\/script>';
    const appHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('</head>', '<meta http-equiv="Pragma" content="no-cache"><meta http-equiv="Expires" content="0">' + _appInject + '</head>').replace('</body>', '<script>/* v' + Date.now() + ' */</script></body>');`;

if (code.includes(oldLine)) {
  code = code.replace(oldLine, newLine);
  console.log('Replaced appHtml injection');
} else {
  console.log('OLD LINE NOT FOUND');
}

fs.writeFileSync('server.js', code);
try {
  require('child_process').execSync('node -c server.js', { cwd: process.cwd() });
  console.log('✅ Syntax OK');
} catch(e) {
  console.error('❌ SYNTAX ERROR');
}

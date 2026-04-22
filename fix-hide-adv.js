const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Change the inject to also add CSS that hides ADV columns when manipulation is disabled
code = code.replace(
  `const _appInject = '<script>window._manipDisabled=' + JSON.stringify(!!_appManipDisabled) + ';window._activeCountries=' + JSON.stringify(_appActiveCountries) + ';<\\/script>';`,
  `const _appInject = '<script>window._manipDisabled=' + JSON.stringify(!!_appManipDisabled) + ';window._activeCountries=' + JSON.stringify(_appActiveCountries) + ';<\\/script>' + (_appManipDisabled ? '<style>.adv-col,.adv-only{display:none!important}</style>' : '');`
);
console.log('1. Server injects CSS to hide ADV columns when manipulation disabled');

fs.writeFileSync('server.js', code);
try {
  require('child_process').execSync('node -c server.js', { cwd: process.cwd() });
  console.log('✅ Syntax OK');
} catch(e) {
  console.error('❌ SYNTAX ERROR');
}

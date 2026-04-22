const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// 1. Add global activeCountries variable and fetch it on page load
// After window._currentUser = u; add fetch for org config
code = code.replace(
  `window._currentUser = u;
    
    // Update sidebar user`,
  `window._currentUser = u;
    
    // Fetch active countries for this org
    try {
      var orgCfg = await (await fetch('/api/org-config', {credentials:'same-origin'})).json();
      window._activeCountries = orgCfg.activeCountries || null;
    } catch(e) { window._activeCountries = null; }
    
    // Update sidebar user`
);

// But this is in a .then() chain, need to make it async-compatible
// Actually .then(function(u) { is not async. Let me add it differently.
// Revert and add a separate fetch after the .then chain

// Actually let's just add a separate call
code = code.replace(
  `window._activeCountries = null; }
    
    // Update sidebar user`,
  `window._activeCountries = null; }
    
    // Update sidebar user`
);

// Let me try a cleaner approach - add the fetch at the end of the init block
code = code.replace(
  `// Hide admin-only nav items for non-admin users
    if (u.role !== 'admin' && u.role !== 'super_admin') {`,
  `// Fetch active countries
    fetch('/api/org-config', {credentials:'same-origin'}).then(function(r){return r.json()}).then(function(cfg){
      window._activeCountries = cfg.activeCountries || null;
      // Filter country dropdowns if active countries set
      if (window._activeCountries) {
        document.querySelectorAll('select').forEach(function(sel) {
          if (sel.id && (sel.id.toLowerCase().includes('country') || sel.id.toLowerCase().includes('ctry'))) {
            Array.from(sel.options).forEach(function(opt) {
              if (opt.value && opt.value.length === 2 && !window._activeCountries.includes(opt.value)) {
                opt.style.display = 'none';
              }
            });
          }
        });
      }
    }).catch(function(){});
    
    // Hide admin-only nav items for non-admin users
    if (u.role !== 'admin' && u.role !== 'super_admin') {`
);
console.log('1. Added activeCountries fetch on page load');

// 2. Add active countries display to Settings page
// Find settings section
const settingsMarker = "id=\"section-settings\"";
if (code.includes(settingsMarker)) {
  // Add org countries config at top of settings section
  code = code.replace(
    settingsMarker + '" class="content-section">',
    settingsMarker + '" class="content-section">\n    <div id="org-countries-config" style="margin-bottom:20px;padding:16px;background:var(--card-bg);border:1px solid var(--border-color);border-radius:12px;display:none"><div style="font-weight:700;margin-bottom:8px">🌍 Active Countries</div><div id="org-countries-list" style="display:flex;flex-wrap:wrap;gap:8px"></div></div>'
  );
  console.log('2. Added countries config UI to settings');
}

// 3. Add JS to populate the countries config
code = code.replace(
  `fetch('/api/org-config', {credentials:'same-origin'}).then(function(r){return r.json()}).then(function(cfg){`,
  `fetch('/api/org-config', {credentials:'same-origin'}).then(function(r){return r.json()}).then(function(cfg){
      // Show active countries in settings
      var ccDiv = document.getElementById('org-countries-list');
      var ccContainer = document.getElementById('org-countries-config');
      if (ccDiv && cfg.activeCountries) {
        ccContainer.style.display = 'block';
        var FLAGS = {HR:'🇭🇷',CZ:'🇨🇿',PL:'🇵🇱',GR:'🇬🇷',SK:'🇸🇰',IT:'🇮🇹',HU:'🇭🇺',SI:'🇸🇮',RO:'🇷🇴',DE:'🇩🇪',BG:'🇧🇬',EN:'🇬🇧'};
        ccDiv.innerHTML = (cfg.allCountries || []).map(function(cc) {
          var active = cfg.activeCountries.includes(cc);
          return '<span style="padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:default;' + (active ? 'background:#dcfce7;color:#166534;border:1px solid #86efac' : 'background:#f3f4f6;color:#9ca3af;border:1px solid #e5e7eb;text-decoration:line-through') + '">' + (FLAGS[cc]||'') + ' ' + cc + '</span>';
        }).join('');
      }`
);
console.log('3. Settings shows active/inactive countries');

fs.writeFileSync('index.html', code);
console.log('\n=== Frontend updated ===');

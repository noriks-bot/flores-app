const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { detectProduct: sharedDetectProduct } = require('./detect-product');

// Load rejection rates from dash
let dashRejectionRates = {};
try {
  const rejFile = '/home/ec2-user/apps/raketa/dashboard/rejections.json';
  if (fs.existsSync(rejFile)) {
    dashRejectionRates = JSON.parse(fs.readFileSync(rejFile, 'utf8'));
    console.log('[FLORES] Loaded dash rejection rates:', Object.keys(dashRejectionRates).join(','));
  }
} catch(e) { console.warn('[FLORES] Could not load dash rejection rates:', e.message); }

const PORT = 3200;
let _dashboardCache = null;
let _dashboardCacheTime = 0;
let _dashRefreshing = false;
const META_TOKEN = 'EAASl5P6z0UYBRJrZCHWVQvMLmwwDu5jzdA5NEdl9t5K4ogCgH5Pi7acEEKhKSf5LYQKQcx9vd6S7euJRJWeICdZCHsVtUyQfVbF4lxAU25t9sRONxjhVZCBAv0nAnQJ7qiszzZBCR75JHzMXfSACfhxApcZBB0tMRngZAZBXQ3c0c4VeZC8OU6ltFc9YaCydW8Vg';
const FB_APP_ID = '1308302851166534';
const FB_APP_SECRET = '055332aa992f885134cf9cb6cd3ce5cf';
const NORIKS_PAGE_ID = '104695358812961';
const NORIKS_PAGE_TOKEN = 'EAASl5P6z0UYBRBeMx5auFDmvdkLwZCm8AZAsaVWqcNvyTFZAZBggUFybXpimvtfceKJIjPijA0prRvgWBILLBtdANqShzEmf8PxVCR9Dg5ZACR8Xsx2ucpO19HNktZCbSCK68rd7shT4ZC1SCZC3WkTNuJysHRqvfHlHuF1WdB5Sd2TNB5fAGvVOfnNNZCFE2ZCPWXJRIaiOAZD';
const AD_ACCOUNTS_MAP = { 'top_noriks_2': 'act_1922887421998222', 'top_noriks_4': 'act_1426869489183439' };
const AD_ACCOUNT = 'act_1922887421998222';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// LLM-powered analysis
async function callLLM(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.choices && j.choices[0]) resolve(j.choices[0].message.content);
          else reject(new Error(j.error?.message || 'LLM call failed'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.end(payload);
  });
}


// Call Dominik agent via OpenClaw CLI
async function callDominikAgent(message) {
  return new Promise((resolve, reject) => {
    const proc = execFile('openclaw', [
      'agent',
      '--agent', 'dominik',
      '--message', message,
      '--json',
      '--timeout', '120'
    ], { timeout: 130000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Dominik agent error:', error.message);
        // Fallback to OpenAI if openclaw agent fails
        return callLLM(AI_SYSTEM_PROMPT, message).then(resolve).catch(reject);
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result.reply || result.content || result.message || stdout);
      } catch(e) {
        // stdout might be plain text response
        resolve(stdout.trim() || 'No response from Dominik');
      }
    });
  });
}

const AI_SYSTEM_PROMPT = `You are Dominik, an elite Facebook Ads strategist for Noriks (fashion e-commerce: t-shirts, boxers, starter packs across HR, CZ, PL, GR, SK, IT, HU).

Your analysis style:
- Direct, actionable, no fluff
- Always reference specific numbers
- Prioritize by impact (highest spend/worst CPA first)
- Use emojis sparingly for visual scanning: \u{1F534} critical, \u{1F7E1} warning, \u{1F7E2} good, \u{1F680} opportunity
- Structure with clear headers (## sections)
- Give SPECIFIC actions: "Pause adset X", "Scale campaign Y by 20%", "Test creative Z in country W"
- Consider seasonality and market maturity
- Compare CPA against benchmarks: Excellent <10\u20ac, Strong <15\u20ac, Good <20\u20ac, Weak >20\u20ac
- Think about creative fatigue, audience saturation, scaling opportunities
- When analyzing campaigns, consider the full funnel: spend > clicks > purchases > CPA > profit

Always end with a prioritized action list (top 3-5 actions, numbered).
Respond in English with Slovenian market terms where relevant.`;

// Dropbox integration
const DROPBOX_APP_KEY = 'h7gx1yglwenhrz2';
const DROPBOX_APP_SECRET = '3n4ebxqlqfehwkr';
const DROPBOX_REFRESH_TOKEN = '2HlTHHp3-2QAAAAAAAAAAZD8orXfKnu4Srqe6Us7JrIY_B_NKu0tXb9HWum7CBaE';
const DROPBOX_ROOT = '13547329251';
const DROPBOX_FOLDER = '/NORIKS Team Folder/TEJA - KREATIVE/FINAL CREATIVES 🔥';
let DROPBOX_ACCESS_TOKEN = null;
let dropboxTokenExpires = 0;
let videosCache = null;
let videosCacheTime = 0;
const VIDEOS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const API_VERSION = 'v21.0';
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- WooCommerce profit data from dash.noriks.com ---
const DASH_CACHE_FILE = path.join(CACHE_DIR, 'dash-cache.json');
const ORIGIN_CACHE_FILE = path.join(CACHE_DIR, 'origin-data.json');

const PRODUCT_COSTS = { tshirt: 3.5, boxers: 2.25 };
const EUR_RATES = { HR: 1, CZ: 0.041, PL: 0.232, GR: 1, IT: 1, HU: 0.00256, SK: 1 };

// WooCommerce API keys per country store
const WC_STORES = {
  HR: { url: 'https://noriks.com/hr', ck: 'ck_ff08e90a8ff90be9f7fdfe7badfd4fdaa456d86b', cs: 'cs_0c36e01e44e488ae9d8a931b591a4d52584d975f' },
  CZ: { url: 'https://noriks.com/cz', ck: 'ck_396d624acec5f7a46dfcfa7d2a74b95c82b38962', cs: 'cs_2a69c7ad4a4d118a2b8abdf44abdd058c9be9115' },
  PL: { url: 'https://noriks.com/pl', ck: 'ck_8fd83582ada887d0e586a04bf870d43634ca8f2c', cs: 'cs_f1bf98e46a3ae0623c5f2f9fcf7c2478240c5115' },
  GR: { url: 'https://noriks.com/gr', ck: 'ck_2595568b83966151e08031e42388dd1c34307107', cs: 'cs_dbd091b4fc11091638f8ec4c838483be32cfb15b' },
  SK: { url: 'https://noriks.com/sk', ck: 'ck_1abaeb006bb9039da0ad40f00ab674067ff1d978', cs: 'cs_32b33bc2716b07a738ff18eb377a767ef60edfe7' },
  IT: { url: 'https://noriks.com/it', ck: 'ck_84a1e1425710ff9eeed69b100ed9ac445efc39e2', cs: 'cs_81d25dcb0371773387da4d30482afc7ce83d1b3e' },
  HU: { url: 'https://noriks.com/hu', ck: 'ck_e591c2a0bf8c7a59ec5893e03adde3c760fbdaae', cs: 'cs_d84113ee7a446322d191be0725c0c92883c984c3' }
};
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };

// Parse campaign name for country + product type
// Supports both old format: DRŽAVA__TIP and new format: cc:DRŽAVA | TIP | sku:PRODUCT | date: DD.MM.YYYY
function parseCampaignName(name) {
  if (!name) return { countries: [], productType: null };
  const n = name.toUpperCase();
  const VALID_COUNTRIES = ['HR','CZ','PL','GR','SK','IT','HU'];
  
  let countries = [];
  
  // New format: cc:HR or cc:GR+IT+SK
  const ccMatch = n.match(/CC:([A-Z+]+)/);
  if (ccMatch) {
    countries = ccMatch[1].split('+').filter(c => VALID_COUNTRIES.includes(c));
  }
  
  // Old format fallback: DRŽAVA__TIP (before __)
  if (!countries.length) {
    const countryMatch = n.match(/^([A-Z_+]+?)__/);
    if (countryMatch) {
      countries = countryMatch[1].split(/[+_]/).filter(c => VALID_COUNTRIES.includes(c));
    }
  }
  
  // Extract product type from sku: field or keywords
  let productType = null;
  if (/SKU:SHIRTS|MAJICE|SHIRT/i.test(n)) productType = 'shirts';
  else if (/SKU:BOXERS|BOXERS|BOXER/i.test(n)) productType = 'boxers';
  else if (/SKU:STARTER_PACK|STARTER/i.test(n)) productType = 'starter';
  else if (/SKU:COMPLETS|2P5|KOMPLET/i.test(n)) productType = 'kompleti';
  else if (/CATALOG/i.test(n)) productType = 'catalog';
  
  return { countries, productType };
}

// Parse campaign type (CBO/ABO/SOFI) from campaign name
function parseCampaignType(name) {
  if (!name) return 'OTHER';
  // Check for pipe-separated segments
  if (/\|\s*CBO[\s|]/i.test(name) || /\|\s*CBO\s*$/i.test(name)) return 'CBO';
  if (/\|\s*ABO[\s|]/i.test(name) || /\|\s*ABO\s*$/i.test(name)) return 'ABO';
  if (/\|\s*SOFI[\s|]/i.test(name) || /\|\s*SOFI\s*$/i.test(name)) return 'SOFI';
  // Fallback: look for the word anywhere
  const n = name.toUpperCase();
  if (/\bCBO\b/.test(n)) return 'CBO';
  if (/\bABO\b/.test(n)) return 'ABO';
  if (/\bSOFI\b/.test(n)) return 'SOFI';
  return 'OTHER';
}

// Load dash cache.json (synced locally)
function loadDashData() {
  try {
    if (fs.existsSync(DASH_CACHE_FILE)) {
      const stat = fs.statSync(DASH_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < 3600000) {
        return JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
      }
    }
  } catch(e) {}
  return null;
}

function loadOriginData() {
  try {
    if (fs.existsSync(ORIGIN_CACHE_FILE)) {
      const stat = fs.statSync(ORIGIN_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < 3600000) {
        return JSON.parse(fs.readFileSync(ORIGIN_CACHE_FILE, 'utf8'));
      }
    }
  } catch(e) {}
  return null;
}

// Sync data from dash server (called on startup + hourly)
const { execSync, execFile } = require('child_process');
function syncDashData() {
  const SRC_DASH = "/home/ec2-user/apps/raketa/dashboard/cache.json";
  const SRC_ORIGIN = "/home/ec2-user/apps/raketa/dashboard/origin-data.json";
  try {
    try { fs.copyFileSync(SRC_DASH, DASH_CACHE_FILE); } catch(e) {}
    try { fs.copyFileSync(SRC_ORIGIN, ORIGIN_CACHE_FILE); } catch(e) {}
    console.log('[FLORES] Synced dash data');
  } catch(e) { console.error('[FLORES] Dash sync failed:', e.message); }
}
syncDashData();
setInterval(syncDashData, 3600000);

// ═══ SQLite Database ═══
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'flores.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS wc_orders (
    id INTEGER PRIMARY KEY,
    country TEXT NOT NULL,
    wc_order_id INTEGER NOT NULL,
    order_date TEXT NOT NULL,
    status TEXT,
    gross_total REAL,
    gross_eur REAL,
    net_revenue REAL,
    product_cost REAL,
    shipping_cost REAL,
    profit REAL,
    product_type TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    is_fb_attributed INTEGER DEFAULT 0,
    raw_meta TEXT,
    created_at TEXT,
    UNIQUE(country, wc_order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_orders_date ON wc_orders(order_date);
  CREATE INDEX IF NOT EXISTS idx_orders_campaign ON wc_orders(utm_campaign);
  CREATE INDEX IF NOT EXISTS idx_orders_country ON wc_orders(country);

  CREATE TABLE IF NOT EXISTS sync_state (
    country TEXT PRIMARY KEY,
    last_synced_order_id INTEGER DEFAULT 0,
    last_sync_at TEXT,
    total_orders INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS flores_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON flores_users(username);
  CREATE INDEX IF NOT EXISTS idx_users_role ON flores_users(role);

  CREATE TABLE IF NOT EXISTS fatigue_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT DEFAULT (datetime('now')),
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flores_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    details TEXT,
    entity_type TEXT,
    entity_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
  CREATE INDEX IF NOT EXISTS idx_activity_log_date ON activity_log(created_at);

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
`);

// ═══ ORGANIZATIONS TABLE ═══
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    plan TEXT DEFAULT 'trial',
    trial_end TEXT,
    stripe_customer_id TEXT,
    max_accounts INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );
`);

// ═══ ORG SETTINGS TABLE ═══
db.exec(`
  CREATE TABLE IF NOT EXISTS org_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    UNIQUE(org_id, category, key)
  );
  CREATE INDEX IF NOT EXISTS idx_org_settings ON org_settings(org_id, category);
`);

// Seed Noriks as org_id=1 if not exists
try {
  const orgCount = db.prepare('SELECT COUNT(*) as cnt FROM organizations').get();
  if (orgCount.cnt === 0) {
    db.prepare("INSERT INTO organizations (name, plan, trial_end, active) VALUES (?, ?, NULL, 1)").run('Noriks', 'enterprise');
  }
} catch(e) { console.error('Org seed error:', e.message); }

// Seed default admin user if no users exist
try {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM flores_users').get();
  if (userCount.cnt === 0) {
    const hash = crypto.createHash('sha256').update('noriks').digest('hex');
    db.prepare('INSERT INTO flores_users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)').run('noriks', hash, 'super_admin', 'Noriks Admin');
  }
} catch(e) { console.error('User seed error:', e.message); }

// Upgrade existing noriks user to super_admin if still admin
try { db.exec("UPDATE flores_users SET role = 'super_admin' WHERE username = 'noriks' AND role = 'admin'"); } catch(e) {}

// Add org_id column for multi-tenant prep
try { db.exec("ALTER TABLE flores_users ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE flores_users ADD COLUMN email TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE flores_settings ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE activity_log ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE notifications ADD COLUMN org_id INTEGER DEFAULT 1"); } catch(e) { /* exists */ }

// ═══ SEED NORIKS ORG SETTINGS ═══
function seedOrgSettings() {
  const upsertSetting = db.prepare('INSERT INTO org_settings (org_id, category, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, category, key) DO UPDATE SET value = excluded.value');
  const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM org_settings WHERE org_id = 1').get().cnt;
  if (existingCount > 0) return; // already seeded

  db.transaction(() => {
    // Countries
    const countries = ['HR','CZ','PL','GR','SK','IT','HU'];
    upsertSetting.run(1, 'countries', 'active', JSON.stringify(countries));

    // WC Stores
    const wcStores = {
      HR: { url: 'https://noriks.com/hr', ck: 'ck_ff08e90a8ff90be9f7fdfe7badfd4fdaa456d86b', cs: 'cs_0c36e01e44e488ae9d8a931b591a4d52584d975f' },
      CZ: { url: 'https://noriks.com/cz', ck: 'ck_396d624acec5f7a46dfcfa7d2a74b95c82b38962', cs: 'cs_2a69c7ad4a4d118a2b8abdf44abdd058c9be9115' },
      PL: { url: 'https://noriks.com/pl', ck: 'ck_8fd83582ada887d0e586a04bf870d43634ca8f2c', cs: 'cs_f1bf98e46a3ae0623c5f2f9fcf7c2478240c5115' },
      GR: { url: 'https://noriks.com/gr', ck: 'ck_2595568b83966151e08031e42388dd1c34307107', cs: 'cs_dbd091b4fc11091638f8ec4c838483be32cfb15b' },
      SK: { url: 'https://noriks.com/sk', ck: 'ck_1abaeb006bb9039da0ad40f00ab674067ff1d978', cs: 'cs_32b33bc2716b07a738ff18eb377a767ef60edfe7' },
      IT: { url: 'https://noriks.com/it', ck: 'ck_84a1e1425710ff9eeed69b100ed9ac445efc39e2', cs: 'cs_81d25dcb0371773387da4d30482afc7ce83d1b3e' },
      HU: { url: 'https://noriks.com/hu', ck: 'ck_e591c2a0bf8c7a59ec5893e03adde3c760fbdaae', cs: 'cs_d84113ee7a446322d191be0725c0c92883c984c3' }
    };
    for (const [cc, store] of Object.entries(wcStores)) {
      upsertSetting.run(1, 'wc_stores', cc, JSON.stringify(store));
    }

    // Meta API
    upsertSetting.run(1, 'meta_api', 'access_token', META_TOKEN);
    upsertSetting.run(1, 'meta_api', 'ad_accounts', JSON.stringify(Object.values(AD_ACCOUNTS_MAP)));
    upsertSetting.run(1, 'meta_api', 'page_id', NORIKS_PAGE_ID);
    upsertSetting.run(1, 'meta_api', 'page_access_token', NORIKS_PAGE_TOKEN);

    // Product Costs
    upsertSetting.run(1, 'product_costs', 'tshirt', '3.50');
    upsertSetting.run(1, 'product_costs', 'boxers', '2.25');

    // Rejection Rates (%)
    const rejections = { HR: 15, CZ: 15, PL: 15, SK: 15, HU: 15, GR: 25, IT: 25 };
    for (const [cc, rate] of Object.entries(rejections)) {
      upsertSetting.run(1, 'rejection_rates', cc, String(rate));
    }

    // Shipping Costs (EUR)
    const shipping = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
    for (const [cc, cost] of Object.entries(shipping)) {
      upsertSetting.run(1, 'shipping_costs', cc, String(cost));
    }

    // VAT Rates (%)
    const vat = { HR: 25, CZ: 21, PL: 23, GR: 24, IT: 22, HU: 27, SK: 23 };
    for (const [cc, rate] of Object.entries(vat)) {
      upsertSetting.run(1, 'vat_rates', cc, String(rate));
    }
  })();
  console.log('[FLORES] Seeded Noriks org settings');
}
try { seedOrgSettings(); } catch(e) { console.error('Seed org settings error:', e.message); }

// ═══ ORG SETTINGS HELPERS ═══
function getOrgSettings(orgId, category) {
  const rows = db.prepare('SELECT key, value FROM org_settings WHERE org_id = ? AND category = ?').all(orgId, category);
  const result = {};
  for (const r of rows) {
    try { result[r.key] = JSON.parse(r.value); } catch { result[r.key] = r.value; }
  }
  return result;
}

function getOrgSetting(orgId, category, key) {
  const row = db.prepare('SELECT value FROM org_settings WHERE org_id = ? AND category = ? AND key = ?').get(orgId, category, key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function getOrgWcStores(orgId) {
  const settings = getOrgSettings(orgId, 'wc_stores');
  const stores = {};
  for (const [cc, val] of Object.entries(settings)) {
    if (typeof val === 'object' && val.url) stores[cc] = val;
  }
  return stores;
}

function getOrgVatRates(orgId) {
  const settings = getOrgSettings(orgId, 'vat_rates');
  const rates = {};
  for (const [cc, val] of Object.entries(settings)) {
    rates[cc] = parseFloat(val) / 100;
  }
  return rates;
}

function getOrgProductCosts(orgId) {
  const settings = getOrgSettings(orgId, 'product_costs');
  const costs = {};
  for (const [k, v] of Object.entries(settings)) {
    costs[k] = parseFloat(v);
  }
  return costs;
}

// Add new columns for flores plugin fields (safe - ignores if already exists)
const newColumns = [
  'adset_id TEXT DEFAULT ""',
  'ad_id TEXT DEFAULT ""',
  'campaign_name TEXT DEFAULT ""',
  'adset_name TEXT DEFAULT ""',
  'ad_name TEXT DEFAULT ""',
  'utm_medium TEXT DEFAULT ""',
  'landing_page TEXT DEFAULT ""',
  'placement TEXT DEFAULT ""',
  'billing_name TEXT DEFAULT ""',
  'billing_city TEXT DEFAULT ""',
  'billing_email TEXT DEFAULT ""',
  'order_datetime TEXT DEFAULT ""'
];
for (const col of newColumns) {
  try { db.exec(`ALTER TABLE wc_orders ADD COLUMN ${col}`); } catch(e) { /* column exists */ }
}

// Prepared statements for WC sync
const upsertOrder = db.prepare(`
  INSERT INTO wc_orders (country, wc_order_id, order_date, status, gross_total, gross_eur, net_revenue, product_cost, shipping_cost, profit, product_type, utm_source, utm_campaign, is_fb_attributed, raw_meta, created_at, adset_id, ad_id, campaign_name, adset_name, ad_name, utm_medium, landing_page, placement, billing_name, billing_city, billing_email, order_datetime)
  VALUES (@country, @wc_order_id, @order_date, @status, @gross_total, @gross_eur, @net_revenue, @product_cost, @shipping_cost, @profit, @product_type, @utm_source, @utm_campaign, @is_fb_attributed, @raw_meta, datetime('now'), @adset_id, @ad_id, @campaign_name, @adset_name, @ad_name, @utm_medium, @landing_page, @placement, @billing_name, @billing_city, @billing_email, @order_datetime)
  ON CONFLICT(country, wc_order_id) DO UPDATE SET
    order_date=excluded.order_date, status=excluded.status, gross_total=excluded.gross_total,
    gross_eur=excluded.gross_eur, net_revenue=excluded.net_revenue, product_cost=excluded.product_cost,
    shipping_cost=excluded.shipping_cost, profit=excluded.profit, product_type=excluded.product_type,
    utm_source=excluded.utm_source, utm_campaign=excluded.utm_campaign, is_fb_attributed=excluded.is_fb_attributed,
    raw_meta=excluded.raw_meta, adset_id=excluded.adset_id, ad_id=excluded.ad_id,
    campaign_name=excluded.campaign_name, adset_name=excluded.adset_name, ad_name=excluded.ad_name,
    utm_medium=excluded.utm_medium, landing_page=excluded.landing_page, placement=excluded.placement,
    billing_name=excluded.billing_name, billing_city=excluded.billing_city,
    billing_email=excluded.billing_email, order_datetime=excluded.order_datetime
`);

const updateSyncState = db.prepare(`
  INSERT INTO sync_state (country, last_synced_order_id, last_sync_at, total_orders)
  VALUES (@country, @last_synced_order_id, @last_sync_at, @total_orders)
  ON CONFLICT(country) DO UPDATE SET
    last_synced_order_id=excluded.last_synced_order_id, last_sync_at=excluded.last_sync_at, total_orders=excluded.total_orders
`);

const getSyncState = db.prepare('SELECT * FROM sync_state WHERE country = ?');

// Product type detection helpers
const shirtWords = /shirt|majic|μπλουζ|koszulk|tričko|tričk|póló|magliett|tshirt|t-shirt/i;
const boxerWords = /boxer|μπόξερ|μποξερ|bokser|boxerk|airflow|modal/i;
const kompletWords = /komplet|bundle|σετ/i;
const starterWords = /starter|εκκίνησ|start/i;

function detectProductType(items) {
  let hasShirt = false, hasBoxer = false, hasKomplet = false, hasStarter = false;
  for (const i of items) {
    const name = i.name || '';
    if (shirtWords.test(name)) hasShirt = true;
    if (boxerWords.test(name)) hasBoxer = true;
    if (kompletWords.test(name) || (i.sku || '').includes('BUNDLE')) hasKomplet = true;
    if (starterWords.test(name)) hasStarter = true;
  }
  if (hasKomplet) return 'kompleti';
  if (hasStarter) return 'starter';
  if (hasShirt && !hasBoxer) return 'shirts';
  if (hasBoxer && !hasShirt) return 'boxers';
  if (hasShirt) return 'shirts';
  if (hasBoxer) return 'boxers';
  return 'shirts'; // default
}

function calculateOrderProfit(order, country) {
  const eurRate = EUR_RATES[country] || 1;
  const vatRate = VAT_RATES[country] || 0;
  const rejRate = (dashRejectionRates[country] || 15) / 100;
  const grossTotal = parseFloat(order.total || 0);
  const grossEur = grossTotal * eurRate;

  // Match dash formula exactly:
  // effectiveGrossEur = grossEur * (1 - rejectionRate)
  // effectiveNetEur = effectiveGrossEur / (1 + vatRate)
  const effectiveGrossEur = grossEur * (1 - rejRate);
  const netRevenue = effectiveGrossEur / (1 + vatRate);

  // Product cost: use shared detectProduct (same as dash) to decompose bundles
  let totalTshirts = 0, totalBoxers = 0;
  const items = order.line_items || [];
  for (const item of items) {
    const qty = item.quantity || 1;
    const detected = sharedDetectProduct(item.name || '', true, item.meta_data || null, item.sku || null);
    totalTshirts += (detected.tshirts || 0) * qty;
    totalBoxers += (detected.boxers || 0) * qty;
  }
  const productCost = (totalTshirts * PRODUCT_COSTS.tshirt) + (totalBoxers * PRODUCT_COSTS.boxers);

  // Shipping ALWAYS applied per order (matches dash behavior)
  const SHIPPING_COSTS = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 5.5 };
  const shippingCost = SHIPPING_COSTS[country] || 4;
  const effectiveProductCost = productCost * (1 - rejRate);
  // profit per order (FB spend subtracted at aggregate level in dashboard API)
  const profit = netRevenue - effectiveProductCost - shippingCost;

  return { grossTotal, grossEur, netRevenue, productCost: effectiveProductCost, shippingCost, profit };
}

// Fetch WC orders for a single country with pagination
function fetchWcOrdersForCountry(country, modifiedAfter) {
  const store = WC_STORES[country];
  if (!store) return Promise.resolve([]);

  return new Promise(async (resolve) => {
    const allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        let wcUrl = `${store.url}/wp-json/wc/v3/orders?per_page=100&page=${page}&status=processing,completed&consumer_key=${store.ck}&consumer_secret=${store.cs}`;
        if (modifiedAfter) wcUrl += `&modified_after=${modifiedAfter}`;

        const data = await new Promise((res, rej) => {
          https.get(wcUrl, resp => {
            let d = '';
            resp.on('data', c => d += c);
            resp.on('end', () => {
              try { res(JSON.parse(d)); } catch (e) { rej(e); }
            });
          }).on('error', rej);
        });

        if (!Array.isArray(data) || data.length === 0) {
          hasMore = false;
        } else {
          allOrders.push(...data);
          if (data.length < 100) hasMore = false;
          else page++;
        }
      } catch (e) {
        console.error(`[FLORES] WC fetch error for ${country} page ${page}:`, e.message);
        hasMore = false;
      }
    }
    resolve(allOrders);
  });
}

// Sync orders for a single country into SQLite
async function syncCountry(country) {
  const state = getSyncState.get(country);
  const modifiedAfter = state?.last_sync_at || null;

  const orders = await fetchWcOrdersForCountry(country, modifiedAfter);
  let count = 0;

  const insertMany = db.transaction((orders) => {
    for (const order of orders) {
      const meta = order.meta_data || [];

      // Priority: flores plugin fields > WC attribution fields
      const floresCampaignId = meta.find(m => m.key === '_flores_campaign_id')?.value || '';
      const floresAdsetId = meta.find(m => m.key === '_flores_adset_id')?.value || '';
      const floresAdId = meta.find(m => m.key === '_flores_ad_id')?.value || '';
      const floresCampaignName = meta.find(m => m.key === '_flores_campaign_name')?.value || '';
      const floresAdsetName = meta.find(m => m.key === '_flores_adset_name')?.value || '';
      const floresAdName = meta.find(m => m.key === '_flores_ad_name')?.value || '';
      const floresUtmSource = meta.find(m => m.key === '_flores_utm_source')?.value || '';
      const floresUtmMedium = meta.find(m => m.key === '_flores_utm_medium')?.value || '';
      const floresLanding = meta.find(m => m.key === '_flores_landing_page')?.value || '';
      const floresPlacement = meta.find(m => m.key === '_flores_placement')?.value || '';

      // WC attribution fallbacks
      const wcUtmSource = meta.find(m => m.key === '_wc_order_attribution_utm_source')?.value || '';
      const wcUtmCampaign = meta.find(m => m.key === '_wc_order_attribution_utm_campaign')?.value || '';
      const wcReferrer = (meta.find(m => m.key === '_wc_order_attribution_referrer')?.value || '').toLowerCase();
      const wcSessionEntry = (meta.find(m => m.key === '_wc_order_attribution_session_entry')?.value || '').toLowerCase();

      // Best values (flores plugin takes priority)
      const utmSource = floresUtmSource || wcUtmSource;
      const utmMedium = floresUtmMedium || '';

      // Campaign ID: flores plugin > WC utm_campaign > session entry extraction
      let campaignId = floresCampaignId || wcUtmCampaign;
      if (!campaignId) {
        const match = wcSessionEntry.match(/campaignid=(\d+)/i);
        if (match) campaignId = match[1];
      }

      // FB attribution: check all sources
      const srcLower = utmSource.toLowerCase();
      const isFB = srcLower.includes('facebook') || srcLower.includes('fb') ||
                   srcLower.includes('ig') || srcLower.includes('meta') ||
                   wcReferrer.includes('facebook.com') || wcReferrer.includes('fb.com') ||
                   wcReferrer.includes('instagram.com') || wcReferrer.includes('fbclid') ||
                   wcSessionEntry.includes('fbclid') || wcSessionEntry.includes('campaignid') ||
                   !!floresCampaignId;  // If flores plugin captured a campaign ID, it's from FB

      const calc = calculateOrderProfit(order, country);
      const ptype = detectProductType(order.line_items || []);
      const orderDate = (order.date_created || '').slice(0, 10);

      const relevantMeta = {};
      for (const m of meta) {
        if (m.key && (m.key.startsWith('_wc_order_attribution_') || m.key.startsWith('_flores_'))) {
          relevantMeta[m.key] = m.value;
        }
      }

      upsertOrder.run({
        country,
        wc_order_id: order.id,
        order_date: orderDate,
        status: order.status || '',
        gross_total: calc.grossTotal,
        gross_eur: Math.round(calc.grossEur * 100) / 100,
        net_revenue: Math.round(calc.netRevenue * 100) / 100,
        product_cost: Math.round(calc.productCost * 100) / 100,
        shipping_cost: calc.shippingCost,
        profit: Math.round(calc.profit * 100) / 100,
        product_type: ptype,
        utm_source: utmSource,
        utm_campaign: campaignId,
        is_fb_attributed: isFB ? 1 : 0,
        raw_meta: JSON.stringify(relevantMeta),
        adset_id: floresAdsetId,
        ad_id: floresAdId,
        campaign_name: floresCampaignName,
        adset_name: floresAdsetName,
        ad_name: floresAdName,
        utm_medium: utmMedium,
        landing_page: floresLanding,
        placement: floresPlacement,
        billing_name: ((order.billing?.first_name || '') + ' ' + (order.billing?.last_name || '')).trim(),
        billing_city: order.billing?.city || '',
        billing_email: order.billing?.email || '',
        order_datetime: (order.date_created || '').replace('T', ' ').slice(0, 16)
      });
      count++;
    }
  });

  insertMany(orders);

  // Check for cancelled orders and remove them from SQLite
  try {
    const store = WC_STORES[country];
    const cancelledUrl = `${store.url}/wp-json/wc/v3/orders?status=cancelled&per_page=100&modified_after=${modifiedAfter || new Date(Date.now() - 7 * 86400000).toISOString()}&consumer_key=${store.ck}&consumer_secret=${store.cs}`;
    const cancelledOrders = await new Promise((res, rej) => {
      https.get(cancelledUrl, resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      }).on('error', rej);
    });
    if (Array.isArray(cancelledOrders) && cancelledOrders.length > 0) {
      const delStmt = db.prepare('DELETE FROM wc_orders WHERE wc_order_id = ? AND country = ?');
      let delCount = 0;
      for (const co of cancelledOrders) {
        const r = delStmt.run(co.id, country);
        if (r.changes > 0) delCount++;
      }
      if (delCount > 0) console.log(`[FLORES] Removed ${delCount} cancelled orders for ${country}`);
    }
  } catch(e) { console.warn(`[FLORES] Cancelled order check failed for ${country}:`, e.message); }

  // Update sync state
  const totalOrders = db.prepare('SELECT COUNT(*) as cnt FROM wc_orders WHERE country = ?').get(country).cnt;
  const maxId = db.prepare('SELECT MAX(wc_order_id) as mid FROM wc_orders WHERE country = ?').get(country).mid || 0;
  updateSyncState.run({
    country,
    last_synced_order_id: maxId,
    last_sync_at: new Date().toISOString(),
    total_orders: totalOrders
  });

  console.log(`[FLORES] Synced ${country}: ${count} orders`);
  return count;
}

// Sync all countries sequentially with delay
async function syncAllCountries() {
  const results = {};
  let totalNew = 0;
  const countries = Object.keys(WC_STORES);

  for (let i = 0; i < countries.length; i++) {
    const country = countries[i];
    try {
      const count = await syncCountry(country);
      results[country] = count;
      totalNew += count;
    } catch (e) {
      console.error(`[FLORES] Sync failed for ${country}:`, e.message);
      results[country] = 0;
    }
    // 2s delay between countries (except after last)
    if (i < countries.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`[FLORES] Sync complete: ${totalNew} total orders`);
  // Auto-clear campaign cache so new orders show immediately
  if (totalNew > 0) {
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("campaigns_"));
      files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
      console.log(`[FLORES] Cleared ${files.length} campaign cache files`);
    } catch(e) {}
  }
  return { synced: results, totalNew };
}

// Initial sync: last 7 days
async function initialSync() {
  console.log('[FLORES] Starting initial WC sync (last 7 days)...');
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  // Temporarily override sync_state to force 7-day lookback
  for (const country of Object.keys(WC_STORES)) {
    const state = getSyncState.get(country);
    if (!state || !state.last_sync_at) {
      updateSyncState.run({
        country,
        last_synced_order_id: 0,
        last_sync_at: sevenDaysAgo.toISOString(),
        total_orders: 0
      });
    }
  }
  await syncAllCountries();
}

// Run initial sync on startup (non-blocking)
initialSync().catch(e => console.error('[FLORES] Initial sync error:', e.message));

// Periodic sync every 15 minutes
setInterval(() => {
  syncAllCountries().catch(e => console.error('[FLORES] Periodic sync error:', e.message));
}, 15 * 60 * 1000);

// Fetch Advertiser profit data from local dash server
let advCache = { data: null, ts: 0, key: '' };
async function fetchAdvertiserData(dateFrom, dateTo) {
  const cacheKey = dateFrom + '_' + dateTo;
  const isToday = dateTo >= new Date().toISOString().slice(0, 10);
  const ttl = isToday ? 300000 : 3600000; // 5min for today, 1hr for historical
  if (advCache.key === cacheKey && Date.now() - advCache.ts < ttl) return advCache.data;
  
  // Also check file cache
  const cacheFile = path.join(CACHE_DIR, 'adv_' + cacheKey + '.json');
  if (!isToday && fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      advCache = { data, ts: Date.now(), key: cacheKey };
      return data;
    } catch(e) {}
  }
  
  try {
    // Direct local HTTP fetch from dash server
    const cmd = `curl -s -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"username":"noriks","password":"noriks"}' -c /tmp/dash_cookies.txt -o /dev/null && curl -s -b /tmp/dash_cookies.txt "http://localhost:3000/api/advertiser-data?start=${dateFrom}&end=${dateTo}"`;
    const result = execSync(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }).toString();
    const data = JSON.parse(result);
    if (!data || data.error) return null;
    
    console.log('[FLORES] Fetched Advertiser data for', dateFrom, 'to', dateTo);
    advCache = { data, ts: Date.now(), key: cacheKey };
    // Cache historical to file
    if (!isToday) fs.writeFileSync(cacheFile, result);
    return data;
  } catch(e) {
    console.error('[FLORES] Advertiser fetch failed:', e.message);
    return null;
  }
}

// Fetch all FB-attributed WC orders from DB
// Returns: { "HR_shirts": { orders: N, totalProfit, totalRevenue, avgProfit, avgRevenue }, ... }
function fetchActualWcOrders(dateFrom, dateTo) {
  const rows = db.prepare(`
    SELECT country, product_type, COUNT(*) as orders, SUM(profit) as totalProfit, SUM(gross_eur) as totalRevenue
    FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1
    GROUP BY country, product_type
  `).all(dateFrom, dateTo);

  const result = {};
  for (const r of rows) {
    const key = r.country + '_' + (r.product_type || 'shirts');
    result[key] = {
      orders: r.orders,
      totalProfit: r.totalProfit || 0,
      totalRevenue: r.totalRevenue || 0,
      avgProfit: r.orders > 0 ? r.totalProfit / r.orders : 0,
      avgRevenue: r.orders > 0 ? r.totalRevenue / r.orders : 0
    };
  }
  return result;
}

// Fetch WC orders from DB, grouped by campaign ID
// Returns: { campaignId: [{ orderId, country, grossEur, profit, ... }] }
function fetchWcOrdersByCampaign(dateFrom, dateTo) {
  const rows = db.prepare(`
    SELECT wc_order_id, country, gross_eur, net_revenue, product_cost, shipping_cost, profit, utm_campaign, adset_id, ad_id
    FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1 AND utm_campaign IS NOT NULL AND utm_campaign != ''
  `).all(dateFrom, dateTo);

  const byCampaign = {};
  for (const r of rows) {
    if (!byCampaign[r.utm_campaign]) byCampaign[r.utm_campaign] = [];
    byCampaign[r.utm_campaign].push({
      orderId: r.wc_order_id,
      country: r.country,
      grossEur: r.gross_eur,
      netEur: r.net_revenue,
      productCost: r.product_cost,
      shipping: r.shipping_cost,
      profit: r.profit,
      adsetId: r.adset_id || '',
      adId: r.ad_id || ''
    });
  }
  return byCampaign;
}

// Calculate WC profit per campaign from its ACTUAL orders (matched by utm_campaign ID)
function enrichCampaignsWithProfit(campaigns, dateFrom, dateTo) {
  const byCampaign = fetchWcOrdersByCampaign(dateFrom, dateTo);
  
  for (const c of campaigns) {
    const metaSpend = parseFloat(c.insights?.spend || 0);
    c._parsed = parseCampaignName(c.name);
    
    // Match WC orders by campaign ID
    const campaignId = c.id || '';
    const orders = byCampaign[campaignId] || [];
    
    const totalProfit = orders.reduce((s, o) => s + o.profit, 0);
    const totalRevenue = orders.reduce((s, o) => s + o.grossEur, 0);
    
    c.wc = {
      orders: orders.length,
      revenueGross: Math.round(totalRevenue * 100) / 100,
      profit: Math.round((totalProfit - metaSpend) * 100) / 100
    };
    c.wc.roas = metaSpend > 0 ? Math.round(c.wc.revenueGross / metaSpend * 100) / 100 : 0;
  }

  return campaigns;
}
const CACHE_TTL = 3600000; // 1 hour default

// Smart cache TTL: historical data cached much longer, today's data shorter
function getSmartTTL(dateFrom, dateTo) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateTo < today) return 86400000 * 7; // historical: 7 days cache
  if (dateFrom === today && dateTo === today) return 600000; // today only: 10 min
  return 1800000; // range including today: 30 min
}

// --- Meta API helper ---
function _metaGetOnce(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    params.access_token = META_TOKEN;
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `https://graph.facebook.com/${API_VERSION}/${endpoint}?${qs}`;
    
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(json.error);
          else resolve(json);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function metaGet(endpoint, params = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      return await _metaGetOnce(endpoint, params);
    } catch (err) {
      if ((err.code === 4 || err.code === 32) && i < 2) {
        console.warn('[Meta] Rate limited, retry ' + (i+1) + '/2 in 5s — ' + endpoint);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
}

// --- Cache helper ---
function getCached(key, ttl, allowStale) {
  const file = path.join(CACHE_DIR, key + '.json');
  try {
    const stat = fs.statSync(file);
    if (allowStale || Date.now() - stat.mtimeMs < (ttl || CACHE_TTL)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function setCache(key, data) {
  const file = path.join(CACHE_DIR, key + '.json');
  fs.writeFileSync(file, JSON.stringify(data));
}

// --- Fetch all pages ---
async function metaGetAll(endpoint, params = {}) {
  let allData = [];
  let result = await metaGet(endpoint, params);
  allData = allData.concat(result.data || []);
  while (result.paging && result.paging.next) {
    result = await new Promise((resolve, reject) => {
      https.get(result.paging.next, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
    allData = allData.concat(result.data || []);
  }
  return allData;
}

// --- API handlers ---
const INSIGHT_FIELDS = 'spend,impressions,clicks,reach,cpm,cpc,ctr,actions,cost_per_action_type';

async function getCampaigns(dateFrom, dateTo) {
  const cacheKey = `campaigns_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;
  try {

  // Get campaign insights (includes campaign_id and campaign_name)
  const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS + ',campaign_id,campaign_name',
    level: 'campaign',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  // Get all campaigns for status info
  const campaigns = await metaGetAll(`${AD_ACCOUNT}/campaigns`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget',
    filtering: JSON.stringify([{field:'spend',operator:'GREATER_THAN',value:0}]),
    limit: 500
  });

  const campaignMap = {};
  for (const c of campaigns) campaignMap[c.id] = c;

  // Build result: start from insights (campaigns with spend), add campaign metadata
  const insightCampaigns = {};
  for (const i of insights) {
    const cid = i.campaign_id;
    insightCampaigns[cid] = {
      id: cid,
      name: i.campaign_name || campaignMap[cid]?.name || cid,
      status: campaignMap[cid]?.status || 'UNKNOWN',
      objective: campaignMap[cid]?.objective || '',
      daily_budget: campaignMap[cid]?.daily_budget || '0',
      insights: i
    };
  }

  // Add active campaigns without spend
  for (const c of campaigns) {
    if (!insightCampaigns[c.id] && c.status === 'ACTIVE') {
      insightCampaigns[c.id] = { ...c, insights: null };
    }
  }

  const result = Object.values(insightCampaigns);

  // Sort: ACTIVE first, then by spend desc
  result.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return 1;
    const spendA = parseFloat(a.insights?.spend || 0);
    const spendB = parseFloat(b.insights?.spend || 0);
    return spendB - spendA;
  });

  // Also fetch from second ad account
  const allAccounts = Object.values(AD_ACCOUNTS_MAP);
  for (const acct of allAccounts) {
    if (acct === AD_ACCOUNT) continue; // Already fetched
    try {
      const ins2 = await metaGetAll(acct + '/insights', {
        fields: INSIGHT_FIELDS + ',campaign_id,campaign_name',
        level: 'campaign',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        limit: 500
      });
      const camps2 = await metaGetAll(acct + '/campaigns', {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget',
        limit: 500
      });
      const cmap2 = {}; for (const cc of camps2) cmap2[cc.id] = cc;
      for (const i of ins2) {
        if (!result.find(r => r.id === i.campaign_id)) {
          result.push({
            id: i.campaign_id,
            name: i.campaign_name || cmap2[i.campaign_id]?.name || i.campaign_id,
            status: cmap2[i.campaign_id]?.status || 'UNKNOWN',
            objective: cmap2[i.campaign_id]?.objective || '',
            daily_budget: cmap2[i.campaign_id]?.daily_budget || '0',
            insights: i
          });
        }
      }
    } catch(e) { console.warn('[getCampaigns] Second account error:', e.message); }
  }

  enrichCampaignsWithProfit(result, dateFrom, dateTo);
  setCache(cacheKey, result);
  return result;
  } catch (err) {
    console.warn('[Meta] getCampaigns failed:', err.message || err);
    const stale = getCached(cacheKey, null, true);
    if (stale) { console.warn('[Meta] Returning stale cache for campaigns'); return stale; }
    throw err;
  }
}

async function getAdsets(campaignId, dateFrom, dateTo) {
  const cacheKey = `adsets_${campaignId}_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;
  try {

  // Get insights first (source of truth for IDs)
  const insights = await metaGetAll(`${campaignId}/insights`, {
    fields: INSIGHT_FIELDS + ',adset_id,adset_name',
    level: 'adset',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  // Get adset metadata
  let adsetMeta = {};
  try {
    const adsets = await metaGetAll(`${campaignId}/adsets`, {
      fields: 'id,name,status,daily_budget,lifetime_budget',
      limit: 500
    });
    for (const a of adsets) adsetMeta[a.id] = a;
  } catch(e) {}

  // Build from insights first (like campaigns)
  const insightAdsets = {};
  for (const i of insights) {
    const aid = i.adset_id;
    insightAdsets[aid] = {
      id: aid,
      name: i.adset_name || adsetMeta[aid]?.name || aid,
      status: adsetMeta[aid]?.status || 'ACTIVE',
      daily_budget: adsetMeta[aid]?.daily_budget || '0',
      insights: i
    };
  }

  // Add active adsets without spend
  for (const [id, meta] of Object.entries(adsetMeta)) {
    if (!insightAdsets[id] && meta.status === 'ACTIVE') {
      insightAdsets[id] = { ...meta, insights: null };
    }
  }

  const result = Object.values(insightAdsets);
  result.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return 1;
    return parseFloat(b.insights?.spend || 0) - parseFloat(a.insights?.spend || 0);
  });

  setCache(cacheKey, result);
  return result;
  } catch (err) {
    console.warn('[Meta] getAdsets failed:', err.message || err);
    const stale = getCached(cacheKey, null, true);
    if (stale) { console.warn('[Meta] Returning stale cache for adsets'); return stale; }
    throw err;
  }
}

async function getAds(adsetId, dateFrom, dateTo) {
  const cacheKey = `ads_${adsetId}_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;
  try {

  // Fetch ad-level insights filtered by adset
  const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS + ',ad_id,ad_name,adset_id',
    level: 'ad',
    filtering: JSON.stringify([{field:'adset.id',operator:'EQUAL',value:adsetId}]),
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  // Try to get ad metadata
  let adMeta = {};
  try {
    const ads = await metaGetAll(`${adsetId}/ads`, {
      fields: 'id,name,status',
      limit: 500
    });
    for (const a of ads) adMeta[a.id] = a;
  } catch(e) {}

  // Build from insights
  const result = insights.filter(i => i.adset_id === adsetId).map(i => ({
    id: i.ad_id,
    name: adMeta[i.ad_id]?.name || i.ad_name || i.ad_id,
    status: adMeta[i.ad_id]?.status || 'ACTIVE',
    insights: i
  }));

  result.sort((a, b) => parseFloat(b.insights?.spend || 0) - parseFloat(a.insights?.spend || 0));

  setCache(cacheKey, result);
  return result;
  } catch (err) {
    console.warn('[Meta] getAds failed:', err.message || err);
    const stale = getCached(cacheKey, null, true);
    if (stale) { console.warn('[Meta] Returning stale cache for ads'); return stale; }
    throw err;
  }
}

// Multi-period profit: returns {campaignId: {yesterday, d3, d7, d14, lifetime}} 
async function getMultiPeriodProfit() {
  const cacheKey = 'multiprofit_' + new Date().toISOString().slice(0,10);
  let cached = getCached(cacheKey);
  if (cached) return cached;

  const today = new Date();
  const fmt = d => d.toISOString().slice(0,10);
  const addD = (d,n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };
  
  const periods = {
    yesterday: { from: fmt(addD(today,-1)), to: fmt(addD(today,-1)) },
    d3: { from: fmt(addD(today,-2)), to: fmt(today) },
    d7: { from: fmt(addD(today,-6)), to: fmt(today) },
    d14: { from: fmt(addD(today,-13)), to: fmt(today) },
    lifetime: { from: '2025-01-01', to: fmt(today) }
  };

  const result = {};

  for (const [period, range] of Object.entries(periods)) {
    // Get campaign insights for this period
    const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {
      fields: 'spend,campaign_id,campaign_name',
      level: 'campaign',
      time_range: JSON.stringify({ since: range.from, until: range.to }),
      limit: 500
    });

    // Build temporary campaign objects for enrichment
    const camps = insights.map(i => ({
      id: i.campaign_id,
      name: i.campaign_name || i.campaign_id,
      insights: { spend: i.spend }
    }));

    enrichCampaignsWithProfit(camps, range.from, range.to);

    for (const c of camps) {
      if (!result[c.id]) result[c.id] = {};
      result[c.id][period] = {
        spend: parseFloat(c.insights?.spend || 0),
        profit: c.wc?.profit ?? -(parseFloat(c.insights?.spend || 0)),
        orders: c.wc?.orders || 0
      };
    }
  }

  setCache(cacheKey, result);
  return result;
}

// Fetch ALL adsets across the account (flat list for Ad Sets tab)
async function getAllAdsets(dateFrom, dateTo) {
  const cacheKey = `all_adsets_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

  const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS + ',adset_id,adset_name,campaign_id,campaign_name',
    level: 'adset',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  // Get adset metadata for status
  let adsetMeta = {};
  try {
    const adsets = await metaGetAll(`${AD_ACCOUNT}/adsets`, {
      fields: 'id,name,status,daily_budget,campaign_id',
      filtering: JSON.stringify([{field:'spend',operator:'GREATER_THAN',value:0}]),
      limit: 500
    });
    for (const a of adsets) adsetMeta[a.id] = a;
  } catch(e) {}

  const result = insights.map(i => ({
    id: i.adset_id,
    name: i.adset_name || adsetMeta[i.adset_id]?.name || i.adset_id,
    campaign_id: i.campaign_id,
    campaign_name: i.campaign_name,
    status: adsetMeta[i.adset_id]?.status || 'ACTIVE',
    daily_budget: adsetMeta[i.adset_id]?.daily_budget || '0',
    insights: i
  }));

  // Enrich with profit: distribute parent campaign WC data proportionally
  // First get campaign-level profit data
  const campaignData = await getCampaigns(dateFrom, dateTo);
  const campaignMap = {};
  for (const c of campaignData) campaignMap[c.id] = c;

  // Group adsets by campaign and distribute profit
  const byCampaign = {};
  for (const as of result) {
    if (!byCampaign[as.campaign_id]) byCampaign[as.campaign_id] = [];
    byCampaign[as.campaign_id].push(as);
  }
  for (const [cid, adsets] of Object.entries(byCampaign)) {
    const camp = campaignMap[cid];
    if (camp?.wc) {
      const totalSpend = adsets.reduce((s, a) => s + parseFloat(a.insights?.spend || 0), 0);
      if (totalSpend > 0) {
        for (const as of adsets) {
          const ratio = parseFloat(as.insights?.spend || 0) / totalSpend;
          const spend = parseFloat(as.insights?.spend || 0);
          as.wc = {
            orders: Math.round(camp.wc.orders * ratio),
            revenueGross: Math.round(camp.wc.revenueGross * ratio * 100) / 100,
            profit: Math.round((camp.wc.profit + parseFloat(camp.insights?.spend || 0)) * ratio * 100) / 100 - spend,
            roas: spend > 0 ? Math.round(camp.wc.revenueGross * ratio / spend * 100) / 100 : 0
          };
        }
      }
    }
  }

  result.sort((a, b) => parseFloat(b.insights?.spend || 0) - parseFloat(a.insights?.spend || 0));
  setCache(cacheKey, result);
  return result;
}

// Fetch ALL ads across the account (flat list for Ads tab)
async function getAllAds(dateFrom, dateTo) {
  const cacheKey = `all_ads_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

  const insights = await metaGetAll(`${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS + ',ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name',
    level: 'ad',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  let adMeta = {};
  try {
    const ads = await metaGetAll(`${AD_ACCOUNT}/ads`, {
      fields: 'id,name,status,adset_id,campaign_id',
      filtering: JSON.stringify([{field:'spend',operator:'GREATER_THAN',value:0}]),
      limit: 500
    });
    for (const a of ads) adMeta[a.id] = a;
  } catch(e) {}

  const result = insights.map(i => ({
    id: i.ad_id,
    name: i.ad_name || adMeta[i.ad_id]?.name || i.ad_id,
    adset_id: i.adset_id,
    adset_name: i.adset_name,
    campaign_id: i.campaign_id,
    campaign_name: i.campaign_name,
    status: adMeta[i.ad_id]?.status || 'ACTIVE',
    insights: i
  }));

  // Distribute campaign profit proportionally by spend
  const campaignData = await getCampaigns(dateFrom, dateTo);
  const campaignMap = {};
  for (const c of campaignData) campaignMap[c.id] = c;

  const byCampaign = {};
  for (const ad of result) {
    if (!byCampaign[ad.campaign_id]) byCampaign[ad.campaign_id] = [];
    byCampaign[ad.campaign_id].push(ad);
  }
  for (const [cid, ads] of Object.entries(byCampaign)) {
    const camp = campaignMap[cid];
    if (camp?.wc) {
      const totalSpend = ads.reduce((s, a) => s + parseFloat(a.insights?.spend || 0), 0);
      if (totalSpend > 0) {
        for (const ad of ads) {
          const ratio = parseFloat(ad.insights?.spend || 0) / totalSpend;
          const spend = parseFloat(ad.insights?.spend || 0);
          ad.wc = {
            orders: Math.round(camp.wc.orders * ratio),
            revenueGross: Math.round(camp.wc.revenueGross * ratio * 100) / 100,
            profit: Math.round((camp.wc.profit + parseFloat(camp.insights?.spend || 0)) * ratio * 100) / 100 - spend,
            roas: spend > 0 ? Math.round(camp.wc.revenueGross * ratio / spend * 100) / 100 : 0
          };
        }
      }
    }
  }

  result.sort((a, b) => parseFloat(b.insights?.spend || 0) - parseFloat(a.insights?.spend || 0));
  setCache(cacheKey, result);
  return result;
}

async function getInsights(level, dateFrom, dateTo, breakdown) {
  const cacheKey = `insights_${level}_${dateFrom}_${dateTo}_${breakdown || 'none'}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

  const params = {
    fields: INSIGHT_FIELDS + ',campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id',
    level: level,
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  };
  if (breakdown) params.breakdowns = breakdown;

  const result = await metaGetAll(`${AD_ACCOUNT}/insights`, params);
  setCache(cacheKey, result);
  return result;
}

// --- HTTP server ---
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(JSON.stringify(data));
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  url.slice(idx + 1).split('&').forEach(p => {
    const eqIdx = p.indexOf('=');
    if (eqIdx === -1) return;
    const k = p.slice(0, eqIdx);
    const v = p.slice(eqIdx + 1);
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return params;
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function fbGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0${path}`, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function fbPost(path, params) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({ ...params, access_token: META_TOKEN }).toString();
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ═══ Dropbox Helpers ═══
async function getDropboxToken() {
  if (DROPBOX_ACCESS_TOKEN && Date.now() < dropboxTokenExpires) return DROPBOX_ACCESS_TOKEN;
  return new Promise((resolve, reject) => {
    const data = `grant_type=refresh_token&refresh_token=${DROPBOX_REFRESH_TOKEN}&client_id=${DROPBOX_APP_KEY}&client_secret=${DROPBOX_APP_SECRET}`;
    const req = https.request({ hostname: 'api.dropboxapi.com', path: '/oauth2/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.access_token) { DROPBOX_ACCESS_TOKEN = j.access_token; dropboxTokenExpires = Date.now() + j.expires_in * 1000 - 60000; resolve(DROPBOX_ACCESS_TOKEN); }
          else reject(new Error('Dropbox token refresh failed: ' + body));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function dropboxApi(endpoint, body) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getDropboxToken();
      const postData = JSON.stringify(body);
      const hostname = endpoint.startsWith('/2/files/get_thumbnail') ? 'content.dropboxapi.com' : 'api.dropboxapi.com';
      const req = https.request({
        hostname, path: endpoint, method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Dropbox-API-Path-Root': JSON.stringify({".tag": "root", "root": DROPBOX_ROOT})
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Dropbox parse error: ' + data.slice(0, 200))); } });
      });
      req.on('error', reject);
      req.end(postData);
    } catch(e) { reject(e); }
  });
}

async function dropboxListAllFiles(folderPath) {
  const allFiles = [];
  let result = await dropboxApi('/2/files/list_folder', { path: folderPath, recursive: true, limit: 2000 });
  allFiles.push(...(result.entries || []));
  while (result.has_more) {
    result = await dropboxApi('/2/files/list_folder/continue', { cursor: result.cursor });
    allFiles.push(...(result.entries || []));
  }
  return allFiles;
}

function parseVideoFilename(name) {
  const idMatch = name.match(/ID(\d+)/i);
  const countries = ['HR','CZ','PL','GR','SK','IT','HU'];
  const foundCountry = countries.find(c => name.toUpperCase().includes('_' + c + '_') || name.toUpperCase().includes('_' + c + '.') || name.toUpperCase().startsWith(c + '_'));
  let productType = null;
  const upper = name.toUpperCase();
  if (/SHIRT/i.test(upper)) productType = 'shirts';
  else if (/BOXER/i.test(upper)) productType = 'boxers';
  else if (/STARTER/i.test(upper)) productType = 'starter';
  else if (/KOMPLET|COMPLET|2P5/i.test(upper)) productType = 'kompleti';
  // Try to extract date from filename (patterns like 13-02-26 or 26.02.13)
  const dateMatch = name.match(/(\d{2})-(\d{2})-(\d{2})/);
  let fileDate = null;
  if (dateMatch) fileDate = `20${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
  return { creativeId: idMatch ? idMatch[1] : null, country: foundCountry || null, productType, fileDate };
}

// --- Auth ---
const sessionStore = {}; // token -> { username, role, userId, displayName, orgId }

function parseCookies(req) {
  const c = {}; (req.headers.cookie || '').split(';').forEach(p => { const [k,v] = p.trim().split('='); if(k) c[k]=v; }); return c;
}

function isAuthed(req) {
  const token = parseCookies(req).flores_session;
  return !!sessionStore[token];
}

function getSessionUser(req) {
  const token = parseCookies(req).flores_session;
  return sessionStore[token] || null;
}

// ═══ RATE LIMITING ═══
const rateLimitMap = new Map(); // sessionToken -> [timestamps]
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function checkRateLimit(req) {
  const token = parseCookies(req).flores_session || req.socket.remoteAddress;
  const now = Date.now();
  let timestamps = rateLimitMap.get(token) || [];
  timestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  timestamps.push(now);
  rateLimitMap.set(token, timestamps);
  return timestamps.length <= RATE_LIMIT_MAX;
}

// Cleanup rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (valid.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, valid);
  }
}, 300000);

// ═══ ACTIVITY LOGGING ═══
const logActivity = db.prepare(`INSERT INTO activity_log (user_id, username, action, details, entity_type, entity_id, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);

function actLog(req, action, details, entityType, entityId) {
  try {
    const user = getSessionUser(req);
    logActivity.run(user?.userId || null, user?.username || 'system', action, details || null, entityType || null, entityId || null, 1);
  } catch(e) { console.error('Activity log error:', e.message); }
}

// ═══ APP VERSION ═══
const APP_VERSION = '2.0.0';
const APP_START_TIME = Date.now();

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0].replace(/^\/flores/, '') || '/';
  const query = parseQuery(req.url);

  // Login API
  if (urlPath === '/api/login' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        // Support login by username OR email
        const user = db.prepare('SELECT * FROM flores_users WHERE (username = ? OR email = ?) AND password_hash = ?').get(username, username, hash);
        if (user) {
          // Check trial expiration
          const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(user.org_id || 1);
          if (org && org.plan === 'trial' && org.trial_end) {
            const trialEnd = new Date(org.trial_end + 'Z');
            if (trialEnd < new Date()) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Your free trial has expired. Please upgrade to continue using Flores.', trial_expired: true }));
            }
          }
          if (org && !org.active) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Your organization has been deactivated. Contact support.' }));
          }
          const token = crypto.randomBytes(32).toString('hex');
          sessionStore[token] = { username: user.username, role: user.role, userId: user.id, displayName: user.display_name, orgId: user.org_id || 1 };
          db.prepare('UPDATE flores_users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);
          // Log login activity
          try { logActivity.run(user.id, user.username, 'login', 'User logged in', 'user', String(user.id), user.org_id || 1); } catch(e) {}
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `flores_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
          res.end(JSON.stringify({ ok: true, role: user.role, username: user.username, redirect: '/app' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  if (urlPath === '/api/logout') {
    delete sessionStore[parseCookies(req).flores_session];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'flores_session=; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ═══ REGISTRATION API ═══
  if (urlPath === '/api/register' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      try {
        const { email, password, company_name } = JSON.parse(body);
        if (!email || !password || !company_name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Email, password, and company name are required' }));
        }
        if (password.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Password must be at least 6 characters' }));
        }
        // Check if email already exists
        const existing = db.prepare('SELECT id FROM flores_users WHERE email = ?').get(email);
        if (existing) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'An account with this email already exists' }));
        }
        // Create organization
        const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const orgResult = db.prepare('INSERT INTO organizations (name, plan, trial_end, max_accounts, active) VALUES (?, ?, ?, ?, 1)').run(company_name, 'trial', trialEnd, 1);
        const orgId = orgResult.lastInsertRowid;
        // Create admin user for the org
        const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') + '_' + orgId;
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        const userResult = db.prepare('INSERT INTO flores_users (username, email, password_hash, role, display_name, org_id) VALUES (?, ?, ?, ?, ?, ?)').run(username, email, hash, 'admin', company_name + ' Admin', orgId);
        const userId = userResult.lastInsertRowid;
        // Auto-login
        const token = crypto.randomBytes(32).toString('hex');
        sessionStore[token] = { username, role: 'admin', userId, displayName: company_name + ' Admin', orgId };
        // Log
        try { logActivity.run(userId, username, 'register', `New organization: ${company_name}`, 'organization', String(orgId), orgId); } catch(e) {}
        // Notify super admins
        try { db.prepare('INSERT INTO notifications (user_id, type, title, message, org_id) VALUES (NULL, ?, ?, ?, 1)').run('new_org', 'New Organization Registered', `${company_name} (${email}) started a free trial`); } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `flores_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
        res.end(JSON.stringify({ ok: true, redirect: '/app', org_id: orgId, username }));
      } catch(e) {
        console.error('Registration error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Registration failed: ' + e.message }));
      }
    });
    return;
  }

  // ═══ FACEBOOK OAUTH ═══
  if (urlPath === '/auth/facebook') {
    const redirectUri = encodeURIComponent((req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host + '/auth/facebook/callback');
    const fbUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${redirectUri}&scope=ads_management,ads_read,business_management`;
    res.writeHead(302, { 'Location': fbUrl });
    return res.end();
  }

  if (urlPath === '/auth/facebook/callback') {
    const code = query.code;
    if (!code) {
      res.writeHead(302, { 'Location': '/login?error=fb_denied' });
      return res.end();
    }
    // Exchange code for token
    try {
      const redirectUri = encodeURIComponent((req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host + '/auth/facebook/callback');
      const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${redirectUri}&client_secret=${FB_APP_SECRET}&code=${code}`;
      const tokenData = await new Promise((resolve, reject) => {
        https.get(tokenUrl, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      if (tokenData.access_token) {
        // Get user info
        const meData = await new Promise((resolve, reject) => {
          https.get(`https://graph.facebook.com/v21.0/me?fields=id,name,email&access_token=${tokenData.access_token}`, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          }).on('error', reject);
        });
        // If user is logged in, store the token for their org
        const sessionUser = getSessionUser(req);
        if (sessionUser) {
          const upsertSetting = db.prepare('INSERT INTO org_settings (org_id, category, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, category, key) DO UPDATE SET value = excluded.value');
          upsertSetting.run(sessionUser.orgId || 1, 'meta_api', 'access_token', tokenData.access_token);
          upsertSetting.run(sessionUser.orgId || 1, 'meta_api', 'fb_user_id', meData.id || '');
          upsertSetting.run(sessionUser.orgId || 1, 'meta_api', 'fb_user_name', meData.name || '');
          res.writeHead(302, { 'Location': '/app' });
          return res.end();
        }
        // Not logged in — redirect to login with info
        res.writeHead(302, { 'Location': '/login?fb_connected=1' });
        return res.end();
      } else {
        res.writeHead(302, { 'Location': '/login?error=fb_token_failed' });
        return res.end();
      }
    } catch(e) {
      console.error('FB OAuth error:', e.message);
      res.writeHead(302, { 'Location': '/login?error=fb_error' });
      return res.end();
    }
  }

  // Serve register page
  if (urlPath === '/register' || urlPath === '/register.html') {
    try {
      const registerHtml = fs.readFileSync(path.join(__dirname, 'register.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(registerHtml);
    } catch(e) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // Serve landing page (public, no auth)
  if (urlPath === '/' || urlPath === '/index' || urlPath === '/landing') {
    try {
      const landingHtml = fs.readFileSync(path.join(__dirname, 'landing.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
      res.end(landingHtml);
    } catch(e) {
      // Fallback: redirect to /app if no landing page exists
      res.writeHead(302, { 'Location': '/app' });
      res.end();
    }
    return;
  }

  // Serve login page without auth
  if (urlPath === '/login' || urlPath === '/login.html') {
    const loginHtml = fs.readFileSync(path.join(__dirname, 'login.html'));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(loginHtml);
    return;
  }

  // Health endpoint (no auth required)
  if (urlPath === '/api/health') {
    const memUsage = process.memoryUsage();
    const dbTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableCounts = {};
    for (const t of dbTables) {
      try { tableCounts[t.name] = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get().c; } catch(e) { tableCounts[t.name] = -1; }
    }
    const lastSync = db.prepare('SELECT MAX(last_sync_at) as ls FROM sync_state').get();
    return sendJSON(res, {
      status: 'ok',
      version: APP_VERSION,
      uptime: Math.floor((Date.now() - APP_START_TIME) / 1000),
      uptimeHuman: `${Math.floor((Date.now() - APP_START_TIME) / 3600000)}h ${Math.floor(((Date.now() - APP_START_TIME) % 3600000) / 60000)}m`,
      db: { tables: tableCounts },
      meta_token: META_TOKEN ? 'configured' : 'missing',
      dropbox_token: DROPBOX_REFRESH_TOKEN ? 'configured' : 'missing',
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
      },
      lastWcSync: lastSync?.ls || null,
      timestamp: new Date().toISOString()
    });
  }

  // Rate limiting
  if (urlPath.startsWith('/api/') && !checkRateLimit(req)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    return res.end(JSON.stringify({ error: 'Rate limit exceeded. Max 100 requests per minute.' }));
  }

  // Auth check for everything else
  if (!isAuthed(req)) {
    if (urlPath.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    // /app requires auth — redirect to login
    if (urlPath === '/app' || urlPath === '/app/') {
      res.writeHead(302, { 'Location': '/login' });
      return res.end();
    }
    // Other pages — redirect to login
    res.writeHead(302, { 'Location': '/login' });
    return res.end();
  }

  // Trial expiration check for authenticated API requests
  const sessionUser = getSessionUser(req);
  if (sessionUser && urlPath.startsWith('/api/') && urlPath !== '/api/me' && urlPath !== '/api/logout') {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(sessionUser.orgId || 1);
    if (org && org.plan === 'trial' && org.trial_end) {
      const trialEnd = new Date(org.trial_end + 'Z');
      if (trialEnd < new Date()) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Your free trial has expired. Please upgrade to continue.', trial_expired: true }));
      }
    }
    if (org && !org.active) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Organization deactivated. Contact support.' }));
    }
  }

  // Serve the app (authenticated SPA)
  if (urlPath === '/app' || urlPath === '/app/') {
    const appHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('</head>', '<meta http-equiv="Pragma" content="no-cache"><meta http-equiv="Expires" content="0"></head>');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(appHtml);
    return;
  }

  // API routes
  if (urlPath.startsWith('/api/')) {
    const dateFrom = query.date_from || getToday();
    const dateTo = query.date_to || getToday();

    try {
      if (urlPath === '/api/campaigns') {
        const data = await getCampaigns(dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/adsets') {
        if (!query.campaign_id) return sendJSON(res, { error: 'campaign_id required' }, 400);
        const data = await getAdsets(query.campaign_id, dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/all-adsets') {
        const data = await getAllAdsets(dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/all-ads') {
        const data = await getAllAds(dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/ads') {
        if (!query.adset_id) return sendJSON(res, { error: 'adset_id required' }, 400);
        const data = await getAds(query.adset_id, dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/campaign-orders') {
        if (!query.campaign_id) return sendJSON(res, { error: 'campaign_id required' }, 400);
        const campaignId = query.campaign_id;
        
        // Query DB for orders matching this campaign
        const rows = db.prepare(`
          SELECT wc_order_id, country, order_date, gross_eur, product_cost, shipping_cost, profit, product_type, adset_id, ad_id, adset_name, ad_name
          FROM wc_orders WHERE utm_campaign = ? AND order_date >= ? AND order_date <= ?
          ORDER BY order_date DESC
        `).all(campaignId, dateFrom, dateTo);
        
        const allOrders = rows.map(r => ({
          id: r.wc_order_id, number: r.wc_order_id,
          date: r.order_date,
          customer: '', email: '',
          country: r.country, total: r.gross_eur, currency: 'EUR',
          products: [{ name: r.product_type || 'unknown', qty: 1, price: r.gross_eur, sku: '' }],
          productCost: r.product_cost,
          profit: r.profit, qty: 1,
          adsetId: r.adset_id || '',
          adId: r.ad_id || '',
          adsetName: r.adset_name || '',
          adName: r.ad_name || ''
        }));
        
        return sendJSON(res, allOrders);
      }
      if (urlPath === '/api/campaign-daily') {
        if (!query.campaign_id) return sendJSON(res, { error: 'campaign_id required' }, 400);
        const cacheKey2 = `cdaily_${query.campaign_id}_${getToday()}`;
        let cached2 = getCached(cacheKey2);
        if (cached2) return sendJSON(res, cached2);
        
        // Fetch daily breakdown for this campaign (last 90 days)
        const d90 = new Date(); d90.setDate(d90.getDate() - 89);
        const dailyInsights = await metaGetAll(`${query.campaign_id}/insights`, {
          fields: 'spend,impressions,clicks,actions,cost_per_action_type',
          time_increment: 1,
          time_range: JSON.stringify({ since: d90.toISOString().slice(0,10), until: getToday() }),
          limit: 500
        });
        
        // Enrich each day with WC profit
        const days = await Promise.all(dailyInsights.map(async i => {
          const day = i.date_start;
          const spend = parseFloat(i.spend || 0);
          const purchases = (i.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
          const purch = purchases ? parseInt(purchases.value) : 0;
          const cpa = purch > 0 ? spend / purch : 0;
          
          // Get WC profit for this campaign on this day
          const camps = [{ id: query.campaign_id, name: query.campaign_name || '', insights: { spend: i.spend } }];
          enrichCampaignsWithProfit(camps, day, day);
          const profit = camps[0].wc?.profit ?? -spend;
          const orders = camps[0].wc?.orders ?? 0;
          
          return { date: day, spend, purchases: purch, cpa, profit, orders };
        }));
        
        setCache(cacheKey2, days);
        return sendJSON(res, days);
      }
      if (urlPath === '/api/multi-profit') {
        const data = await getMultiPeriodProfit();
        return sendJSON(res, data);
      }
      if (urlPath === '/api/insights') {
        const level = query.level || 'campaign';
        const data = await getInsights(level, dateFrom, dateTo, query.breakdown);
        return sendJSON(res, data);
      }

      if (urlPath === '/api/resync-profits' && req.method === 'POST') {
        console.log('[RESYNC] Force re-sync: resetting sync_state to 30 days ago and re-fetching all orders...');
        try {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
          for (const country of Object.keys(WC_STORES)) {
            updateSyncState.run({
              country,
              last_synced_order_id: 0,
              last_sync_at: thirtyDaysAgo,
              total_orders: 0
            });
          }
          const result = await syncAllCountries();
          // Clear all caches
          try {
            const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
            files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
            console.log('[RESYNC] Cleared ' + files.length + ' cache files');
          } catch(e) {}
          const totalOrders = db.prepare('SELECT COUNT(*) as cnt FROM wc_orders').get().cnt;
          console.log('[RESYNC] Complete. Total orders in DB: ' + totalOrders);
          return sendJSON(res, { ok: true, totalOrders, synced: result.synced });
        } catch (e) {
          console.error('[RESYNC] Error:', e.message);
          return sendJSON(res, { error: e.message }, 500);
        }
      }
      if (urlPath === '/api/sync') {
        try {
          const result = await syncAllCountries();
          return sendJSON(res, result);
        } catch (e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      }
      if (urlPath === '/api/sync-status') {
        const states = db.prepare('SELECT * FROM sync_state').all();
        const totalOrders = db.prepare('SELECT COUNT(*) as cnt FROM wc_orders').get().cnt;
        return sendJSON(res, { countries: states, totalOrders });
      }
      if (urlPath === '/api/base-report') {
        const start = query.start || dateFrom;
        const end = query.end || dateTo;

        // 1. Get campaign insights from Meta (use getCampaigns which is cached)
        const campaignData = await getCampaigns(start, end);

        // 2. Get all DB orders for the period
        const dbOrdersByCountry = {};
        const dbOrderRows = db.prepare(`
          SELECT country, COUNT(*) as orders, SUM(gross_eur) as revenue, SUM(profit) as profit
          FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1
          GROUP BY country
        `).all(start, end);
        for (const r of dbOrderRows) {
          dbOrdersByCountry[r.country] = { orders: r.orders, revenue: r.revenue || 0, profit: r.profit || 0 };
        }

        // Total orders per country (for proportional spend splitting)
        const totalOrdersByCountry = {};
        let totalOrdersAll = 0;
        for (const [cc, data] of Object.entries(dbOrdersByCountry)) {
          totalOrdersByCountry[cc] = data.orders;
          totalOrdersAll += data.orders;
        }

        // 2b. Get FB purchases per campaign from insights
        const campaignPurchases = {};
        for (const c of campaignData) {
          if (c.insights && c.insights.actions) {
            const pa = c.insights.actions.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
            campaignPurchases[c.id] = pa ? parseInt(pa.value) : 0;
          } else {
            campaignPurchases[c.id] = 0;
          }
        }

        // 3. Aggregate spend by country and type
        const byCountry = {};
        const byType = {};
        const byCountryAndType = {};

        for (const c of campaignData) {
          const spend = parseFloat(c.insights?.spend || 0);
          if (spend <= 0) continue;
          const parsed = parseCampaignName(c.name);
          const campType = parseCampaignType(c.name);
          const countries = parsed.countries.length > 0 ? parsed.countries : Object.keys(WC_STORES);

          // Split spend proportionally by order count in those countries
          let relevantOrders = 0;
          for (const cc of countries) {
            relevantOrders += (totalOrdersByCountry[cc] || 0);
          }

          for (const cc of countries) {
            const ccOrders = totalOrdersByCountry[cc] || 0;
            // Proportional split: if there are orders, use order ratio; otherwise equal split
            let spendShare;
            if (relevantOrders > 0) {
              spendShare = spend * (ccOrders / relevantOrders);
            } else {
              spendShare = spend / countries.length;
            }

            // Distribute FB purchases proportionally
            const fbPurchases = campaignPurchases[c.id] || 0;
            let purchShare;
            if (relevantOrders > 0) {
              purchShare = fbPurchases * (ccOrders / relevantOrders);
            } else {
              purchShare = fbPurchases / countries.length;
            }

            // By Country
            if (!byCountry[cc]) byCountry[cc] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
            byCountry[cc].spend += spendShare;
            byCountry[cc].purchases += purchShare;

            // By Type
            if (!byType[campType]) byType[campType] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
            byType[campType].spend += spendShare;
            byType[campType].purchases += purchShare;

            // By Country + Type
            const key = `${cc}_${campType}`;
            if (!byCountryAndType[key]) byCountryAndType[key] = { country: cc, type: campType, spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
            byCountryAndType[key].spend += spendShare;
            byCountryAndType[key].purchases += purchShare;
          }
        }

        // Fill in orders/revenue/profit from DB
        for (const cc of Object.keys(WC_STORES)) {
          const dbData = dbOrdersByCountry[cc] || { orders: 0, revenue: 0, profit: 0 };
          if (!byCountry[cc]) byCountry[cc] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
          byCountry[cc].orders = dbData.orders;
          byCountry[cc].revenue = Math.round(dbData.revenue * 100) / 100;
          byCountry[cc].profit = Math.round(dbData.profit * 100) / 100;
          byCountry[cc].spend = Math.round(byCountry[cc].spend * 100) / 100;
          byCountry[cc].purchases = Math.round(byCountry[cc].purchases);
          byCountry[cc].cpa = byCountry[cc].purchases > 0 ? Math.round(byCountry[cc].spend / byCountry[cc].purchases * 100) / 100 : 0;
          byCountry[cc].roas = byCountry[cc].spend > 0 ? Math.round(byCountry[cc].revenue / byCountry[cc].spend * 100) / 100 : 0;
          byCountry[cc].netProfit = Math.round((dbData.profit - byCountry[cc].spend) * 100) / 100;
          byCountry[cc].ppo = byCountry[cc].orders > 0 ? Math.round(byCountry[cc].netProfit / byCountry[cc].orders * 100) / 100 : 0;
        }

        // Orders/revenue/profit by type: get from DB grouped by type
        // We need to distribute DB orders by type based on campaign attribution
        // Simplification: query DB orders by campaign, then map campaign→type
        const dbOrdersByCampaign = db.prepare(`
          SELECT utm_campaign, country, COUNT(*) as orders, SUM(gross_eur) as revenue, SUM(profit) as profit
          FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1
          AND utm_campaign IS NOT NULL AND utm_campaign != ''
          GROUP BY utm_campaign, country
        `).all(start, end);

        // Map campaign_id → type
        const campaignTypeMap = {};
        for (const c of campaignData) {
          campaignTypeMap[c.id] = parseCampaignType(c.name);
        }

        for (const row of dbOrdersByCampaign) {
          const campType = campaignTypeMap[row.utm_campaign] || 'OTHER';
          if (!byType[campType]) byType[campType] = { spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
          byType[campType].orders += row.orders;
          byType[campType].revenue += row.revenue || 0;
          byType[campType].profit += row.profit || 0;

          const key = `${row.country}_${campType}`;
          if (!byCountryAndType[key]) byCountryAndType[key] = { country: row.country, type: campType, spend: 0, orders: 0, revenue: 0, profit: 0, purchases: 0 };
          byCountryAndType[key].orders += row.orders;
          byCountryAndType[key].revenue += row.revenue || 0;
          byCountryAndType[key].profit += row.profit || 0;
        }

        // Round and calculate CPA/ROAS for byType and byCountryAndType
        for (const v of Object.values(byType)) {
          v.spend = Math.round(v.spend * 100) / 100;
          v.revenue = Math.round(v.revenue * 100) / 100;
          v.profit = Math.round(v.profit * 100) / 100;
          v.purchases = Math.round(v.purchases);
          v.cpa = v.purchases > 0 ? Math.round(v.spend / v.purchases * 100) / 100 : 0;
          v.roas = v.spend > 0 ? Math.round(v.revenue / v.spend * 100) / 100 : 0;
          v.netProfit = Math.round((v.profit - v.spend) * 100) / 100;
          v.ppo = v.orders > 0 ? Math.round(v.netProfit / v.orders * 100) / 100 : 0;
        }
        for (const v of Object.values(byCountryAndType)) {
          v.spend = Math.round(v.spend * 100) / 100;
          v.revenue = Math.round(v.revenue * 100) / 100;
          v.profit = Math.round(v.profit * 100) / 100;
          v.purchases = Math.round(v.purchases);
          v.cpa = v.purchases > 0 ? Math.round(v.spend / v.purchases * 100) / 100 : 0;
          v.roas = v.spend > 0 ? Math.round(v.revenue / v.spend * 100) / 100 : 0;
          v.netProfit = Math.round((v.profit - v.spend) * 100) / 100;
          v.ppo = v.orders > 0 ? Math.round(v.netProfit / v.orders * 100) / 100 : 0;
        }

        return sendJSON(res, { byCountry, byType, byCountryAndType });
      }
      if (urlPath === '/api/origin-report') {
        const start = query.start || dateFrom;
        const end = query.end || dateTo;

        // Classify each order into an origin category
        const rows = db.prepare(`
          SELECT order_date, gross_eur, profit, is_fb_attributed, utm_source, utm_medium, utm_campaign
          FROM wc_orders WHERE order_date >= ? AND order_date <= ?
        `).all(start, end);

        function classifyOrigin(r) {
          const src = (r.utm_source || '').toLowerCase();
          const med = (r.utm_medium || '').toLowerCase();
          const camp = (r.utm_campaign || '').trim();

          if (r.is_fb_attributed === 1 && camp !== '') return 'FB Measured';
          if (r.is_fb_attributed === 1) return 'FB Unmeasured';
          if (src.includes('google') && (med.includes('cpc') || med.includes('paid') || med.includes('ppc'))) return 'Google Ads';
          if (src.includes('google') && (med === '' || med.includes('organic') || med.includes('referral'))) return 'Google Organic';
          if (src.includes('klaviyo') || src.includes('email') || src.includes('newsletter')) return 'Klaviyo';
          if (src.includes('callcenter') || src.includes('call_center') || src.includes('call-center') || src.includes('phone')) return 'Call Center';
          if (src === '' || src === 'direct' || src === '(direct)') return 'Direct';
          return 'Other';
        }

        // Build daily and byOrigin
        const dailyMap = {};
        const originMap = {};
        let totalOrders = 0, totalFB = 0, fbMeasured = 0, fbUnmeasured = 0;

        for (const r of rows) {
          const origin = classifyOrigin(r);
          totalOrders++;
          if (origin === 'FB Measured') { totalFB++; fbMeasured++; }
          else if (origin === 'FB Unmeasured') { totalFB++; fbUnmeasured++; }

          // Daily
          const d = r.order_date;
          if (!dailyMap[d]) {
            dailyMap[d] = { date: d, totalOrders: 0, fbTotal: 0, fbMeasured: 0, fbUnmeasured: 0, assignedInAdsManager: 0, googleAds: 0, googleOrganic: 0, klaviyo: 0, callCenter: 0, direct: 0, other: 0 };
          }
          dailyMap[d].totalOrders++;
          if (origin === 'FB Measured') { dailyMap[d].fbTotal++; dailyMap[d].fbMeasured++; dailyMap[d].assignedInAdsManager++; }
          else if (origin === 'FB Unmeasured') { dailyMap[d].fbTotal++; dailyMap[d].fbUnmeasured++; }
          else if (origin === 'Google Ads') dailyMap[d].googleAds++;
          else if (origin === 'Google Organic') dailyMap[d].googleOrganic++;
          else if (origin === 'Klaviyo') dailyMap[d].klaviyo++;
          else if (origin === 'Call Center') dailyMap[d].callCenter++;
          else if (origin === 'Direct') dailyMap[d].direct++;
          else dailyMap[d].other++;

          // By Origin
          if (!originMap[origin]) originMap[origin] = { origin, orders: 0, revenue: 0, profit: 0 };
          originMap[origin].orders++;
          originMap[origin].revenue += (r.gross_eur || 0);
          originMap[origin].profit += (r.profit || 0);
        }

        // Round origin values
        for (const o of Object.values(originMap)) {
          o.revenue = Math.round(o.revenue * 100) / 100;
          o.profit = Math.round(o.profit * 100) / 100;
        }

        const daily = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));
        const byOrigin = Object.values(originMap).sort((a, b) => b.orders - a.orders);

        return sendJSON(res, {
          summary: { totalOrders, totalFB, fbMeasured, fbUnmeasured, assignedInAdsManager: fbMeasured },
          daily,
          byOrigin
        });
      }
      if (urlPath === '/api/creative-report') {
        function getPurchases(ins) {
          const p = (ins.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
          return p ? parseInt(p.value) : 0;
        }
        const start = query.start || dateFrom;
        const end = query.end || dateTo;

        // Check cache first
        const crCacheKey = 'creative_report_' + start + '_' + end;
        const crCached = getCached(crCacheKey);
        if (crCached) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(crCached)); }

        // Fetch all ads with insights for date range
        const allAdsData = await getAllAds(start, end);

        const COUNTRIES = ['HR','CZ','PL','GR','SK','IT','HU'];
        const creativeMap = {};

        for (const ad of allAdsData) {
          const name = ad.name || '';
          const ins = ad.insights;
          if (!ins) continue;

          // Parse creative ID
          const idMatch = name.match(/^(ID\d+)/i);
          const creativeId = idMatch ? idMatch[1].toUpperCase() : 'Other';

          // Parse country from ad name (after ID and date)
          let adCountry = null;
          const parts = name.split('_');
          for (const p of parts) {
            const upper = p.toUpperCase();
            if (COUNTRIES.includes(upper)) { adCountry = upper; break; }
          }

          if (!creativeMap[creativeId]) {
            creativeMap[creativeId] = {
              id: creativeId,
              name: name, // first ad name as representative
              totalSpend: 0,
              totalClicks: 0,
              totalPurchases: 0,
              totalImpressions: 0,
              adCount: 0,
              countries: {}
            };
          }

          const c = creativeMap[creativeId];
          const spend = parseFloat(ins.spend || 0);
          const clicks = parseInt(ins.clicks || 0);
          const impressions = parseInt(ins.impressions || 0);
          const purchases = getPurchases(ins);

          c.totalSpend += spend;
          c.totalClicks += clicks;
          c.totalPurchases += purchases;
          c.totalImpressions += impressions;
          c.adCount++;

          // Use first name only if shorter / more representative
          if (name.length < c.name.length && creativeId !== 'Other') c.name = name;

          if (adCountry) {
            if (!c.countries[adCountry]) c.countries[adCountry] = { spend: 0, clicks: 0, purchases: 0 };
            c.countries[adCountry].spend += spend;
            c.countries[adCountry].clicks += clicks;
            c.countries[adCountry].purchases += purchases;
          }
        }

        // Calculate derived metrics and round
        const creatives = Object.values(creativeMap).map(c => {
          c.totalSpend = Math.round(c.totalSpend * 100) / 100;
          c.ctr = c.totalImpressions > 0 ? Math.round(c.totalClicks / c.totalImpressions * 10000) / 100 : 0;
          c.cpc = c.totalClicks > 0 ? Math.round(c.totalSpend / c.totalClicks * 100) / 100 : 0;
          c.cpa = c.totalPurchases > 0 ? Math.round(c.totalSpend / c.totalPurchases * 100) / 100 : 0;
          // Round country values
          for (const cc of Object.keys(c.countries)) {
            c.countries[cc].spend = Math.round(c.countries[cc].spend * 100) / 100;
          }
          return c;
        });

        // Sort by totalSpend descending
        creatives.sort((a, b) => b.totalSpend - a.totalSpend);

        // Totals
        const totals = {
          spend: Math.round(creatives.reduce((s, c) => s + c.totalSpend, 0) * 100) / 100,
          clicks: creatives.reduce((s, c) => s + c.totalClicks, 0),
          purchases: creatives.reduce((s, c) => s + c.totalPurchases, 0),
          impressions: creatives.reduce((s, c) => s + c.totalImpressions, 0)
        };

        const crResult = { creatives, totals };
        setCache(crCacheKey, crResult);
        return sendJSON(res, crResult);
      }

      // Dominik Chat - direct conversation via OpenClaw
      if (urlPath === '/api/chat-dominik' && req.method === 'POST') {
        const body = await readBody(req);
        const { message, context } = JSON.parse(body || '{}');
        if (!message) return sendJSON(res, { error: 'Message required' }, 400);

        try {
          // Build context-aware message for Dominik
          let fullMessage = message;
          if (context === 'campaigns') {
            // Inject current campaign summary
            const today = new Date().toISOString().slice(0, 10);
            const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
            try {
              const campaigns = await getCampaigns(d7, today);
              const active = campaigns.filter(c => c.status === 'ACTIVE');
              let ctxStr = `[Context: ${active.length} active campaigns, period ${d7} to ${today}]\n`;
              for (const c of active.slice(0, 10)) {
                const sp = parseFloat(c.insights?.spend || 0);
                const pAct = (c.insights?.actions || []).find(a => a.action_type === 'purchase' || a.action_type === 'omni_purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
                const p = pAct ? parseInt(pAct.value) : 0;
                ctxStr += `  ${c.name}: ${sp.toFixed(0)}EUR, ${p}p, CPA ${p > 0 ? (sp/p).toFixed(2) : 'N/A'}EUR\n`;
              }
              fullMessage = ctxStr + '\nUser question: ' + message;
            } catch(e) { /* proceed without context */ }
          }

          const reply = await callDominikAgent(fullMessage);
          return sendJSON(res, { reply, timestamp: new Date().toISOString() });
        } catch(e) {
          console.error('Chat Dominik error:', e.message);
          return sendJSON(res, { error: 'Chat failed: ' + e.message }, 500);
        }
      }

            // LLM-Powered AI Analysis
      if (urlPath === '/api/ai-analyze' && req.method === 'POST') {
        const body = await readBody(req);
        const { mode, campaignId, dateRange, question } = JSON.parse(body || '{}');
        const aiStart = dateRange?.start || dateFrom;
        const aiEnd = dateRange?.end || dateTo;

        try {
          let dataContext = '';

          if (mode === 'campaign' && campaignId) {
            // Single campaign deep analysis
            const campaignData = await getCampaigns(aiStart, aiEnd);
            const searchLower = campaignId.toLowerCase();
            const campaign = campaignData.find(c => c.id === campaignId || (c.name || '').toLowerCase().includes(searchLower));
            if (!campaign) return sendJSON(res, { error: 'Campaign not found: ' + campaignId }, 404);

            const spend = parseFloat(campaign.insights?.spend || 0);
            const pAct = (campaign.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
            const purch = pAct ? parseInt(pAct.value) : 0;
            const cpa = purch > 0 ? (spend / purch).toFixed(2) : 'N/A';

            let adsetInfo = '';
            try {
              const adsets = await getAdsets(campaign.id, aiStart, aiEnd);
              adsetInfo = adsets.map(a => {
                const asp = parseFloat(a.spend || 0);
                const ap = parseInt(a.purchases || 0);
                return `  - ${a.name} | Status: ${a.status} | Spend: ${asp.toFixed(2)}EUR | Purchases: ${ap} | CPA: ${ap > 0 ? (asp/ap).toFixed(2) : 'N/A'}EUR`;
              }).join('\n');
            } catch(e) {}

            dataContext = `CAMPAIGN ANALYSIS REQUEST
Campaign: ${campaign.name}
ID: ${campaign.id}
Status: ${campaign.status}
Period: ${aiStart} to ${aiEnd}
Spend: ${spend.toFixed(2)} EUR
Purchases (FB): ${purch}
CPA: ${cpa} EUR
WC Orders: ${campaign.wc?.orders || 0}
WC Revenue: ${(campaign.wc?.revenue || 0).toFixed(2)} EUR
WC Profit: ${(campaign.wc?.profit || 0).toFixed(2)} EUR

ADSETS:
${adsetInfo || 'No adset data available'}

${question ? 'USER QUESTION: ' + question : 'Provide a comprehensive analysis with specific recommendations.'}`;

          } else if (mode === 'general') {
            // Overall account analysis
            const campaignData = await getCampaigns(aiStart, aiEnd);
            const active = campaignData.filter(c => c.status === 'ACTIVE');
            let totalSpend = 0, totalPurch = 0, totalOrders = 0, totalProfit = 0;

            const campaignSummaries = campaignData.slice(0, 30).map(c => {
              const sp = parseFloat(c.insights?.spend || 0);
              const pAct = (c.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
              const p = pAct ? parseInt(pAct.value) : 0;
              totalSpend += sp; totalPurch += p;
              totalOrders += (c.wc?.orders || 0); totalProfit += (c.wc?.profit || 0);
              return `${c.name} | ${c.status} | Spend: ${sp.toFixed(0)}EUR | Purch: ${p} | CPA: ${p > 0 ? (sp/p).toFixed(2) : 'N/A'}EUR | WC Orders: ${c.wc?.orders || 0} | Profit: ${(c.wc?.profit || 0).toFixed(0)}EUR`;
            }).join('\n');

            dataContext = `GENERAL ACCOUNT ANALYSIS
Period: ${aiStart} to ${aiEnd}
Total Campaigns: ${campaignData.length} (${active.length} active)
Total Spend: ${totalSpend.toFixed(2)} EUR
Total Purchases (FB): ${totalPurch}
Overall CPA: ${totalPurch > 0 ? (totalSpend/totalPurch).toFixed(2) : 'N/A'} EUR
Total WC Orders: ${totalOrders}
Total Profit: ${totalProfit.toFixed(2)} EUR
ROAS: ${totalSpend > 0 ? ((totalProfit + totalSpend) / totalSpend).toFixed(2) : 'N/A'}

TOP CAMPAIGNS (by spend):
${campaignSummaries}

${question ? 'USER QUESTION: ' + question : 'Provide strategic analysis: what is working, what is not, and what should we do next. Focus on the highest-impact opportunities.'}`;

          } else if (mode === 'creative') {
            // Creative analysis
            const allAds = await getAllAds(aiStart, aiEnd);
            const creativeMap = {};
            for (const ad of allAds) {
              const idMatch = (ad.name || '').match(/^(ID\d+)/i);
              const crId = idMatch ? idMatch[1].toUpperCase() : null;
              if (!crId) continue;
              if (!creativeMap[crId]) creativeMap[crId] = { spend: 0, purchases: 0, countries: {} };
              const sp = parseFloat(ad.insights?.spend || 0);
              const pAct = (ad.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
              const p = pAct ? parseInt(pAct.value) : 0;
              creativeMap[crId].spend += sp;
              creativeMap[crId].purchases += p;
            }

            const creatives = Object.entries(creativeMap)
              .map(([id, d]) => ({ id, ...d, cpa: d.purchases > 0 ? d.spend / d.purchases : null }))
              .sort((a, b) => b.spend - a.spend)
              .slice(0, 30);

            const crSummary = creatives.map(c => `${c.id} | Spend: ${c.spend.toFixed(0)}EUR | Purchases: ${c.purchases} | CPA: ${c.cpa ? c.cpa.toFixed(2) : 'N/A'}EUR`).join('\n');

            dataContext = `CREATIVE ANALYSIS
Period: ${aiStart} to ${aiEnd}
Total Unique Creatives: ${Object.keys(creativeMap).length}

TOP CREATIVES (by spend):
${crSummary}

${question ? 'USER QUESTION: ' + question : 'Analyze creative performance: which creatives are winning, which should be killed, and what expansion opportunities exist. Identify patterns in what works.'}`;

          } else {
            // Free-form question with general context
            dataContext = question || 'Give me a quick overview of what I should focus on today for Noriks Facebook ads.';
          }

          // Call Dominik agent via OpenClaw
          const agentPrompt = AI_SYSTEM_PROMPT + '\n\nDATA:\n' + dataContext; // Routes to Dominik (Sonnet) via OpenClaw
          const llmResponse = await callDominikAgent(agentPrompt);
          return sendJSON(res, { analysis: llmResponse, mode, timestamp: new Date().toISOString() });
        } catch(e) {
          console.error('AI Analyze error:', e.message);
          return sendJSON(res, { error: 'AI analysis failed: ' + e.message }, 500);
        }
      }

            if (urlPath === '/api/creative-fatigue' && req.method === 'POST') {
        let body = '';
        await new Promise((resolve) => {
          req.on('data', c => body += c);
          req.on('end', resolve);
        });
        const { start, end, refresh } = JSON.parse(body || '{}');
        
        // Check SQLite cache (15 min TTL) unless refresh forced
        if (!refresh) {
          try {
            const cached = db.prepare("SELECT data, computed_at FROM fatigue_cache ORDER BY id DESC LIMIT 1").get();
            if (cached) {
              const age = Date.now() - new Date(cached.computed_at + 'Z').getTime();
              if (age < 15 * 60 * 1000) {
                const parsed = JSON.parse(cached.data);
                parsed._cached = true;
                parsed._cachedAt = cached.computed_at;
                return sendJSON(res, parsed);
              }
            }
          } catch(e) { /* cache miss, compute fresh */ }
        }
        
        try {
          const today = new Date();
          const fmt = d => d.toISOString().slice(0, 10);
          const d14 = fmt(new Date(today - 14 * 86400000));
          const d3 = fmt(new Date(today - 3 * 86400000));
          const dEnd = fmt(today);
          
          // Fetch ads for 14-day and 3-day windows
          const [ads14d, ads3d] = await Promise.all([
            getAllAds(d14, dEnd),
            getAllAds(d3, dEnd)
          ]);
          
          // Group by creative ID (extract ID prefix like "ID489" from ad name)
          function extractCreativeId(name) {
            const m = (name || '').match(/^(ID\d+)/i);
            return m ? m[1].toUpperCase() : null;
          }
          
          function getMetrics(ads) {
            const groups = {};
            for (const ad of ads) {
              const cid = extractCreativeId(ad.name);
              if (!cid) continue;
              if (!groups[cid]) groups[cid] = { spend: 0, clicks: 0, impressions: 0, reach: 0, purchases: 0, names: new Set() };
              const g = groups[cid];
              const ins = ad.insights || {};
              g.spend += parseFloat(ins.spend || 0);
              g.clicks += parseInt(ins.clicks || 0);
              g.impressions += parseInt(ins.impressions || 0);
              g.reach += parseInt(ins.reach || 0);
              g.names.add(ad.name);
              const purch = (ins.actions || []).find(a => 
                a.action_type === 'offsite_conversion.fb_pixel_purchase' || 
                a.action_type === 'purchase' || 
                a.action_type === 'omni_purchase'
              );
              g.purchases += purch ? parseInt(purch.value) : 0;
            }
            // Compute CPA and CTR
            for (const [id, g] of Object.entries(groups)) {
              g.cpa = g.purchases > 0 ? g.spend / g.purchases : null;
              g.ctr = g.impressions > 0 ? (g.clicks / g.impressions) * 100 : 0;
              g.frequency = g.reach > 0 ? g.impressions / g.reach : 0;
              g.name = [...g.names][0] || id;
            }
            return groups;
          }
          
          const metrics14 = getMetrics(ads14d);
          const metrics3 = getMetrics(ads3d);
          
          const fatigued = [];
          const healthy = [];
          
          for (const [id, m14] of Object.entries(metrics14)) {
            // Only analyze creatives with meaningful spend
            if (m14.spend < 5) continue;
            
            const m3 = metrics3[id];
            const cpa14 = m14.cpa;
            const cpa3 = m3?.cpa || null;
            const ctr14 = m14.ctr;
            const ctr3 = m3?.ctr || 0;
            
            let isFatigued = false;
            let severity = 'low';
            let reasons = [];
            
            // FB Frequency (impressions/reach) — primary fatigue metric
            const freq14 = m14.frequency || 0;
            const freq3 = m3?.frequency || 0;
            
            // High frequency = audience fatigue
            if (freq14 >= 4) {
              isFatigued = true;
              reasons.push('frequency');
              if (freq14 >= 6) severity = 'high';
              else severity = 'medium';
            }
            
            // Frequency rising fast (3d higher than 14d avg)
            if (freq3 > freq14 * 1.3 && freq3 >= 3) {
              isFatigued = true;
              reasons.push('freq_rising');
              if (freq3 >= 5) severity = 'high';
              else if (severity !== 'high') severity = 'medium';
            }
            
            // CPA spike (supporting signal)
            if (cpa14 && cpa14 > 0 && cpa3 && cpa3 > 0) {
              const cpaChange = ((cpa3 - cpa14) / cpa14) * 100;
              if (cpaChange > 30) {
                isFatigued = true;
                reasons.push('cpa');
                if (cpaChange > 60 && severity !== 'high') severity = 'high';
                else if (severity === 'low') severity = 'medium';
              }
            }
            
            // CTR decline (supporting signal)
            if (ctr14 > 0 && ctr3 >= 0) {
              const ctrChange = ((ctr3 - ctr14) / ctr14) * 100;
              if (ctrChange < -20) {
                isFatigued = true;
                reasons.push('ctr');
                if (severity === 'low') severity = 'medium';
              }
            }
            
            // Multiple signals = high
            if (reasons.length >= 3) severity = 'high';
            if (reasons.length >= 2 && reasons.includes('frequency')) severity = 'high';
            
            const entry = {
              id,
              name: m14.name,
              cpa14d: cpa14 ? Math.round(cpa14 * 100) / 100 : null,
              cpa3d: cpa3 ? Math.round(cpa3 * 100) / 100 : null,
              cpaChange: (cpa14 && cpa3 && cpa14 > 0) ? (((cpa3 - cpa14) / cpa14) * 100).toFixed(0) + '%' : 'N/A',
              frequency14d: Math.round((m14.frequency || 0) * 100) / 100,
              frequency3d: Math.round((m3?.frequency || 0) * 100) / 100,
              ctr14d: Math.round(ctr14 * 100) / 100,
              ctr3d: Math.round(ctr3 * 100) / 100,
              ctrChange: ctr14 > 0 ? (((ctr3 - ctr14) / ctr14) * 100).toFixed(0) + '%' : 'N/A',
              severity,
              totalSpend14d: Math.round(m14.spend * 100) / 100,
              purchases14d: m14.purchases,
              purchases3d: m3?.purchases || 0
            };
            
            if (isFatigued) {
              fatigued.push(entry);
            } else {
              healthy.push(entry);
            }
          }
          
          // Sort fatigued by severity
          const sevOrder = { high: 0, medium: 1, low: 2 };
          fatigued.sort((a, b) => (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3) || b.totalSpend14d - a.totalSpend14d);
          healthy.sort((a, b) => b.totalSpend14d - a.totalSpend14d);
          
          const fatigueResult = {
            fatigued,
            healthy,
            summary: {
              totalCreatives: fatigued.length + healthy.length,
              fatigued: fatigued.length,
              healthy: healthy.length
            }
          };
          
          // Save to SQLite cache
          try {
            db.prepare("DELETE FROM fatigue_cache WHERE id NOT IN (SELECT id FROM fatigue_cache ORDER BY id DESC LIMIT 5)").run();
            db.prepare("INSERT INTO fatigue_cache (data) VALUES (?)").run(JSON.stringify(fatigueResult));
          } catch(e) { console.error('Fatigue cache save error:', e.message); }
          
          return sendJSON(res, fatigueResult);
        } catch (e) {
          console.error('Creative fatigue error:', e);
          return sendJSON(res, { error: e.message }, 500);
        }
      }

      if (urlPath === '/api/ai-hints' && req.method === 'POST') {
        let body = '';
        await new Promise((resolve) => {
          req.on('data', c => body += c);
          req.on('end', resolve);
        });
        const { prompt, dateRange, campaignId } = JSON.parse(body || '{}');
        const aiStart = dateRange?.start || dateFrom;
        const aiEnd = dateRange?.end || dateTo;

        // Campaign-specific analysis mode
        if (campaignId) {
          const campaignData = await getCampaigns(aiStart, aiEnd);
          // Find campaign by ID or name (partial match)
          const searchLower = campaignId.toLowerCase();
          const campaign = campaignData.find(c => c.id === campaignId || (c.name || '').toLowerCase().includes(searchLower));
          if (!campaign) {
            return sendJSON(res, { error: `Campaign not found: ${campaignId}` }, 404);
          }

          const spend = parseFloat(campaign.insights?.spend || 0);
          const purchases = (campaign.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
          const purch = purchases ? parseInt(purchases.value) : 0;
          const orders = campaign.wc?.orders || 0;
          const profit = campaign.wc?.profit || 0;
          const cpa = purch > 0 ? Math.round(spend / purch * 100) / 100 : 0;

          // Get adsets
          let adsetList = [];
          try {
            const adsets = await getAdsets(campaign.id, aiStart, aiEnd);
            adsetList = adsets.map(a => ({
              name: a.name,
              id: a.id,
              status: a.status,
              spend: Math.round(parseFloat(a.spend || 0) * 100) / 100,
              purchases: parseInt(a.purchases || 0),
              cpa: a.purchases > 0 ? Math.round(a.spend / a.purchases * 100) / 100 : null
            }));
            adsetList.sort((a, b) => b.spend - a.spend);
          } catch(e) { console.error('Adset fetch error:', e.message); }

          // Campaign-specific recommendations
          const recommendations = [];
          if (cpa > 30) {
            recommendations.push({ type: 'pause', text: `Campaign CPA (€${cpa.toFixed(2)}) is well above target. Consider pausing.` });
          } else if (cpa > 0 && cpa < 15) {
            recommendations.push({ type: 'scale', text: `Campaign CPA (€${cpa.toFixed(2)}) is strong. Consider increasing budget.` });
          } else if (cpa >= 15 && cpa <= 30) {
            recommendations.push({ type: 'adjust', text: `Campaign CPA (€${cpa.toFixed(2)}) is moderate. Review adsets for optimization.` });
          }
          if (spend > 20 && purch === 0) {
            recommendations.push({ type: 'pause', text: `€${spend.toFixed(2)} spent with 0 purchases. Consider pausing.` });
          }

          // Adset-level recommendations
          for (const a of adsetList) {
            if (a.cpa && a.cpa > 30) {
              recommendations.push({ type: 'pause', text: `Pause adset "${(a.name||'').slice(0,40)}" (CPA €${a.cpa.toFixed(2)})` });
            } else if (a.spend > 15 && a.purchases === 0) {
              recommendations.push({ type: 'pause', text: `Pause adset "${(a.name||'').slice(0,40)}" (€${a.spend.toFixed(2)} spent, 0 purchases)` });
            } else if (a.cpa && a.cpa < 12 && a.purchases >= 2) {
              recommendations.push({ type: 'scale', text: `Scale adset "${(a.name||'').slice(0,40)}" (CPA €${a.cpa.toFixed(2)}, ${a.purchases} purchases)` });
            }
          }

          // Check for new adsets (watch)
          for (const a of adsetList) {
            if (a.spend > 0 && a.spend < 10 && a.purchases === 0) {
              recommendations.push({ type: 'watch', text: `Watch adset "${(a.name||'').slice(0,40)}" — low spend (€${a.spend.toFixed(2)}), needs more data` });
            }
          }

          // Daily breakdown
          let dailyData = [];
          try {
            const dailyInsights = await metaGetAll(campaign.id + '/insights', {
              fields: 'spend,actions',
              time_range: JSON.stringify({ since: aiStart, until: aiEnd }),
              time_increment: 1
            });
            dailyData = dailyInsights.map(d => ({
              date: d.date_start,
              spend: parseFloat(d.spend || 0),
              purchases: ((d.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase')?.value || 0) * 1
            }));
          } catch(e) { console.error('Daily insights error:', e.message); }

          return sendJSON(res, {
            summary: {
              campaignName: campaign.name,
              campaignId: campaign.id,
              campaignStatus: campaign.status,
              totalSpend: Math.round(spend * 100) / 100,
              totalOrders: orders,
              totalProfit: Math.round(profit * 100) / 100,
              avgCPA: cpa,
              totalPurchases: purch,
              adsets: adsetList,
              recommendations,
              dailyData,
              dateRange: { start: aiStart, end: aiEnd }
            }
          });
        }

        // General analysis (existing behavior)
        const campaignData = await getCampaigns(aiStart, aiEnd);

        let totalSpend = 0, totalOrders = 0, totalRevenue = 0, totalProfit = 0, totalPurchases = 0;
        const campDetails = [];

        for (const c of campaignData) {
          const spend = parseFloat(c.insights?.spend || 0);
          const purchases = (c.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
          const purch = purchases ? parseInt(purchases.value) : 0;
          const orders = c.wc?.orders || 0;
          const profit = c.wc?.profit || 0;
          const revenue = c.wc?.revenueGross || 0;

          totalSpend += spend;
          totalOrders += orders;
          totalRevenue += revenue;
          totalProfit += profit;
          totalPurchases += purch;

          if (spend > 0) {
            campDetails.push({
              name: c.name,
              id: c.id,
              status: c.status,
              spend: Math.round(spend * 100) / 100,
              purchases: purch,
              orders,
              profit: Math.round(profit * 100) / 100,
              cpa: purch > 0 ? Math.round(spend / purch * 100) / 100 : null
            });
          }
        }

        // Sort for top/worst
        const byProfit = [...campDetails].sort((a, b) => b.profit - a.profit);
        const topCampaigns = byProfit.slice(0, 5);
        const worstCampaigns = byProfit.slice(-5).reverse();

        // Generate recommendations
        const recommendations = [];
        for (const c of campDetails) {
          if (c.cpa && c.cpa > 30) {
            recommendations.push({ type: 'pause', text: `Pause ${c.name} (CPA €${c.cpa.toFixed(2)}, well above target)`, campaign: c.name });
          } else if (c.cpa && c.cpa < 15) {
            recommendations.push({ type: 'scale', text: `Scale ${c.name} (CPA €${c.cpa.toFixed(2)}, strong performer)`, campaign: c.name });
          } else if (c.purchases === 0 && c.spend > 20) {
            recommendations.push({ type: 'pause', text: `Pause ${c.name} (€${c.spend.toFixed(2)} spent, 0 purchases)`, campaign: c.name });
          } else if (c.cpa && c.cpa >= 15 && c.cpa <= 30 && c.profit < 0) {
            recommendations.push({ type: 'adjust', text: `Adjust ${c.name} (CPA €${c.cpa.toFixed(2)}, negative profit €${c.profit.toFixed(2)})`, campaign: c.name });
          } else if (c.spend > 0 && c.spend < 10 && c.purchases === 0) {
            recommendations.push({ type: 'watch', text: `Watch ${c.name} — low spend (€${c.spend.toFixed(2)}), needs more data`, campaign: c.name });
          }
        }

        // Country performance comparison
        const countryPerf = {};
        for (const c of campDetails) {
          const parsed = parseCampaignName(c.name);
          for (const cc of parsed.countries) {
            if (!countryPerf[cc]) countryPerf[cc] = { spend: 0, purchases: 0, profit: 0 };
            countryPerf[cc].spend += c.spend;
            countryPerf[cc].purchases += c.purchases;
            countryPerf[cc].profit += c.profit;
          }
        }

        // Country-level recommendations
        for (const [cc, data] of Object.entries(countryPerf)) {
          const cpa = data.purchases > 0 ? data.spend / data.purchases : null;
          if (cpa && cpa > 30) {
            recommendations.push({ type: 'adjust', text: `Consider reducing budget in ${cc} (country CPA €${cpa.toFixed(2)})`, campaign: cc });
          } else if (cpa && cpa < 12 && data.spend > 50) {
            recommendations.push({ type: 'scale', text: `Increase budget in ${cc} (country CPA €${cpa.toFixed(2)}, room to scale)`, campaign: cc });
          }
        }

        const avgCPA = totalPurchases > 0 ? Math.round(totalSpend / totalPurchases * 100) / 100 : 0;

        return sendJSON(res, {
          summary: {
            totalSpend: Math.round(totalSpend * 100) / 100,
            totalOrders,
            totalProfit: Math.round(totalProfit * 100) / 100,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            avgCPA,
            totalPurchases,
            topCampaigns,
            worstCampaigns,
            recommendations,
            countryPerformance: countryPerf,
            dateRange: { start: aiStart, end: aiEnd },
            prompt: prompt || ''
          }
        });
      }
      if (urlPath === '/api/clear-cache') {
        const files = fs.readdirSync(CACHE_DIR).filter(f => !f.startsWith('dash-') && f !== 'origin-data.json');
        files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
        return sendJSON(res, { cleared: files.length });
      }

      // ═══ SESSION INFO ═══
      if (urlPath === '/api/me') {
        const user = getSessionUser(req);
        return sendJSON(res, { username: user?.username, role: user?.role, displayName: user?.displayName, orgId: user?.orgId });
      }

      // ═══ USERS MANAGEMENT (admin only) ═══
      if (urlPath === '/api/users' && req.method === 'GET') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const page = parseInt(query.page) || 1;
        const limit = Math.min(parseInt(query.limit) || 50, 200);
        const offset = (page - 1) * limit;
        const total = db.prepare('SELECT COUNT(*) as cnt FROM flores_users').get().cnt;
        const users = db.prepare('SELECT id, username, display_name, role, created_at, last_login FROM flores_users ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
        return sendJSON(res, { data: users, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
      }
      if (urlPath === '/api/users' && req.method === 'POST') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const body = await readBody(req);
        const { username, password, display_name, role } = JSON.parse(body);
        if (!username || !password) return sendJSON(res, { error: "Username and password required" }, 400);
        if (username.length < 3 || username.length > 50) return sendJSON(res, { error: "Username must be 3-50 characters" }, 400);
        if (password.length < 4) return sendJSON(res, { error: "Password must be at least 4 characters" }, 400);
        if (/[^a-zA-Z0-9._-]/.test(username)) return sendJSON(res, { error: "Username can only contain letters, numbers, dots, dashes, underscores" }, 400);
        if (!['super_admin', 'admin', 'advertiser', 'viewer'].includes(role)) return sendJSON(res, { error: 'Invalid role' }, 400);
        try {
          const hash = crypto.createHash('sha256').update(password).digest('hex');
          const result = db.prepare('INSERT INTO flores_users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(username, hash, display_name || username, role);
          actLog(req, 'user_created', `Created user ${username} (${role})`, 'user', String(result.lastInsertRowid));
          // Create notification for new user
          try { db.prepare('INSERT INTO notifications (user_id, type, title, message, org_id) VALUES (NULL, ?, ?, ?, 1)').run('user_created', 'New User Created', `User "${username}" was created with role ${role}`); } catch(e) {}
          return sendJSON(res, { ok: true, id: result.lastInsertRowid });
        } catch(e) {
          return sendJSON(res, { error: 'Username already exists' }, 400);
        }
      }
      if (urlPath.match(/^\/api\/users\/\d+$/) && req.method === 'PUT') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const id = parseInt(urlPath.split('/').pop());
        const body = await readBody(req);
        const { display_name, role, password } = JSON.parse(body);
        if (role && !['super_admin', 'admin', 'advertiser', 'viewer'].includes(role)) return sendJSON(res, { error: 'Invalid role' }, 400);
        if (password) {
          const hash = crypto.createHash('sha256').update(password).digest('hex');
          db.prepare('UPDATE flores_users SET display_name = ?, role = ?, password_hash = ? WHERE id = ?').run(display_name, role, hash, id);
        } else {
          db.prepare('UPDATE flores_users SET display_name = ?, role = ? WHERE id = ?').run(display_name, role, id);
        }
        return sendJSON(res, { ok: true });
      }
      if (urlPath.match(/^\/api\/users\/\d+$/) && req.method === 'DELETE') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const id = parseInt(urlPath.split('/').pop());
        if (user.userId === id) return sendJSON(res, { error: 'Cannot delete yourself' }, 400);
        db.prepare('DELETE FROM flores_users WHERE id = ?').run(id);
        return sendJSON(res, { ok: true });
      }

      // ═══ SETTINGS ═══
      if (urlPath === '/api/settings' && req.method === 'GET') {
        const rows = db.prepare('SELECT key, value FROM flores_settings').all();
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        return sendJSON(res, settings);
      }
      if (urlPath === '/api/settings' && req.method === 'POST') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const body = await readBody(req);
        const settings = JSON.parse(body);
        const upsert = db.prepare('INSERT INTO flores_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        db.transaction(() => {
          for (const [k, v] of Object.entries(settings)) upsert.run(k, String(v));
        })();
        actLog(req, 'settings_changed', `Updated ${Object.keys(settings).length} settings`, 'settings', null);
        return sendJSON(res, { ok: true });
      }

      // ═══ FB INTEGRATION ═══
      if (urlPath === '/api/fb-status') {
        try {
          const meData = await fbGet(`/me?fields=id,name&access_token=${META_TOKEN}`);
          return sendJSON(res, {
            app_id: FB_APP_ID,
            token_valid: !meData.error,
            user_name: meData.name || 'Unknown',
            user_id: meData.id || ''
          });
        } catch(e) {
          return sendJSON(res, { app_id: FB_APP_ID, token_valid: false, user_name: 'Error', error: e.message });
        }
      }
      if (urlPath === '/api/fb-accounts') {
        try {
          const data = await fbGet(`/me/adaccounts?fields=name,account_id,currency,timezone_name,account_status&limit=50&access_token=${META_TOKEN}`);
          return sendJSON(res, data.data || []);
        } catch(e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      }
      if (urlPath === '/api/fb-pages') {
        try {
          const data = await fbGet(`/me/accounts?fields=name,id,access_token,tasks&limit=50&access_token=${META_TOKEN}`);
          return sendJSON(res, data.data || []);
        } catch(e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      }

      // ═══ BULK CREATE CAMPAIGNS ═══
      if (urlPath === '/api/bulk-create-campaigns' && req.method === 'POST') {
        const body = await readBody(req);
        const { campaigns: campConfigs } = JSON.parse(body);
        if (!campConfigs || !campConfigs.length) return sendJSON(res, { error: 'No campaigns provided' }, 400);

        const results = [];
        for (let i = 0; i < campConfigs.length; i++) {
          const cfg = campConfigs[i];
          const adAccountId = AD_ACCOUNTS_MAP[cfg.ad_account] || AD_ACCOUNTS_MAP['top_noriks_2'];
          try {
            // 1. Create Campaign (PAUSED)
            const campaignData = await fbPost(`/${adAccountId}/campaigns`, {
              name: cfg.campaign_name,
              objective: cfg.objective || 'OUTCOME_SALES',
              status: 'PAUSED',
              special_ad_categories: '[]',
              ...(cfg.campaign_type === 'CBO' ? { daily_budget: Math.round((cfg.daily_budget || 20) * 100) } : {})
            });
            if (campaignData.error) throw new Error(campaignData.error.message);

            // 2. Create AdSet
            const targeting = {
              geo_locations: { countries: [cfg.country] },
              age_min: cfg.age_min || 25,
              age_max: cfg.age_max || 55,
            };
            if (cfg.gender && cfg.gender !== 'all') {
              targeting.genders = Array.isArray(cfg.gender) ? cfg.gender : [parseInt(cfg.gender)];
            }
            const adsetPayload = {
              campaign_id: campaignData.id,
              name: `${cfg.campaign_name} - Adset`,
              targeting: JSON.stringify(targeting),
              billing_event: 'IMPRESSIONS',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
              status: 'PAUSED',
              ...(cfg.campaign_type !== 'CBO' ? { daily_budget: Math.round((cfg.daily_budget || 20) * 100) } : {})
            };
            const adsetData = await fbPost(`/${adAccountId}/adsets`, adsetPayload);
            if (adsetData.error) throw new Error(adsetData.error.message);

            // 3. Create Creative
            const creativePayload = {
              name: `${cfg.campaign_name} - Creative`,
              object_story_spec: JSON.stringify({
                page_id: NORIKS_PAGE_ID,
                link_data: {
                  image_url: cfg.image_url || '',
                  link: cfg.landing_page_url || '',
                  message: cfg.primary_text || '',
                  name: cfg.headline || '',
                  call_to_action: { type: cfg.cta || 'SHOP_NOW', value: { link: cfg.landing_page_url || '' } }
                }
              })
            };
            const creativeData = await fbPost(`/${adAccountId}/adcreatives`, creativePayload);
            if (creativeData.error) throw new Error(creativeData.error.message);

            // 4. Create Ad
            const adPayload = {
              name: `${cfg.campaign_name} - Ad`,
              adset_id: adsetData.id,
              creative: JSON.stringify({ creative_id: creativeData.id }),
              status: 'PAUSED'
            };
            const adData = await fbPost(`/${adAccountId}/ads`, adPayload);
            if (adData.error) throw new Error(adData.error.message);

            results.push({
              index: i,
              success: true,
              campaign_name: cfg.campaign_name,
              campaign_id: campaignData.id,
              adset_id: adsetData.id,
              creative_id: creativeData.id,
              ad_id: adData.id
            });
          } catch(e) {
            results.push({
              index: i,
              success: false,
              campaign_name: cfg.campaign_name,
              error: e.message
            });
          }
          // Delay between campaigns
          if (i < campConfigs.length - 1) await new Promise(r => setTimeout(r, 1000));
        }
        actLog(req, 'bulk_upload', `Bulk created ${results.filter(r=>r.success).length}/${results.length} campaigns`, 'campaign', null);
        return sendJSON(res, { results });
      }

      // ═══ VIDEOS (Dropbox) ═══
      if (urlPath === '/api/videos' && req.method === 'GET') {
        const forceRefresh = query.refresh === '1';
        if (!forceRefresh && videosCache && Date.now() - videosCacheTime < VIDEOS_CACHE_TTL) {
          return sendJSON(res, videosCache);
        }
        try {
          const allFiles = await dropboxListAllFiles(DROPBOX_FOLDER);
          const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
          const videos = allFiles
            .filter(f => f['.tag'] === 'file' && videoExts.some(ext => f.name.toLowerCase().endsWith(ext)))
            .map(f => {
              const parsed = parseVideoFilename(f.name);
              return {
                name: f.name,
                path: f.path_display || f.path_lower,
                id: parsed.creativeId,
                country: parsed.country,
                productType: parsed.productType,
                fileDate: parsed.fileDate,
                size: f.size,
                modified: f.server_modified
              };
            })
            .sort((a, b) => {
              const idA = parseInt(a.id) || 0, idB = parseInt(b.id) || 0;
              return idB - idA; // newest IDs first
            });
          const result = { files: videos, total: videos.length, cached_at: new Date().toISOString() };
          videosCache = result;
          videosCacheTime = Date.now();
          return sendJSON(res, result);
        } catch(e) {
          console.error('Videos API error:', e);
          return sendJSON(res, { error: e.message }, 500);
        }
      }
      if (urlPath === '/api/video-link' && req.method === 'GET') {
        if (!query.path) return sendJSON(res, { error: 'path required' }, 400);
        try {
          const result = await dropboxApi('/2/files/get_temporary_link', { path: query.path });
          if (result.error) throw new Error(JSON.stringify(result.error));
          return sendJSON(res, { link: result.link, name: result.metadata?.name });
        } catch(e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      }
      if (urlPath === '/api/video-thumbnail' && req.method === 'GET') {
        if (!query.path) return sendJSON(res, { error: 'path required' }, 400);
        try {
          const token = await getDropboxToken();
          // Sanitize path for HTTP header (replace non-ASCII with escaped unicode)
          const safePath = query.path.replace(/[^\x00-\x7F]/g, function(ch) {
            var code = ch.codePointAt(0);
            if (code > 0xFFFF) return '\\U' + ('00000000' + code.toString(16)).slice(-8);
            return '\\u' + ('0000' + code.toString(16)).slice(-4);
          });
          const arg = JSON.stringify({ resource: { ".tag": "path", path: safePath }, format: { ".tag": "jpeg" }, size: { ".tag": "w256h256" }, mode: { ".tag": "fitone_bestfit" } });
          return new Promise((resolve, reject) => {
            const req2 = https.request({
              hostname: 'content.dropboxapi.com', path: '/2/files/get_thumbnail_v2', method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + token,
                'Dropbox-API-Arg': arg,
                'Dropbox-API-Path-Root': JSON.stringify({".tag": "root", "root": DROPBOX_ROOT})
              }
            }, (resp) => {
              res.writeHead(resp.statusCode, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
              resp.pipe(res);
              resolve();
            });
            req2.on('error', (e) => { sendJSON(res, { error: e.message }, 500); resolve(); });
            req2.end();
          });
        } catch(e) {
          return sendJSON(res, { error: e.message }, 500);
        }
      }

      // ═══ DASHBOARD API ═══
      if (urlPath === '/api/dashboard') {
        const dashFrom = query.date_from || getToday(); const dashTo = query.date_to || getToday();
        // Dashboard reads from SQLite - no Meta API calls, instant response
        const today = getToday();
        const d7ago = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
        
        // Today's KPIs from wc_orders
        const todayStats = db.prepare('SELECT COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date >= ? AND order_date <= ?').get(dashFrom, dashTo);
        const fbOrders = db.prepare('SELECT COUNT(*) as orders FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1').get(dashFrom, dashTo);
        
        // 7-day daily chart data
        const chartData = db.prepare('SELECT order_date as date, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date >= ? GROUP BY order_date ORDER BY order_date').all(d7ago);
        
        // Top campaigns - from Meta API (has campaign names)
        let topCampaignsRaw = [];
        try { topCampaignsRaw = await getCampaigns(dashFrom, dashTo); } catch(e) {}
        
        // Top products
        const topProducts = db.prepare("SELECT product_type, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue FROM wc_orders WHERE order_date >= ? AND order_date <= ? GROUP BY product_type ORDER BY orders DESC").all(dashFrom, dashTo);
        
        // By country (today)
        const byCountry = db.prepare('SELECT country, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date = ? GROUP BY country ORDER BY orders DESC').all(today);
        
        // 7-day totals
        const weekStats = db.prepare('SELECT COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date >= ?').get(d7ago);
        
        // FB spend from dash-cache
        let fbSpendToday = 0, fbSpend7d = 0, fbSpendRange = 0;
        let dashCacheData = null;
        try {
          const dc = JSON.parse(fs.readFileSync(DASH_CACHE_FILE, 'utf8'));
          dashCacheData = dc.data || {};
          const td = dashCacheData[today] || {};
          for (const [,v] of Object.entries(td)) { if (v && typeof v.spend === 'number') fbSpendToday += v.spend; }
          for (const [date, countries] of Object.entries(dashCacheData)) {
            if (date >= d7ago && date <= today) {
              for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpend7d += v.spend; }
            }
            if (date >= dashFrom && date <= dashTo) {
              for (const [,v] of Object.entries(countries)) { if (v && typeof v.spend === 'number') fbSpendRange += v.spend; }
            }
          }
        } catch(e) {}

        // Enrich topCampaigns with FB spend data
        let enrichedCampaigns = [];
        if (Array.isArray(topCampaignsRaw)) {
          for (const camp of topCampaignsRaw) {
            const spend = parseFloat(camp.insights?.spend) || 0;
            const pActCheck = (camp.insights?.actions || []).find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'omni_purchase');
            const hasPurchases = pActCheck && parseInt(pActCheck.value) > 0;
            if (spend <= 0 && !hasPurchases) continue;
            const pAct = (camp.insights?.actions || []).find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'omni_purchase');
            const purchases = pAct ? parseInt(pAct.value) : 0;
            const wcOrders = camp.wc?.orders || 0;
            const orders = Math.max(wcOrders, purchases);
            const revenue = camp.wc?.revenueGross || 0;
            const rawProfit = camp.wc?.profit || 0;
            const profit = Math.round((rawProfit - spend) * 100) / 100;
            enrichedCampaigns.push({
              name: camp.name,
              displayName: camp.name,
              spend: Math.round(spend * 100) / 100,
              orders,
              revenue: Math.round(revenue * 100) / 100,
              profit,
              cpa: orders > 0 ? Math.round(spend / orders * 100) / 100 : 0
            });
          }
          enrichedCampaigns.sort((a, b) => { if (a.orders > 0 && b.orders === 0) return -1; if (b.orders > 0 && a.orders === 0) return 1; return b.orders - a.orders || b.spend - a.spend; });
          enrichedCampaigns = enrichedCampaigns.slice(0, 10);
        }

        // Top creatives — ad-level: FB spend + WC orders/revenue/profit
        let topCreativesData = [];
        try {
          let adsInsights = await metaGetAll(AD_ACCOUNT + '/insights', {
            level: 'ad',
            fields: 'ad_name,ad_id,spend,actions,action_values',
            time_range: JSON.stringify({since: dashFrom, until: dashTo}),
            sort: 'spend_descending',
            limit: '50'
          });
          // Also fetch from second ad account
          for (const acct of Object.values(AD_ACCOUNTS_MAP)) {
            if (acct === AD_ACCOUNT) continue;
            try {
              const ads2 = await metaGetAll(acct + '/insights', {
                level: 'ad', fields: 'ad_name,ad_id,spend,actions,action_values',
                time_range: JSON.stringify({since: dashFrom, until: dashTo}),
                sort: 'spend_descending', limit: '50'
              });
              adsInsights = adsInsights.concat(ads2);
            } catch(e) {}
          }
          // Get WC orders per ad_id from SQLite
          const wcAdOrders = db.prepare("SELECT ad_id, COUNT(*) as orders, COALESCE(SUM(gross_eur),0) as revenue, COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id").all(dashFrom, dashTo);
          const wcAdMap = {};
          for (const row of wcAdOrders) { wcAdMap[row.ad_id] = row; }
          
          for (const ad of (adsInsights || [])) {
            const spend = parseFloat(ad.spend) || 0;
            const pAct = (ad.actions || []).find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'omni_purchase');
            const purchases = pAct ? parseInt(pAct.value) : 0;
            const hasPurchases = purchases > 0;
            if (spend <= 0 && !hasPurchases) continue;
            const wc = wcAdMap[ad.ad_id] || {};
            const orders = Math.max(wc.orders || 0, purchases);
            const revenue = wc.revenue ? Math.round(wc.revenue * 100) / 100 : 0;
            const profit = Math.round(((wc.profit || 0) - spend) * 100) / 100;
            topCreativesData.push({
              id: ad.ad_id,
              name: ad.ad_name,
              spend: Math.round(spend * 100) / 100,
              purchases,
              orders,
              revenue,
              profit,
              cpa: orders > 0 ? Math.round(spend / orders * 100) / 100 : 0
            });
          }
          topCreativesData.sort((a, b) => { if (a.purchases > 0 && b.purchases === 0) return -1; if (b.purchases > 0 && a.purchases === 0) return 1; return b.purchases - a.purchases || b.spend - a.spend; });
          topCreativesData = topCreativesData.slice(0, 10);
        } catch(e) { console.warn('[DASH] Top creatives fetch error:', e.message); }

        // FB KPI data
        const fbAttributedProfit = db.prepare('SELECT COALESCE(SUM(profit),0) as profit FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND is_fb_attributed = 1').get(dashFrom, dashTo);
        let fbMeasuredOrders = 0;
        if (Array.isArray(topCampaignsRaw)) {
          for (const camp of topCampaignsRaw) {
            const pAct = (camp.insights?.actions || []).find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'omni_purchase');
            if (pAct) fbMeasuredOrders += parseInt(pAct.value) || 0;
          }
        }
        const fbOrderCount = fbOrders?.orders || 0;
        const fbUnmeasuredOrders = Math.max(0, fbOrderCount - fbMeasuredOrders);
        const fbCpa = fbOrderCount > 0 ? Math.round((fbSpendRange / fbOrderCount) * 100) / 100 : 0;
        const fbProfit = Math.round(((fbAttributedProfit.profit || 0) - fbSpendRange) * 100) / 100;

        // Alerts
        const alerts = [];
        // Global CPA alert
        if (fbSpendRange > 0 && todayStats.orders > 0) {
          const todayCPA = fbSpendRange / todayStats.orders;
          if (todayCPA > 25) alerts.push({ type: 'high_cpa', message: 'CPA today is €' + todayCPA.toFixed(2) + ' — above €25 threshold' });
        }
        // Global ROAS alert
        if (fbSpendRange > 50 && todayStats.revenue > 0) {
          const roas = todayStats.revenue / fbSpendRange;
          if (roas < 1.5) alerts.push({ type: 'low_roas', message: 'ROAS today is ' + roas.toFixed(2) + 'x — below 1.5x threshold' });
        }
        // Global no-orders alert
        if (fbSpendRange > 100 && todayStats.orders === 0) {
          alerts.push({ type: 'no_orders', message: '€' + fbSpendToday.toFixed(0) + ' spent today with 0 orders' });
        }
        // Per-campaign high CPA alert
        for (const camp of enrichedCampaigns) {
          if (camp.orders > 0 && camp.cpa > 20) {
            alerts.push({ type: 'high_cpa', message: camp.name + ' — CPA €' + camp.cpa.toFixed(2) + ' (>' + '\u20ac20)' });
          }
        }
        // Per-campaign high spend, zero orders alert
        for (const camp of enrichedCampaigns) {
          if (camp.spend > 15 && camp.orders === 0) {
            alerts.push({ type: 'no_orders', message: camp.name + ' — €' + camp.spend.toFixed(0) + ' spent, 0 orders' });
          }
        }
        // Per-country high spend, zero orders alert
        if (dashCacheData) {
          const td = dashCacheData[dashFrom] || {};
          for (const [ctry, v] of Object.entries(td)) {
            if (v && typeof v.spend === 'number' && v.spend > 15) {
              const ctryOrders = db.prepare('SELECT COUNT(*) as cnt FROM wc_orders WHERE order_date >= ? AND order_date <= ? AND country = ?').get(dashFrom, dashTo, ctry);
              if ((ctryOrders?.cnt || 0) === 0) {
                alerts.push({ type: 'no_orders', message: ctry + ' — €' + v.spend.toFixed(0) + ' spent, 0 orders' });
              }
            }
          }
        }
        // Spending pace alert (projected daily spend > €800)
        {
          const now = new Date();
          const currentHour = now.getUTCHours() + now.getUTCMinutes() / 60;
          if (currentHour > 1 && fbSpendToday > 0) {
            const projectedSpend = fbSpendToday * (24 / currentHour);
            if (projectedSpend > 800) {
              alerts.push({ type: 'high_cpa', message: 'Spending pace: projected €' + projectedSpend.toFixed(0) + '/day (current €' + fbSpendToday.toFixed(0) + ' in ' + currentHour.toFixed(1) + 'h)' });
            }
          }
        }

        // Orders list for table
        const ordersList = db.prepare("SELECT wc_order_id, order_date, order_datetime, country, gross_eur, profit, utm_source, utm_medium, utm_campaign, is_fb_attributed, billing_name, billing_city, billing_email, raw_meta FROM wc_orders WHERE order_date >= ? AND order_date <= ? ORDER BY order_datetime DESC, wc_order_id DESC").all(dashFrom, dashTo);
        const ordersListFormatted = ordersList.map(o => {
          let origin = 'Organic';
          if (o.is_fb_attributed === 1) origin = 'Facebook';
          else if (o.utm_source === 'callcenter') origin = 'Call Center';
          else if ((o.utm_source || '').includes('google') || o.utm_medium === 'cpc') origin = 'Google';
          else if ((o.utm_source || '').includes('klaviyo') || (o.utm_source || '').includes('email')) origin = 'Klaviyo';
          const fbMeasured = o.is_fb_attributed === 1 ? (o.utm_campaign && o.utm_campaign !== '' && !o.utm_campaign.startsWith('google') ? 'Measured' : 'Not Measured') : null;
          const customer = (o.billing_name || '').trim() || '#' + o.wc_order_id;
          const datetime = (o.order_datetime || o.order_date || '').slice(0, 16);
          let items = '';
          try { const mm = JSON.parse(o.raw_meta || '{}'); if (mm.line_items) items = mm.line_items.map(li => (li.quantity||1) + 'x ' + (li.name||'').slice(0,30)).join(', '); } catch(e5) {}
          let orderDatetime2 = datetime;
          if (!orderDatetime2 || orderDatetime2.length < 11) {
            try { const mm2 = JSON.parse(o.raw_meta || '{}'); if (mm2.date_created) orderDatetime2 = mm2.date_created.replace('T',' ').slice(0,16); } catch(e6) {}
          }
          return { id: o.wc_order_id, date: o.order_date, datetime: orderDatetime2, country: o.country, customer, email: o.billing_email || '', origin, fbMeasured, items, revenue: Math.round(o.gross_eur * 100) / 100, profit: Math.round(o.profit * 100) / 100 };
        });

        return sendJSON(res, {
          orders_list: ordersListFormatted,
          kpis: {
            orders: todayStats.orders || 0,
            revenue: Math.round((todayStats.revenue || 0) * 100) / 100,
            profit: Math.round(((todayStats.profit || 0) - fbSpendRange) * 100) / 100,
            fbOrders: fbOrderCount,
            profitPerOrder: todayStats.orders > 0 ? Math.round(((todayStats.profit || 0) - fbSpendRange) / todayStats.orders * 100) / 100 : 0,
            fbProfitPerOrder: fbOrderCount > 0 ? Math.round(fbProfit / fbOrderCount * 100) / 100 : 0,
            ordersBySource: (() => { try { const rows = db.prepare("SELECT CASE WHEN is_fb_attributed = 1 THEN 'Facebook' WHEN utm_source = 'callcenter' THEN 'Call Center' WHEN utm_source LIKE '%google%' OR utm_medium = 'cpc' THEN 'Google' WHEN utm_source LIKE '%klaviyo%' OR utm_source LIKE '%email%' THEN 'Klaviyo' ELSE 'Organic' END as src, COUNT(*) as cnt FROM wc_orders WHERE order_date >= ? AND order_date <= ? GROUP BY src ORDER BY cnt DESC").all(dashFrom, dashTo); const m = {}; rows.forEach(r => m[r.src] = r.cnt); return m; } catch(e) { return {}; } })(),
            fbMeasuredOrders,
            fbUnmeasuredOrders,
            fbCpa,
            fbProfit,
            weekOrders: weekStats?.orders || 0,
            weekRevenue: Math.round((weekStats?.revenue || 0) * 100) / 100,
            weekProfit: Math.round(((weekStats?.profit || 0) - fbSpend7d) * 100) / 100,
            spend: Math.round(fbSpendRange * 100) / 100,
            cpa: todayStats.orders > 0 ? Math.round((fbSpendRange / todayStats.orders) * 100) / 100 : 0,
            activeCampaigns: Array.isArray(topCampaignsRaw) ? topCampaignsRaw.filter(c => c.status === "ACTIVE").length : 0,
            weekSpend: Math.round(fbSpend7d * 100) / 100
          },
          topCampaigns: enrichedCampaigns,
          topProducts,
          byCountry: byCountry.map(c => ({ country: c.country, orders: c.orders, revenue: Math.round(c.revenue * 100) / 100, profit: Math.round(c.profit * 100) / 100 })),
          chartData: chartData.map(d => {
            let daySpend = 0;
            try { const dd = (dashCacheData||{})[d.date]||{}; for (const [,v] of Object.entries(dd)) { if (v && typeof v.spend === 'number') daySpend += v.spend; } } catch(e){}
            return { date: d.date, orders: d.orders, revenue: Math.round(d.revenue * 100) / 100, profit: Math.round((d.profit - daySpend) * 100) / 100, spend: Math.round(daySpend * 100) / 100 };
          }),
          alerts: alerts,
          topCreatives: topCreativesData,
          date: today
        });
      }

            // ═══ ACTIVITY LOG API ═══
      if (urlPath === '/api/activity-log') {
        const page = parseInt(query.page) || 1;
        const limit = Math.min(parseInt(query.limit) || 50, 200);
        const offset = (page - 1) * limit;
        let where = 'WHERE org_id = 1';
        const params = [];
        if (query.user) { where += ' AND username = ?'; params.push(query.user); }
        if (query.action) { where += ' AND action = ?'; params.push(query.action); }
        if (query.from) { where += ' AND created_at >= ?'; params.push(query.from); }
        if (query.to) { where += ' AND created_at <= ?'; params.push(query.to + ' 23:59:59'); }
        const total = db.prepare(`SELECT COUNT(*) as cnt FROM activity_log ${where}`).get(...params).cnt;
        const rows = db.prepare(`SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        const users = db.prepare('SELECT DISTINCT username FROM activity_log WHERE org_id = 1').all().map(r => r.username);
        const actions = db.prepare('SELECT DISTINCT action FROM activity_log WHERE org_id = 1').all().map(r => r.action);
        return sendJSON(res, { data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) }, filters: { users, actions } });
      }

      // ═══ NOTIFICATIONS API ═══
      if (urlPath === '/api/notifications') {
        const user = getSessionUser(req);
        const rows = db.prepare('SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND org_id = 1 ORDER BY created_at DESC LIMIT 50').all(user?.userId || 0);
        const unread = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0 AND org_id = 1').get(user?.userId || 0).cnt;
        return sendJSON(res, { notifications: rows, unread });
      }
      if (urlPath === '/api/notifications/mark-read' && req.method === 'POST') {
        const user = getSessionUser(req);
        const body = await readBody(req);
        const { id, all: markAll } = JSON.parse(body || '{}');
        if (markAll) {
          db.prepare('UPDATE notifications SET read = 1 WHERE (user_id = ? OR user_id IS NULL) AND org_id = 1').run(user?.userId || 0);
        } else if (id) {
          db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
        }
        return sendJSON(res, { ok: true });
      }

      // ═══ SUPER ADMIN: ORGANIZATIONS ═══
      if (urlPath === '/api/admin/organizations' && req.method === 'GET') {
        const user = getSessionUser(req);
        if (!user || user.role !== 'super_admin') return sendJSON(res, { error: 'Super admin access required' }, 403);
        const orgs = db.prepare('SELECT * FROM organizations ORDER BY id').all();
        const orgData = orgs.map(o => {
          const userCount = db.prepare('SELECT COUNT(*) as cnt FROM flores_users WHERE org_id = ?').get(o.id).cnt;
          let trialStatus = 'active';
          if (o.plan === 'trial' && o.trial_end) {
            trialStatus = new Date(o.trial_end + 'Z') < new Date() ? 'expired' : 'active';
          } else if (o.plan !== 'trial') {
            trialStatus = 'paid';
          }
          return { ...o, userCount, trialStatus };
        });
        const stats = {
          totalOrgs: orgs.length,
          activeTrials: orgs.filter(o => o.plan === 'trial' && o.active && o.trial_end && new Date(o.trial_end + 'Z') >= new Date()).length,
          paidPlans: orgs.filter(o => o.plan !== 'trial' && o.active).length,
          inactive: orgs.filter(o => !o.active).length
        };
        return sendJSON(res, { organizations: orgData, stats });
      }
      if (urlPath.match(/^\/api\/admin\/organizations\/\d+$/) && req.method === 'PUT') {
        const user = getSessionUser(req);
        if (!user || user.role !== 'super_admin') return sendJSON(res, { error: 'Super admin access required' }, 403);
        const orgId = parseInt(urlPath.split('/').pop());
        const body = await readBody(req);
        const { plan, active, extend_trial_days, max_accounts } = JSON.parse(body);
        if (plan !== undefined) db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(plan, orgId);
        if (active !== undefined) db.prepare('UPDATE organizations SET active = ? WHERE id = ?').run(active ? 1 : 0, orgId);
        if (max_accounts !== undefined) db.prepare('UPDATE organizations SET max_accounts = ? WHERE id = ?').run(max_accounts, orgId);
        if (extend_trial_days) {
          const org = db.prepare('SELECT trial_end FROM organizations WHERE id = ?').get(orgId);
          const baseDate = (org && org.trial_end) ? new Date(org.trial_end + 'Z') : new Date();
          const newEnd = new Date(Math.max(baseDate.getTime(), Date.now()) + extend_trial_days * 24 * 60 * 60 * 1000);
          db.prepare('UPDATE organizations SET trial_end = ? WHERE id = ?').run(newEnd.toISOString().slice(0, 19).replace('T', ' '), orgId);
        }
        actLog(req, 'org_updated', `Updated org ${orgId}: ${JSON.stringify({ plan, active, extend_trial_days })}`, 'organization', String(orgId));
        return sendJSON(res, { ok: true });
      }

      // ═══ ORG SETTINGS API ═══
      if (urlPath.match(/^\/api\/org-settings\/[\w-]+$/) && req.method === 'GET') {
        const user = getSessionUser(req);
        const category = urlPath.split('/').pop();
        const orgId = user?.orgId || 1;
        const settings = getOrgSettings(orgId, category);
        return sendJSON(res, settings);
      }
      if (urlPath.match(/^\/api\/org-settings\/[\w-]+$/) && req.method === 'POST') {
        const user = getSessionUser(req);
        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return sendJSON(res, { error: 'Admin access required' }, 403);
        const category = urlPath.split('/').pop();
        const orgId = user.orgId || 1;
        const body = await readBody(req);
        const settings = JSON.parse(body);
        const upsertSetting = db.prepare('INSERT INTO org_settings (org_id, category, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, category, key) DO UPDATE SET value = excluded.value');
        const deleteSetting = db.prepare('DELETE FROM org_settings WHERE org_id = ? AND category = ? AND key = ?');
        db.transaction(() => {
          for (const [k, v] of Object.entries(settings)) {
            if (v === null || v === undefined || v === '') {
              deleteSetting.run(orgId, category, k);
            } else {
              const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
              upsertSetting.run(orgId, category, k, val);
            }
          }
        })();
        actLog(req, 'org_settings_changed', `Updated ${category} settings (${Object.keys(settings).length} keys)`, 'org_settings', category);
        return sendJSON(res, { ok: true });
      }

      // ═══ ME ENDPOINT (enhanced) ═══
      if (urlPath === '/api/me-full') {
        const user = getSessionUser(req);
        const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(user?.orgId || 1);
        let trialDaysLeft = null;
        if (org && org.plan === 'trial' && org.trial_end) {
          trialDaysLeft = Math.max(0, Math.ceil((new Date(org.trial_end + 'Z').getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
        }
        return sendJSON(res, {
          username: user?.username,
          role: user?.role,
          displayName: user?.displayName,
          orgId: user?.orgId,
          organization: org ? { name: org.name, plan: org.plan, trialDaysLeft, active: !!org.active } : null
        });
      }

      return sendJSON(res, { error: 'not found' }, 404);
    } catch (err) {
      console.error('API error:', err);
      return sendJSON(res, { error: err.message || String(err) }, 500);
    }
  }

  // Static files (CSS, JS, images, etc.)
  let filePath = urlPath;
  filePath = path.join(__dirname, filePath);
  
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Flores running on http://localhost:${PORT}`);
  // Pre-warm dashboard cache on startup + every 10 min
  // Background dashboard refresh (non-blocking)
  async function refreshDashboardInBackground() {
    if (_dashRefreshing) return;
    _dashRefreshing = true;
    try {
      const today = getToday();
      const d7ago = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      const dashFrom = today, dashTo = today;
      const campaignData = await getCampaigns(dashFrom, dashTo);
      let totalSpend = 0, totalPurchases = 0, totalOrders = 0, totalRevenue = 0, totalProfit = 0, activeCampaigns = 0;
      const topCampaigns = [];
      for (const c of campaignData) {
        const spend = parseFloat(c.insights?.spend || 0);
        const pAct = (c.insights?.actions || []).find(a => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase' || a.action_type === 'omni_purchase');
        const p = pAct ? parseInt(pAct.value) : 0;
        totalSpend += spend; totalPurchases += p;
        totalOrders += (c.wc?.orders || 0); totalRevenue += (c.wc?.revenueGross || 0); totalProfit += (c.wc?.profit || 0);
        if (c.status === 'ACTIVE') activeCampaigns++;
        topCampaigns.push({ name: c.name, spend: Math.round(spend*100)/100, purchases: p, profit: Math.round(((c.wc?.profit||0) - spend)*100)/100 });
      }
      topCampaigns.sort((a,b) => b.spend - a.spend);
      const avgCPA = totalPurchases > 0 ? totalSpend / totalPurchases : 0;
      _dashboardCache = {
        kpis: { spend: Math.round(totalSpend*100)/100, orders: totalOrders, revenue: Math.round(totalRevenue*100)/100, profit: Math.round(totalProfit*100)/100, cpa: Math.round(avgCPA*100)/100, activeCampaigns },
        topCampaigns: topCampaigns.slice(0,5),
        topCreatives: [],
        alerts: [],
        chartData: [],
        date: today
      };
      _dashboardCacheTime = Date.now();
      console.log('[FLORES] Dashboard background refresh done');
    } catch(e) { console.log('[FLORES] Background refresh failed:', e.message); }
    _dashRefreshing = false;
  }

  async function prewarmDashboard() {
    try {
      const today = getToday();
      await getCampaigns(today, today);
      _dashboardCacheTime = 0; // Force refresh next dashboard call
      console.log('[FLORES] Campaign cache pre-warmed');
    } catch(e) { console.log('[FLORES] Pre-warm failed:', e.message); }
  }
  setTimeout(prewarmDashboard, 3000);
  setInterval(prewarmDashboard, 600000);
});

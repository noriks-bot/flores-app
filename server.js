const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3200;
const META_TOKEN = 'EAAbve4r8sNoBQZBwFXNmYMwfat1w6XGsvLF0pRvjrYJig6JVhXZAMvRZA5Fz9qEThfygBnQrUiXUZBwNXv9SBIlMPp27zx3VMzfIXcGHY9TcIP9Uh93taCsk4tZAoK9vs5MrT2LP9ogFs9Jbuzj7ZBZBjGXIdpdgKvCWKUDgZAHiium8mceXs8lrvtYeKPBWuLQVSueZCeO7sSUg1';
const AD_ACCOUNT = 'act_1922887421998222';
const API_VERSION = 'v21.0';
const CACHE_DIR = path.join(__dirname, 'cache');

// --- WooCommerce profit data from dash.noriks.com ---
const DASH_CACHE_FILE = path.join(CACHE_DIR, 'dash-cache.json');
const ORIGIN_CACHE_FILE = path.join(CACHE_DIR, 'origin-data.json');

const PRODUCT_COSTS = { tshirt: 3.5, boxers: 2.25 };
const EUR_RATES = { HR: 1, CZ: 0.041, PL: 0.232, GR: 1, IT: 1, HU: 0.00256, SK: 1 };

// WooCommerce API keys per country store — DISABLED (WC REST API calls removed)
const WC_STORES = {
  // HR: { url: 'https://noriks.com/hr', ck: 'ck_ff08e90a8ff90be9f7fdfe7badfd4fdaa456d86b', cs: 'cs_0c36e01e44e488ae9d8a931b591a4d52584d975f' },
  // CZ: { url: 'https://noriks.com/cz', ck: 'ck_396d624acec5f7a46dfcfa7d2a74b95c82b38962', cs: 'cs_2a69c7ad4a4d118a2b8abdf44abdd058c9be9115' },
  // PL: { url: 'https://noriks.com/pl', ck: 'ck_8fd83582ada887d0e586a04bf870d43634ca8f2c', cs: 'cs_f1bf98e46a3ae0623c5f2f9fcf7c2478240c5115' },
  // GR: { url: 'https://noriks.com/gr', ck: 'ck_2595568b83966151e08031e42388dd1c34307107', cs: 'cs_dbd091b4fc11091638f8ec4c838483be32cfb15b' },
  // SK: { url: 'https://noriks.com/sk', ck: 'ck_1abaeb006bb9039da0ad40f00ab674067ff1d978', cs: 'cs_32b33bc2716b07a738ff18eb377a767ef60edfe7' },
  // IT: { url: 'https://noriks.com/it', ck: 'ck_84a1e1425710ff9eeed69b100ed9ac445efc39e2', cs: 'cs_81d25dcb0371773387da4d30482afc7ce83d1b3e' },
  // HU: { url: 'https://noriks.com/hu', ck: 'ck_e591c2a0bf8c7a59ec5893e03adde3c760fbdaae', cs: 'cs_d84113ee7a446322d191be0725c0c92883c984c3' }
};
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };

// Parse campaign name for country + product type
// Format: DRŽAVA__TIP | date: DD.MM.YYYY or DRŽAVA+DRŽAVA__TIP
function parseCampaignName(name) {
  if (!name) return { countries: [], productType: null };
  const n = name.toUpperCase();
  
  // Extract countries (before __)
  const countryMatch = n.match(/^([A-Z_+]+?)__/);
  let countries = [];
  if (countryMatch) {
    countries = countryMatch[1].split(/[+_]/).filter(c => ['HR','CZ','PL','GR','SK','IT','HU'].includes(c));
  }
  
  // Extract product type
  let productType = null;
  if (/MAJICE|SHIRT/i.test(n)) productType = 'shirts';
  else if (/BOXERS|BOXER/i.test(n)) productType = 'boxers';
  else if (/STARTER/i.test(n)) productType = 'starter';
  else if (/2P5|KOMPLET/i.test(n)) productType = 'kompleti';
  else if (/CATALOG/i.test(n)) productType = 'catalog';
  
  return { countries, productType };
}

// Fetch dash cache.json via SSH (cached locally for 1 hour)
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
const { execSync } = require('child_process');
function syncDashData() {
  try {
    execSync('scp -i /home/ec2-user/.ssh/firma_appi.pem ec2-user@18.185.109.219:/home/ec2-user/apps/raketa/dashboard/cache.json ' + DASH_CACHE_FILE, { timeout: 30000 });
    execSync('scp -i /home/ec2-user/.ssh/firma_appi.pem ec2-user@18.185.109.219:/home/ec2-user/apps/raketa/dashboard/origin-data.json ' + ORIGIN_CACHE_FILE, { timeout: 30000 });
    console.log('[FLORES] Synced dash data');
  } catch(e) { console.error('[FLORES] Dash sync failed:', e.message); }
}
syncDashData();
setInterval(syncDashData, 3600000);

// Fetch Advertiser profit data directly from dash server via SSH
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
    // Use SSH + curl to fetch from dash server (more reliable than direct HTTP)
    const cmd = `ssh -i /home/ec2-user/.ssh/firma_appi.pem -o ConnectTimeout=10 ec2-user@18.185.109.219 'TOKEN=$(curl -s -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -d "{\\"username\\":\\"noriks\\",\\"password\\":\\"noriks\\"}" -D - 2>/dev/null | grep -oP "session=\\\\K[^;]+") && curl -s -b "session=$TOKEN" "http://localhost:3000/api/advertiser-data?start=${dateFrom}&end=${dateTo}"'`;
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

// Fetch all FB-attributed WC orders and calculate actual profit per order
// Returns: { "HR_shirts": { orders: N, totalProfit, totalRevenue, avgProfit, avgRevenue }, ... }
const wcOrdersCache = {};
async function fetchActualWcOrders(dateFrom, dateTo) {
  const cacheKey = `${dateFrom}_${dateTo}`;
  if (wcOrdersCache[cacheKey] && Date.now() - wcOrdersCache[cacheKey].ts < 3600000) return wcOrdersCache[cacheKey].data;
  
  const result = {}; // "COUNTRY_productType" -> { orders, totalProfit, totalRevenue }
  
  for (const [country, store] of Object.entries(WC_STORES)) {
    try {
      const eurRate = EUR_RATES[country] || 1;
      const vatRate = VAT_RATES[country] || 0;
      const rejRate = 0.1;
      
      const wcUrl = `${store.url}/wp-json/wc/v3/orders?after=${dateFrom}T00:00:00&before=${dateTo}T23:59:59&per_page=100&status=processing,completed&consumer_key=${store.ck}&consumer_secret=${store.cs}`;
      const wcData = await new Promise((resolve, reject) => {
        https.get(wcUrl, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      
      if (!Array.isArray(wcData)) continue;
      
      for (const order of wcData) {
        const meta = order.meta_data || [];
        const utm = (meta.find(m => m.key === '_wc_order_attribution_utm_source')?.value || '').toLowerCase();
        const ref = (meta.find(m => m.key === '_wc_order_attribution_referrer')?.value || '').toLowerCase();
        const sess = meta.find(m => m.key === '_wc_order_attribution_session_entry')?.value || '';
        const isFB = utm.includes('facebook') || utm.includes('fb') || utm.includes('ig') || utm.includes('meta') ||
                     ref.includes('facebook.com') || ref.includes('fb.com') || ref.includes('instagram.com') ||
                     ref.includes('fbclid') || sess.includes('fbclid') || sess.includes('campaignID');
        if (!isFB) continue;
        
        const items = order.line_items || [];
        const grossEur = parseFloat(order.total || 0) * eurRate;
        const netRevenue = grossEur * (1 - rejRate) / (1 + vatRate);
        
        let productCost = 0;
        const shirtWords = /shirt|majic|μπλουζ|koszulk|tričko|tričk|póló|magliett|tshirt|t-shirt/i;
        const boxerWords = /boxer|μπόξερ|μποξερ|bokser|boxerk|airflow|modal/i;
        const kompletWords = /komplet|bundle|σετ/i;
        const starterWords = /starter|εκκίνησ|start/i;
        
        let hasShirt = false, hasBoxer = false, hasKomplet = false, hasStarter = false;
        for (const i of items) {
          const qty = i.quantity || 1;
          const isShirt = shirtWords.test(i.name || '') || shirtWords.test(i.sku || '');
          productCost += (isShirt ? PRODUCT_COSTS.tshirt : PRODUCT_COSTS.boxers) * qty;
          if (shirtWords.test(i.name || '')) hasShirt = true;
          if (boxerWords.test(i.name || '')) hasBoxer = true;
          if (kompletWords.test(i.name || '') || (i.sku||'').includes('BUNDLE')) hasKomplet = true;
          if (starterWords.test(i.name || '')) hasStarter = true;
        }
        
        let ptype = 'shirts'; // default
        if (hasKomplet) ptype = 'kompleti';
        else if (hasStarter) ptype = 'starter';
        else if (hasShirt && !hasBoxer) ptype = 'shirts';
        else if (hasBoxer && !hasShirt) ptype = 'boxers';
        else if (hasShirt) ptype = 'shirts';
        else if (hasBoxer) ptype = 'boxers';
        
        const shippingCost = parseFloat(order.shipping_total || 0) > 0 ? 3.5 : 0;
        const orderProfit = netRevenue - productCost - shippingCost;
        
        const key = country + '_' + ptype;
        if (!result[key]) result[key] = { orders: 0, totalProfit: 0, totalRevenue: 0 };
        result[key].orders++;
        result[key].totalProfit += orderProfit;
        result[key].totalRevenue += grossEur;
      }
    } catch(e) { console.error(`[FLORES] WC fetch error for ${country}:`, e.message); }
  }
  
  // Calculate averages
  for (const v of Object.values(result)) {
    v.avgProfit = v.orders > 0 ? v.totalProfit / v.orders : 0;
    v.avgRevenue = v.orders > 0 ? v.totalRevenue / v.orders : 0;
  }
  
  wcOrdersCache[cacheKey] = { data: result, ts: Date.now() };
  return result;
}

// Fetch WC orders from all stores, matched to campaigns by utm_campaign ID
// Returns: { campaignId: [{ orderId, country, grossEur, profit, ... }] }
const wcOrdersByCampaignCache = {};
async function fetchWcOrdersByCampaign(dateFrom, dateTo) {
  const cacheKey = dateFrom + '_' + dateTo;
  const isToday = dateTo >= new Date().toISOString().slice(0, 10);
  const ttl = isToday ? 300000 : 3600000;
  if (wcOrdersByCampaignCache[cacheKey] && Date.now() - wcOrdersByCampaignCache[cacheKey].ts < ttl) {
    return wcOrdersByCampaignCache[cacheKey].data;
  }
  
  const byCampaign = {};
  const REJECTION_RATE = 0.1;
  
  const fetches = Object.entries(WC_STORES).map(async ([country, store]) => {
    try {
      const wcUrl = `${store.url}/wp-json/wc/v3/orders?after=${dateFrom}T00:00:00&before=${dateTo}T23:59:59&per_page=100&status=processing,completed&consumer_key=${store.ck}&consumer_secret=${store.cs}`;
      const wcData = await new Promise((resolve, reject) => {
        https.get(wcUrl, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve([]); } });
        }).on('error', () => resolve([]));
      });
      if (!Array.isArray(wcData)) return;
      
      for (const order of wcData) {
        const meta = order.meta_data || [];
        const utmCampaign = meta.find(m => m.key === '_wc_order_attribution_utm_campaign')?.value || '';
        const utmSource = (meta.find(m => m.key === '_wc_order_attribution_utm_source')?.value || '').toLowerCase();
        const referrer = (meta.find(m => m.key === '_wc_order_attribution_referrer')?.value || '').toLowerCase();
        const sessionEntry = (meta.find(m => m.key === '_wc_order_attribution_session_entry')?.value || '').toLowerCase();
        
        const isFB = utmSource.includes('fb') || utmSource.includes('ig') || utmSource.includes('meta') || utmSource.includes('facebook') ||
                     referrer.includes('facebook.com') || referrer.includes('fb.com') || referrer.includes('instagram.com') ||
                     sessionEntry.includes('fbclid');
        if (!isFB) continue;
        
        // Calculate order profit (same formulas as dash.noriks.com)
        const eurRate = EUR_RATES[country] || 1;
        const grossTotal = parseFloat(order.total || 0);
        const grossEur = grossTotal * eurRate;
        const vatRate = VAT_RATES[country] || 0;
        const netEur = grossEur * (1 - REJECTION_RATE) / (1 + vatRate);
        
        let productCost = 0;
        const items = order.line_items || [];
        for (const item of items) {
          const qty = item.quantity || 1;
          const nameL = (item.name || '').toLowerCase();
          const isShirt = /shirt|majic|μπλουζ|koszulk|tričko|póló|magliett|tshirt|t-shirt/i.test(nameL);
          productCost += (isShirt ? PRODUCT_COSTS.tshirt : PRODUCT_COSTS.boxers) * qty;
        }
        
        const shippingCost = parseFloat(order.shipping_total || 0) > 0 ? 3.5 : 0;
        const profit = netEur - productCost - shippingCost;
        
        let campaignId = utmCampaign;
        if (!campaignId) {
          const match = sessionEntry.match(/campaignid=(\d+)/i);
          if (match) campaignId = match[1];
        }
        if (!campaignId) continue;
        
        if (!byCampaign[campaignId]) byCampaign[campaignId] = [];
        byCampaign[campaignId].push({
          orderId: order.id, country,
          grossEur: Math.round(grossEur * 100) / 100,
          netEur: Math.round(netEur * 100) / 100,
          productCost: Math.round(productCost * 100) / 100,
          shipping: shippingCost,
          profit: Math.round(profit * 100) / 100
        });
      }
    } catch(e) { console.error('[FLORES] WC fetch error for', country, e.message); }
  });
  
  await Promise.all(fetches);
  console.log('[FLORES] WC orders by campaign:', Object.keys(byCampaign).length, 'campaigns,', Object.values(byCampaign).reduce((s, v) => s + v.length, 0), 'orders');
  wcOrdersByCampaignCache[cacheKey] = { data: byCampaign, ts: Date.now() };
  return byCampaign;
}

// Calculate WC profit per campaign from its ACTUAL orders (matched by utm_campaign ID)
async function enrichCampaignsWithProfit(campaigns, dateFrom, dateTo) {
  const byCampaign = await fetchWcOrdersByCampaign(dateFrom, dateTo);
  
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
const CACHE_TTL = 3600000; // 1 hour

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- Meta API helper ---
function metaGet(endpoint, params = {}) {
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

// --- Cache helper ---
function getCached(key) {
  const file = path.join(CACHE_DIR, key + '.json');
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) {
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

  await enrichCampaignsWithProfit(result, dateFrom, dateTo);
  setCache(cacheKey, result);
  return result;
}

async function getAdsets(campaignId, dateFrom, dateTo) {
  const cacheKey = `adsets_${campaignId}_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

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
}

async function getAds(adsetId, dateFrom, dateTo) {
  const cacheKey = `ads_${adsetId}_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

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

    await enrichCampaignsWithProfit(camps, range.from, range.to);

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
    const [k, v] = p.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return params;
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

// --- Auth ---
const crypto = require('crypto');
const USERS = { noriks: 'noriks' };
const sessions = new Set();

function parseCookies(req) {
  const c = {}; (req.headers.cookie || '').split(';').forEach(p => { const [k,v] = p.trim().split('='); if(k) c[k]=v; }); return c;
}

function isAuthed(req) {
  return sessions.has(parseCookies(req).flores_session);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0].replace(/^\/flores/, '') || '/';
  const query = parseQuery(req.url);

  // Login API
  if (urlPath === '/api/login' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (USERS[username] && USERS[username] === password) {
          const token = crypto.randomBytes(32).toString('hex');
          sessions.add(token);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `flores_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  if (urlPath === '/api/logout') {
    sessions.delete(parseCookies(req).flores_session);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'flores_session=; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Serve login page without auth
  if (urlPath === '/login' || urlPath === '/login.html') {
    const loginHtml = fs.readFileSync(path.join(__dirname, 'login.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml);
    return;
  }

  // Auth check for everything else
  if (!isAuthed(req)) {
    if (urlPath.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    res.writeHead(302, { 'Location': '/flores/login' });
    return res.end();
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
        const camp = query.campaign_name || '';
        const parsed = parseCampaignName(camp);
        const df = dateFrom, dt = dateTo;
        
        // Fetch all WC orders and filter by campaign ID (utm_campaign match)
        const countries = parsed.countries.length ? parsed.countries : Object.keys(WC_STORES);
        const allOrders = [];
        
        for (const country of countries) {
          const store = WC_STORES[country];
          if (!store) continue;
          
          try {
            const wcUrl = `${store.url}/wp-json/wc/v3/orders?after=${df}T00:00:00&before=${dt}T23:59:59&per_page=100&status=processing,completed&consumer_key=${store.ck}&consumer_secret=${store.cs}`;
            const wcData = await new Promise((resolve, reject) => {
              https.get(wcUrl, res2 => {
                let data2 = '';
                res2.on('data', c2 => data2 += c2);
                res2.on('end', () => { try { resolve(JSON.parse(data2)); } catch(e2) { reject(e2); } });
              }).on('error', reject);
            });
            if (!Array.isArray(wcData)) continue;
            
            for (const order of wcData) {
              const meta = order.meta_data || [];
              // Match by campaign ID
              let utmCamp = meta.find(m => m.key === '_wc_order_attribution_utm_campaign')?.value || '';
              if (!utmCamp) {
                const se = (meta.find(m => m.key === '_wc_order_attribution_session_entry')?.value || '');
                const match = se.match(/campaignid=(\d+)/i);
                if (match) utmCamp = match[1];
              }
              if (utmCamp !== campaignId) continue; // Only this campaign's orders
              
              // Calculate order profit
              const eurRate = EUR_RATES[country] || 1;
              const grossTotal = parseFloat(order.total || 0);
              const grossTotalEur = grossTotal * eurRate;
              const vatRate = VAT_RATES[country] || 0;
              const netRevenue = grossTotalEur * 0.9 / (1 + vatRate); // 10% rejection rate
              let productCost = 0;
              let totalQty = 0;
              const items = order.line_items || [];
              const products = items.map(i => {
                const qty = i.quantity || 1;
                totalQty += qty;
                const isShirt = /shirt|majic|μπλουζ|koszulk|tričko|póló|magliett|tshirt|t-shirt/i.test(i.name || '');
                const cost = (isShirt ? PRODUCT_COSTS.tshirt : PRODUCT_COSTS.boxers) * qty;
                productCost += cost;
                return { name: i.name, qty, price: Math.round(parseFloat(i.total || 0) * eurRate * 100) / 100, sku: i.sku || '' };
              });
              const shippingCost = parseFloat(order.shipping_total || 0) > 0 ? 3.5 : 0;
              const profit = netRevenue - productCost - shippingCost;
              
              allOrders.push({
                id: order.id, number: order.number,
                date: order.date_created?.slice(0, 10) || '',
                customer: (order.billing?.first_name || '') + ' ' + (order.billing?.last_name || ''),
                email: order.billing?.email || '',
                country, total: Math.round(grossTotalEur * 100) / 100, currency: 'EUR',
                products, productCost: Math.round(productCost * 100) / 100,
                profit: Math.round(profit * 100) / 100, qty: totalQty
              });
            }
          } catch(e) { console.error(`WC fetch error for ${country}:`, e.message); }
        }
        
        allOrders.sort((a, b) => new Date(b.date) - new Date(a.date));
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
          await enrichCampaignsWithProfit(camps, day, day);
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
      if (urlPath === '/api/clear-cache') {
        const files = fs.readdirSync(CACHE_DIR).filter(f => !f.startsWith('dash-') && f !== 'origin-data.json');
        files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
        return sendJSON(res, { cleared: files.length });
      }
      return sendJSON(res, { error: 'not found' }, 404);
    } catch (err) {
      console.error('API error:', err);
      return sendJSON(res, { error: err.message || String(err) }, 500);
    }
  }

  // Static files
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
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
});

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

// Calculate WC profit per campaign
function enrichCampaignsWithProfit(campaigns, dateFrom, dateTo) {
  const dashData = loadDashData();
  const originData = loadOriginData();
  if (!dashData || !dashData.data) return campaigns;

  // Aggregate WC data per country per product type for date range
  const wcAgg = {}; // country -> { shirts: {orders,revenue,cost}, boxers: {...}, ... }
  
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    const dayData = dashData.data[ds];
    if (!dayData) continue;
    
    for (const country of Object.keys(dayData)) {
      if (!wcAgg[country]) wcAgg[country] = {};
      const cd = dayData[country];
      if (!cd) continue;
      
      // Get origin data for attribution ratio (same as Advertiser)
      const originDay = originData?.daily?.[ds]?.[country];
      const fbOrders = originDay?.wcByProduct || {};
      
      // Attribution ratio: FB orders / total orders (same as Advertiser's attrRatio)
      const totalCountryOrders = cd.orders || cd.total_orders || 0;
      const totalFbOrders = Object.values(fbOrders).reduce((s, v) => s + (v || 0), 0);
      const attrRatio = totalCountryOrders > 0 ? totalFbOrders / totalCountryOrders : (totalFbOrders > 0 ? 1 : 0);
      
      // FB-attributed revenue and profit (proportioned like Advertiser)
      const fbRevenueGross = (cd.revenue_gross_eur || 0) * attrRatio;
      const fbProfit = (cd.profit || 0) * attrRatio;
      
      for (const ptype of ['shirts', 'boxers', 'starter', 'kompleti', 'catalog']) {
        if (!wcAgg[country][ptype]) wcAgg[country][ptype] = { orders: 0, revenueGross: 0, profit: 0 };
        const orders = fbOrders[ptype] || 0;
        if (orders === 0) continue;
        
        const typeRatio = totalFbOrders > 0 ? orders / totalFbOrders : 0;
        
        wcAgg[country][ptype].orders += orders;
        wcAgg[country][ptype].revenueGross += fbRevenueGross * typeRatio;
        wcAgg[country][ptype].profit += fbProfit * typeRatio;
      }
    }
  }

  // Group campaigns by country (for profit distribution by spend ratio)
  const countryGroups = {}; // "HR" -> [campaign1, campaign2, ...]
  const countryProductGroups = {}; // "HR_shirts" -> [campaign1, campaign2] (for order distribution)
  
  for (const c of campaigns) {
    const parsed = parseCampaignName(c.name);
    c._parsed = parsed;
    const spend = parseFloat(c.insights?.spend || 0);
    
    for (const country of (parsed.countries.length ? parsed.countries : [])) {
      // Country group (for profit)
      if (!countryGroups[country]) countryGroups[country] = [];
      countryGroups[country].push({ campaign: c, spend });
      
      // Country+product group (for orders)
      if (parsed.productType) {
        const key = country + '_' + parsed.productType;
        if (!countryProductGroups[key]) countryProductGroups[key] = [];
        countryProductGroups[key].push({ campaign: c, spend });
      }
    }
  }

  // 1. Distribute ORDERS by country+product spend ratio (integer, largest remainder)
  for (const [key, group] of Object.entries(countryProductGroups)) {
    const [country, ptype] = key.split('_');
    const wcData = wcAgg[country]?.[ptype];
    if (!wcData || wcData.orders === 0) continue;
    
    const totalSpend = group.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) continue;
    
    const totalOrders = wcData.orders;
    const rawShares = group.map(g => ({ g, raw: (g.spend / totalSpend) * totalOrders }));
    const floorSum = rawShares.reduce((s, r) => s + Math.floor(r.raw), 0);
    let remaining = totalOrders - floorSum;
    const byRemainder = rawShares.map((r, i) => ({ i, frac: r.raw - Math.floor(r.raw) })).sort((a, b) => b.frac - a.frac);
    const orderAlloc = rawShares.map(r => Math.floor(r.raw));
    for (const br of byRemainder) { if (remaining <= 0) break; orderAlloc[br.i]++; remaining--; }
    
    for (let idx = 0; idx < group.length; idx++) {
      if (!group[idx].campaign.wc) group[idx].campaign.wc = { orders: 0, revenueGross: 0, profit: 0 };
      group[idx].campaign.wc.orders += orderAlloc[idx];
    }
  }

  // 2. Distribute PROFIT + REVENUE by spend ratio ONLY to campaigns that have orders > 0
  // Campaigns with 0 orders = pure loss (revenue 0, profit = -spend)
  for (const [country, group] of Object.entries(countryGroups)) {
    // Sum all product types for this country
    let countryRevenue = 0, countryProfit = 0;
    for (const ptype of ['shirts', 'boxers', 'starter', 'kompleti', 'catalog']) {
      const wd = wcAgg[country]?.[ptype];
      if (wd) { countryRevenue += wd.revenueGross; countryProfit += wd.profit; }
    }
    if (countryRevenue === 0 && countryProfit === 0) continue;
    
    // Only campaigns with orders participate in revenue/profit distribution
    const withOrders = group.filter(g => g.campaign.wc && g.campaign.wc.orders > 0);
    const totalSpend = withOrders.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) continue;
    
    for (const g of withOrders) {
      const ratio = g.spend / totalSpend;
      g.campaign.wc.revenueGross += countryRevenue * ratio;
      g.campaign.wc.profit += countryProfit * ratio;
    }
  }

  // Round WC values + pure loss for 0-order campaigns
  for (const c of campaigns) {
    const spend = parseFloat(c.insights?.spend || 0);
    if (spend > 0 && !c.wc) {
      c.wc = { orders: 0, revenueGross: 0, profit: -spend, roas: 0 };
    }
    if (c.wc) {
      c.wc.orders = Math.round(c.wc.orders);
      if (c.wc.orders === 0) {
        // Pure loss: no orders = no revenue, profit = -spend
        c.wc.revenueGross = 0;
        c.wc.profit = spend > 0 ? -spend : 0;
        c.wc.roas = 0;
      } else {
        c.wc.revenueGross = Math.round(c.wc.revenueGross * 100) / 100;
        c.wc.profit = Math.round(c.wc.profit * 100) / 100;
        c.wc.roas = spend > 0 ? Math.round(c.wc.revenueGross / spend * 100) / 100 : 0;
      }
    }
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

  enrichCampaignsWithProfit(result, dateFrom, dateTo);
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

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0].replace(/^\/flores/, '') || '/';
  const query = parseQuery(req.url);

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
      if (urlPath === '/api/ads') {
        if (!query.adset_id) return sendJSON(res, { error: 'adset_id required' }, 400);
        const data = await getAds(query.adset_id, dateFrom, dateTo);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/campaign-orders') {
        if (!query.campaign_id) return sendJSON(res, { error: 'campaign_id required' }, 400);
        const camp = query.campaign_name || '';
        const parsed = parseCampaignName(camp);
        const df = dateFrom, dt = dateTo;
        
        if (!parsed.countries.length) return sendJSON(res, { error: 'Cannot determine country from campaign name' }, 400);
        
        const allOrders = [];
        for (const country of parsed.countries) {
          const store = WC_STORES[country];
          if (!store) continue;
          
          try {
            // Fetch orders from WC API
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
              // Check FB attribution
              const meta = order.meta_data || [];
              const source = meta.find(m => m.key === '_wc_order_attribution_source_type')?.value || '';
              const utm = meta.find(m => m.key === '_wc_order_attribution_utm_source')?.value || '';
              const referrer = meta.find(m => m.key === '_wc_order_attribution_referrer')?.value || '';
              const sessionEntry = meta.find(m => m.key === '_wc_order_attribution_session_entry')?.value || '';
              const utmL = utm.toLowerCase();
              const refL = referrer.toLowerCase();
              const isFB = utmL.includes('facebook') || utmL.includes('fb') || utmL.includes('ig') || utmL.includes('meta') ||
                           refL.includes('facebook.com') || refL.includes('fb.com') || refL.includes('instagram.com') ||
                           refL.includes('fbclid') || sessionEntry.includes('fbclid') || sessionEntry.includes('campaignID');
              
              if (!isFB) continue;
              
              // Check product type match (multi-language product names)
              const items = order.line_items || [];
              let orderType = null;
              const shirtWords = /shirt|majic|μπλουζ|koszulk|tričko|tričk|póló|magliett|tshirt|t-shirt|λευκ|μαύρα μπλουζ/i;
              const boxerWords = /boxer|μπόξερ|μποξερ|bokser|boxerk|airflow|modal/i;
              const kompletWords = /komplet|bundle|σετ.*μπλουζ.*μπ|set/i;
              const starterWords = /starter|εκκίνησ|start/i;
              
              const hasKomplet = items.some(i => kompletWords.test(i.name||'') || (i.sku||'').includes('BUNDLE'));
              const hasStarter = items.some(i => starterWords.test(i.name||''));
              const hasShirt = items.some(i => shirtWords.test(i.name||''));
              const hasBoxer = items.some(i => boxerWords.test(i.name||''));
              
              if (hasKomplet) orderType = 'kompleti';
              else if (hasStarter) orderType = 'starter';
              else if (hasShirt && !hasBoxer) orderType = 'shirts';
              else if (hasBoxer && !hasShirt) orderType = 'boxers';
              else if (hasShirt) orderType = 'shirts';
              else if (hasBoxer) orderType = 'boxers';
              
              // For catalog campaigns, accept all FB orders
              const isCatalog = parsed.productType === 'catalog';
              if (!isCatalog && parsed.productType && orderType !== parsed.productType) continue;
              
              // Calculate order profit
              const grossTotal = parseFloat(order.total || 0);
              const vatRate = VAT_RATES[country] || 0;
              const rejRate = 0.1; // approximate
              const netRevenue = grossTotal * (1 - rejRate) / (1 + vatRate);
              let productCost = 0;
              let totalQty = 0;
              const products = items.map(i => {
                const qty = i.quantity || 1;
                totalQty += qty;
                const isShirt = (i.name||'').toLowerCase().includes('shirt') || (i.name||'').toLowerCase().includes('majic');
                const cost = isShirt ? PRODUCT_COSTS.tshirt * qty : PRODUCT_COSTS.boxers * qty;
                productCost += cost;
                return { name: i.name, qty, price: parseFloat(i.total || 0), sku: i.sku || '' };
              });
              
              const shippingCost = parseFloat(order.shipping_total || 0) > 0 ? 3.5 : 0; // avg shipping cost
              const profit = netRevenue - productCost - shippingCost;
              
              allOrders.push({
                id: order.id,
                number: order.number,
                date: order.date_created?.slice(0, 10) || '',
                customer: (order.billing?.first_name || '') + ' ' + (order.billing?.last_name || ''),
                email: order.billing?.email || '',
                country,
                total: grossTotal,
                currency: order.currency || 'EUR',
                products,
                productCost: Math.round(productCost * 100) / 100,
                profit: Math.round(profit * 100) / 100,
                qty: totalQty,
                type: orderType
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
        const days = dailyInsights.map(i => {
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
        });
        
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

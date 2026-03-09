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
const VAT_RATES = { HR: 0.25, CZ: 0.21, PL: 0.23, GR: 0.24, IT: 0.22, HU: 0.27, SK: 0.23 };

// Parse campaign name for country + product type
// Format: DRŽAVA__TIP | date: DD.MM.YYYY or DRŽAVA+DRŽAVA__TIP
function parseCampaignName(name) {
  if (!name) return { countries: [], productType: null };
  const n = name.toUpperCase();
  
  // Extract countries (before __)
  const countryMatch = n.match(/^([A-Z+]+)__/);
  let countries = [];
  if (countryMatch) {
    countries = countryMatch[1].split('+').filter(c => ['HR','CZ','PL','GR','SK','IT','HU'].includes(c));
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
      
      // Get origin wcByProduct for Facebook-attributed orders
      const originDay = originData?.daily?.[ds]?.[country];
      const fbOrders = originDay?.wcByProduct || {};
      
      for (const ptype of ['shirts', 'boxers', 'starter', 'kompleti', 'catalog']) {
        if (!wcAgg[country][ptype]) wcAgg[country][ptype] = { orders: 0, revenueGross: 0, productCost: 0, shippingCost: 0 };
        const orders = fbOrders[ptype] || 0;
        if (orders === 0) continue;
        
        const totalOrders = cd.orders || 1;
        const orderRatio = orders / totalOrders;
        
        wcAgg[country][ptype].orders += orders;
        wcAgg[country][ptype].revenueGross += (cd.revenue_gross_eur || 0) * orderRatio;
        wcAgg[country][ptype].productCost += (cd.product_cost || 0) * orderRatio;
        wcAgg[country][ptype].shippingCost += (cd.shipping_cost || 0) * orderRatio;
      }
    }
  }

  // Now distribute WC data to campaigns based on country+type and spend ratio
  // Group campaigns by country+type
  const groups = {}; // "HR_shirts" -> [campaign1, campaign2]
  for (const c of campaigns) {
    const parsed = parseCampaignName(c.name);
    c._parsed = parsed;
    const spend = parseFloat(c.insights?.spend || 0);
    
    for (const country of (parsed.countries.length ? parsed.countries : ['_ALL'])) {
      const key = country + '_' + (parsed.productType || '_all');
      if (!groups[key]) groups[key] = [];
      groups[key].push({ campaign: c, spend });
    }
  }

  // Assign WC metrics to each campaign
  for (const [key, group] of Object.entries(groups)) {
    const [country, ptype] = key.split('_');
    if (country === '_ALL' || ptype === '_all') continue;
    
    const wcData = wcAgg[country]?.[ptype];
    if (!wcData || wcData.orders === 0) continue;
    
    const totalSpend = group.reduce((s, g) => s + g.spend, 0);
    if (totalSpend === 0) continue;
    
    const vatRate = VAT_RATES[country] || 0;
    
    for (const g of group) {
      const ratio = g.spend / totalSpend;
      const wcOrders = Math.round(wcData.orders * ratio * 10) / 10;
      const wcRevenueGross = wcData.revenueGross * ratio;
      const wcRevenueNet = wcRevenueGross / (1 + vatRate);
      const wcProductCost = wcData.productCost * ratio;
      const wcShippingCost = wcData.shippingCost * ratio;
      const wcProfit = wcRevenueNet - g.spend - wcProductCost - wcShippingCost;
      
      if (!g.campaign.wc) g.campaign.wc = { orders: 0, revenueGross: 0, revenueNet: 0, productCost: 0, shippingCost: 0, profit: 0 };
      g.campaign.wc.orders += wcOrders;
      g.campaign.wc.revenueGross += wcRevenueGross;
      g.campaign.wc.revenueNet += wcRevenueNet;
      g.campaign.wc.productCost += wcProductCost;
      g.campaign.wc.shippingCost += wcShippingCost;
      g.campaign.wc.profit += wcProfit;
    }
  }

  // Round WC values
  for (const c of campaigns) {
    if (c.wc) {
      c.wc.orders = Math.round(c.wc.orders * 10) / 10;
      c.wc.revenueGross = Math.round(c.wc.revenueGross * 100) / 100;
      c.wc.revenueNet = Math.round(c.wc.revenueNet * 100) / 100;
      c.wc.profit = Math.round(c.wc.profit * 100) / 100;
      c.wc.roas = parseFloat(c.insights?.spend || 0) > 0 ? Math.round(c.wc.revenueGross / parseFloat(c.insights.spend) * 100) / 100 : 0;
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

  const adsets = await metaGetAll(`${campaignId}/adsets`, {
    fields: 'id,name,status,daily_budget,lifetime_budget,targeting',
    limit: 500
  });

  const insights = await metaGetAll(`${campaignId}/insights`, {
    fields: INSIGHT_FIELDS,
    level: 'adset',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  const insightMap = {};
  for (const i of insights) {
    insightMap[i.adset_id] = i;
  }

  const result = adsets.map(a => ({
    ...a,
    insights: insightMap[a.id] || null
  }));

  result.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return 1;
    const spendA = parseFloat(a.insights?.spend || 0);
    const spendB = parseFloat(b.insights?.spend || 0);
    return spendB - spendA;
  });

  setCache(cacheKey, result);
  return result;
}

async function getAds(adsetId, dateFrom, dateTo) {
  const cacheKey = `ads_${adsetId}_${dateFrom}_${dateTo}`;
  let cached = getCached(cacheKey);
  if (cached) return cached;

  const ads = await metaGetAll(`${adsetId}/ads`, {
    fields: 'id,name,status,creative{title,body,thumbnail_url}',
    limit: 500
  });

  const insights = await metaGetAll(`${adsetId}/insights`, {
    fields: INSIGHT_FIELDS,
    level: 'ad',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    limit: 500
  });

  const insightMap = {};
  for (const i of insights) {
    insightMap[i.ad_id] = i;
  }

  const result = ads.map(a => ({
    ...a,
    insights: insightMap[a.id] || null
  }));

  result.sort((a, b) => {
    const spendA = parseFloat(a.insights?.spend || 0);
    const spendB = parseFloat(b.insights?.spend || 0);
    return spendB - spendA;
  });

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
  res.writeHead(status, { 'Content-Type': 'application/json' });
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
      if (urlPath === '/api/insights') {
        const level = query.level || 'campaign';
        const data = await getInsights(level, dateFrom, dateTo, query.breakdown);
        return sendJSON(res, data);
      }
      if (urlPath === '/api/clear-cache') {
        const files = fs.readdirSync(CACHE_DIR);
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Flores running on http://localhost:${PORT}`);
});

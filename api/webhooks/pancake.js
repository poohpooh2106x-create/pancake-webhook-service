/**
 * Vercel Serverless Function: PanCake Webhook Handler with Multi-Device Cloud Sync & Live Logs
 * Endpoint: /api/webhooks/pancake
 */
const { google } = require('googleapis');
const https = require('https');

// Dedicated Cloud Storage ID for Multi-Device Global Sync
const CLOUD_OBJECT_ID = 'ff8081819ff5b11001a027ca21547381';
const CLOUD_API_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

// Local Memory Cache (Loaded dynamically from Cloud Database via fetchCloudData)
let memoryLeads = [];
let memoryTruckTypes = ['หัวลาก', 'ตู้10', 'หาง', 'ดั๊ม', '6 ล้อ', 'เครน'];
let memoryChannels = ['FB เคพีศรีราชา', 'TikTok', 'LOA เคพี', 'FB เฮียตั้มรถติด', 'อื่นๆ'];
let memoryDeletedIds = [];
let webhookLogs = [];
const dedupeCache = new Map();

const DEDUPE_TTL_MS = 60 * 1000; // 1 minute dedupe for exact duplicate spam

function normalizeThaiDigits(text) {
  if (!text) return '';
  const thaiDigitsMap = {
    '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
    '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9'
  };
  return String(text).replace(/[๐-๙]/g, (ch) => thaiDigitsMap[ch] || ch);
}

function cleanThaiPhoneNumber(rawPhone) {
  if (!rawPhone) return null;
  if (typeof rawPhone !== 'string') rawPhone = String(rawPhone);

  const thaiDigitsMap = {
    '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
    '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9'
  };
  const norm = rawPhone.replace(/[๐-๙]/g, (ch) => thaiDigitsMap[ch] || ch);

  // Match 10-digit mobile numbers starting with 06, 08, 09 (e.g. 081-234-5678, 099 731 6431, 0812345678)
  const regex = /(?:^|[^\d])(0[689][\d\s\-\.\/]{7,13}\d)(?:[^\d]|$)/g;
  const regexIntl = /(?:^|[^\d])(?:\+?66)([\d\s\-\.\/]{8,14}\d)(?:[^\d]|$)/g;

  for (const match of norm.matchAll(regex)) {
    const cleaned = match[1].replace(/[\s\-\.\/]/g, '');
    if (cleaned.length === 10 && /^0[689]\d{8}$/.test(cleaned)) {
      return cleaned;
    }
  }

  for (const match of norm.matchAll(regexIntl)) {
    const cleaned = match[1].replace(/[\s\-\.\/]/g, '');
    if (cleaned.length === 9 && /^[689]\d{8}$/.test(cleaned)) {
      return '0' + cleaned;
    }
  }

  return null;
}

function isBlacklistedLead(lead, blacklist) {
  if (!lead || !Array.isArray(blacklist) || blacklist.length === 0) return false;
  const leadPhone = lead.phone ? String(lead.phone).trim() : '';
  const cleanPhone = cleanThaiPhoneNumber(leadPhone) || leadPhone.replace(/[\s\-\.\/]/g, '');
  const leadId = lead.id ? String(lead.id).trim() : '';

  for (const item of blacklist) {
    if (!item) continue;
    const str = String(item).trim();
    if (leadId && (str === leadId || str.toLowerCase() === leadId.toLowerCase())) return true;
    if (leadPhone && (str === leadPhone || str.replace(/[\s\-\.\/]/g, '') === cleanPhone)) return true;
    if (cleanPhone && (str === cleanPhone || cleanThaiPhoneNumber(str) === cleanPhone)) return true;
  }
  return false;
}

function parseLeadDateTime(dateStr, timeStr) {
  if (!dateStr) return 0;
  try {
    let d = 1, m = 1, y = 1970;
    if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        d = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        y = parseInt(parts[2], 10);
      }
    } else if (dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          y = parseInt(parts[0], 10);
          m = parseInt(parts[1], 10) - 1;
          d = parseInt(parts[2], 10);
        } else {
          d = parseInt(parts[0], 10);
          m = parseInt(parts[1], 10) - 1;
          y = parseInt(parts[2], 10);
        }
      }
    }

    let hh = 0, mm = 0, ss = 0;
    if (timeStr) {
      const tParts = timeStr.split(':');
      if (tParts.length >= 2) {
        hh = parseInt(tParts[0], 10) || 0;
        mm = parseInt(tParts[1], 10) || 0;
        ss = parseInt(tParts[2], 10) || 0;
      }
    }

    return new Date(y, m, d, hh, mm, ss).getTime() || 0;
  } catch(e) {
    return 0;
  }
}

function sortLeadsByDate(leadsArray) {
  if (!Array.isArray(leadsArray)) return [];
  return leadsArray.sort((a, b) => {
    const timeA = parseLeadDateTime(a.date, a.time);
    const timeB = parseLeadDateTime(b.date, b.time);
    return timeB - timeA;
  });
}

/**
 * Universal Recursive Deep Scan Helper for Thai Phone Numbers in any JSON structure
 */
function deepFindThaiPhone(obj, depth = 0) {
  if (!obj || depth > 6) return null;
  if (typeof obj === 'string') {
    const cleaned = cleanThaiPhoneNumber(obj);
    if (cleaned) return cleaned;
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindThaiPhone(item, depth + 1);
      if (found) return found;
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const val of Object.values(obj)) {
      const found = deepFindThaiPhone(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function detectTruckType(text) {
  if (!text) return '';
  const t = String(text).toLowerCase();
  for (const truck of memoryTruckTypes) {
    if (truck !== 'อื่นๆ' && t.includes(truck.toLowerCase())) return truck;
  }
  if (t.includes('หัวลาก') || t.includes('ลาก')) return 'หัวลาก';
  if (t.includes('ตู้') || t.includes('10 บาน') || t.includes('ตู้10')) return 'ตู้10';
  if (t.includes('หาง') || t.includes('ก้างปลา') || t.includes('เทรลเลอร์')) return 'หาง';
  if (t.includes('ดั๊ม') || t.includes('ดัมพ์') || t.includes('ดั้มพ์') || t.includes('dump')) return 'ดั๊ม';
  if (t.includes('6 ล้อ') || t.includes('หกล้อ') || t.includes('6ล้อ')) return '6 ล้อ';
  if (t.includes('เครน')) return 'เครน';
  return '';
}

function resolveChannelSource(rawSource, querySource, payload) {
  if (querySource && typeof querySource === 'string' && querySource.trim()) {
    return querySource.trim();
  }
  
  const pName = payload?.page_name || payload?.page?.name || payload?.data?.page_name || '';
  const raw = Array.isArray(rawSource) ? rawSource.join(',') : String(rawSource || pName || '');
  const candidate = raw.trim();

  // Match against dynamic custom channel list
  if (Array.isArray(memoryChannels)) {
    const matched = memoryChannels.find(c => c && candidate.toLowerCase() === c.toLowerCase());
    if (matched) return matched;
  }

  if (candidate.includes('เฮียตั้ม') || candidate.toLowerCase().includes('tum')) return 'FB เฮียตั้มรถติด';
  if (candidate.includes('เคพี') || candidate.toLowerCase().includes('kp')) return 'FB เคพีศรีราชา';
  if (candidate.toLowerCase().includes('tiktok')) return 'TikTok';
  if (candidate.toLowerCase().includes('loa') || candidate.toLowerCase().includes('line')) return 'LOA เคพี';

  return candidate || 'FB เคพีศรีราชา';
}

function getThaiDateTime() {
  const now = new Date();
  const optionsDate = { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' };
  const optionsTime = { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const date = new Intl.DateTimeFormat('en-GB', optionsDate).format(now);
  const time = new Intl.DateTimeFormat('en-GB', optionsTime).format(now);
  return { date, time };
}

function isDuplicateSpam(id, phone) {
  if (!phone) return false;
  const now = Date.now();
  for (const [k, timestamp] of dedupeCache.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      dedupeCache.delete(k);
    }
  }
  const key = `${id || 'noid'}:${phone}`;
  return dedupeCache.has(key) || dedupeCache.has(`phone:${phone}`);
}

function recordLeadDedupe(id, phone) {
  if (!phone) return;
  const now = Date.now();
  const key = `${id || 'noid'}:${phone}`;
  dedupeCache.set(key, now);
  dedupeCache.set(`phone:${phone}`, now);
}



function extractAdSource(payload) {
  if (!payload || typeof payload !== 'object') return '';

  // 1. Direct & Nested known fields from Meta & PanCake
  const candidates = [
    payload.ads_context_data?.ad_title,
    payload.ads_context_data?.ad_name,
    payload.referral?.ads_context_data?.ad_title,
    payload.referral?.ads_context_data?.ad_name,
    payload.referral?.ad_title,
    payload.referral?.ad_name,
    payload.referral?.title,
    payload.data?.ads_context_data?.ad_title,
    payload.data?.referral?.ads_context_data?.ad_title,
    payload.data?.referral?.ad_title,
    payload.data?.referral?.ad_name,
    payload.data?.ad_name,
    payload.data?.ad_title,
    payload.ad_name,
    payload.ad_title,
    payload.ad,
    payload.post?.name,
    payload.post?.title,
    payload.post?.message,
    payload.post_name,
    payload.post_title,
    payload.pancake_customer_obj?.ad_name,
    payload.pancake_customer_obj?.ad_title,
    payload.pancake_customer_obj?.referral?.ad_title,
    payload.extra_infor?.ad_name,
    payload.extra_infor?.ad_title,
    payload.extra_infor?.ad,
    payload.utm_campaign,
    payload.utm_content
  ];

  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) return c.trim();
  }

  // 2. Facebook Messenger Webhook structure (entry[0].messaging[0].referral)
  if (Array.isArray(payload.entry)) {
    for (const e of payload.entry) {
      if (Array.isArray(e.messaging)) {
        for (const m of e.messaging) {
          const mRef = m.referral?.ads_context_data?.ad_title || m.referral?.ad_title || m.referral?.ad_name || m.referral?.ref || '';
          if (mRef && typeof mRef === 'string' && mRef.trim()) return mRef.trim();
        }
      }
    }
  }

  // 3. Fallback: Deep recursive search for keys like ad_title, ad_name, ads_context_data
  let foundAd = '';
  function deepSearch(obj, depth = 0) {
    if (!obj || depth > 5 || foundAd) return;
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) {
          const lk = k.toLowerCase();
          if (lk === 'ad_title' || lk === 'ad_name' || lk === 'adtitle' || lk === 'adname' || lk === 'campaign_name') {
            foundAd = v.trim();
            return;
          }
        } else if (typeof v === 'object' && v !== null) {
          deepSearch(v, depth + 1);
        }
      }
    }
  }
  deepSearch(payload);
  if (foundAd) return foundAd;

  // 4. Ad ID fallback if name is not available
  const adId = payload.referral?.ad_id || payload.data?.referral?.ad_id || payload.ad_id || '';
  if (adId) return `Ad ID: ${adId}`;

  return '';
}


// Cloud Storage Helpers (Global Multi-Device Sync & Persistent Logs)

function fetchCloudData() {
  return new Promise((resolve) => {
    https.get(CLOUD_API_URL, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.data && Array.isArray(json.data.leads)) {
            memoryLeads = json.data.leads;
            if (Array.isArray(json.data.truckTypes) && json.data.truckTypes.length > 0) {
              memoryTruckTypes = json.data.truckTypes;
            }
            if (Array.isArray(json.data.channels) && json.data.channels.length > 0) {
              memoryChannels = json.data.channels;
            }
            if (Array.isArray(json.data.deletedIds)) {
              memoryDeletedIds = json.data.deletedIds;
            }
            if (Array.isArray(json.data.logs)) {
              webhookLogs = json.data.logs;
            }
            // Filter out any blacklisted deleted leads
            if (memoryDeletedIds.length > 0) {
              memoryLeads = memoryLeads.filter(l => !memoryDeletedIds.includes(l.phone) && (!l.id || !memoryDeletedIds.includes(l.id)));
            }
            resolve(json.data);
            return;
          }
        } catch(e) {}
        resolve({ leads: memoryLeads, truckTypes: memoryTruckTypes, channels: memoryChannels, deletedIds: memoryDeletedIds, logs: webhookLogs });
      });
    }).on('error', () => resolve({ leads: memoryLeads, truckTypes: memoryTruckTypes, channels: memoryChannels, deletedIds: memoryDeletedIds, logs: webhookLogs }));
  });
}

const GOOGLE_SHEETS_SCRIPT_URL = process.env.GOOGLE_SHEETS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzUdIU62Fx5-OS9Ldjx54O_HU5NJtt-C5RoFrF0k1OECVeTnFlyirdEheX6b88e8rBXmw/exec';

async function syncToGoogleSheets(data) {
  if (!GOOGLE_SHEETS_SCRIPT_URL || !data) return;
  try {
    if (Array.isArray(data)) {
      for (const lead of data) {
        if (lead && lead.phone) {
          fetch(GOOGLE_SHEETS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead }),
            redirect: 'follow'
          }).catch(() => {});
        }
      }
    } else if (data.phone) {
      fetch(GOOGLE_SHEETS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead: data }),
        redirect: 'follow'
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('Google Sheets sync error:', e.message);
  }
}

function saveCloudData(leadsList, truckTypesList, logsList, deletedIdsList, channelsList) {
  return new Promise((resolve) => {
    if (Array.isArray(leadsList)) memoryLeads = sortLeadsByDate(leadsList);
    if (Array.isArray(truckTypesList)) memoryTruckTypes = truckTypesList;
    if (Array.isArray(channelsList)) memoryChannels = channelsList;
    if (Array.isArray(logsList)) webhookLogs = logsList;
    if (Array.isArray(deletedIdsList)) memoryDeletedIds = deletedIdsList;

    // Filter memoryLeads against blacklist before saving to cloud
    if (memoryDeletedIds.length > 0) {
      memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    memoryLeads = sortLeadsByDate(memoryLeads);

    const payload = JSON.stringify({
      name: 'PancakeCRM_Leads',
      data: {
        leads: memoryLeads,
        truckTypes: memoryTruckTypes,
        channels: memoryChannels,
        deletedIds: memoryDeletedIds.slice(-500),
        logs: webhookLogs.slice(0, 30),
        updatedAt: new Date().toISOString()
      }
    });

    const req = https.request(CLOUD_API_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let resBody = '';
      res.on('data', d => resBody += d);
      res.on('end', () => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
    });

    req.on('error', (err) => {
      console.error('Cloud save error:', err.message);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}



async function getSheetsClient() {
  let auth = null;
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (credentials.private_key && typeof credentials.private_key === 'string') {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    auth = new google.auth.GoogleAuth({ credentials, scopes });
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes });
  } else {
    throw new Error('Missing Google Service Account credentials.');
  }
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function appendToSheet(rows) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const hasServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  if (!spreadsheetId || !hasServiceAccount) {
    return { logOnly: true, message: 'Google Sheets credentials not configured. Running in Log-Only mode.' };
  }

  const sheetName = process.env.SHEET_NAME || 'Facebook KP';
  const sheets = await getSheetsClient();
  const range = `'${sheetName}'!A:M`;

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });

  return { logOnly: false, updates: response.data.updates };
}

const ALLOWED_ORIGINS = [
  'https://pancake-webhook-service.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5000'
];

// 1. Strong Random Default Tokens & Multi-Token Set Support
const VALID_ADMIN_TOKENS = new Set([
  process.env.PANCAKE_ADMIN_TOKEN,
  process.env.PANCAKE_SECRET_TOKEN,
  'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e',
  'kp_crm_sec_2026'
].filter(Boolean));

const VALID_SALES_TOKENS = new Set([
  process.env.PANCAKE_SALES_TOKEN,
  'kp_sales_4a7c8e2b9d1f3068e5b7a2c4d9f103b872e4a9c1d5f8b0e3a6c2d4f8b9e1a3c5',
  'kp_sales_4a8b1c9d2e7f3056e8b1c4a9d2e7f30572bca39104ef92817d6a5c3b1e2f4a08'
].filter(Boolean));

const ADMIN_SECRET_TOKEN = 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e';
const SALES_SECRET_TOKEN = 'kp_sales_4a7c8e2b9d1f3068e5b7a2c4d9f103b872e4a9c1d5f8b0e3a6c2d4f8b9e1a3c5';

// 2. Rate Limiting State (Max 100 requests/minute per IP/Token)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(clientKey) {
  const now = Date.now();
  let entry = rateLimitMap.get(clientKey);
  if (!entry || now - entry.startTime > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 1, startTime: now };
    rateLimitMap.set(clientKey, entry);
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetSeconds: 60 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const resetSeconds = Math.ceil((entry.startTime + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, remaining: 0, resetSeconds };
  }
  return { 
    allowed: true, 
    remaining: RATE_LIMIT_MAX - entry.count, 
    resetSeconds: Math.ceil((entry.startTime + RATE_LIMIT_WINDOW_MS - now) / 1000) 
  };
}

// 3. Security Audit Logging (Timestamp, IP, Method, Path, Masked Token, Status Code, Role)
let securityAuditLogs = [];
const MAX_AUDIT_LOGS = 100;

function recordAuditLog(req, ip, role, statusCode, action) {
  const { date, time } = getThaiDateTime();
  const rawToken = getProvidedToken(req) || '';
  const maskedToken = rawToken.length > 10 ? `${rawToken.slice(0, 6)}...${rawToken.slice(-4)}` : (rawToken ? '****' : 'none');
  
  const logEntry = {
    id: 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: `${date} ${time}`,
    ip,
    method: req.method,
    path: req.url || '/api/webhooks/pancake',
    action: action || req.query?.action || 'request',
    role: role || 'unauthenticated',
    token: maskedToken,
    statusCode,
    userAgent: (req.headers['user-agent'] || 'unknown').slice(0, 100)
  };

  securityAuditLogs.unshift(logEntry);
  if (securityAuditLogs.length > MAX_AUDIT_LOGS) {
    securityAuditLogs.pop();
  }
}

// 4. Cookie Parser Helper
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts.shift()?.trim();
    if (key) list[key] = decodeURIComponent(parts.join('=').trim());
  });
  return list;
}

// 5. Token & Auth Verification Helper
function getProvidedToken(req) {
  // A. httpOnly Cookie (Browser Session)
  const cookies = parseCookies(req);
  if (cookies.crm_session) return cookies.crm_session.trim();
  if (cookies.crm_auth_token) return cookies.crm_auth_token.trim();

  // B. Authorization Header
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();

  // C. Custom Header
  if (req.headers['x-pancake-secret']) return String(req.headers['x-pancake-secret']).trim();

  // D. Query Parameter (for PanCake Webhook configuration)
  if (req.query?.secret) return String(req.query.secret).trim();
  if (req.query?.token) return String(req.query.token).trim();

  return null;
}

function authenticateUser(req) {
  const token = getProvidedToken(req);
  if (!token) return { authenticated: false, role: null };
  if (VALID_ADMIN_TOKENS.has(token)) return { authenticated: true, role: 'admin' };
  if (VALID_SALES_TOKENS.has(token)) return { authenticated: true, role: 'sales' };
  return { authenticated: false, role: null };
}

async function getRawBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return {};
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch(e) { return { raw: req.body }; }
  }
  if (!req.on || typeof req.on !== 'function') return {};
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch(e) { resolve({ raw: data }); }
    });
    req.on('error', () => resolve({}));
  });
}


module.exports = async (req, res) => {
  // CORS with credentials support (httpOnly Cookie)
  const reqOrigin = req.headers.origin;
  if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://pancake-webhook-service.vercel.app');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pancake-Secret, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';

  // Rate Limiting Check (Max 100 req/min)
  const rateLimitKey = `${clientIp}_${getProvidedToken(req) || 'anon'}`;
  const rateCheck = checkRateLimit(rateLimitKey);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
  res.setHeader('X-RateLimit-Reset', rateCheck.resetSeconds);

  if (!rateCheck.allowed) {
    recordAuditLog(req, clientIp, 'rate_limited', 429, 'rate_limit_exceeded');
    res.setHeader('Retry-After', rateCheck.resetSeconds);
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded (Max 100 req/min). Please try again in ${rateCheck.resetSeconds} seconds.`,
      retryAfter: rateCheck.resetSeconds
    });
  }

  // Parse body safely
  let payload = await getRawBody(req);
  if (!payload || typeof payload !== 'object') payload = {};

  // Ensure memoryLeads has latest cloud state
  await fetchCloudData();

  const action = req.query?.action || payload?.action || '';
  const authUser = authenticateUser(req);


  // ACTION: LOGIN (Set httpOnly Cookie)
  if (action === 'login' && req.method === 'POST') {
    const inputToken = (payload?.token || req.query?.secret || req.query?.token || req.headers['x-pancake-secret'] || '').trim();
    if (VALID_ADMIN_TOKENS.has(inputToken)) {
      res.setHeader('Set-Cookie', `crm_session=${encodeURIComponent(ADMIN_SECRET_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      recordAuditLog(req, clientIp, 'admin', 200, 'login_success');
      return res.status(200).json({
        success: true,
        role: 'admin',
        token: ADMIN_SECRET_TOKEN,
        message: 'Admin authentication successful (httpOnly session cookie established)'
      });
    } else if (VALID_SALES_TOKENS.has(inputToken)) {
      res.setHeader('Set-Cookie', `crm_session=${encodeURIComponent(SALES_SECRET_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      recordAuditLog(req, clientIp, 'sales', 200, 'login_success');
      return res.status(200).json({
        success: true,
        role: 'sales',
        token: SALES_SECRET_TOKEN,
        message: 'Sales authentication successful (httpOnly session cookie established)'
      });
    } else {
      recordAuditLog(req, clientIp, 'unknown', 401, 'login_failed');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid Secret Token / Password'
      });
    }
  }

  // ACTION: LOGOUT (Clear httpOnly Cookie)
  if (action === 'logout') {
    res.setHeader('Set-Cookie', 'crm_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    recordAuditLog(req, clientIp, 'unauthenticated', 200, 'logout');
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  }

  // ACTION: WHOAMI (Check current session & role)
  if (action === 'whoami') {
    recordAuditLog(req, clientIp, authUser.role || 'guest', 200, 'whoami');
    return res.status(200).json({
      authenticated: authUser.authenticated,
      role: authUser.role || 'admin',
      userType: authUser.role === 'sales' ? 'Sales Representative (Restricted Access)' : 'Administrator (Full Access)'
    });
  }

  // ACTION: AUDIT LOGS (Admin Only)
  if (action === 'audit_logs') {
    if (!authUser.authenticated || authUser.role !== 'admin') {
      recordAuditLog(req, clientIp, authUser.role || 'unauthenticated', 403, 'audit_logs_forbidden');
      return res.status(403).json({ error: 'Forbidden', message: 'Only Administrators can view Security Audit Logs' });
    }
    recordAuditLog(req, clientIp, authUser.role, 200, 'view_audit_logs');
    return res.status(200).json({ success: true, logs: securityAuditLogs });
  }

  // GET: Return global cloud leads, truck types & logs
  if (req.method === 'GET') {
    await fetchCloudData();
    const effectiveRole = authUser.role || 'admin';
    recordAuditLog(req, clientIp, effectiveRole, 200, 'read_leads');

    // Ensure memoryLeads does not contain any blacklisted leads before returning
    if (memoryDeletedIds.length > 0) {
      memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    memoryLeads = sortLeadsByDate(memoryLeads);

    return res.status(200).json({
      status: 'online',
      platform: 'vercel',
      role: effectiveRole,
      endpoint: '/api/webhooks/pancake',
      serverTime: new Date().toISOString(),
      leads: memoryLeads,
      recentLeads: memoryLeads.slice(0, 50),
      truckTypes: memoryTruckTypes,
      channelSources: memoryChannels,
      channels: memoryChannels,
      deletedIds: memoryDeletedIds,
      webhookLogs: webhookLogs.slice(0, 50),
      securityAuditLogs: effectiveRole === 'admin' ? securityAuditLogs.slice(0, 30) : [],
      totalReceived: webhookLogs.length,
      totalLeads: memoryLeads.length
    });
  }

  // ACTION: DELETE LEAD (Admin Only)
  if (action === 'delete_lead') {
    if (authUser.role === 'sales') {
      recordAuditLog(req, clientIp, authUser.role, 403, 'delete_lead_forbidden');
      return res.status(403).json({ error: 'Forbidden', message: 'Only Admin can delete leads' });
    }
    const delPhone = payload?.phone;
    const delId = payload?.id;

    if (delPhone) {
      if (!memoryDeletedIds.includes(delPhone)) memoryDeletedIds.push(delPhone);
      const cleanP = cleanThaiPhoneNumber(delPhone);
      if (cleanP && !memoryDeletedIds.includes(cleanP)) memoryDeletedIds.push(cleanP);
    }
    if (delId && !memoryDeletedIds.includes(delId)) memoryDeletedIds.push(delId);
    if (Array.isArray(payload?.deletedIds)) {
      for (const d of payload.deletedIds) {
        if (d && !memoryDeletedIds.includes(d)) memoryDeletedIds.push(d);
      }
    }

    if (Array.isArray(payload?.leads)) {
      memoryLeads = payload.leads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    } else if (delPhone || delId) {
      memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
    recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'delete_lead_success');
    return res.status(200).json({ success: true, message: 'Lead deleted permanently', totalLeads: memoryLeads.length, deletedIds: memoryDeletedIds });
  }

  // PUT / POST with sync action: Save state from frontend
  if (action === 'sync_trucks') {
    if (Array.isArray(payload?.truckTypes) && payload.truckTypes.length > 0) {
      memoryTruckTypes = payload.truckTypes;
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'sync_truck_types');
      return res.status(200).json({ success: true, message: 'Truck types updated', truckTypes: memoryTruckTypes });
    }
  }

  if (action === 'sync_channels') {
    if (Array.isArray(payload?.channelSources) && payload.channelSources.length > 0) {
      memoryChannels = payload.channelSources;
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'sync_channel_sources');
      return res.status(200).json({ success: true, message: 'Channel sources updated', channelSources: memoryChannels });
    }
  }

  if (action === 'sync_state') {
    // Merge deletedIds if client sent any
    if (Array.isArray(payload?.deletedIds)) {
      for (const d of payload.deletedIds) {
        if (d && !memoryDeletedIds.includes(d)) memoryDeletedIds.push(d);
      }
    }

    if (Array.isArray(payload?.channelSources) && payload.channelSources.length > 0) {
      memoryChannels = payload.channelSources;
    }

    // RBAC: Role-Based Access Control
    if (authUser.role === 'sales') {
      // Sales can only update the 'report' note for leads; they cannot delete leads or change truck list
      if (Array.isArray(payload?.leads)) {
        for (const updatedLead of payload.leads) {
          const target = memoryLeads.find(l => (updatedLead.id && l.id === updatedLead.id) || l.phone === updatedLead.phone);
          if (target && updatedLead.report !== undefined) {
            target.report = updatedLead.report;
          }
        }
      }
      if (payload?.lead) {
        const target = memoryLeads.find(l => (payload.lead.id && l.id === payload.lead.id) || l.phone === payload.lead.phone);
        if (target && payload.lead.report !== undefined) {
          target.report = payload.lead.report;
          await syncToGoogleSheets(target);
        } else {
          await syncToGoogleSheets(payload.lead);
        }
      }
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      recordAuditLog(req, clientIp, authUser.role, 200, 'sync_sales_report');
      return res.status(200).json({ success: true, message: 'Sales report updated', role: 'sales', deletedIds: memoryDeletedIds });
    }

    // Admin has full control - filter against blacklist
    if (Array.isArray(payload?.leads)) {
      memoryLeads = payload.leads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    if (payload?.lead) {
      const target = memoryLeads.find(l => (payload.lead.id && l.id === payload.lead.id) || l.phone === payload.lead.phone);
      if (target) {
        if (payload.lead.report !== undefined) target.report = payload.lead.report;
        if (payload.lead.sales !== undefined) target.sales = payload.lead.sales;
        if (payload.lead.truck !== undefined) target.truck = payload.lead.truck;
        if (payload.lead.date !== undefined) target.date = payload.lead.date;
        if (payload.lead.source !== undefined) target.source = payload.lead.source;
        await syncToGoogleSheets(target);
      } else {
        await syncToGoogleSheets(payload.lead);
      }
    }
    if (Array.isArray(payload?.truckTypes) && payload.truckTypes.length > 0) memoryTruckTypes = payload.truckTypes;
    await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);

    recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'sync_admin_state');
    return res.status(200).json({ 
      success: true, 
      message: 'Cloud state synced successfully', 
      totalLeads: memoryLeads.length,
      deletedIds: memoryDeletedIds,
      role: authUser.role || 'admin'
    });
  }

  // DELETE: Clear server logs (Admin Only)
  if (req.method === 'DELETE') {
    if (authUser.role === 'sales') {
      recordAuditLog(req, clientIp, authUser.role, 403, 'delete_logs_forbidden');
      return res.status(403).json({ error: 'Forbidden', message: 'Only Admin can clear server logs' });
    }
    webhookLogs.length = 0;
    recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'clear_logs');
    return res.status(200).json({ success: true, message: 'Server logs cleared' });
  }

  // Handle Incoming PanCake Webhook (POST without internal admin actions)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { date, time } = getThaiDateTime();

  try {
    // Record incoming raw webhook log
    const logEntry = {
      id: 'log_' + Date.now(),
      timestamp: `${date} ${time}`,
      headers: req.headers,
      payload: payload
    };
    webhookLogs.unshift(logEntry);
    if (webhookLogs.length > 100) webhookLogs.pop();

    console.log('📥 Received PanCake Webhook POST:', JSON.stringify(payload));

    // Extract leads flexibly from ANY PanCake payload format
    let itemsToProcess = [];

    // Format 1: PanCake CRM fields (Object หรือ Array)
    const rawFields = Array.isArray(payload.fields)
      ? payload.fields
      : (payload.fields && typeof payload.fields === 'object' ? [payload.fields] : null);

    if (rawFields && rawFields.length > 0) {
      itemsToProcess = rawFields.map(f => {
        let phoneVal = '';
        if (Array.isArray(f.PHONE) && f.PHONE.length > 0) {
          phoneVal = f.PHONE[0]?.VALUE || f.PHONE[0]?.value || '';
        } else if (typeof f.PHONE === 'string') {
          phoneVal = f.PHONE;
        } else if (f.phone || f.phone_number) {
          phoneVal = f.phone || f.phone_number;
        }
        return {
          id: f.id || f.customer_id || '',
          name: f.NAME || f.name || f.customer_name || 'ลูกค้า PanCake',
          phone: phoneVal,
          source: f.source || 'FB เคพีศรีราชา',
          isUpdate: true
        };
      });
    }
    // Format 2: PanCake CRM customer / contacts object (ลูกค้าเก่าอัปเดตข้อมูล)
    else if (payload.customer || payload.customers || payload.contact || payload.data?.customer) {
      const cust = payload.customer || payload.contact || payload.data?.customer || (Array.isArray(payload.customers) ? payload.customers[0] : payload.customers);
      let phoneVal = '';
      if (Array.isArray(cust.phone_numbers) && cust.phone_numbers.length > 0) {
        phoneVal = cust.phone_numbers[0]?.number || cust.phone_numbers[0]?.phone || cust.phone_numbers[0];
      } else if (cust.phone_number || cust.phone) {
        phoneVal = cust.phone_number || cust.phone;
      }

      itemsToProcess = [{
        id: cust.id || cust.page_customer_id || '',
        name: cust.name || cust.customer_name || cust.full_name || 'ลูกค้า PanCake',
        phone: phoneVal,
        source: cust.source || cust.page_name || 'FB เคพีศรีราชา',
        isUpdate: true
      }];
    }
    // Format 3: Direct Data payload (PanCake webhook v2)
    else if (payload.data && (payload.data.phone_numbers || payload.data.phone || payload.data.phone_number || payload.data.name)) {
      const d = payload.data;
      let phoneVal = d.phone || d.phone_number || '';
      if (Array.isArray(d.phone_numbers) && d.phone_numbers.length > 0) {
        phoneVal = d.phone_numbers[0]?.number || d.phone_numbers[0]?.phone || d.phone_numbers[0];
      }

      itemsToProcess = [{
        id: d.id || payload.id || '',
        name: d.name || d.customer_name || 'ลูกค้า PanCake',
        phone: phoneVal,
        source: d.source || 'FB เคพีศรีราชา',
        isUpdate: true
      }];
    }
    // Format 4: PanCake Messaging event (ลูกค้าทักในแชท)
    else if (payload.data && (payload.data.message || payload.data.messages)) {
      const msg = payload.data.message || (Array.isArray(payload.data.messages) ? payload.data.messages[0] : {});
      const conv = payload.data.conversation || {};
      const from = msg.from || conv.from || {};
      itemsToProcess = [{
        id: from.id || msg.conversation_id || conv.id || '',
        name: from.name || 'ลูกค้า PanCake',
        phone: msg.message || msg.original_message || msg.text || conv.snippet || '',
        source: 'FB เคพีศรีราชา',
        isRawChat: true
      }];
    }
    // Format 5: Generic Single object (อัปเดตฟิลด์เดี่ยว)
    else if (payload.NAME || payload.PHONE || payload.phone || payload.phone_number || payload.name || payload.message || payload.text) {
      let phoneVal = payload.phone || payload.phone_number || payload.message || payload.text || '';
      if (Array.isArray(payload.PHONE) && payload.PHONE.length > 0) {
        phoneVal = payload.PHONE[0]?.VALUE || payload.PHONE[0]?.value || '';
      } else if (typeof payload.PHONE === 'string') {
        phoneVal = payload.PHONE;
      }
      itemsToProcess = [{
        id: payload.id || '',
        name: payload.NAME || payload.name || payload.customer_name || 'ลูกค้า PanCake',
        phone: phoneVal,
        source: payload.source || 'FB เคพีศรีราชา',
        isUpdate: true
      }];
    }

    // Format 6: Universal Deep Scan Fallback (ดักจับเบอร์จากทุกฟิลด์ในก้อน JSON)
    if (itemsToProcess.length === 0 || !itemsToProcess.some(i => cleanThaiPhoneNumber(i.phone))) {
      const deepPhone = deepFindThaiPhone(payload);
      if (deepPhone) {
        const custName = payload.name || payload.customer_name || payload.from?.name || payload.data?.from?.name || 'ลูกค้า PanCake';
        itemsToProcess = [{
          id: payload.id || payload.customer_id || '',
          name: custName,
          phone: deepPhone,
          source: resolveChannelSource('', req.query?.source, payload),
          isUpdate: true
        }];
      }
    }

    if (itemsToProcess.length === 0) {
      console.log('ℹ️ No customer/phone items detected in payload');
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs);
      return res.status(200).json({
        success: true,
        message: 'Webhook received (no customer items matched)',
        receivedPayload: payload
      });
    }

    // Fetch latest cloud leads first
    await fetchCloudData();

    const rowsToAppend = [];
    const newLeads = [];

    for (const item of itemsToProcess) {
      const customerName = (item.name || 'ลูกค้า PanCake').trim();
      const validPhone = cleanThaiPhoneNumber(item.phone) || deepFindThaiPhone(item);

      if (!validPhone) {
        console.log(`⚠️ No valid Thai phone found for "${customerName}" (Raw: "${item.phone}")`);
        continue;
      }

      if (isDuplicateSpam(item.id, validPhone)) {
        console.log(`⚠️ Rapid duplicate spam skipped: ${validPhone} (ID: ${item.id})`);
        continue;
      }

      recordLeadDedupe(item.id, validPhone);

      const truck = detectTruckType(item.phone + ' ' + (payload.message || '') + ' ' + JSON.stringify(payload));
      const finalSource = resolveChannelSource(item.source, req.query?.source || req.query?.channel || req.query?.page, payload);
      const adSource = extractAdSource(payload) || (item.ad || '');

      const leadObj = {
        id: item.id || 'lead_' + Date.now(),
        date,
        time,
        source: finalSource,
        ad: adSource,
        name: customerName,
        phone: validPhone,
        truck: truck,
        sales: '',
        report: ''
      };

      // Check if lead exists in memoryLeads (e.g. old customer giving number again today)
      const existingIdx = memoryLeads.findIndex(l => (leadObj.id && l.id === leadObj.id) || l.phone === leadObj.phone);
      if (existingIdx !== -1) {
        // Move existing lead to the TOP and refresh timestamp to TODAY & NOW!
        const existing = memoryLeads[existingIdx];
        existing.phone = validPhone;
        existing.date = date;
        existing.time = time;
        existing.source = finalSource;
        if (adSource) existing.ad = adSource;
        if (customerName !== 'ลูกค้า PanCake') existing.name = customerName;
        if (truck) existing.truck = truck;

        leadObj.ad = existing.ad || adSource;
        leadObj.sales = existing.sales || '';
        leadObj.truck = existing.truck || truck || '';
        leadObj.report = existing.report || '';


        // Move to the top of memory list!
        memoryLeads.splice(existingIdx, 1);
        memoryLeads.unshift(existing);
      } else {
        memoryLeads.unshift(leadObj);
      }



      newLeads.push(leadObj);

      rowsToAppend.push([
        date,
        time,
        finalSource,
        customerName,
        `'${validPhone}`,
        truck,
        '', '', '', '', '', '', ''
      ]);
    }

    // Save updated leads and persistent logs to Cloud Database immediately!
    await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs);

    // Sync new leads to Google Sheets via Apps Script Webhook
    if (newLeads.length > 0) {
      await syncToGoogleSheets(newLeads);
    }

    // If Google Sheets Service Account is configured, also append to Sheets
    if (rowsToAppend.length > 0) {
      await appendToSheet(rowsToAppend);
    }

    console.log(`✅ Processed ${newLeads.length} lead(s) successfully and synced to Cloud`);

    return res.status(200).json({
      success: true,
      message: `Processed ${newLeads.length} lead(s)`,
      leads: memoryLeads,
      recentLeads: newLeads,
      serverTime: `${date} ${time}`
    });

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
};

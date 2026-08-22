/**
 * Vercel Serverless Function: PanCake Webhook Handler with Server Sync & Live Logs
 * Endpoint: /api/webhooks/pancake
 */
const { google } = require('googleapis');

// Server-side in-memory store for recent leads & raw webhook logs
const recentLeads = [];
const webhookLogs = [];
const dedupeCache = new Map();
const DEDUPE_TTL_MS = 15 * 60 * 1000;

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
  let cleaned = normalizeThaiDigits(rawPhone).replace(/[\s\-\.\(\)\/]/g, '');
  if (cleaned.startsWith('+66')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('66') && cleaned.length >= 11) {
    cleaned = '0' + cleaned.slice(2);
  }
  const m = cleaned.match(/0[689]\d{8}/) || cleaned.match(/0[2-57]\d{7,8}/);
  return m ? m[0] : null;
}

function detectTruckType(text) {
  if (!text) return 'หัวลาก';
  const t = text.toLowerCase();
  if (t.includes('ตู้') || t.includes('10 บาน')) return 'ตู้10';
  if (t.includes('หาง') || t.includes('ก้างปลา') || t.includes('เทรลเลอร์')) return 'หาง';
  if (t.includes('ดั๊ม') || t.includes('ดัมพ์') || t.includes('ดั้มพ์')) return 'ดั๊ม';
  return 'หัวลาก';
}

function getThaiDateTime() {
  const now = new Date();
  const optionsDate = { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' };
  const optionsTime = { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const date = new Intl.DateTimeFormat('en-GB', optionsDate).format(now);
  const time = new Intl.DateTimeFormat('en-GB', optionsTime).format(now);
  return { date, time };
}

function isDuplicate(id, phone) {
  const key = `${id || 'noid'}:${phone}`;
  const now = Date.now();
  for (const [k, timestamp] of dedupeCache.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      dedupeCache.delete(k);
    }
  }
  return dedupeCache.has(key);
}

function recordLead(id, phone) {
  const key = `${id || 'noid'}:${phone}`;
  dedupeCache.set(key, Date.now());
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

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pancake-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }

  // GET: Return server status, live leads & logs to frontend dashboard
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      platform: 'vercel',
      endpoint: '/api/webhooks/pancake',
      serverTime: new Date().toISOString(),
      recentLeads: recentLeads.slice(0, 50),
      webhookLogs: webhookLogs.slice(0, 50),
      totalReceived: webhookLogs.length,
      totalLeads: recentLeads.length
    });
  }

  // DELETE: Clear server logs if requested
  if (req.method === 'DELETE') {
    recentLeads.length = 0;
    webhookLogs.length = 0;
    return res.status(200).json({ success: true, message: 'Server logs cleared' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { date, time } = getThaiDateTime();

  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch(e) { payload = { raw: req.body }; }
    } else if (!payload) {
      payload = {};
    }

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

    // Format 1: PanCake CRM fields array
    if (Array.isArray(payload.fields)) {
      itemsToProcess = payload.fields.map(f => ({
        id: f.id || '',
        name: f.NAME || f.name || '',
        phone: (Array.isArray(f.PHONE) && f.PHONE[0]?.VALUE) || f.PHONE || f.phone || '',
        source: 'FB เคพีศรีราชา'
      }));
    }
    // Format 2: PanCake CRM customer object
    else if (payload.customer || payload.customers) {
      const cust = payload.customer || (Array.isArray(payload.customers) ? payload.customers[0] : payload.customers);
      itemsToProcess = [{
        id: cust.id || '',
        name: cust.name || cust.customer_name || '',
        phone: (Array.isArray(cust.phone_numbers) ? cust.phone_numbers[0] : cust.phone_numbers) || cust.phone_number || cust.phone || '',
        source: cust.source || 'FB เคพีศรีราชา'
      }];
    }
    // Format 3: PanCake Messaging event (แชท)
    else if (payload.data && payload.data.message) {
      const msg = payload.data.message;
      const conv = payload.data.conversation || {};
      const from = msg.from || conv.from || {};
      itemsToProcess = [{
        id: msg.id || conv.id || '',
        name: from.name || 'ลูกค้า PanCake',
        phone: msg.message || msg.original_message || conv.snippet || '',
        source: 'FB เคพีศรีราชา',
        isRawChat: true
      }];
    }
    // Format 4: Single object
    else if (payload.NAME || payload.PHONE || payload.phone || payload.name) {
      itemsToProcess = [{
        id: payload.id || '',
        name: payload.NAME || payload.name || '',
        phone: (Array.isArray(payload.PHONE) && payload.PHONE[0]?.VALUE) || payload.PHONE || payload.phone || '',
        source: payload.source || 'FB เคพีศรีราชา'
      }];
    }

    if (itemsToProcess.length === 0) {
      console.log('ℹ️ No customer/phone items detected in payload');
      return res.status(200).json({
        success: true,
        message: 'Webhook received (no customer items matched)',
        receivedPayload: payload
      });
    }

    const rowsToAppend = [];
    const newLeads = [];

    for (const item of itemsToProcess) {
      const customerName = (item.name || 'ลูกค้า PanCake').trim();
      const validPhone = cleanThaiPhoneNumber(item.phone);

      if (!validPhone) {
        console.log(`⚠️ No valid Thai phone found for "${customerName}" (Raw: "${item.phone}")`);
        continue;
      }

      if (isDuplicate(item.id, validPhone)) {
        console.log(`⚠️ Duplicate skipped: ${validPhone} (ID: ${item.id})`);
        continue;
      }

      recordLead(item.id, validPhone);

      const truck = detectTruckType(item.phone + ' ' + (payload.message || ''));
      const leadObj = {
        id: item.id || 'lead_' + Date.now(),
        date,
        time,
        source: item.source || 'FB เคพีศรีราชา',
        name: customerName,
        phone: validPhone,
        truck: truck,
        sales: ''
      };

      // Add to server memory list so frontend polling gets it immediately!
      recentLeads.unshift(leadObj);
      if (recentLeads.length > 200) recentLeads.pop();

      newLeads.push(leadObj);

      rowsToAppend.push([
        date,
        time,
        'Facebook',
        customerName,
        `'${validPhone}`,
        truck,
        '', '', '', '', '', '', ''
      ]);
    }

    // If Google Sheets is configured, also append to Sheets
    if (rowsToAppend.length > 0) {
      await appendToSheet(rowsToAppend);
    }

    console.log(`✅ Processed ${newLeads.length} new lead(s) successfully`);

    return res.status(200).json({
      success: true,
      message: `Processed ${newLeads.length} lead(s)`,
      leads: newLeads,
      serverTime: `${date} ${time}`
    });

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
};

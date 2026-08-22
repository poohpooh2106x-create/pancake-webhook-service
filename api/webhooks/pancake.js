/**
 * Vercel Serverless Function: PanCake Webhook Handler
 * Endpoint: /api/webhooks/pancake
 */
const { google } = require('googleapis');

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
  if (/^0[689]\d{8}$/.test(cleaned) || /^0[2-57]\d{7,8}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      platform: 'vercel',
      endpoint: '/api/webhooks/pancake',
      sheet: process.env.SHEET_NAME || 'Facebook KP',
      googleSheetsConnected: !!(process.env.SPREADSHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE))
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  console.log('📥 Received PanCake Webhook POST Request on Vercel');

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    console.log('📦 Webhook Payload:', JSON.stringify(payload));

    let fieldItems = [];
    if (Array.isArray(payload.fields)) {
      fieldItems = payload.fields;
    } else if (payload.fields && typeof payload.fields === 'object') {
      fieldItems = [payload.fields];
    } else if (payload.NAME || payload.PHONE) {
      fieldItems = [payload];
    }

    if (fieldItems.length === 0) {
      return res.status(200).json({ success: true, message: 'No fields to process', savedCount: 0 });
    }

    const { date, time } = getThaiDateTime();
    const rowsToAppend = [];
    const processedLeads = [];

    for (const item of fieldItems) {
      const recordId = item.id || '';
      const customerName = (item.NAME || item.name || 'ลูกค้า PanCake').trim();

      let rawPhone = '';
      if (Array.isArray(item.PHONE) && item.PHONE.length > 0) {
        rawPhone = item.PHONE[0].VALUE || item.PHONE[0].value || '';
      } else if (typeof item.PHONE === 'string') {
        rawPhone = item.PHONE;
      } else if (item.phone) {
        rawPhone = item.phone;
      }

      const validPhone = cleanThaiPhoneNumber(rawPhone);
      if (!validPhone) {
        console.log(`⚠️ Invalid phone for "${customerName}": "${rawPhone}"`);
        continue;
      }

      if (isDuplicate(recordId, validPhone)) {
        console.log(`⚠️ [DUPLICATE] Skipped lead for "${customerName}" (${validPhone})`);
        continue;
      }

      recordLead(recordId, validPhone);

      const row = [
        date,
        time,
        'Facebook',
        customerName,
        `'${validPhone}`,
        '', '', '', '', '', '', '', ''
      ];

      rowsToAppend.push(row);
      processedLeads.push({
        name: customerName,
        phone: validPhone,
        date,
        time,
        source: 'Facebook'
      });
    }

    if (rowsToAppend.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No new valid leads to append (may be duplicate or invalid phone)',
        savedCount: 0
      });
    }

    const sheetResult = await appendToSheet(rowsToAppend);

    if (sheetResult.logOnly) {
      console.log('==================================================');
      console.log('📋 [LOG ONLY MODE] Data received (Google Sheets not connected yet)');
      for (const lead of processedLeads) {
        console.log(`📅 วันที่: ${lead.date} | ⏰ เวลา: ${lead.time} | 👤 ชื่อ: ${lead.name} | 📞 เบอร์: ${lead.phone}`);
      }
      console.log('==================================================');

      return res.status(200).json({
        success: true,
        mode: 'log_only',
        message: 'Received and parsed webhook successfully (Google Sheets not configured yet)',
        savedCount: rowsToAppend.length,
        leads: processedLeads
      });
    }

    console.log(`✅ [LEAD SAVED] Successfully written to Google Sheets`);
    return res.status(200).json({
      success: true,
      mode: 'google_sheets',
      message: `Successfully saved ${rowsToAppend.length} lead(s) to Google Sheets`,
      savedCount: rowsToAppend.length,
      leads: processedLeads
    });

  } catch (err) {
    console.error('❌ Error handling webhook:', err.message);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
};

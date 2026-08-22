/**
 * Standalone Netlify Function: PanCake Webhook Handler for Lead Automation
 * Endpoint: /api/webhooks/pancake or /.netlify/functions/pancake
 */

const { google } = require('googleapis');

// In-Memory Deduplication Cache (Persists across warm container invocations)
const dedupeCache = new Map();
const DEDUPE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Replace Thai numerals (๐-๙) with Arabic numbers (0-9)
 */
function normalizeThaiDigits(text) {
  if (!text) return '';
  const thaiDigitsMap = {
    '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
    '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9'
  };
  return String(text).replace(/[๐-๙]/g, (ch) => thaiDigitsMap[ch] || ch);
}

/**
 * Validate and clean Thai phone number to 10-digit format (starting with 0)
 * @param {string} rawPhone 
 * @returns {string|null} - e.g. "0997316431" or null if invalid
 */
function cleanThaiPhoneNumber(rawPhone) {
  if (!rawPhone) return null;

  // Convert Thai digits & remove spaces, dashes, dots, parentheses
  let cleaned = normalizeThaiDigits(rawPhone).replace(/[\s\-\.\(\)\/]/g, '');

  // Handle +66 or 66 country code prefix
  if (cleaned.startsWith('+66')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('66') && cleaned.length >= 11) {
    cleaned = '0' + cleaned.slice(2);
  }

  // Check if it's a valid 10-digit Thai phone number starting with 0
  // (mobile starting with 06, 08, 09 or landlines 9-10 digits)
  if (/^0[689]\d{8}$/.test(cleaned) || /^0[2-57]\d{7,8}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Format Current Date & Time in Thai Timezone (Asia/Bangkok / GMT+7)
 */
function getThaiDateTime() {
  const now = new Date();

  const optionsDate = { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' };
  const optionsTime = { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

  const date = new Intl.DateTimeFormat('en-GB', optionsDate).format(now); // DD/MM/YYYY
  const time = new Intl.DateTimeFormat('en-GB', optionsTime).format(now); // HH:mm:ss

  return { date, time };
}

/**
 * Check if the lead is duplicate within TTL
 */
function isDuplicate(id, phone) {
  const key = `${id || 'noid'}:${phone}`;
  const now = Date.now();

  // Clean expired entries
  for (const [k, timestamp] of dedupeCache.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      dedupeCache.delete(k);
    }
  }

  if (dedupeCache.has(key)) {
    return true;
  }

  return false;
}

/**
 * Mark lead as processed in cache
 */
function recordLead(id, phone) {
  const key = `${id || 'noid'}:${phone}`;
  dedupeCache.set(key, Date.now());
}

/**
 * Get Google Sheets Client using Service Account credentials from ENV
 */
async function getSheetsClient() {
  let auth = null;
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      if (credentials.private_key && typeof credentials.private_key === 'string') {
        credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
      }

      auth = new google.auth.GoogleAuth({
        credentials,
        scopes
      });
    } catch (e) {
      throw new Error(`Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}`);
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes
    });
  } else {
    throw new Error('Missing Google Service Account credentials.');
  }

  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/**
 * Append row(s) to Google Sheets ("Facebook KP") if credentials are configured
 */
async function appendToSheet(rows) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const hasServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  // If Google Sheets is not configured, run in Log-Only mode
  if (!spreadsheetId || !hasServiceAccount) {
    return {
      logOnly: true,
      message: 'Google Sheets credentials not configured. Running in Log-Only mode.'
    };
  }

  const sheetName = process.env.SHEET_NAME || 'Facebook KP';
  const sheets = await getSheetsClient();
  const range = `'${sheetName}'!A:M`;

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows
    }
  });

  return {
    logOnly: false,
    updates: response.data.updates
  };
}

/**
 * Main Netlify Function Handler
 */
exports.handler = async (event, context) => {
  // CORS & Common Headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pancake-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'OK' }) };
  }

  // Handle GET request for Health Check / Verification
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'online',
        service: 'pancake-webhook-service',
        endpoint: '/api/webhooks/pancake',
        sheet: process.env.SHEET_NAME || 'Facebook KP',
        googleSheetsConnected: !!(process.env.SPREADSHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE))
      })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  console.log('📥 Received PanCake Webhook POST Request');

  try {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      console.error('❌ Failed to parse JSON body:', event.body);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON payload' })
      };
    }

    console.log('📦 Webhook Payload:', JSON.stringify(payload));

    // Extract items from fields (รองรับทั้ง Array และ Object)
    let fieldItems = [];
    if (Array.isArray(payload.fields)) {
      fieldItems = payload.fields;
    } else if (payload.fields && typeof payload.fields === 'object') {
      fieldItems = [payload.fields];
    } else if (payload.NAME || payload.PHONE) {
      fieldItems = [payload];
    }


    if (fieldItems.length === 0) {
      console.log('ℹ️ No fields array found in payload. Skipped.');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'No fields to process', savedCount: 0 })
      };
    }

    const { date, time } = getThaiDateTime();
    const rowsToAppend = [];
    const processedLeads = [];

    for (const item of fieldItems) {
      const recordId = item.id || '';
      const customerName = (item.NAME || item.name || 'ลูกค้า PanCake').trim();

      // Extract Phone Number
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
        console.log(`⚠️ Invalid or missing Thai phone number for customer "${customerName}" (Raw: "${rawPhone}"). Skipping.`);
        continue;
      }

      // Check Deduplication
      if (isDuplicate(recordId, validPhone)) {
        console.log(`⚠️ [DUPLICATE] Skipped lead for "${customerName}" (${validPhone}) [ID: ${recordId}]. Already recorded recently.`);
        continue;
      }

      // Mark as recorded
      recordLead(recordId, validPhone);

      // Structure row for Google Sheets (Columns A - M)
      // A=วันที่รับ, B=เวลา, C=ที่มา ("Facebook"), D=ชื่อลูกค้า, E=เบอร์โทร (มี ' นำหน้าคงเลข 0)
      const row = [
        date,             // Column A: วันที่รับ
        time,             // Column B: เวลา
        'Facebook',       // Column C: ที่มา
        customerName,     // Column D: ชื่อลูกค้า
        `'${validPhone}`, // Column E: เบอร์โทร
        '',               // Column F: รถที่สนใจ (ว่าง)
        '',               // Column G: เซลล์ที่รับ (ว่าง)
        '',               // Column H: วันที่ติดตาม (ว่าง)
        '',               // Column I: ข้อมูลลูกค้า (ว่าง)
        '',               // Column J: ความเป็นไปได้ (ว่าง)
        '',               // Column K: จอง/ไม่จอง (ว่าง)
        '',               // Column L: โน้ต (ว่าง)
        ''                // Column M: ที่มาลูกค้า (ว่าง)
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
      console.log('ℹ️ No new valid leads to append.');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'No new valid leads to append (may be duplicate or invalid phone)',
          savedCount: 0
        })
      };
    }

    console.log(`📝 Appending ${rowsToAppend.length} row(s) to Google Sheets:`, processedLeads);

    const sheetResult = await appendToSheet(rowsToAppend);

    if (sheetResult.logOnly) {
      console.log('==================================================');
      console.log('📋 [LOG ONLY MODE] Data received (Google Sheets not connected yet)');
      for (const lead of processedLeads) {
        console.log(`📅 วันที่: ${lead.date} | ⏰ เวลา: ${lead.time}`);
        console.log(`🏢 ที่มา: ${lead.source}`);
        console.log(`👤 ชื่อลูกค้า: ${lead.name}`);
        console.log(`📞 เบอร์โทร: ${lead.phone}`);
      }
      console.log('==================================================');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          mode: 'log_only',
          message: 'Received and parsed webhook successfully (Google Sheets not configured yet)',
          savedCount: rowsToAppend.length,
          leads: processedLeads
        })
      };
    }

    console.log(`✅ [LEAD SAVED] Successfully written to Google Sheets (${sheetResult.updates ? sheetResult.updates.updatedRange : 'OK'})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        mode: 'google_sheets',
        message: `Successfully saved ${rowsToAppend.length} lead(s) to Google Sheets`,
        savedCount: rowsToAppend.length,
        leads: processedLeads
      })
    };

  } catch (err) {
    console.error('❌ Error handling PanCake webhook:', err.message);
    if (err.stack) console.error(err.stack);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: err.message
      })
    };
  }
};

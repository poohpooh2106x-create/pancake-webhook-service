/**
 * Vercel Serverless Function: PanCake Webhook Handler with Multi-Device Cloud Sync & Live Logs
 * Endpoint: /api/webhooks/pancake
 */
const { google } = require('googleapis');
const https = require('https');

// Dedicated Cloud Storage ID for Multi-Device Global Sync
const CLOUD_OBJECT_ID = 'ff8081819ff5b11001a027ca21547381';
const CLOUD_API_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

// Local Memory Cache
let memoryLeads = [
  {
    id: 'lead_1',
    date: '22/08/2026',
    time: '11:28:05',
    source: 'FB เคพีศรีราชา',
    name: 'ประกายฟ้า สานนอก',
    phone: '0997316431',
    truck: 'หัวลาก',
    sales: 'ท็อป'
  }
];
let memoryTruckTypes = ['หัวลาก', 'ตู้10', 'หาง', 'ดั๊ม', '6 ล้อ', 'อื่นๆ'];
const webhookLogs = [];
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
  const t = String(text).toLowerCase();
  if (t.includes('ตู้') || t.includes('10 บาน')) return 'ตู้10';
  if (t.includes('หาง') || t.includes('ก้างปลา') || t.includes('เทรลเลอร์')) return 'หาง';
  if (t.includes('ดั๊ม') || t.includes('ดัมพ์') || t.includes('ดั้มพ์')) return 'ดั๊ม';
  if (t.includes('6 ล้อ') || t.includes('หกล้อ')) return '6 ล้อ';
  return 'หัวลาก';
}

function resolveChannelSource(rawSource, querySource, payload) {
  if (querySource && querySource.trim()) return querySource.trim();
  
  const pName = payload?.page_name || payload?.page?.name || payload?.data?.page_name || '';
  const candidate = String(rawSource || pName || '').trim();

  if (candidate.includes('เฮียตั้ม') || candidate.toLowerCase().includes('tum')) return 'FB เฮียตั้มรถติด';
  if (candidate.includes('เคพี') || candidate.toLowerCase().includes('kp')) return 'FB เคพีศรีราชา';
  if (candidate.toLowerCase().includes('tiktok')) return 'TikTok';
  if (candidate.toLowerCase().includes('loa') || candidate.toLowerCase().includes('line')) return 'LOA เคพี';

  if (!candidate || /^[-0-9,\s_]+$/.test(candidate)) {
    return 'FB เคพีศรีราชา';
  }
  return candidate;
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
  const key = `${id || 'noid'}:${phone}`;
  const now = Date.now();
  for (const [k, timestamp] of dedupeCache.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      dedupeCache.delete(k);
    }
  }
  return dedupeCache.has(key);
}

function recordLeadDedupe(id, phone) {
  const key = `${id || 'noid'}:${phone}`;
  dedupeCache.set(key, Date.now());
}

// Deep search any string for Thai phone number
function deepFindThaiPhone(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') {
    return cleanThaiPhoneNumber(obj);
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const found = deepFindThaiPhone(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

// Cloud Storage Helpers (Global Multi-Device Sync)
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
            if (Array.isArray(json.data.truckTypes)) {
              memoryTruckTypes = json.data.truckTypes;
            }
            resolve(json.data);
            return;
          }
        } catch(e) {}
        resolve({ leads: memoryLeads, truckTypes: memoryTruckTypes });
      });
    }).on('error', () => resolve({ leads: memoryLeads, truckTypes: memoryTruckTypes }));
  });
}

function saveCloudData(leadsList, truckTypesList) {
  return new Promise((resolve) => {
    if (Array.isArray(leadsList)) memoryLeads = leadsList;
    if (Array.isArray(truckTypesList)) memoryTruckTypes = truckTypesList;

    const payload = JSON.stringify({
      name: 'PancakeCRM_Leads',
      data: {
        leads: memoryLeads,
        truckTypes: memoryTruckTypes,
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

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pancake-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }

  // Parse body safely early for all methods
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch(e) { payload = { raw: req.body }; }
  } else if (!payload) {
    payload = {};
  }

  // GET: Return global cloud leads, truck types & logs to frontend dashboard
  if (req.method === 'GET') {
    await fetchCloudData();
    return res.status(200).json({
      status: 'online',
      platform: 'vercel',
      endpoint: '/api/webhooks/pancake',
      serverTime: new Date().toISOString(),
      leads: memoryLeads,
      recentLeads: memoryLeads.slice(0, 50),
      truckTypes: memoryTruckTypes,
      webhookLogs: webhookLogs.slice(0, 50),
      totalReceived: webhookLogs.length,
      totalLeads: memoryLeads.length
    });
  }

  // PUT / POST with sync action: Save state from frontend (user assigned sales or added truck)
  if (req.query?.action === 'sync_state' || payload?.action === 'sync_state') {
    if (Array.isArray(payload?.leads)) memoryLeads = payload.leads;
    if (Array.isArray(payload?.truckTypes)) memoryTruckTypes = payload.truckTypes;
    await saveCloudData(memoryLeads, memoryTruckTypes);
    return res.status(200).json({ 
      success: true, 
      message: 'Cloud state synced successfully', 
      totalLeads: memoryLeads.length 
    });
  }

  // DELETE: Clear server logs if requested
  if (req.method === 'DELETE') {
    webhookLogs.length = 0;
    return res.status(200).json({ success: true, message: 'Server logs cleared' });
  }

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

      const leadObj = {
        id: item.id || 'lead_' + Date.now(),
        date,
        time,
        source: finalSource,
        name: customerName,
        phone: validPhone,
        truck: truck,
        sales: ''
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
        if (customerName !== 'ลูกค้า PanCake') existing.name = customerName;
        if (truck && truck !== 'หัวลาก') existing.truck = truck;

        leadObj.sales = existing.sales || '';
        leadObj.truck = existing.truck || truck;

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

    // Save updated leads to Cloud Database immediately!
    if (newLeads.length > 0) {
      await saveCloudData(memoryLeads, memoryTruckTypes);
    }

    // If Google Sheets is configured, also append to Sheets
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

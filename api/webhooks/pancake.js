/**
 * Vercel Serverless Function: PanCake Webhook Handler with Multi-Device Cloud Sync & Live Logs
 * Endpoint: /api/webhooks/pancake
 */
const { google } = require('googleapis');
const https = require('https');

const APP_VERSION = '2026.08.28.6';

// ---------------------------------------------------------------------------
// STORAGE LAYER
// Primary: Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
// Fallback: the original restful-api.dev object (used until the env vars exist),
// so deploying this change is a no-op until Upstash is configured.
// ---------------------------------------------------------------------------
const CLOUD_OBJECT_ID = 'ff8081819ff5b11001a03c0bbbae2203';
const CLOUD_API_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STORAGE_KEY = process.env.PANCAKE_STORAGE_KEY || 'pancake_crm_state_v1';
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

function upstashCommand(command) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(command);
    let host, path;
    try {
      const u = new URL(UPSTASH_URL);
      host = u.hostname;
      path = u.pathname && u.pathname !== '/' ? u.pathname : '/';
    } catch (e) { return reject(new Error('Bad UPSTASH_REDIS_REST_URL')); }
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d || '{}');
          if (j.error) return reject(new Error(j.error));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Read the shared state object ({ leads, truckTypes, channels, ... }) or null.
function legacyObjectLoad() {
  return new Promise((resolve) => {
    https.get(CLOUD_API_URL, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json && json.data ? json.data : null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function storageLoad() {
  if (!USE_UPSTASH) return legacyObjectLoad();
  try {
    const raw = await upstashCommand(['GET', STORAGE_KEY]);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('storageLoad (upstash) error:', e.message);
    return null;
  }
  // First run on Upstash: seed from the old restful-api.dev object so the
  // existing leads carry over instead of resetting to the hardcoded defaults.
  try {
    const seed = await legacyObjectLoad();
    if (seed && (Array.isArray(seed.leads) || Array.isArray(seed.recentLeads))) {
      await upstashCommand(['SET', STORAGE_KEY, JSON.stringify(seed)]);
      console.log('storageLoad: seeded Upstash from legacy object');
      return seed;
    }
  } catch (e) {
    console.error('storageLoad seed error:', e.message);
  }
  return null;
}

// Persist the shared state object. Returns true on success.
async function storageSave(dataObj) {
  if (USE_UPSTASH) {
    try {
      await upstashCommand(['SET', STORAGE_KEY, JSON.stringify(dataObj)]);
      return true;
    } catch (e) {
      console.error('storageSave (upstash) error:', e.message);
      return false;
    }
  }
  const payloadStr = JSON.stringify({ name: 'pancake_crm_state', data: dataObj });
  return new Promise((resolve) => {
    const req = https.request(CLOUD_API_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', (err) => { console.error('storageSave (legacy) error:', err.message); resolve(false); });
    req.write(payloadStr);
    req.end();
  });
}

// Union-merge two lead arrays by id/phone. Leads present only in `base`
// (added on another device) are kept; overlapping leads take `incoming`'s
// field values. Prevents the "lead vanishes when two devices sync" race.
function mergeLeadArrays(base, incoming, blacklist) {
  const map = new Map();
  const keyOf = (l) => (l && (l.id || l.phone)) || null;
  for (const l of (Array.isArray(base) ? base : [])) {
    const k = keyOf(l);
    if (k && !isBlacklistedLead(l, blacklist)) map.set(k, l);
  }
  for (const l of (Array.isArray(incoming) ? incoming : [])) {
    const k = keyOf(l);
    if (!k || isBlacklistedLead(l, blacklist)) continue;
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, ...l } : l);
  }
  return sortLeadsByDate([...map.values()]);
}

const DEFAULT_MASTER_LEADS = [
  {
    id: "lead_20260826_084901_0612833830",
    date: "26/08/2026",
    time: "8:49:01",
    name: "Phichit Tepchomphoo",
    phone: "0612833830",
    source: "FB เคพีศรีราชา",
    truck: "",
    sales: "",
    ad: "[ AI EXPERT ADS ] - รถตัด และ",
    report: ""
  },
  {
    id: "lead_20260825_163233_0832420639",
    date: "25/08/2026",
    time: "16:32:33",
    name: "Jirapan Thongsamrit",
    phone: "0832420639",
    source: "FB เคพีศรีราชา",
    truck: "หาง",
    sales: "",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_162700_0632394248",
    date: "25/08/2026",
    time: "16:27:00",
    name: "ปกรณ์",
    phone: "0632394248",
    source: "Marketplace",
    truck: "เครน",
    sales: "ปุ๊ก",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_155252_0879462785",
    date: "25/08/2026",
    time: "15:52:52",
    name: "จิรชญา จันทร์สุรินทร์",
    phone: "0879462785",
    source: "FB เคพีศรีราชา",
    truck: "เครน",
    sales: "เกด",
    ad: "",
    report: "ส่งเสนอราคาใบปิดดูลูกค้าคะ"
  },
  {
    id: "lead_20260825_153741_0615163625",
    date: "25/08/2026",
    time: "15:37:41",
    name: "Nok Raungchai",
    phone: "0615163625",
    source: "FB เคพีศรีราชา",
    truck: "เครน",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_152454_0992574678",
    date: "25/08/2026",
    time: "15:24:54",
    name: "เอกพล ชุมทองจิตร",
    phone: "0992574678",
    source: "FB เคพีศรีราชา",
    truck: "โดยสาร",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_143347_0807562789",
    date: "25/08/2026",
    time: "14:33:47",
    name: "ปรีชา ดารช",
    phone: "0807562789",
    source: "FB เคพีศรีราชา",
    truck: "ถังน้ำขี้",
    sales: "ท็อป",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_143007_0654642972",
    date: "25/08/2026",
    time: "14:30:07",
    name: "พำรุต พำรี เดอร์ลอย",
    phone: "0654642972",
    source: "FB เคพีศรีราชา",
    truck: "รถน้ำ",
    sales: "จิ๊บ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_141924_0959847717",
    date: "25/08/2026",
    time: "14:19:24",
    name: "ประเสริฐ ณ.บุรีรัมย์",
    phone: "0959847717",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "",
    ad: "",
    report: "รถคันแรก วิ่งผลดาวน์200,000ทักหาส่งรูปและรายละเอียดเรียบร้อยครับกรุณาติดต่อลูกค้าทันทีครับ"
  },
  {
    id: "lead_20260825_140021_0980671323",
    date: "25/08/2026",
    time: "14:00:21",
    name: "Bank'k Suwannatep",
    phone: "0980671323",
    source: "FB เคพีศรีราชา",
    truck: "คอก",
    sales: "วุธ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_123512_0807242982",
    date: "25/08/2026",
    time: "12:35:12",
    name: "Amrat Boonkong",
    phone: "0807242982",
    source: "FB เคพีศรีราชา",
    truck: "",
    sales: "เกด",
    ad: "",
    report: "ลูกค้าหารถ 10 ล้อหัวลากที่มีเครน 5-8 ตัน ใช้วิ่ง 380/400 แรง ค่ะ"
  },
  {
    id: "lead_20260825_111009_0805425918",
    date: "25/08/2026",
    time: "11:10:09",
    name: "Viroj Bussaplay",
    phone: "0805425918",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260825_083635_0610098596",
    date: "25/08/2026",
    time: "8:36:35",
    name: "นายจรูญ ชนะงาม",
    phone: "0610098596",
    source: "FB เคพีศรีราชา",
    truck: "หาง",
    sales: "จิ๊บ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_204324_0642723396",
    date: "24/08/2026",
    time: "20:43:24",
    name: "พงษ์นนท์ นันทพันธ์",
    phone: "0642723396",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_180651_0819804209",
    date: "24/08/2026",
    time: "18:06:51",
    name: "Kheng Sa-uenram",
    phone: "0819804209",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_155459_0986176747",
    date: "24/08/2026",
    time: "15:54:59",
    name: "Nay Win",
    phone: "0986176747",
    source: "Marketplace",
    truck: "โดยสาร",
    sales: "ปุ๊ก",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_154154_0958905989",
    date: "24/08/2026",
    time: "15:41:54",
    name: "Anurak",
    phone: "0958905989",
    source: "Marketplace",
    truck: "โดยสาร",
    sales: "เฟิร์น",
    ad: "",
    report: "ติดต่อ 16.48 น. คุยรายละเอียดเรื่องรถ ลูกค้าสนใจเป็น 4 ล้อจัมโบ้อยากได้เป็นแบบคอกตอนนี้กำลังหารถอยู่"
  },
  {
    id: "lead_20260824_141015_0928875844",
    date: "24/08/2026",
    time: "14:10:15",
    name: "อภิเชษฐ์ เจริญลาภ",
    phone: "0928875844",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "วุธ",
    ad: "",
    report: "ชื่อ เปียกครับแตก อาชีพ ไม่ค่อยเข้าเงื่อนไข อยู่ ต่างจังหวัด สอบถามข้อมูลไว้ จะโทรมาหาใหม่ ถ้า ปรึกษากับแฟนแล้ว"
  },
  {
    id: "lead_20260824_135838_0868924419",
    date: "24/08/2026",
    time: "13:58:38",
    name: "สุวิทย์ เหมนเสถียรย์",
    phone: "0868924419",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เฟิร์น",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_112010_0840957477",
    date: "24/08/2026",
    time: "11:20:10",
    name: "Sathaporn Piyaboonpanya",
    phone: "0840957477",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "จิ๊บ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_111530_0930189287",
    date: "24/08/2026",
    time: "11:15:30",
    name: "chili(มะขี)",
    phone: "0930189287",
    source: "FB เคพีศรีราชา",
    truck: "โดยสาร",
    sales: "ปุ๊ก",
    ad: "",
    report: "ลูกค้าต้องการ รถสองแถว ราคา 3-4 แสน ซื้อเงินสด เสนอราคา หกล้อถอยหลังส่งคาไปแล้ว รอเสนอสองแถวเพิ่ม"
  },
  {
    id: "lead_20260824_101713_0963577542",
    date: "24/08/2026",
    time: "10:17:13",
    name: "Theeraphat Nuhoung",
    phone: "0963577542",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เฟิร์น",
    ad: "[ AI EXPERT ADS ] - รถตัด และ",
    report: "โทรติดต่อแล้ว ลูกค้าสนใจเข้ามาดูรถวันเสาร์"
  },
  {
    id: "lead_20260824_100153_0653169838",
    date: "24/08/2026",
    time: "10:01:53",
    name: "ศุภรัตน์ นาคพงศ์",
    phone: "0653169838",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "เฟิร์น",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_092504_0828758814",
    date: "24/08/2026",
    time: "09:25:04",
    name: "Ome Boonyai",
    phone: "0828758814",
    source: "FB เคพีศรีราชา",
    truck: "ตู้10",
    sales: "จิ๊บ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260824_091109_0850271577",
    date: "24/08/2026",
    time: "09:11:09",
    name: "สายชล ศรีงามขำ",
    phone: "0850271577",
    source: "FB เคพีศรีราชา",
    truck: "คอก",
    sales: "วุธ",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_114927_0997316431",
    date: "22/08/2026",
    time: "11:49:27",
    name: "ประภาษิต สานนอก",
    phone: "0997316431",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "ท็อป",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_114915_0988918611",
    date: "22/08/2026",
    time: "11:49:15",
    name: "ชีวิตคือ การเดินทาง",
    phone: "0988918611",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_114419_0961917277",
    date: "22/08/2026",
    time: "11:44:19",
    name: "Supattana Wongkom",
    phone: "0961917277",
    source: "FB เคพีศรีราชา",
    truck: "เครน",
    sales: "เกด",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_114825_0997316432",
    date: "22/08/2026",
    time: "11:48:25",
    name: "ประภาษิต สานนอก",
    phone: "0997316432",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_162140_0897402202",
    date: "22/08/2026",
    time: "16:21:40",
    name: "ณัฐพงษ์ บุญวงค์",
    phone: "0897402202",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_162118_0865401249",
    date: "22/08/2026",
    time: "16:21:18",
    name: "นาย อำนวยชัย",
    phone: "0865401249",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "",
    ad: "",
    report: ""
  },
  {
    id: "lead_20260822_160248_0817251742",
    date: "22/08/2026",
    time: "16:02:48",
    name: "Sawai Sinoun",
    phone: "0817251742",
    source: "FB เคพีศรีราชา",
    truck: "หัวลาก",
    sales: "วุธ",
    ad: "",
    report: ""
  }
];

// Local Memory Cache (Loaded dynamically from Cloud Database via fetchCloudData)
let memoryLeads = [...DEFAULT_MASTER_LEADS];
let memoryTruckTypes = ['หัวลาก', 'ตู้10', 'หาง', 'เครน', 'โดยสาร', 'คอก', 'รถน้ำ', 'ถังน้ำขี้', 'ดั๊ม', '6 ล้อ', 'อื่นๆ'];
let memoryChannels = ['FB เคพีศรีราชา', 'TikTok', 'LOA เคพี', 'FB เฮียตั้มรถติด', 'Marketplace', 'อื่นๆ'];
let memoryDeletedIds = [];
// Last-edit timestamps for the customizable lists. A stale copy (lagging cloud,
// another warm instance) must never resurrect a truck type / channel the user
// just deleted, so we only accept an incoming list if it is newer.
let memoryTruckTypesUpdatedAt = 0;
let memoryChannelsUpdatedAt = 0;
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
  if (t.includes('เครน')) return 'เครน';
  if (t.includes('โดยสาร')) return 'โดยสาร';
  if (t.includes('คอก')) return 'คอก';
  if (t.includes('รถน้ำ')) return 'รถน้ำ';
  if (t.includes('ถังน้ำขี้')) return 'ถังน้ำขี้';
  if (t.includes('ดั๊ม') || t.includes('ดัมพ์') || t.includes('ดั้มพ์') || t.includes('dump')) return 'ดั๊ม';
  if (t.includes('6 ล้อ') || t.includes('หกล้อ') || t.includes('6ล้อ')) return '6 ล้อ';
  return '';
}

function resolveChannelSource(rawSource, querySource, payload) {
  if (querySource && typeof querySource === 'string' && querySource.trim()) {
    return querySource.trim();
  }
  
  const possibleNames = [
    rawSource,
    payload?.page_name,
    payload?.page?.name,
    payload?.data?.page_name,
    payload?.data?.page?.name,
    payload?.customer?.page_name,
    payload?.customer?.source,
    payload?.from?.page_name
  ];

  let candidate = '';
  for (const name of possibleNames) {
    if (name) {
      const s = Array.isArray(name) ? name.join(',') : String(name).trim();
      if (s && !/^[-0-9,\s_]+$/.test(s)) {
        candidate = s;
        break;
      }
    }
  }

  if (!candidate) {
    const raw = Array.isArray(rawSource) ? rawSource.join(',') : String(rawSource || '');
    if (raw && !/^[-0-9,\s_]+$/.test(raw.trim())) {
      candidate = raw.trim();
    }
  }

  // Match against dynamic custom channel list
  if (candidate && Array.isArray(memoryChannels)) {
    const matched = memoryChannels.find(c => c && candidate.toLowerCase() === c.toLowerCase());
    if (matched) return matched;
  }

  if (candidate) {
    if (candidate.toLowerCase().includes('marketplace')) return 'Marketplace';
    if (candidate.includes('เฮียตั้ม') || candidate.toLowerCase().includes('tum')) return 'FB เฮียตั้มรถติด';
    if (candidate.includes('เคพี') || candidate.toLowerCase().includes('kp')) return 'FB เคพีศรีราชา';
    if (candidate.toLowerCase().includes('tiktok')) return 'TikTok';
    if (candidate.toLowerCase().includes('loa') || candidate.toLowerCase().includes('line')) return 'LOA เคพี';
    return candidate;
  }

  return 'FB เคพีศรีราชา';
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

  // 1. Direct & Deeply Nested candidate paths from Meta & PanCake
  const candidates = [
    payload.ad_title,
    payload.ad_name,
    payload.ad,
    payload.ads_context_data?.ad_title,
    payload.ads_context_data?.ad_name,
    payload.ads_context_data?.title,
    payload.referral?.ads_context_data?.ad_title,
    payload.referral?.ads_context_data?.ad_name,
    payload.referral?.ads_context_data?.title,
    payload.referral?.ad_title,
    payload.referral?.ad_name,
    payload.referral?.title,
    payload.referral?.ref,
    payload.data?.ad_title,
    payload.data?.ad_name,
    payload.data?.ad,
    payload.data?.ads_context_data?.ad_title,
    payload.data?.ads_context_data?.ad_name,
    payload.data?.referral?.ads_context_data?.ad_title,
    payload.data?.referral?.ads_context_data?.ad_name,
    payload.data?.referral?.ad_title,
    payload.data?.referral?.ad_name,
    payload.data?.conversation?.ad_title,
    payload.data?.conversation?.ad_name,
    payload.data?.conversation?.ads_context_data?.ad_title,
    payload.data?.conversation?.ads_context_data?.ad_name,
    payload.data?.conversation?.referral?.ad_title,
    payload.data?.conversation?.referral?.ad_name,
    payload.data?.conversation?.recent_ad?.ad_title,
    payload.data?.conversation?.recent_ad?.name,
    payload.data?.conversation?.recent_ad?.title,
    payload.data?.message?.ad_title,
    payload.data?.message?.ad_name,
    payload.data?.message?.referral?.ad_title,
    payload.data?.message?.referral?.ad_name,
    payload.data?.message?.attachments?.[0]?.title,
    payload.data?.message?.attachments?.[0]?.payload?.title,
    payload.data?.customer?.recent_ad_title,
    payload.data?.customer?.ad_name,
    payload.data?.customer?.ad_title,
    payload.data?.customer?.extra_infor?.ad_name,
    payload.data?.customer?.extra_infor?.ad_title,
    payload.data?.customer?.extra_infor?.ad,
    payload.data?.customer?.ads_context_data?.ad_title,
    payload.data?.customer?.referral?.ad_title,
    payload.customer?.recent_ad_title,
    payload.customer?.ad_name,
    payload.customer?.ad_title,
    payload.customer?.extra_infor?.ad_name,
    payload.customer?.extra_infor?.ad_title,
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
    if (c && typeof c === 'string' && c.trim() && !/^[-0-9,\s_]+$/.test(c.trim())) {
      return c.trim();
    }
  }

  // 2. Facebook Messenger Webhook structure (entry[0].messaging[0].referral or changes)
  if (Array.isArray(payload.entry)) {
    for (const e of payload.entry) {
      if (Array.isArray(e.messaging)) {
        for (const m of e.messaging) {
          const mRef = m.referral?.ads_context_data?.ad_title || m.referral?.ad_title || m.referral?.ad_name || m.referral?.ref || '';
          if (mRef && typeof mRef === 'string' && mRef.trim() && !/^[-0-9,\s_]+$/.test(mRef.trim())) return mRef.trim();
        }
      }
      if (Array.isArray(e.changes)) {
        for (const ch of e.changes) {
          const chRef = ch.value?.referral?.ad_title || ch.value?.referral?.ads_context_data?.ad_title || ch.value?.ad_name || ch.value?.ad_title || '';
          if (chRef && typeof chRef === 'string' && chRef.trim() && !/^[-0-9,\s_]+$/.test(chRef.trim())) return chRef.trim();
        }
      }
    }
  }

  // 2b. PanCake "recent ad" the customer messaged in from — object OR array,
  //     found at many roots (conversation.recent_ad, customer.current_ads, ...)
  const cleanAdStr = (v) => {
    if (!v || typeof v !== 'string') return '';
    const s = v.trim().replace(/\s+/g, ' ');
    if (!s || /^[-0-9,\s_]+$/.test(s)) return '';
    return s.length > 90 ? s.slice(0, 90).trim() + '…' : s;
  };
  const adBuckets = [
    payload.recent_ad, payload.recent_ads, payload.ads, payload.ad,
    payload.conversation?.recent_ad, payload.conversation?.ads,
    payload.data?.recent_ad, payload.data?.recent_ads, payload.data?.ads,
    payload.data?.conversation?.recent_ad, payload.data?.conversation?.recent_ads,
    payload.data?.conversation?.ads, payload.data?.conversation?.ads_sources,
    payload.data?.page_customer?.recent_ad, payload.data?.page_customer?.ads,
    payload.customer?.recent_ad, payload.customer?.current_ads, payload.customer?.ads,
    payload.data?.customer?.recent_ad, payload.data?.customer?.current_ads,
    payload.data?.customer?.ads, payload.data?.customer?.ads_sources,
    payload.pancake_customer_obj?.recent_ad, payload.pancake_customer_obj?.current_ads
  ];
  for (const bucket of adBuckets) {
    if (!bucket) continue;
    const entries = Array.isArray(bucket) ? bucket : [bucket];
    for (const ad of entries) {
      if (!ad) continue;
      if (typeof ad === 'string') { const s = cleanAdStr(ad); if (s) return s; continue; }
      const title = cleanAdStr(ad.ad_title) || cleanAdStr(ad.title) || cleanAdStr(ad.ad_name)
        || cleanAdStr(ad.name) || cleanAdStr(ad.headline) || cleanAdStr(ad.caption)
        || cleanAdStr(ad.message) || cleanAdStr(ad.ad_message) || cleanAdStr(ad.post_message);
      if (title) return title;
      const aid = ad.ad_id || ad.id || ad.post_id;
      if (aid && /^[0-9_]{5,}$/.test(String(aid).trim())) return `Ad ID: ${String(aid).trim()}`;
    }
  }

  // 3. Deep recursive search for any property named ad_title, ad_name, campaign_name, etc.
  let foundAd = '';
  let foundAdId = '';
  function deepSearch(obj, depth = 0) {
    if (!obj || depth > 6 || foundAd) return;
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (typeof v === 'string' && v.trim()) {
          if (
            (lk === 'ad_title' || lk === 'ad_name' || lk === 'adtitle' || lk === 'adname' || lk === 'campaign_name' || lk === 'campaign_title' || lk === 'source_ad_name' || lk === 'ad_headline' || lk === 'ad_message' || lk === 'ad_caption') &&
            !/^[-0-9,\s_]+$/.test(v.trim())
          ) {
            foundAd = cleanAdStr(v);
            if (foundAd) return;
          }
          if (!foundAdId && (lk === 'ad_id' || lk === 'source_ad_id') && /^[0-9_]{5,}$/.test(v.trim())) {
            foundAdId = v.trim();
          }
        } else if (typeof v === 'number' && !foundAdId && (lk === 'ad_id' || lk === 'source_ad_id') && String(v).length >= 5) {
          foundAdId = String(v);
        } else if (typeof v === 'object' && v !== null) {
          deepSearch(v, depth + 1);
        }
      }
    }
  }
  deepSearch(payload);
  if (foundAd) return foundAd;

  // 4. Ad ID fallback if no ad title/name was found anywhere
  const adId = payload.referral?.ad_id ||
               payload.referral?.ads_context_data?.ad_id ||
               payload.data?.referral?.ad_id ||
               payload.data?.conversation?.ad_id ||
               payload.data?.customer?.ad_id ||
               payload.data?.ad_id ||
               payload.ad_id ||
               foundAdId || '';
  if (adId && String(adId).trim()) return `Ad ID: ${String(adId).trim()}`;

  return '';
}


// Cloud Storage Helpers (Global Multi-Device Sync & Persistent Logs)

async function fetchCloudData() {
  const memSnapshot = () => ({ leads: memoryLeads, truckTypes: memoryTruckTypes, channels: memoryChannels, deletedIds: memoryDeletedIds, logs: webhookLogs });
  if (process.env.NODE_ENV === 'test') return memSnapshot();

  let data = null;
  try { data = await storageLoad(); } catch (e) { data = null; }
  if (!data || typeof data !== 'object') return memSnapshot();

  // 1. Lightweight recentLeads (legacy restful-api.dev payloads carried only these)
  if (Array.isArray(data.recentLeads)) {
    for (const rLead of data.recentLeads) {
      if (rLead && rLead.phone && !isBlacklistedLead(rLead, memoryDeletedIds)) {
        const existingIdx = memoryLeads.findIndex(l => (rLead.id && l.id === rLead.id) || l.phone === rLead.phone);
        if (existingIdx !== -1) memoryLeads[existingIdx] = { ...memoryLeads[existingIdx], ...rLead };
        else memoryLeads.unshift(rLead);
      }
    }
  }

  // 2. Full leads list from storage: update existing leads field-by-field and add new ones
  if (Array.isArray(data.leads)) {
    const cloudLeads = data.leads.filter(l => l && l.phone && l.phone !== '0812345678');
    for (const cl of cloudLeads) {
      if (isBlacklistedLead(cl, memoryDeletedIds)) continue;
      const idx = memoryLeads.findIndex(l => (cl.id && l.id === cl.id) || l.phone === cl.phone);
      if (idx !== -1) memoryLeads[idx] = { ...memoryLeads[idx], ...cl };
      else memoryLeads.unshift(cl);
    }
  }

  // Customizable lists: only accept a copy at least as new as what we hold
  const cloudTruckTs = Number(data.truckTypesUpdatedAt) || 0;
  if (Array.isArray(data.truckTypes) && data.truckTypes.length > 0 && cloudTruckTs >= memoryTruckTypesUpdatedAt) {
    memoryTruckTypes = data.truckTypes;
    memoryTruckTypesUpdatedAt = cloudTruckTs;
  }
  const cloudChannelTs = Number(data.channelsUpdatedAt) || 0;
  if (Array.isArray(data.channels) && data.channels.length > 0 && cloudChannelTs >= memoryChannelsUpdatedAt) {
    memoryChannels = data.channels;
    memoryChannelsUpdatedAt = cloudChannelTs;
  }
  if (Array.isArray(data.deletedIds)) {
    for (const d of data.deletedIds) {
      if (d && !memoryDeletedIds.includes(d)) memoryDeletedIds.push(d);
    }
  }
  if (Array.isArray(data.logs)) webhookLogs = data.logs;

  if (memoryDeletedIds.length > 0) {
    memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
  }
  return data;
}

const GOOGLE_SHEETS_SCRIPT_URL = process.env.GOOGLE_SHEETS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzUdIU62Fx5-OS9Ldjx54O_HU5NJtt-C5RoFrF0k1OECVeTnFlyirdEheX6b88e8rBXmw/exec';

async function postLeadToSheet(lead, attempt = 0) {
  try {
    const res = await fetch(GOOGLE_SHEETS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead }),
      redirect: 'follow'
    });
    if (res && !res.ok && attempt < 2) throw new Error('HTTP ' + res.status);
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      return postLeadToSheet(lead, attempt + 1);
    }
    console.warn('Sync lead to sheet failed after retries:', err.message, lead && lead.phone);
  }
}

async function syncToGoogleSheets(data) {
  if (process.env.NODE_ENV === 'test') return;
  if (!GOOGLE_SHEETS_SCRIPT_URL || !data) return;
  try {
    const leads = Array.isArray(data) ? data : [data];
    for (const lead of leads) {
      if (lead && lead.phone) await postLeadToSheet(lead);
    }
  } catch (e) {
    console.warn('Google Sheets sync error:', e.message);
  }
}

async function saveCloudData(leadsList, truckTypesList, logsList, deletedIdsList, channelsList) {
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

  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve(true);
  }

  // Persist the FULL shared state (Upstash has no practical size limit).
  const fullData = {
    leads: memoryLeads.slice(0, USE_UPSTASH ? 2000 : 120),
    recentLeads: memoryLeads.slice(0, 3),
    truckTypes: memoryTruckTypes,
    channels: memoryChannels,
    truckTypesUpdatedAt: memoryTruckTypesUpdatedAt,
    channelsUpdatedAt: memoryChannelsUpdatedAt,
    deletedIds: memoryDeletedIds.slice(-500),
    updatedAt: Date.now()
  };

  const ok = await storageSave(fullData);
  if (ok || USE_UPSTASH) return ok;

  // Legacy provider rejected the full payload (size/rate limit): persist the delta
  return storageSave({
    recentLeads: memoryLeads.slice(0, 3),
    truckTypes: memoryTruckTypes,
    channels: memoryChannels,
    truckTypesUpdatedAt: memoryTruckTypesUpdatedAt,
    channelsUpdatedAt: memoryChannelsUpdatedAt,
    deletedIds: memoryDeletedIds.slice(-20),
    updatedAt: Date.now()
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

// Credentials. Set PANCAKE_ADMIN_PASSWORD (+ optional PANCAKE_SALES_PASSWORD)
// in the environment. Until one of those is set, a short bootstrap password
// keeps the tool usable so nobody is locked out on deploy.
const VALID_ADMIN_TOKENS = new Set([
  process.env.PANCAKE_ADMIN_PASSWORD,
  process.env.PANCAKE_ADMIN_TOKEN,
  process.env.PANCAKE_SECRET_TOKEN
].filter(Boolean));

const VALID_SALES_TOKENS = new Set([
  process.env.PANCAKE_SALES_PASSWORD,
  process.env.PANCAKE_SALES_TOKEN
].filter(Boolean));

const AUTH_CONFIGURED = VALID_ADMIN_TOKENS.size > 0;
if (!AUTH_CONFIGURED) {
  VALID_ADMIN_TOKENS.add('kp_crm_sec_2026');
  VALID_ADMIN_TOKENS.add('kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e');
  VALID_SALES_TOKENS.add('kp_sales_2026');
  VALID_SALES_TOKENS.add('kp_sales_4a7c8e2b9d1f3068e5b7a2c4d9f103b872e4a9c1d5f8b0e3a6c2d4f8b9e1a3c5');
}

// 2. Rate Limiting State (Max 100 requests/minute per IP/Token)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(clientKey) {
  const now = Date.now();
  // Prevent unbounded growth of the per-key map on long-lived warm instances
  if (rateLimitMap.size > 5000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.startTime > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
    }
  }
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
    if (key) {
      const rawVal = parts.join('=').trim();
      try { list[key] = decodeURIComponent(rawVal); }
      catch (e) { list[key] = rawVal; }
    }
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

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


  // ACTION: LOGIN — verify password, set an httpOnly session cookie.
  // The password itself is never returned to the browser and is never stored
  // client-side; the cookie (HttpOnly, Secure, SameSite=Lax) carries the session.
  if (action === 'login' && req.method === 'POST') {
    const input = (payload?.password || payload?.token || req.query?.secret || req.query?.token || req.headers['x-pancake-secret'] || '').trim();
    const role = input && VALID_ADMIN_TOKENS.has(input) ? 'admin'
               : input && VALID_SALES_TOKENS.has(input) ? 'sales'
               : null;
    if (!role) {
      recordAuditLog(req, clientIp, 'unknown', 401, 'login_failed');
      return res.status(401).json({ error: 'Unauthorized', message: 'รหัสผ่านไม่ถูกต้อง' });
    }
    res.setHeader('Set-Cookie', `crm_session=${encodeURIComponent(input)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    recordAuditLog(req, clientIp, role, 200, 'login_success');
    return res.status(200).json({ success: true, role });
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
      role: authUser.role,
      userType: authUser.role === 'sales' ? 'Sales Representative (Restricted Access)'
              : authUser.role === 'admin' ? 'Administrator (Full Access)' : null
    });
  }

  // --- Everything below requires a valid session ---------------------------
  // (the PanCake webhook itself is a plain POST with no ?action and stays open)
  const isWebhookPost = req.method === 'POST' && !action;
  if (!isWebhookPost && !authUser.authenticated) {
    recordAuditLog(req, clientIp, 'unauthenticated', 401, `${action || req.method}_denied`);
    return res.status(401).json({ error: 'Unauthorized', message: 'กรุณาเข้าสู่ระบบ' });
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
    // cloud state already refreshed once at the top of the handler
    const effectiveRole = authUser.role;
    recordAuditLog(req, clientIp, effectiveRole, 200, 'read_leads');

    // Ensure memoryLeads does not contain any blacklisted leads before returning
    if (memoryDeletedIds.length > 0) {
      memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    memoryLeads = sortLeadsByDate(memoryLeads);

    const { date: thaiDate, time: thaiTime } = getThaiDateTime();

    return res.status(200).json({
      status: 'online',
      platform: 'vercel',
      storage: USE_UPSTASH ? 'upstash' : 'legacy',
      appVersion: APP_VERSION,
      serverTimestamp: Date.now(),
      serverTime: `${thaiDate} ${thaiTime}`,
      role: effectiveRole,
      endpoint: '/api/webhooks/pancake',
      leads: memoryLeads,
      recentLeads: memoryLeads.slice(0, 50),
      truckTypes: memoryTruckTypes,
      channelSources: memoryChannels,
      channels: memoryChannels,
      truckTypesUpdatedAt: memoryTruckTypesUpdatedAt,
      channelsUpdatedAt: memoryChannelsUpdatedAt,
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
      memoryLeads = mergeLeadArrays(memoryLeads, payload.leads, memoryDeletedIds);
    } else {
      memoryLeads = memoryLeads.filter(l => !isBlacklistedLead(l, memoryDeletedIds));
    }
    await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
    recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'delete_lead_success');
    return res.status(200).json({ success: true, message: 'Lead deleted permanently', totalLeads: memoryLeads.length, deletedIds: memoryDeletedIds });
  }

  // PUT / POST with sync action: Save state from frontend.
  // An explicit list edit always wins and bumps the last-edit timestamp.
  if (action === 'sync_trucks') {
    if (Array.isArray(payload?.truckTypes) && payload.truckTypes.length > 0) {
      memoryTruckTypes = payload.truckTypes;
      memoryTruckTypesUpdatedAt = Number(payload.truckTypesUpdatedAt) || Date.now();
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'sync_truck_types');
      return res.status(200).json({ success: true, message: 'Truck types updated', truckTypes: memoryTruckTypes, truckTypesUpdatedAt: memoryTruckTypesUpdatedAt });
    }
  }

  if (action === 'sync_channels') {
    if (Array.isArray(payload?.channelSources) && payload.channelSources.length > 0) {
      memoryChannels = payload.channelSources;
      memoryChannelsUpdatedAt = Number(payload.channelsUpdatedAt) || Date.now();
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      recordAuditLog(req, clientIp, authUser.role || 'admin', 200, 'sync_channel_sources');
      return res.status(200).json({ success: true, message: 'Channel sources updated', channelSources: memoryChannels, channelsUpdatedAt: memoryChannelsUpdatedAt });
    }
  }

  if (action === 'sync_state') {
    // Merge deletedIds if client sent any
    if (Array.isArray(payload?.deletedIds)) {
      for (const d of payload.deletedIds) {
        if (d && !memoryDeletedIds.includes(d)) memoryDeletedIds.push(d);
      }
    }

    // Customizable lists: only accept when the client's copy is newer, so a
    // stale device syncing a lead edit cannot resurrect a deleted entry.
    const stateChannelTs = Number(payload?.channelsUpdatedAt) || 0;
    if (Array.isArray(payload?.channelSources) && payload.channelSources.length > 0 && stateChannelTs >= memoryChannelsUpdatedAt) {
      memoryChannels = payload.channelSources;
      memoryChannelsUpdatedAt = stateChannelTs || memoryChannelsUpdatedAt;
    }
    const stateTruckTs = Number(payload?.truckTypesUpdatedAt) || 0;
    if (Array.isArray(payload?.truckTypes) && payload.truckTypes.length > 0 && stateTruckTs >= memoryTruckTypesUpdatedAt) {
      memoryTruckTypes = payload.truckTypes;
      memoryTruckTypesUpdatedAt = stateTruckTs || memoryTruckTypesUpdatedAt;
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
      let salesSheetTarget = null;
      if (payload?.lead) {
        const target = memoryLeads.find(l => (payload.lead.id && l.id === payload.lead.id) || l.phone === payload.lead.phone);
        if (target && payload.lead.report !== undefined) {
          target.report = payload.lead.report;
          salesSheetTarget = target;
        } else {
          salesSheetTarget = payload.lead;
        }
      }
      await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
      if (salesSheetTarget) { syncToGoogleSheets(salesSheetTarget).catch(() => {}); }
      recordAuditLog(req, clientIp, authUser.role, 200, 'sync_sales_report');
      return res.status(200).json({ success: true, message: 'Sales report updated', role: 'sales', deletedIds: memoryDeletedIds });
    }

    // Admin has full control. Union-merge so a lead added on another device
    // is not dropped when this device syncs its (older) full list.
    if (Array.isArray(payload?.leads)) {
      memoryLeads = mergeLeadArrays(memoryLeads, payload.leads, memoryDeletedIds);
    }
    let sheetSyncTarget = null;
    if (payload?.lead) {
      const target = memoryLeads.find(l => (payload.lead.id && l.id === payload.lead.id) || l.phone === payload.lead.phone);
      if (target) {
        if (payload.lead.report !== undefined) target.report = payload.lead.report;
        if (payload.lead.sales !== undefined) target.sales = payload.lead.sales;
        if (payload.lead.truck !== undefined) target.truck = payload.lead.truck;
        if (payload.lead.date !== undefined) target.date = payload.lead.date;
        if (payload.lead.source !== undefined) target.source = payload.lead.source;
        sheetSyncTarget = target;
      } else {
        sheetSyncTarget = payload.lead;
      }
    }
    // truckTypes / channels already handled above with timestamp gating
    // Persist the shared cloud state FIRST (critical path for multi-device sync);
    // Google Sheets is best-effort and must never block or pre-empt the cloud write.
    await saveCloudData(memoryLeads, memoryTruckTypes, webhookLogs, memoryDeletedIds, memoryChannels);
    if (sheetSyncTarget) { syncToGoogleSheets(sheetSyncTarget).catch(() => {}); }

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

    // cloud state already refreshed once at the top of the handler
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
        adSource,
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
      try {
        await appendToSheet(rowsToAppend);
      } catch(sheetErr) {
        console.warn('Optional appendToSheet skipped:', sheetErr.message);
      }
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

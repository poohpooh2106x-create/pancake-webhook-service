/**
 * Comprehensive Automated Tests for PanCake Webhook Handler
 * Endpoint handler: api/webhooks/pancake.js
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const pancakeHandler = require('../api/webhooks/pancake.js');

function createMockReqRes({ method = 'GET', url = '/api/webhooks/pancake', headers = {}, query = {}, body = {} } = {}) {
  const req = {
    method,
    url,
    headers: { 'user-agent': 'TestRunner/1.0', ...headers },
    query,
    body,
    socket: { remoteAddress: '127.0.0.1' }
  };

  const resData = {
    statusCode: 200,
    headers: {},
    body: null
  };

  const res = {
    status(code) {
      resData.statusCode = code;
      return res;
    },
    setHeader(name, val) {
      resData.headers[name.toLowerCase()] = val;
      return res;
    },
    json(data) {
      resData.body = data;
      return res;
    },
    send(data) {
      resData.body = data;
      return res;
    }
  };

  return { req, res, resData };
}

async function runAllTests() {
  console.log('🧪 Starting PanCake Webhook Handler Test Suite...\n');

  // Test 1: GET Request (System Health Check, App Version & Cloud Data)
  {
    const { req, res, resData } = createMockReqRes({ method: 'GET' });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200, 'GET should return 200');
    assert.strictEqual(resData.body.status, 'online', 'Status should be online');
    assert.strictEqual(resData.body.appVersion, '2026.08.28.3', 'App version must match');
    assert.ok(typeof resData.body.serverTimestamp === 'number', 'Server timestamp must be present');
    assert.ok(resData.headers['cache-control']?.includes('no-cache'), 'Cache-Control header must be set to no-cache');
    assert.ok(Array.isArray(resData.body.leads), 'Leads should be an array');
    assert.ok(Array.isArray(resData.body.truckTypes), 'Truck types should be an array');
    console.log('✅ Test 1 Passed: GET Health check, appVersion & initial cloud state');
  }

  // Test 2: Admin Authentication Login
  {
    const adminToken = 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'login' },
      body: { token: adminToken }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200, 'Admin login should return 200');
    assert.strictEqual(resData.body.success, true);
    assert.strictEqual(resData.body.role, 'admin');
    assert.ok(resData.headers['set-cookie']?.includes('crm_session='), 'Should set httpOnly cookie');
    console.log('✅ Test 2 Passed: Admin Token login & session cookie');
  }

  // Test 3: Sales Authentication Login (Official Token)
  {
    const salesToken = 'kp_sales_4a7c8e2b9d1f3068e5b7a2c4d9f103b872e4a9c1d5f8b0e3a6c2d4f8b9e1a3c5';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'login' },
      body: { token: salesToken }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200, 'Sales login should return 200');
    assert.strictEqual(resData.body.success, true);
    assert.strictEqual(resData.body.role, 'sales');
    console.log('✅ Test 3 Passed: Sales Token login & RBAC role assignment');
  }

  // Test 4: Invalid Authentication Token
  {
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'login' },
      body: { token: 'invalid_token_12345' }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 401, 'Invalid token should return 401');
    assert.strictEqual(resData.body.error, 'Unauthorized');
    console.log('✅ Test 4 Passed: Invalid Token rejected with 401');
  }

  // Test 5: Standard PanCake Webhook Payload
  {
    const testPhone = '0812345678';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: {
        fields: [
          {
            id: 'test_lead_std_01',
            NAME: 'ทดสอบ ลูกค้าใหม่',
            PHONE: [{ VALUE: testPhone }]
          }
        ]
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.body.success, true);
    const created = resData.body.recentLeads?.find(l => l.phone === testPhone);
    assert.ok(created, 'Lead with valid phone should be processed');
    assert.strictEqual(created.phone, testPhone);
    console.log('✅ Test 5 Passed: Standard PanCake fields payload processed');
  }

  // Test 6: Deep Universal Fallback Scan for Thai Phone Number (deepFindThaiPhone)
  {
    const nestedPhone = '0987654321';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: {
        event: 'custom_message',
        meta: {
          deep_nested: {
            conversation: {
              raw_text: `สนใจรถสิบล้อ ติดต่อได้ที่เบอร์ ${nestedPhone} นะครับ`
            }
          }
        }
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.body.success, true);
    const created = resData.body.recentLeads?.find(l => l.phone === nestedPhone);
    assert.ok(created, 'Deep nested Thai phone should be successfully extracted by deepFindThaiPhone');
    assert.strictEqual(created.phone, nestedPhone);
    console.log('✅ Test 6 Passed: Universal deep Thai phone scanner (deepFindThaiPhone)');
  }

  // Test 7: Deduplication Prevention
  {
    const dupPhone = '0987654321';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: {
        fields: [
          {
            id: 'dup_test_id',
            NAME: 'ลูกค้ายิงซ้ำ',
            PHONE: [{ VALUE: dupPhone }]
          }
        ]
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    const newCount = resData.body.recentLeads?.length || 0;
    assert.strictEqual(newCount, 0, 'Duplicate lead within TTL should be skipped');
    console.log('✅ Test 7 Passed: Rapid duplicate spam prevention');
  }

  // Test 8: Sync State with Single Lead Update
  {
    const updateLead = {
      id: '570f8dab-320b-4488-8fa0-1bdd5bfcf473',
      phone: '0963577542',
      report: 'โทรติดต่อแล้ว ลูกค้าสนใจเข้ามาดูรถวันเสาร์'
    };
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'sync_state' },
      headers: { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' },
      body: {
        lead: updateLead
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.body.success, true);
    console.log('✅ Test 8 Passed: State and single lead update sync');
  }

  // Test 9: Lead Deletion & Cloud Blacklist
  {
    const delPhone = '0812345678';
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'delete_lead' },
      headers: { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' },
      body: {
        phone: delPhone,
        id: 'test_lead_std_01'
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.body.success, true);
    assert.ok(resData.body.deletedIds?.includes(delPhone), 'Deleted phone must be recorded in blacklist');
    console.log('✅ Test 9 Passed: Permanent deletion and cloud blacklist recording');
  }

  // Test 10: Server Blacklist Rejection of Resurrected Leads
  {
    const resurrectedLead = {
      id: 'test_lead_std_01',
      phone: '0812345678',
      name: 'พยายามคืนชีพเคสเก่า'
    };
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'sync_state' },
      headers: { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' },
      body: {
        leads: [resurrectedLead]
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    const { req: getReq, res: getRes, resData: getResData } = createMockReqRes({ method: 'GET' });
    await pancakeHandler(getReq, getRes);
    const found = getResData.body.leads?.find(l => l.phone === '0812345678');
    assert.strictEqual(found, undefined, 'Blacklisted lead must be completely rejected by Cloud Server');
    console.log('✅ Test 10 Passed: Cloud Blacklist blocks resurrection of deleted leads');
  }

  // Test 11: Sync Custom Channel Sources
  {
    const customChannels = ['FB เคพีศรีราชา', 'TikTok', 'LOA เคพี', 'FB เฮียตั้มรถติด', 'FB เพจสำรอง', 'หน้าร้าน'];
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      query: { action: 'sync_channels' },
      headers: { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' },
      body: {
        channelSources: customChannels
      }
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.body.success, true);
    assert.deepStrictEqual(resData.body.channelSources, customChannels);
    console.log('✅ Test 11 Passed: Custom channel sources dynamic sync & persistence');
  }

  // Test 13: Deleted truck type must not be resurrected by an older sync
  {
    const admin = { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' };
    const trimmed = ['หัวลาก', 'ตู้10', 'หาง'];
    const newTs = Date.now();

    // User removes several truck types (fresh timestamp)
    let m = createMockReqRes({ method: 'POST', query: { action: 'sync_trucks' }, headers: admin,
      body: { truckTypes: trimmed, truckTypesUpdatedAt: newTs } });
    await pancakeHandler(m.req, m.res);
    assert.deepStrictEqual(m.res && m.resData.body.truckTypes, trimmed, 'sync_trucks should apply the trimmed list');

    // A stale device echoes the old long list with an older timestamp
    m = createMockReqRes({ method: 'POST', query: { action: 'sync_state' }, headers: admin,
      body: { leads: [], truckTypes: ['หัวลาก','ตู้10','หาง','เครน','โดยสาร','คอก','รถน้ำ','ถังน้ำขี้','ดั๊ม','6 ล้อ','อื่นๆ'], truckTypesUpdatedAt: newTs - 60000 } });
    await pancakeHandler(m.req, m.res);

    m = createMockReqRes({ method: 'GET', headers: admin });
    await pancakeHandler(m.req, m.res);
    assert.deepStrictEqual(m.resData.body.truckTypes, trimmed, 'older sync_state must not resurrect removed truck types');
    console.log('✅ Test 13 Passed: Deleted truck types stay deleted against a stale sync');
  }

  // Test 12: Ad Title Extraction from Nested Conversation Webhook
  {
    const adWebhookPayload = {
      data: {
        conversation: {
          id: 'conv_ad_test_123',
          ad_title: '[ AI EXPERT ADS ] - รถตัด และ คลิปแรกเจ...',
          recent_ad: {
            ad_title: '[ AI EXPERT ADS ] - รถตัด และ คลิปแรกเจ...'
          }
        },
        message: {
          text: 'สนใจสอบถามราคาครับ เบอร์โทร 0612833830',
          from: {
            name: 'Phichit Tepchomphoo'
          }
        }
      }
    };
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: adWebhookPayload
    });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200);
    const addedLead = resData.body.recentLeads?.find(l => l.phone === '0612833830');
    assert.ok(addedLead, 'Lead with phone 0612833830 must be processed');
    assert.strictEqual(addedLead.ad, '[ AI EXPERT ADS ] - รถตัด และ คลิปแรกเจ...', 'Ad title must be accurately extracted from conversation');
    console.log('✅ Test 12 Passed: Ad title extracted accurately from conversation payload');
  }

  // Test 14: Ad captured from PanCake conversation.recent_ad as an ARRAY
  {
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: {
        data: {
          conversation: {
            id: 'conv_recent_ad_arr',
            recent_ad: [
              { id: '52599132199219', ad_id: '52599132199219', ad_title: '[ AI EXPERT ADS ] - รถตัด และ', message: 'หญิงชราผู้เสียสติ...' }
            ]
          },
          message: { text: 'ขอดู 12 ล้อ อีซูซุ ดั้ม เบอร์ 0983979144', from: { name: 'ช่าง เมืองชล' } }
        }
      }
    });
    await pancakeHandler(req, res);
    const lead = resData.body.recentLeads?.find(l => l.phone === '0983979144');
    assert.ok(lead, 'Lead 0983979144 must be processed');
    assert.strictEqual(lead.ad, '[ AI EXPERT ADS ] - รถตัด และ', 'Ad title must be read from recent_ad array');
    console.log('✅ Test 14 Passed: Ad title read from conversation.recent_ad array');
  }

  // Test 15: Ad ID fallback when only a numeric ad id is present
  {
    const { req, res, resData } = createMockReqRes({
      method: 'POST',
      body: {
        data: {
          customer: { name: 'ลูกค้าแอด', current_ads: [{ ad_id: '52599132199219', post_id: '12345' }] },
          message: { text: 'สนใจครับ 0955111222' }
        }
      }
    });
    await pancakeHandler(req, res);
    const lead = resData.body.recentLeads?.find(l => l.phone === '0955111222');
    assert.ok(lead, 'Lead 0955111222 must be processed');
    assert.strictEqual(lead.ad, 'Ad ID: 52599132199219', 'Falls back to Ad ID when no title is available');
    console.log('✅ Test 15 Passed: Ad ID fallback when no ad title present');
  }

  // Test 16: A lead added on another device is not dropped when a device
  // syncs its own (older) full list back (union-merge, not blind replace)
  {
    const admin = { 'x-pancake-secret': 'kp_admin_9f8d3a1b7c4e2095f6a8e1b4c3d702e961fae40b3c2d89a7102e5c8b7a4d3f1e' };

    let m = createMockReqRes({ method: 'POST', query: { action: 'sync_state' }, headers: admin,
      body: { leads: [{ id: 'devB_1', date: '28/08/2026', time: '09:00:00', name: 'เคสจากเครื่อง B', phone: '0900777001', source: 'FB เคพีศรีราชา', truck: '', sales: '', report: '', ad: '' }] } });
    await pancakeHandler(m.req, m.res);

    m = createMockReqRes({ method: 'POST', query: { action: 'sync_state' }, headers: admin,
      body: { leads: [{ id: 'devA_1', date: '28/08/2026', time: '08:00:00', name: 'เคสจากเครื่อง A', phone: '0900777002', source: 'FB เคพีศรีราชา', truck: '', sales: '', report: '', ad: '' }] } });
    await pancakeHandler(m.req, m.res);

    m = createMockReqRes({ method: 'GET', headers: admin });
    await pancakeHandler(m.req, m.res);
    const phones = m.resData.body.leads.map(l => l.phone);
    assert.ok(phones.includes('0900777001'), 'device B lead must survive device A sync');
    assert.ok(phones.includes('0900777002'), 'device A lead must be present');
    console.log('✅ Test 16 Passed: Concurrent full-list syncs union-merge (no lead lost)');
  }

  console.log('\n🎉 ALL 12 TESTS PASSED SUCCESSFULLY! The codebase is robust, clean, and ready.\n');
}

runAllTests().catch((err) => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});

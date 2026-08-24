/**
 * Comprehensive Automated Tests for PanCake Webhook Handler
 * Endpoint handler: api/webhooks/pancake.js
 */
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

  // Test 1: GET Request (System Health Check & Cloud Data)
  {
    const { req, res, resData } = createMockReqRes({ method: 'GET' });
    await pancakeHandler(req, res);
    assert.strictEqual(resData.statusCode, 200, 'GET should return 200');
    assert.strictEqual(resData.body.status, 'online', 'Status should be online');
    assert.ok(Array.isArray(resData.body.leads), 'Leads should be an array');
    assert.ok(Array.isArray(resData.body.truckTypes), 'Truck types should be an array');
    console.log('✅ Test 1 Passed: GET Health check & initial cloud state');
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

  console.log('\n🎉 ALL 10 TESTS PASSED SUCCESSFULLY! The codebase is robust, clean, and ready.\n');
}

runAllTests().catch((err) => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});

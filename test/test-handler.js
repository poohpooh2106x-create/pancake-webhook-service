/**
 * Unit test for Standalone Netlify Function Handler
 */
const assert = require('assert');
const { handler } = require('../netlify/functions/pancake.js');

async function runTests() {
  console.log('🧪 Testing Standalone Netlify Function Handler...\n');

  // Test 1: GET request (Health check)
  const getEvent = { httpMethod: 'GET' };
  const getRes = await handler(getEvent, {});
  assert.strictEqual(getRes.statusCode, 200);
  const getBody = JSON.parse(getRes.body);
  assert.strictEqual(getBody.status, 'online');
  console.log('✅ Test 1 Passed: GET Health check');

  // Test 2: POST with Invalid JSON
  const invalidJsonEvent = { httpMethod: 'POST', body: 'invalid json' };
  const invalidRes = await handler(invalidJsonEvent, {});
  assert.strictEqual(invalidRes.statusCode, 400);
  console.log('✅ Test 2 Passed: Invalid JSON handling');

  // Test 3: POST with Invalid Phone
  const invalidPhoneEvent = {
    httpMethod: 'POST',
    body: JSON.stringify({
      fields: [
        {
          id: 'test_inv',
          NAME: 'ทดสอบ เบอร์ผิด',
          PHONE: [{ VALUE: '12345', VALUE_TYPE: 'WORK' }]
        }
      ]
    })
  };
  const invPhoneRes = await handler(invalidPhoneEvent, {});
  assert.strictEqual(invPhoneRes.statusCode, 200);
  const invPhoneBody = JSON.parse(invPhoneRes.body);
  assert.strictEqual(invPhoneBody.savedCount, 0);
  console.log('✅ Test 3 Passed: Invalid phone skipped');

  // Test 4: POST with exact user payload
  const validEvent = {
    httpMethod: 'POST',
    body: JSON.stringify({
      fields: [
        {
          id: 'rec_standalone_01',
          NAME: 'ประกายฟ้า สานนอก',
          PHONE: [
            {
              VALUE: '099-731-6431',
              VALUE_TYPE: 'WORK'
            }
          ]
        }
      ]
    })
  };

  const validRes = await handler(validEvent, {});
  assert.strictEqual(validRes.statusCode, 200);
  const validBody = JSON.parse(validRes.body);
  assert.strictEqual(validBody.success, true);
  assert.strictEqual(validBody.savedCount, 1);
  assert.strictEqual(validBody.leads[0].phone, '0997316431');
  assert.strictEqual(validBody.leads[0].source, 'Facebook');
  console.log('✅ Test 4 Passed: Exact PanCake JSON payload parsed successfully');

  // Test 5: Deduplication check
  const dupRes = await handler(validEvent, {});
  assert.strictEqual(dupRes.statusCode, 200);
  const dupBody = JSON.parse(dupRes.body);
  assert.strictEqual(dupBody.savedCount, 0, 'Duplicate should have savedCount = 0');
  console.log('✅ Test 5 Passed: Deduplication successfully prevented recording duplicate');

  console.log('\n🎉 All Standalone Netlify Function Handler tests passed successfully!\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

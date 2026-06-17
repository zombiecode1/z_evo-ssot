import fetch from 'node-fetch';

interface TestResult {
  test_name: string;
  status: 'success' | 'failure';
  response_time_ms: number;
  error?: string;
  details?: any;
}

const BASE_URL = 'http://localhost:9999';
const results: TestResult[] = [];

async function runTest(testName: string, testFn: () => Promise<any>) {
  const startTime = Date.now();
  try {
    const details = await testFn();
    const responseTime = Date.now() - startTime;
    results.push({
      test_name: testName,
      status: 'success',
      response_time_ms: responseTime,
      details
    });
    console.log(`  PASS  ${testName} (${responseTime}ms)`);
    return details;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    results.push({
      test_name: testName,
      status: 'failure',
      response_time_ms: responseTime,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log(`  FAIL  ${testName} (${responseTime}ms): ${error instanceof Error ? error.message : error}`);
  }
}

async function testHealth() {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error('Status not ok');
  return data;
}

async function testChatSimple() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Say hello in 3 words' }],
      max_tokens: 30
    })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) throw new Error('No content');
  if (!data.model) throw new Error('No model');
  if (!data.usage?.total_tokens) throw new Error('No usage');
  return { model: data.model, content: data.choices[0].message.content, usage: data.usage };
}

async function testChatWithModel() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Say hello in 3 words' }],
      max_tokens: 30
    })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.model !== 'llama-3.3-70b-versatile') throw new Error(`Wrong model: ${data.model}`);
  return { model: data.model };
}

async function testChatStreaming() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Count 1 2' }],
      max_tokens: 30,
      stream: true
    })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const text = await res.text();
  if (!text.includes('data: [DONE]')) throw new Error('No [DONE] marker');
  if (!text.includes('chat.completion.chunk')) throw new Error('No chunk object');
  return { chunks: text.split('\n').filter(l => l.startsWith('data: ')).length };
}

async function testJsonMode() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Return JSON with key "name" and value "test"' }],
      response_format: { type: 'json_object' },
      max_tokens: 50
    })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content');
  const parsed = JSON.parse(content);
  if (!parsed.name) throw new Error('JSON missing name field');
  return { json: parsed };
}

async function testToolCalling() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string', description: 'City name' } },
            required: ['location']
          }
        }
      }],
      tool_choice: 'auto',
      max_tokens: 150
    })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('No message');
  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
  const hasContent = msg.content && msg.content.length > 0;
  if (!hasToolCalls && !hasContent) throw new Error('No tool_calls or content');
  if (hasToolCalls) {
    const tc = msg.tool_calls[0];
    if (tc.type !== 'function') throw new Error(`Wrong tool type: ${tc.type}`);
    return { tool_calls: msg.tool_calls.map((t: any) => ({ name: t.function.name, args: JSON.parse(t.function.arguments) })) };
  }
  return { content: msg.content };
}

async function testListModels() {
  const res = await fetch(`${BASE_URL}/v1/models`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error('Models not array');
  if (data.data.length === 0) throw new Error('No models');
  return { count: data.data.length, models: data.data.slice(0, 3).map((m: any) => m.id) };
}

async function testGetModel() {
  const res = await fetch(`${BASE_URL}/v1/models/llama-3.3-70b-versatile`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.id !== 'llama-3.3-70b-versatile') throw new Error('Wrong model id');
  return { id: data.id };
}

async function testLogs() {
  const res = await fetch(`${BASE_URL}/api/logs`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.logs)) throw new Error('Logs not array');
  return { count: data.logs.length };
}

async function testStatus() {
  const res = await fetch(`${BASE_URL}/api/status`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(`Status: ${data.status}`);
  return data;
}

async function testAutoSelectToggle() {
  const res = await fetch(`${BASE_URL}/api/auto-select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.auto_select !== false) throw new Error('Toggle failed');
  // Toggle back
  await fetch(`${BASE_URL}/api/auto-select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  return { toggled: true };
}

async function testDashboard() {
  const res = await fetch(`${BASE_URL}/dashboard`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const html = await res.text();
  if (!html.includes('switchTab')) throw new Error('Missing switchTab');
  if (!html.includes('testChat')) throw new Error('Missing testChat');
  if (!html.includes('function switchTab')) throw new Error('Missing switchTab definition');
  return { size: html.length };
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('  Groq Bridge - Complete Test Suite');
  console.log('='.repeat(60));

  await runTest('Health Check', testHealth);
  await runTest('Chat Completion (simple)', testChatSimple);
  await runTest('Chat Completion (with model)', testChatWithModel);
  await runTest('Chat Completion (streaming)', testChatStreaming);
  await runTest('JSON Mode', testJsonMode);
  await runTest('Tool Calling', testToolCalling);
  await runTest('List Models', testListModels);
  await runTest('Get Single Model', testGetModel);
  await runTest('Request Logs', testLogs);
  await runTest('Server Status', testStatus);
  await runTest('Auto-Select Toggle', testAutoSelectToggle);
  await runTest('Dashboard HTML', testDashboard);

  console.log('='.repeat(60));
  console.log('  RESULTS SUMMARY');
  console.log('='.repeat(60));

  const successCount = results.filter(r => r.status === 'success').length;
  const failureCount = results.filter(r => r.status === 'failure').length;
  const avgTime = results.length > 0 ? results.reduce((s, r) => s + r.response_time_ms, 0) / results.length : 0;

  console.log(`  Total:  ${results.length}`);
  console.log(`  Passed: ${successCount}`);
  console.log(`  Failed: ${failureCount}`);
  console.log(`  Avg:    ${avgTime.toFixed(1)}ms`);
  console.log('='.repeat(60));

  console.log('\nJSON Output:');
  console.log(JSON.stringify(results, null, 2));

  if (failureCount > 0) {
    console.log('\nSOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\nALL TESTS PASSED');
  }
}

runAllTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});

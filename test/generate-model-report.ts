import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __dirname: any;

interface ModelInfo {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  max_tokens?: number;
  category?: string;
}

interface ModelResult {
  model: string;
  status: 'success' | 'error';
  duration_ms: number;
  prompt: string;
  response?: string;
  usage?: any;
  error?: string;
  where_to_use?: string;
  improvements?: string;
  stream_supported?: boolean;
  stream_chunks?: number;
  stream_sample?: string;
  stream_error?: string;
  stream_duration_ms?: number;
  stream_url?: string;
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:9999';
const REPORT_PATH = path.resolve(__dirname, '../documentation/model-response-report.html');
const BENGALI_REPORT_PATH = path.resolve(__dirname, '../documentation/model-response-report-bn.html');
const SUMMARY_PATH = path.resolve(__dirname, '../documentation/model-response-report.json');

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const expectedOutcome = (model: ModelInfo, item?: ModelResult) => {
  const id = (model?.id || '').toLowerCase();
  if (id.includes('whisper')) return 'এই মডেল চ্যাট কমপ্লিশন সমর্থন করে না; অডিও ট্রান্সক্রিপশনের ফলাফল প্রত্যাশিত।';
  if (id.includes('prompt-guard')) return 'গার্ড মডেল: আউটপুট সংক্ষিপ্ত বা সংখ্যাসূচক হতে পারে (সিকিউরিটি লেয়ার)।';
  if (item && item.status === 'success') return 'সংক্ষিপ্ত, প্রাসঙ্গিক টেক্সট রেসপন্স প্রত্যাশিত।';
  return 'প্রাতিষ্ঠানিকভাবে একটি সংক্ষিপ্ত উত্তর বা ব্যাখ্যা প্রত্যাশিত ছিল, কিন্তু ত্রুটি ঘটেছে।';
};

const recommendation = (item: ModelResult) => {
  if (item.status === 'success') {
    return 'মডেল সঠিকভাবে কাজ করেছে; পারফরম্যান্স পর্যালোচনা করতে ল্যাটেন্সি এবং ইউসেজ দেখুন।';
  }
  return 'ত্রুটি হলে মডেল অ্যাক্সেস, সার্ভার সেটিংস বা অনুরোধ বিন্যাস পরীক্ষা করুন এবং পুনরায় চেষ্টা করুন।';
};

const suggestUsage = (model: ModelInfo, item?: Partial<ModelResult>): string => {
  const id = (model.id || '').toLowerCase();
  if (id.includes('whisper')) return 'স্পিচ-টু-টেক্সট (অডিও ট্রান্সক্রিপশন) ও ভয়েস প্রসেসিং।';
  if (id.includes('qwen') || id.includes('gpt') || id.includes('llama') || id.includes('openai')) return 'চ্যাটবট, টেক্সট জেনারেশন, সারাংশ ও সহায়ক অ্যাপ্লিকেশন।';
  if (id.includes('groq/compound') || id.includes('compound')) return 'লো-ল্যাটেন্সি সার্ভিস, রিয়েলটাইম উত্তরের জন্য উপযোগী।';
  if (id.includes('allam')) return 'আঞ্চলিক ভাষা মডেল—লোকালাইজড অ্যাপ্লিকেশন ও ভাষাগত কাজ।';
  return 'জেনেরিক টেক্সট প্রসেসিং ও প্রোটোটাইপিং; প্রম্পট টিউনিং ব্যবহার করুন।';
};

const suggestImprovements = (model: ModelInfo, item?: Partial<ModelResult>): string => {
  const id = (model.id || '').toLowerCase();
  if (id.includes('whisper')) return 'উন্নত অডিও ইনপুট, স্যাম্পলিং ও নোয়েজ রিডাকশন; ভাষা নির্ধারণ যোগ করুন।';
  if (id.includes('qwen') || id.includes('gpt') || id.includes('llama') || id.includes('openai')) return 'প্রম্পট টিউনিং, কনটেক্সট বাড়ানো, রেট লিমিট ও টোকেন ব্যবস্থাপনা পরীক্ষা করুন।';
  if (id.includes('groq/compound') || id.includes('compound')) return 'বহু রিকোয়ারমেন্টে টেস্ট করুন; ব্যালান্সড টেম্পারেচার এবং কনটেক্সট প্রয়োগ করুন।';
  return 'ইনপুট স্যানিটাইজেশন, প্রম্পট স্পষ্টীকরণ এবং পুনরাবৃত্তি পরীক্ষা করুন।';
};

async function fetchJson(url: string, opts: any = {}) {
  const response = await fetch(url, opts);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${text}`);
  }
}

async function getModels(): Promise<ModelInfo[]> {
  const data = await fetchJson(`${BASE_URL}/v1/models`);
  if (!Array.isArray(data.data)) {
    throw new Error('Model list response missing data array');
  }
  return data.data;
}

async function testModel(model: ModelInfo): Promise<ModelResult> {
  const prompt = `You are a helpful assistant. In one short sentence, tell me that you are responding from model ${model.id}.`;
  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 40,
    temperature: 0.2,
  };

  const start = Date.now();
  try {
    const result = await fetchJson(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const duration = Date.now() - start;
    const content = result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || '';
    const where = suggestUsage(model, { response: content });
    const improve = suggestImprovements(model, { response: content });
    // also test streaming support for this model
    const streamTest = await testStreamingForModel(model);
    return {
      model: model.id,
      status: 'success',
      duration_ms: duration,
      prompt,
      response: content.trim(),
      usage: result.usage || null,
      where_to_use: where,
      improvements: improve,
      stream_supported: streamTest.supported,
      stream_chunks: streamTest.chunks,
      stream_sample: streamTest.sample,
      stream_error: streamTest.error,
      stream_duration_ms: streamTest.duration_ms,
      stream_url: streamTest.url,
    };
  } catch (error: any) {
    const duration = Date.now() - start;
    const where = suggestUsage(model);
    const improve = suggestImprovements(model);
    const streamTest = await testStreamingForModel(model);
    return {
      model: model.id,
      status: 'error',
      duration_ms: duration,
      prompt,
      error: error instanceof Error ? error.message : String(error),
      where_to_use: where,
      improvements: improve,
      stream_supported: streamTest.supported,
      stream_chunks: streamTest.chunks,
      stream_sample: streamTest.sample,
      stream_error: streamTest.error,
      stream_duration_ms: streamTest.duration_ms,
      stream_url: streamTest.url,
    };
  }
}

async function testStreamingForModel(model: ModelInfo): Promise<{ supported: boolean; chunks: number; sample?: string; error?: string; duration_ms: number; url?: string }> {
  const url = `${BASE_URL}/v1/chat/completions`;
  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: 'Stream test - please reply with a short tokenized chunk.' }],
    max_tokens: 20,
    stream: true,
  };
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await res.text();
    const duration = Date.now() - start;
    if (!res.ok) {
      return { supported: false, chunks: 0, error: `HTTP ${res.status} ${res.statusText}: ${text}`, duration_ms: duration, url };
    }
    const lines = text.split(/\r?\n/);
    const dataLines = lines.filter(l => l.trim().startsWith('data: '));
    const chunks = dataLines.length;
    const sample = text.slice(0, 1000);
    const supported = chunks > 0 && text.includes('[DONE]');
    return { supported, chunks, sample, duration_ms: duration, url };
  } catch (err: any) {
    const duration = Date.now() - start;
    return { supported: false, chunks: 0, error: err instanceof Error ? err.message : String(err), duration_ms: duration, url };
  }
}

function buildHtml(results: ModelResult[], models: ModelInfo[]): string {
  const serverTime = new Date().toISOString();
  const successCount = results.filter((item) => item.status === 'success').length;
  const errorCount = results.length - successCount;
  const avgLatency = results.length > 0 ? Math.round(results.reduce((sum, item) => sum + item.duration_ms, 0) / results.length) : 0;

  const rows = results.map((item) => {
    const rowClass = item.status === 'success' ? 'row-success' : 'row-error';
    const usageHtml = item.usage ? `<pre>${escapeHtml(JSON.stringify(item.usage, null, 2))}</pre>` : '';
    const modelInfo = models.find(m => m.id === item.model) || { id: item.model, object: 'model' } as ModelInfo;
    const expected = expectedOutcome(modelInfo, item as ModelResult);
    const streamSupported = item.stream_supported ? 'yes' : 'no';
    const streamChunks = item.stream_chunks ?? 0;
    const streamSample = item.stream_sample ? `<pre>${escapeHtml(String(item.stream_sample).slice(0, 500))}</pre>` : '';
    return `
      <tr class="${rowClass}">
        <td><code>${escapeHtml(item.model)}</code></td>
        <td>${item.status}</td>
        <td>${item.duration_ms}ms</td>
        <td>${escapeHtml(item.prompt)}</td>
        <td>${escapeHtml(item.response || '')}</td>
        <td>${escapeHtml(expected)}</td>
        <td>${escapeHtml(item.where_to_use || '')}</td>
        <td>${escapeHtml(item.improvements || '')}</td>
        <td>${escapeHtml(streamSupported)}</td>
        <td>${streamChunks}</td>
        <td>${streamSample}</td>
        <td>${usageHtml}</td>
        <td>${escapeHtml(item.error || '')}</td>
      </tr>`;
  }).join('');

  const modelRows = models.map((model) => `
      <tr>
        <td><code>${escapeHtml(model.id)}</code></td>
        <td>${escapeHtml(model.owned_by || 'unknown')}</td>
        <td>${escapeHtml(String(model.category || 'n/a'))}</td>
        <td>${model.context_window ?? 'n/a'}</td>
        <td>${model.max_tokens ?? 'n/a'}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Groq Model Response Report</title>
  <style>
    body { background:#0b1220; color:#e6edf3; font-family:Inter,system-ui,sans-serif; margin:0; padding:24px; }
    h1,h2 { margin:0 0 12px 0; }
    .hero { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; align-items:flex-end; margin-bottom:24px; }
    .card { background:#111827; border:1px solid #273147; border-radius:18px; padding:18px; box-shadow:0 16px 40px rgba(0,0,0,.25); }
    .summary { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }
    .stat { padding:16px; border-radius:14px; background:#141c2f; }
    .stat strong { display:block; font-size:1.9rem; line-height:1; margin-bottom:4px; color:#58a6ff; }
    table { width:100%; border-collapse:collapse; margin-top:16px; }
    th, td { text-align:left; padding:12px 14px; border-bottom:1px solid #1f283d; vertical-align:top; }
    th { background:#121a2d; color:#8fa4bf; font-size:.85rem; text-transform:uppercase; letter-spacing:.04em; }
    tr.row-error td { color:#ffb3b3; }
    tr.row-success td { color:#e6edf3; }
    code { font-family:source-code-pro,monospace; background:#172136; padding:4px 6px; border-radius:6px; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:.82rem; background:#101623; padding:10px; border-radius:10px; }
    a { color:#58a6ff; text-decoration:none; }
    a:hover { text-decoration:underline; }
  </style>
</head>
<body>
  <div class="hero">
    <div>
      <h1>Groq Model Response Report</h1>
      <p>Generated from <code>${escapeHtml(BASE_URL)}</code> on ${escapeHtml(serverTime)}</p>
      <p>${results.length} models tested, ${successCount} succeeded, ${errorCount} failed.</p>
    </div>
    <div class="card" style="min-width:240px;">
      <div class="summary">
        <div class="stat"><strong>${results.length}</strong>Models tested</div>
        <div class="stat"><strong>${successCount}</strong>OK</div>
        <div class="stat"><strong>${errorCount}</strong>Errors</div>
        <div class="stat"><strong>${avgLatency}ms</strong>Avg latency</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Model Metadata</h2>
    <table>
      <thead>
        <tr><th>Model ID</th><th>Owned by</th><th>Category</th><th>Context</th><th>Max tokens</th></tr>
      </thead>
      <tbody>${modelRows}</tbody>
    </table>
  </div>

  <div class="card" style="margin-top:24px;">
    <h2>Response Results</h2>
    <table>
      <thead>
          <tr><th>Model</th><th>Status</th><th>Latency</th><th>Prompt</th><th>Response</th><th>Expected</th><th>Where to use</th><th>Improvements</th><th>Stream</th><th>Chunks</th><th>Stream sample</th><th>Usage</th><th>Error</th></tr>
        </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function buildHtmlBengali(results: ModelResult[], models: ModelInfo[]): string {
  const serverTime = new Date().toISOString();
  const successCount = results.filter((item) => item.status === 'success').length;
  const errorCount = results.length - successCount;
  const avgLatency = results.length > 0 ? Math.round(results.reduce((sum, item) => sum + item.duration_ms, 0) / results.length) : 0;

  const rows = results.map((item) => {
    const rowClass = item.status === 'success' ? 'row-success' : 'row-error';
    const usageHtml = item.usage ? `<pre>${escapeHtml(JSON.stringify(item.usage, null, 2))}</pre>` : '';
    const modelInfo = models.find(m => m.id === item.model) || { id: item.model, object: 'model' } as ModelInfo;
    const expected = expectedOutcome(modelInfo, item as ModelResult);
    const streamSupported = item.stream_supported ? 'হ্যাঁ' : 'না';
    const streamChunks = item.stream_chunks ?? 0;
    const streamSample = item.stream_sample ? `<pre>${escapeHtml(String(item.stream_sample).slice(0, 500))}</pre>` : '';
    return `
      <tr class="${rowClass}">
        <td><code>${escapeHtml(item.model)}</code></td>
        <td>${item.status === 'success' ? 'সফল' : 'ত্রুটি'}</td>
        <td>${item.duration_ms}ms</td>
        <td>${escapeHtml(item.prompt)}</td>
        <td>${escapeHtml(item.response || '')}</td>
        <td>${escapeHtml(expected)}</td>
        <td>${escapeHtml(item.where_to_use || '')}</td>
        <td>${escapeHtml(item.improvements || '')}</td>
        <td>${escapeHtml(streamSupported)}</td>
        <td>${streamChunks}</td>
        <td>${streamSample}</td>
        <td>${usageHtml}</td>
        <td>${escapeHtml(item.error || '')}</td>
      </tr>`;
  }).join('');

  const modelRows = models.map((model) => `
      <tr>
        <td><code>${escapeHtml(model.id)}</code></td>
        <td>${escapeHtml(model.owned_by || 'অজানা')}</td>
        <td>${escapeHtml(String(model.category || 'ন/এ'))}</td>
        <td>${model.context_window ?? 'ন/এ'}</td>
        <td>${model.max_tokens ?? 'ন/এ'}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Groq মডেল রিপোর্ট</title>
  <style>
    body { background:#0b1220; color:#e6edf3; font-family:Inter,system-ui,sans-serif; margin:0; padding:24px; }
    h1,h2 { margin:0 0 12px 0; }
    .hero { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; align-items:flex-end; margin-bottom:24px; }
    .card { background:#111827; border:1px solid #273147; border-radius:18px; padding:18px; box-shadow:0 16px 40px rgba(0,0,0,.25); }
    .summary { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }
    .stat { padding:16px; border-radius:14px; background:#141c2f; }
    .stat strong { display:block; font-size:1.9rem; line-height:1; margin-bottom:4px; color:#58a6ff; }
    table { width:100%; border-collapse:collapse; margin-top:16px; }
    th, td { text-align:left; padding:12px 14px; border-bottom:1px solid #1f283d; vertical-align:top; }
    th { background:#121a2d; color:#8fa4bf; font-size:.85rem; text-transform:uppercase; letter-spacing:.04em; }
    tr.row-error td { color:#ffb3b3; }
    tr.row-success td { color:#e6edf3; }
    code { font-family:source-code-pro,monospace; background:#172136; padding:4px 6px; border-radius:6px; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:.82rem; background:#101623; padding:10px; border-radius:10px; }
  </style>
</head>
<body>
  <div class="hero">
    <div>
      <h1>Groq মডেল রেসপন্স রিপোর্ট</h1>
      <p><code>${escapeHtml(BASE_URL)}</code> থেকে তৈরি হয়েছে ${escapeHtml(serverTime)} তারিখে।</p>
      <p>${results.length}টি মডেল পরীক্ষা করা হয়েছে, ${successCount}টি সফল, ${errorCount}টি ত্রুটিপূর্ণ।</p>
    </div>
    <div class="card" style="min-width:240px;">
      <div class="summary">
        <div class="stat"><strong>${results.length}</strong>মডেল</div>
        <div class="stat"><strong>${successCount}</strong>সফল</div>
        <div class="stat"><strong>${errorCount}</strong>ত্রুটি</div>
        <div class="stat"><strong>${avgLatency}ms</strong>গড় ল্যাটেন্সি</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>মডেল মেটাডেটা</h2>
    <table>
      <thead>
        <tr><th>মডেল আইডি</th><th>মালিক</th><th>ক্যাটাগরি</th><th>কনটেক্সট</th><th>ম্যাক্স টোকেন</th></tr>
      </thead>
      <tbody>${modelRows}</tbody>
    </table>
  </div>

  <div class="card" style="margin-top:24px;">
    <h2>ফলাফলের বিবরণ</h2>
    <table>
      <thead>
        <tr><th>মডেল</th><th>স্ট্যাটাস</th><th>সময়</th><th>প্রম্পট</th><th>প্রতিক্রিয়া</th><th>কি হওয়া উচিত</th><th>কোথায় ব্যবহার</th><th>উন্নতির পরামর্শ</th><th>স্ট্রিম</th><th>চাঙ্ক</th><th>স্ট্রিম স্যাম্পল</th><th>ইউসেজ</th><th>ত্রুটি</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

async function main() {
  console.log(`Connecting to ${BASE_URL}`);
  const models = await getModels();
  console.log(`Found ${models.length} models.`);

  const results: ModelResult[] = [];
  for (const model of models) {
    process.stdout.write(`Testing ${model.id}... `);
    const result = await testModel(model);
    results.push(result);
    console.log(result.status === 'success' ? `ok (${result.duration_ms}ms)` : `failed (${result.duration_ms}ms)`);
  }

  console.log(`Writing HTML report to ${REPORT_PATH}`);
  fs.writeFileSync(REPORT_PATH, buildHtml(results, models), 'utf-8');
  console.log(`Writing Bengali HTML report to ${BENGALI_REPORT_PATH}`);
  fs.writeFileSync(BENGALI_REPORT_PATH, buildHtmlBengali(results, models), 'utf-8');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ generated_at: new Date().toISOString(), base_url: BASE_URL, results }, null, 2), 'utf-8');
  console.log('Done. Open documentation/model-response-report.html or documentation/model-response-report-bn.html in your browser.');
}

main().catch((error) => {
  console.error('Report generation failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

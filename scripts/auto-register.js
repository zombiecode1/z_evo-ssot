#!/usr/bin/env node
const path = require('path');

const dirArg = process.argv[2] || process.cwd();
const server = process.env.PROXI_URL || 'http://localhost:9999';
const user_id = process.env.AUTO_REG_USER || 'local-auto-user';
const workspace_id = process.env.AUTO_REG_WORKSPACE || 'local-auto-workspace';

const dir = path.resolve(dirArg);

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; } catch { return { ok: res.ok, status: res.status, body: text }; }
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  }
}

(async () => {
  console.log('Auto-register script');
  console.log('Directory:', dir);
  console.log('Server:', server);

  // 1) Request set directory
  console.log('\n1) Setting working directory...');
  const setRes = await postJson(`${server}/v1/agent/directory`, { directory: dir });
  console.log('Response:', setRes.status, JSON.stringify(setRes.body, null, 2));

  const needsPerm = setRes.body && setRes.body.requiresPermission;
  if (!setRes.ok && !needsPerm) {
    console.error('Failed to set directory. Aborting.');
    process.exit(1);
  }

  // 2) If permission required, grant it
  if (needsPerm) {
    console.log('\n2) Granting permission (scan) for the directory...');
    const grantBody = {
      grant: true,
      scope: 'scan',
      user_id,
      workspace_id,
      directory: dir,
    };
    const grantRes = await postJson(`${server}/v1/agent/permission`, grantBody);
    console.log('Grant response:', grantRes.status, JSON.stringify(grantRes.body, null, 2));
    if (!grantRes.ok && grantRes.status !== 200) {
      console.error('Permission grant failed. Aborting.');
      process.exit(1);
    }
  }

  // 3) Re-call set directory including user/workspace context so watcher starts
  console.log('\n3) Re-setting working directory (with user/workspace) to start watcher...');
  const setRes2 = await postJson(`${server}/v1/agent/directory`, { directory: dir, user_id, workspace_id });
  console.log('Response:', setRes2.status, JSON.stringify(setRes2.body, null, 2));

  // 4) Fetch SSOT
  console.log('\n4) Fetching SSOT content (if any)...');
  try {
    const ssotRes = await fetch(`${server}/v1/agent/ssot`);
    const ssotText = await ssotRes.text();
    if (ssotRes.ok && ssotText && ssotText.length > 0) {
      console.log('SSOT length:', ssotText.length);
      console.log('\nSSOT preview (first 800 chars):\n');
      console.log(ssotText.slice(0, 800));
    } else {
      console.warn('No SSOT available or error fetching SSOT:', ssotRes.status);
    }
  } catch (e) {
    console.error('Failed to fetch SSOT:', e);
  }

  console.log('\nDone.');
})();

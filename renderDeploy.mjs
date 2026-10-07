const KEY = process.env.RENDER_API_KEY;
const base = 'https://api.render.com/v1';
const h = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const svcId = 'srv-db2jtf7avr4c73eapt9g';

async function req(p, method = 'GET', body) {
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  console.log(`\n[${method} ${p}] status=${r.status}`);
  try { console.log(JSON.stringify(JSON.parse(t), null, 2).slice(0, 2000)); } catch { console.log(t.slice(0, 500)); }
  return r.status;
}

// 1. Get service details (see what branch/commit the live deploy is on)
await req(`/services/${svcId}`);

// 2. Ensure DB_BACKEND=mongo and that the SQLite DATABASE_URL does not mislead the
//    default-resolution (set it explicitly), keep existing AI keys.
const envBody = [
  { key: 'DB_BACKEND', value: 'mongo' },
  { key: 'DATABASE_URL', value: 'sqlite:./data/papertrader.db' },
  { key: 'CLEAR_DB_PASSWORD', value: process.env.CLEAR_DB_PASSWORD || 'clearpaper2026' },
];
for (const e of envBody) {
  await req(`/services/${svcId}/env-vars/${e.key}`, 'PUT', { value: e.value });
}

// 3. Force a fresh deploy from the current main branch.
await req(`/services/${svcId}/deploys`, 'POST', {});

const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.log('RENDER_API_KEY required'); process.exit(1); }
const base = 'https://api.render.com/v1';
const h = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(p) {
  const r = await fetch(base + p, { headers: h });
  if (!r.ok) console.log('GET', p, '->', r.status, await r.text());
  return r.json();
}

// 1. List services
const svcs = await get('/services');
const list = Array.isArray(svcs) ? svcs : (svcs.services || []);
console.log('=== services ===');
for (const s of list) {
  const svc = s.service || s;
  console.log(svc.name, '| id:', svc.id, '| type:', svc.type, '| branch:', svc.branch, '| repo:', svc.repo, '| autoDeploy:', JSON.stringify(svc.autoDeploy));
}
const svc = list.find((s) => /paper/i.test((s.service?.name || s.name || ''))) || list[0];
const svcId = (svc.service ? svc.service : svc).id;
const svcName = (svc.service ? svc.service.name : svc.name);
console.log('\n=== chosen service ===', svcName, svcId);

// 2. Env vars: show which expected keys are set (redact values)
const env = await get(`/services/${svcId}/env-vars`);
const ev = Array.isArray(env) ? env : (env.envVars || []);
const map = new Map();
for (const e of ev) {
  const e2 = e.envVar ? e.envVar : e;
  map.set(e2.key, e2.value);
}
console.log('\n=== env vars ===');
for (const [k, v] of map) {
  const secret = /key|secret|token|password|uri/i.test(k);
  console.log(`${k} = ${secret ? (v ? '<set:' + String(v).slice(-4) + '>' : '<empty>') : JSON.stringify(v)}`);
}
const need = ['DB_BACKEND', 'DATABASE_URL', 'MONGODB_URI', 'MONGODB_DB',
  'SYSTEM1_PROVIDER', 'SYSTEM1_GATE_MODE', 'SYSTEM1_MODEL',
  'SYSTEM1_API_KEY', 'SYSTEM1_GEMINI_API_KEY', 'SYSTEM1_POOLSIDE_API_KEY',
  'GROQ_API_KEY', 'GEMINI_API_KEY', 'POOLSIDE_API_KEY'];
console.log('\n=== expected AI/DB keys present? ===');
for (const k of need) console.log(`${k}: ${map.has(k) ? 'SET' : 'MISSING'}`);

// 3. Latest deploys
const deps = await get(`/services/${svcId}/deploys?limit=5`);
const dlist = Array.isArray(deps) ? deps : (deps.deploys || []);
console.log('\n=== recent deploys ===');
for (const d of dlist) console.log({ id: d.id||d.deploy?.id, status: d.status||d.deploy?.status, commitId: (d.commitId||d.commit?.id||''), created: d.createdAt });

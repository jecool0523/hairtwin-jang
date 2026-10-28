import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PNG } = require('../server/node_modules/pngjs');
const base = process.argv[2] ?? 'https://hairtwin-jang.vercel.app';
const owners = [];
let token = '';
async function request(path, body, auth = token) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(path + ': HTTP ' + response.status + ' returned a non-JSON response.'); }
  return { status: response.status, bytes: Buffer.byteLength(text), ...json };
}
try {
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/customers', undefined, '')).status, 401);
  const name = '배포확인-' + randomUUID().slice(0, 12), password = randomUUID();
  const registered = await request('/auth/register', { name, password }, '');
  assert.equal(registered.status, 201);
  owners.push(registered.data.designer.id);
  token = registered.data.token;
  assert.equal((await request('/auth/login', { name, password: 'wrong-password' }, '')).status, 401);
  assert.equal((await request('/auth/login', { name, password }, '')).status, 200);
  assert.equal((await request('/auth/me')).data.designer.id, owners[0]);
  const customer = await request('/customers', { name: '상담저장 확인' });
  assert.equal(customer.status, 201);

  // A noisy 512px image produces an aggregate result well beyond Vercel's
  // buffered JSON limit. Separate media transfers must keep that result small.
  const png = new PNG({ width: 512, height: 512 });
  randomBytes(png.data.length).copy(png.data);
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  const photo = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const uploaded = await request('/media', { image: photo });
  assert.equal(uploaded.status, 200);
  const reference = uploaded.data.reference;
  assert.match(reference, /^media:[a-f0-9]{64}$/);
  const input = {
    requestId: randomUUID(), customerName: customer.data.name, intent: '배포 검증',
    photos: { front: reference, side: reference, back: reference },
    presetId: 'layered', preset: { id: 'layered', name: '레이어드', desc: '' },
    condition: { damage: '건강', texture: '직모', thickness: '보통', density: '보통', elasticity: '보통', feel: '보통' },
    bang: 45, sideLength: 50, sideHair: '조금 뜸',
  };
  const generated = await request('/ai/generate', input);
  assert.equal(generated.status, 200);
  assert.equal(generated.data.candidates.length, 3);
  assert.ok(generated.bytes < 20000);
  const imagePath = generated.data.candidates[0].views.front;
  const image = await fetch(base + imagePath);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  await image.arrayBuffer();
  const badUrl = new URL(imagePath, base);
  badUrl.searchParams.set('signature', '0'.repeat(64));
  assert.equal((await fetch(badUrl)).status, 404);
  const edited = await request('/ai/edit', {
    requestId: randomUUID(), sessionId: generated.data.sessionId,
    baseVersionId: generated.data.versions[0].id, view: 'front', region: null,
    condition: input.condition, bang: 60, sideLength: 65, sideHair: '조금 뜸', feedback: [], freeText: '확인',
  });
  assert.equal(edited.status, 200);
  const saved = await request('/records', {
    customerName: customer.data.name, views: generated.data.candidates[0].views,
    sessionId: generated.data.sessionId, selectedVersionId: edited.data.version.id,
  });
  assert.equal(saved.status, 201);
  assert.equal((await request('/records/' + saved.data.id)).data.selectedVersionId, edited.data.version.id);
  assert.equal((await request('/customers')).data[0].historyCount, 1);
  const other = await request('/auth/register', { name: '소유권확인-' + randomUUID().slice(0, 12), password: randomUUID() }, '');
  assert.equal(other.status, 201);
  owners.push(other.data.designer.id);
  assert.equal((await request('/ai/generate', { ...input, requestId: randomUUID() }, other.data.token)).status, 404);
  assert.equal((await request('/records/' + saved.data.id, undefined, other.data.token)).status, 404);
  console.log(JSON.stringify({ status: 'PASS', checks: ['health', 'registration', 'password-login', 'authorization', 'individual-photo-upload', 'large-generation-result', 'signed-images', 'image-edit', 'persistent-consultation', 'owner-isolation'], generationResponseBytes: generated.bytes }));
} finally {
  const { initializeDatabase, transaction, closeDb } = await import('../server/src/db/database.ts');
  await initializeDatabase();
  for (const id of owners) await transaction(async db => {
    await db.prepare('DELETE FROM consultation_records WHERE designer_id = ?').run(id);
    await db.prepare('DELETE FROM ai_versions WHERE session_id IN (SELECT id FROM ai_sessions WHERE designer_id = ?)').run(id);
    await db.prepare('DELETE FROM ai_sessions WHERE designer_id = ?').run(id);
    await db.prepare('DELETE FROM presets WHERE designer_id = ?').run(id);
    await db.prepare('DELETE FROM customers WHERE designer_id = ?').run(id);
    await db.prepare('DELETE FROM designers WHERE id = ?').run(id);
  });
  await closeDb();
}

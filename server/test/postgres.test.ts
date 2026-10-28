import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';

test('PostgreSQL preserves authenticated consultations across database reconnection', {
  skip: !process.env.RUN_POSTGRES_TESTS,
}, async () => {
  process.env.AUTH_PROVIDER = 'real';
  process.env.AI_PROVIDER = 'mock';
  const { initializeDatabase, getDb, transaction, closeDb } = await import('../src/db/database.js');
  const auth = await import('../src/services/auth.service.js');
  const customers = await import('../src/services/customer.service.js');
  const presets = await import('../src/services/preset.service.js');
  const ai = await import('../src/services/ai.service.js');
  const records = await import('../src/services/record.service.js');
  await initializeDatabase();
  let designerId = '';
  try {
    const name = '배포검증-' + randomUUID().slice(0, 15);
    const password = randomUUID();
    const account = await auth.register({ name, password });
    designerId = account.designer.id;
    assert.equal((await auth.login({ name, password })).designer.id, designerId);
    await assert.rejects(auth.login({ name, password: 'incorrect-password' }));
    const customer = await customers.createCustomer(designerId, { name: '영구저장 검증 고객' });
    const preset = await presets.createPreset(designerId, { name: '검증 레이어드' });
    assert.equal((await presets.getPreset(designerId, preset.id)).name, '검증 레이어드');
    const png = new PNG({ width: 32, height: 32 });
    png.data.fill(180);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    const photo = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
    const condition = { damage: '건강', texture: '직모', thickness: '보통', density: '보통', elasticity: '보통', feel: '보통' };
    const generated = await ai.generate(designerId, {
      requestId: randomUUID(), customerName: customer.name, intent: '검증',
      photos: { front: photo, side: photo, back: photo }, presetId: preset.id,
      preset: { id: preset.id, name: preset.name, desc: '' }, condition,
      bang: 45, sideLength: 50, sideHair: '조금 뜸',
    });
    assert.equal(generated.candidates.length, 3);
    const { compactImages, resolveImages, imageLinks } = await import('../src/services/media.service.js');
    const reference = await compactImages(designerId, photo);
    assert.match(reference, /^media:[a-f0-9]{64}$/);
    assert.equal(await resolveImages(designerId, reference), photo);
    await assert.rejects(resolveImages('different-owner', reference));
    const links = await imageLinks(designerId, generated);
    assert.ok(JSON.stringify(links).length < 15000);
    assert.match(links.candidates[0].views.front, /^\/api\/media\//);
    const edited = await ai.edit(designerId, {
      requestId: randomUUID(), sessionId: generated.sessionId,
      baseVersionId: generated.versions[0].id, view: 'front', region: null,
      bang: 60, sideLength: 65, sideHair: '조금 뜸', condition, feedback: [], freeText: '검증',
    });
    const record = await records.createRecord(designerId, {
      customerName: customer.name, views: generated.candidates[0].views,
      sessionId: generated.sessionId, selectedVersionId: edited.version.id,
    });
    assert.equal(record.customerId, customer.id);
    await assert.rejects(transaction(async db => {
      await db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('롤백되어야 함', customer.id);
      throw new Error('rollback probe');
    }));
    await closeDb();
    await initializeDatabase();
    assert.equal((await customers.getCustomer(designerId, customer.id)).name, customer.name);
    assert.equal((await customers.getCustomer(designerId, customer.id)).historyCount, 1);
    assert.equal((await records.getRecord(designerId, record.id)).selectedVersionId, edited.version.id);
    assert.equal((await ai.getSession(designerId, generated.sessionId)).versions.length, 4);
  } finally {
    if (designerId) await transaction(async db => {
      await db.prepare('DELETE FROM consultation_records WHERE designer_id = ?').run(designerId);
      await db.prepare('DELETE FROM ai_versions WHERE session_id IN (SELECT id FROM ai_sessions WHERE designer_id = ?)').run(designerId);
      await db.prepare('DELETE FROM ai_sessions WHERE designer_id = ?').run(designerId);
      await db.prepare('DELETE FROM presets WHERE designer_id = ?').run(designerId);
      await db.prepare('DELETE FROM customers WHERE designer_id = ?').run(designerId);
      await db.prepare('DELETE FROM designers WHERE id = ?').run(designerId);
    });
    await closeDb();
  }
});

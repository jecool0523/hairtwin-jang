import { buildApp } from '../server/dist/app.js';
import { initializeDatabase } from '../server/dist/db/database.js';

const app = buildApp();
export default async function handler(req, res) {
  try { await initializeDatabase(); }
  catch (error) {
    console.error('database.initialization.failed', { code: error?.code });
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: { code: 'DATABASE_UNAVAILABLE', message: '데이터베이스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.' } }));
    return;
  }
  return app(req, res);
}

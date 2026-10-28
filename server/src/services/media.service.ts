import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getDb, type DatabaseSync } from '../db/database.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../utils/http.js';
import { readPng } from '../providers/image/png.js';

export const mediaEnabled = Boolean(process.env.DATABASE_URL || process.env.VERCEL);
const reference = /^media:([a-f0-9]{64})$/;

async function mapStrings(value: any, transform: (value: string) => Promise<string>): Promise<any> {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return Promise.all(value.map(item => mapStrings(item, transform)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await mapStrings(item, transform)]));
    return Object.fromEntries(entries);
  }
  return value;
}

// Images are deduplicated per owner and kept once, instead of being repeated in
// every candidate, version and JSON response. No temporary filesystem is used.
export async function compactImages<T>(designerId: string, value: T, db: DatabaseSync = getDb()): Promise<T> {
  if (!mediaEnabled) return value;
  const pending = new Map<string, Promise<string>>();
  return mapStrings(value, image => {
    if (!image.startsWith('data:image/png;base64,')) return Promise.resolve(image);
    const id = createHash('sha256').update(designerId).update(image).digest('hex');
    if (!pending.has(id)) pending.set(id, (async () => {
      await db.prepare('INSERT INTO media (id, designer_id, data_url) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(id, designerId, image);
      return 'media:' + id;
    })());
    return pending.get(id)!;
  });
}

export async function resolveImages<T>(designerId: string, value: T): Promise<T> {
  const pending = new Map<string, Promise<string>>();
  return mapStrings(value, image => {
    const match = image.match(reference);
    if (!match) return Promise.resolve(image);
    const id = match[1];
    if (!pending.has(id)) pending.set(id, (async () => {
      const row = await getDb().prepare('SELECT data_url FROM media WHERE id = ? AND designer_id = ?').get(id, designerId);
      if (!row) throw notFound('사진을 찾을 수 없습니다. 다시 선택해주세요.');
      return row.data_url;
    })());
    return pending.get(id)!;
  });
}

function signature(id: string, expires: string): string {
  return createHmac('sha256', config.jwtSecret).update('image:' + id + ':' + expires).digest('hex');
}

export async function imageLinks<T>(designerId: string, value: T): Promise<T> {
  const compact = await compactImages(designerId, value);
  const expires = String(Math.floor(Date.now() / 1000) + 7 * 86400);
  return mapStrings(compact, async image => {
    const match = image.match(reference);
    return match ? '/api/media/' + match[1] + '?expires=' + expires + '&signature=' + signature(match[1], expires) : image;
  });
}

export async function uploadMedia(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const image = req.body?.image;
    if (typeof image !== 'string' || image.length > 4_000_000) throw badRequest('사진 한 장은 4MB 이하로 준비해주세요.');
    readPng(image);
    const id = (req as Request & { designerId: string }).designerId;
    res.json({ ok: true, data: { reference: await compactImages(id, image) } });
  } catch (error) { next(error); }
}

export async function serveMedia(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const expires = String(req.query.expires ?? '');
    const supplied = String(req.query.signature ?? '');
    if (!/^[a-f0-9]{64}$/.test(id) || !/^\d{10}$/.test(expires) || Number(expires) < Date.now() / 1000 || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(id, expires), 'hex'))) throw notFound('사진 링크가 만료되었거나 올바르지 않습니다.');
    const row = await getDb().prepare('SELECT data_url FROM media WHERE id = ?').get(id);
    if (!row) throw notFound('사진을 찾을 수 없습니다.');
    const data = Buffer.from(row.data_url.split(',')[1], 'base64');
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    // Streaming also supports a large model output without buffering JSON copies.
    for (let offset = 0; offset < data.length; offset += 65536) res.write(data.subarray(offset, offset + 65536));
    res.end();
  } catch (error) { next(error); }
}

export function mediaTransport(req: Request, res: Response, next: NextFunction): void {
  if (!mediaEnabled) { next(); return; }
  const originalJson = res.json.bind(res);
  res.json = body => {
    const designerId = (req as Request & { designerId?: string }).designerId;
    if (!designerId || !body?.ok) return originalJson(body);
    // Upload references must stay opaque until they are submitted to the API.
    if (req.method === 'POST' && req.path === '/media') return originalJson(body);
    void imageLinks(designerId, body).then(result => originalJson(result)).catch(error => {
      res.json = originalJson;
      next(error);
    });
    return res;
  };
  next();
}

export async function resolveMediaBody(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const designerId = (req as Request & { designerId?: string }).designerId;
    if (mediaEnabled && designerId && req.body) req.body = await resolveImages(designerId, req.body);
    next();
  } catch (error) { next(error); }
}

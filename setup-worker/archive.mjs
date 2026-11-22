import { DurableObject } from 'cloudflare:workers';

const models = { gemini: 'gemini-3.5-flash-lite', openai: 'gpt-6-luna' };
const encoder = new TextEncoder();
const maxRows = 20000;

export async function validateRecord(row) {
  if (!row || row.game !== 'gta-6' || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) ||
      typeof row.english !== 'string' || !row.english.trim() || row.english.length > 1440 ||
      typeof row.turkish !== 'string' || !row.turkish.trim() || row.turkish.length > 2880 ||
      !Number.isFinite(row.confidence) || row.confidence < 72 || row.confidence > 100 ||
      !Object.hasOwn(models, row.provider) || models[row.provider] !== row.model ||
      !Number.isSafeInteger(row.createdAt) || row.createdAt < 1577836800000 || row.createdAt > Date.now() + 300000) return null;
  const value = JSON.stringify([1, row.game, row.english, row.turkish, row.provider, row.model]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== row.id) return null;
  // Explicitly select fields: API keys and arbitrary client properties are never stored.
  return { id: row.id, game: row.game, english: row.english, turkish: row.turkish,
    provider: row.provider, model: row.model, confidence: row.confidence, createdAt: row.createdAt };
}

export class TranslationArchive extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS candidates (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL, game TEXT NOT NULL,
      english TEXT NOT NULL, turkish TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, confidence REAL NOT NULL,
      captured_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'unreviewed'
    )`);
  }
  save(rows) {
    // A synchronous transaction keeps the batch and capacity check atomic.
    return this.ctx.storage.transactionSync(() => {
      const [{ count }] = this.sql.exec('SELECT COUNT(*) AS count FROM candidates').toArray();
      const newIds = new Set(rows.filter(row => !this.sql.exec('SELECT id FROM candidates WHERE id = ?', row.id).toArray().length).map(row => row.id));
      if (count + newIds.size > maxRows) return { status: 507 };
      for (const row of rows) this.sql.exec(`INSERT OR IGNORE INTO candidates
        (id, game, english, turkish, provider, model, confidence, captured_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.game, row.english, row.turkish,
        row.provider, row.model, row.confidence, row.createdAt, Date.now());
      return { status: 200, data: { saved: rows.map(row => row.id) } };
    });
  }
  export(after, limit, through) {
    const [{ last }] = this.sql.exec('SELECT COALESCE(MAX(sequence), 0) AS last FROM candidates').toArray();
    const snapshot = through === null ? last : Math.min(through, last);
    const rows = this.sql.exec(`SELECT * FROM candidates WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`,
      after, snapshot, limit).toArray();
    const next = rows.length ? rows[rows.length - 1].sequence : after;
    return { format: 1, reviewRequired: true, through: snapshot, records: rows,
      next: next < snapshot ? next : null };
  }
}

export async function archiveRequest(request, env, readJson, response) {
  const method = request.method;
  if (!['POST', 'GET'].includes(method)) return response(405);
  const secret = method === 'POST' ? env.TRANSLATION_WRITE_TOKEN : env.TRANSLATION_READ_TOKEN;
  const supplied = request.headers.get('Authorization') || '';
  if (!secret || !/^[0-9a-f]{64}$/.test(secret) || !/^Bearer [0-9a-f]{64}$/.test(supplied) ||
      !crypto.subtle.timingSafeEqual(encoder.encode(secret), encoder.encode(supplied.slice(7)))) return response(403);
  const archive = env.TRANSLATION_ARCHIVE.getByName('gta-6-review-v1');
  if (method === 'GET') {
    const params = new URL(request.url).searchParams;
    const after = params.get('after') || '0', limit = params.get('limit') || '200', through = params.get('through');
    if (![after, limit].every(value => /^\d{1,10}$/.test(value)) || Number(limit) < 1 || Number(limit) > 200 ||
        (through !== null && !/^\d{1,10}$/.test(through))) return response(400);
    return response(200, await archive.export(Number(after), Number(limit), through === null ? null : Number(through)));
  }
  const { success } = await env.ARCHIVE_LIMIT.limit({ key: 'archive-write' });
  if (!success) return response(429);
  let body;
  try { body = await readJson(request.body, 65536); } catch { return response(400); }
  if (!body || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 4) return response(400);
  const rows = await Promise.all(body.records.map(validateRecord));
  if (rows.some(row => !row)) return response(400);
  const saved = await archive.save(rows);
  return response(saved.status, saved.data);
}

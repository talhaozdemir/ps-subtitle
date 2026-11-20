import { DurableObject } from 'cloudflare:workers';

const lifetime = 5 * 60 * 1000;
const hashPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function response(status, data) {
  const headers = { 'Cache-Control': 'no-store' };
  return data ? Response.json(data, { status, headers }) : new Response(null, { status, headers });
}

async function digest(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(body) {
  if (!body) throw new Error('Missing body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > 8300) throw new Error('Body too large');
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function validHash(stored, supplied) {
  return crypto.subtle.timingSafeEqual(encoder.encode(stored), encoder.encode(supplied));
}

export class SetupSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      read_hash TEXT NOT NULL,
      upload_hash TEXT NOT NULL,
      expires INTEGER NOT NULL,
      iv TEXT,
      ciphertext TEXT
    )`);
  }

  getSession() {
    const [session] = this.sql.exec('SELECT * FROM session WHERE id = 1').toArray();
    return session && session.expires > Date.now() ? session : null;
  }

  async create(readHash, uploadHash) {
    const existing = this.getSession();
    if (existing) {
      return validHash(existing.read_hash, readHash) && validHash(existing.upload_hash, uploadHash) ? 201 : 409;
    }
    const expires = Date.now() + lifetime;
    await this.ctx.storage.setAlarm(expires);
    this.sql.exec('DELETE FROM session WHERE expires <= ?', Date.now());
    const added = this.sql.exec(
      'INSERT OR IGNORE INTO session (id, read_hash, upload_hash, expires) VALUES (1, ?, ?, ?)',
      readHash, uploadHash, expires
    );
    if (added.rowsWritten) return 201;
    const concurrent = this.getSession();
    return concurrent && validHash(concurrent.read_hash, readHash) && validHash(concurrent.upload_hash, uploadHash) ? 201 : 409;
  }

  upload(tokenHash, envelope) {
    const session = this.getSession();
    if (!session || !validHash(session.upload_hash, tokenHash)) return 404;
    if (session.ciphertext) {
      return session.iv === envelope.iv && session.ciphertext === envelope.ciphertext ? 204 : 409;
    }
    this.sql.exec('UPDATE session SET iv = ?, ciphertext = ? WHERE id = 1', envelope.iv, envelope.ciphertext);
    return 204;
  }

  read(tokenHash) {
    const session = this.getSession();
    if (!session || !validHash(session.read_hash, tokenHash)) return { status: 404 };
    if (!session.ciphertext) return { status: 204 };
    return { status: 200, data: { iv: session.iv, ciphertext: session.ciphertext } };
  }

  async close(tokenHash) {
    const session = this.getSession();
    if (!session || !validHash(session.read_hash, tokenHash)) return 404;
    this.sql.exec('DELETE FROM session WHERE id = 1');
    await this.ctx.storage.deleteAlarm();
    return 204;
  }

  async alarm() {
    const session = this.getSession();
    if (session) await this.ctx.storage.setAlarm(session.expires);
    else this.sql.exec('DELETE FROM session WHERE id = 1');
  }
}

export default {
  async fetch(request, env) {
    const match = /^\/api\/setup\/([0-9a-f]{32})$/.exec(new URL(request.url).pathname);
    if (!match) return response(404);
    const method = request.method;
    if (!['POST', 'PUT', 'GET', 'DELETE'].includes(method)) return response(405);
    const token = request.headers.get('Authorization') || '';
    if (!/^Bearer [0-9a-f]{64}$/.test(token)) return response(404);
    try {
      const session = env.SETUP_SESSIONS.getByName(match[1]);
      const hash = await digest(token.slice(7));
      if (method === 'GET') {
        const result = await session.read(hash);
        return response(result.status, result.data);
      }
      if (method === 'DELETE') return response(await session.close(hash));

      let body;
      try { body = await readJson(request.body); } catch { return response(400); }
      if (method === 'POST') {
        if (!body || typeof body.uploadHash !== 'string' || !hashPattern.test(body.uploadHash)) return response(400);
        const { success } = await env.SETUP_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'setup' });
        return response(success ? await session.create(hash, body.uploadHash) : 429);
      }
      if (!body || typeof body.iv !== 'string' || !/^[0-9a-f]{24}$/.test(body.iv) ||
          typeof body.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){17,4096}$/.test(body.ciphertext)) {
        return response(400);
      }
      return response(await session.upload(hash, body));
    } catch {
      console.error({ event: 'setup_request_failed', method });
      return response(503);
    }
  }
};

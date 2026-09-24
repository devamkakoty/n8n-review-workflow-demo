import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { planReviewBatch } from './planner.mjs';

export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 64 * 1024;
export const BODY_TIMEOUT_MS = 5000;
const HOST = '127.0.0.1';

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chunks.length = 0;
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new RequestError(408, 'body_timeout'));
    }, BODY_TIMEOUT_MS);
    timer.unref();
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new RequestError(413, 'body_too_large'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (done) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(chunks));
        finish(null, JSON.parse(text));
      } catch {
        finish(new RequestError(400, 'invalid_json'));
      }
    });
    req.on('aborted', () => finish(new RequestError(400, 'request_aborted')));
    req.on('error', () => finish(new RequestError(400, 'request_aborted')));
  });
}

function reply(res, status, body, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Connection': 'close',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * Starts one synthetic-only server with a private, hash/ID-only memory ledger.
 * No host option, external calls, disk writes, approval or action execution.
 * Port 0 is for tests. Local processes are trusted; this is not an auth boundary.
 */
export async function startReviewServer({ port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('invalid_port');
  }
  let ledger = {};
  const server = http.createServer({
    maxHeaderSize: 8192,
    headersTimeout: 10000,
    requestTimeout: 10000,
  }, async (req, res) => {
    // Reject browser origins and nonliteral hosts; no CORS or browser UI.
    if (req.socket.remoteAddress !== HOST ||
        req.headers.host !== `${HOST}:${req.socket.localPort}` ||
        req.headers.origin !== undefined) {
      req.resume();
      return reply(res, 403, { error: 'local_requests_only' });
    }
    if (req.url !== '/health' && req.url !== '/plan') {
      req.resume();
      return reply(res, 404, { error: 'not_found' });
    }
    const method = req.url === '/health' ? 'GET' : 'POST';
    if (req.method !== method) {
      req.resume();
      return reply(res, 405, { error: 'method_not_allowed' }, { Allow: method });
    }
    if (req.url === '/health') {
      req.resume();
      return reply(res, 200, { status: 'ok', mode: 'synthetic_review_only' });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
        req.headers['content-encoding'] !== undefined) {
      req.resume();
      return reply(res, 415, { error: 'unsupported_media_type' });
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume();
      return reply(res, 413, { error: 'body_too_large' });
    }
    try {
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          !Object.hasOwn(input, 'notes') ||
          Object.keys(input).some((key) => !['notes', 'enabled'].includes(key))) {
        throw new RequestError(400, 'invalid_request');
      }
      let output;
      try {
        output = planReviewBatch({ ...input, ledger });
      } catch (error) {
        if (error instanceof TypeError) throw new RequestError(400, 'invalid_request');
        throw error;
      }
      ledger = output.ledger;
      // Do not expose a caller-replaceable ledger or a reset/execute endpoint.
      reply(res, 200, { results: output.results, summary: output.summary });
    } catch (error) {
      reply(res, error instanceof RequestError ? error.status : 500, {
        error: error instanceof RequestError ? error.message : 'internal_error',
      });
    }
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startReviewServer({
      port: process.env.PORT === undefined ? DEFAULT_PORT : Number(process.env.PORT),
    });
    console.log(`Synthetic review wrapper: http://${HOST}:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close();
        server.closeAllConnections();
      });
    }
  } catch {
    console.error('Wrapper startup failed: check PORT and whether it is already in use.');
    process.exitCode = 1;
  }
}

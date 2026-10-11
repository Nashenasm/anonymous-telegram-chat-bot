import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import webhook, { coinRushApi, ensureCoinRushRuntimeSchema, duelApi, ensureDuelRuntimeSchema } from './api/webhook.js';
import mandatoryJobs from './api/mandatory-jobs.js';
import cryptoJobs from './api/crypto-jobs.js';
import mandatoryTrack from './api/mandatory-track.js';

const port = Number(process.env.PORT || 3000);
const maxBody = 1024 * 1024;

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'anonymous-telegram-chat' }));
  }
  if (req.method === 'GET' && requestUrl.pathname === '/game/coin-rush.html') {
    try {
      const html = await fs.readFile(path.join(process.cwd(), 'game', 'coin-rush.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (error) {
      console.error('game_file_error', error?.message || error);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('game_not_found');
    }
  }
  if (req.method === 'GET' && requestUrl.pathname === '/game/duel.html') {
    try {
      const html = await fs.readFile(path.join(process.cwd(), 'game', 'duel.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (error) {
      console.error('duel_game_file_error', error?.message || error);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('game_not_found');
    }
  }
  const duelUrl = requestUrl;
  if (duelUrl.pathname.startsWith('/api/game/')) {
    try { await ensureDuelRuntimeSchema(); } catch (error) { console.error('duel_schema_error', error?.message || error); res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'game_unavailable' })); }
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > maxBody) break; }
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); }
    }
    try { return await duelApi({ method: req.method, query: Object.fromEntries(duelUrl.searchParams), body }, res); }
    catch (error) { console.error('duel_api_error', error?.message || error); res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: error?.message || 'game_error' })); }
  }
  if (requestUrl.pathname.startsWith('/api/coin-rush/')) {
    try { await ensureCoinRushRuntimeSchema(); } catch (error) { console.error('coin_rush_schema_error', error?.message || error); res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'game_unavailable' })); }
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > maxBody) break; }
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); }
    }
    try { return await coinRushApi({ method: req.method, query: Object.fromEntries(requestUrl.searchParams), body }, res); }
    catch (error) { console.error('coin_rush_api_error', error?.message || error); res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'game_error' })); }
  }
  if (req.url === '/api/mandatory-jobs') {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { res.writeHead(this.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); },
    };
    try { await mandatoryJobs({ method: req.method, headers: req.headers }, response); }
    catch (error) { console.error('mandatory_jobs_server_error', error?.message || error); if (!res.writableEnded) { res.writeHead(500); res.end(JSON.stringify({ ok: false })); } }
    return;
  }
  if (req.url === '/api/crypto-jobs') {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { res.writeHead(this.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); },
    };
    try { await cryptoJobs({ method: req.method, headers: req.headers }, response); }
    catch (error) { console.error('crypto_jobs_server_error', error?.message || error); if (!res.writableEnded) { res.writeHead(500); res.end(JSON.stringify({ ok: false })); } }
    return;
  }
  if (requestUrl.pathname === '/api/mandatory-track') {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      send(body) { res.writeHead(this.statusCode, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(body)); },
      redirect(code, target) { res.writeHead(code, { location: target }); res.end(); },
      setHeader(name, value) { res.setHeader(name, value); },
    };
    try { await mandatoryTrack({ method: req.method, query: Object.fromEntries(requestUrl.searchParams) }, response); }
    catch (error) { console.error('mandatory_track_server_error', error?.message || error); if (!res.writableEnded) { res.writeHead(500); res.end('tracking failed'); } }
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/webhook') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  }
  let body = ''; let tooLarge = false;
  for await (const chunk of req) { body += chunk; if (body.length > maxBody) tooLarge = true; }
  if (tooLarge) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'payload_too_large' })); }
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); }
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { res.writeHead(this.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); },
  };
  try { await webhook({ method: req.method, headers: req.headers, body: parsed }, response); }
  catch (error) { console.error('server_error', error); if (!res.writableEnded) { res.writeHead(500); res.end(JSON.stringify({ ok: false })); } }
});
server.listen(port, '0.0.0.0', () => console.log(`anonymous-telegram-chat listening on ${port}`));

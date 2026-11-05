/**
 * Schutz vor öffentlich abrufbaren Dateien:
 * - Sicherheits-Header (nosniff, Referrer-Policy, HSTS nur über HTTPS) auf allen Antworten der Anwendung.
 * - Der Ordner public/ (Dokumentenstamm in Plesk) enthält nur unbedenkliche Dateien.
 * - Das Prüfskript (npm run pruefe:oeffentlich) erkennt öffentlich ausgelieferte Projektdateien.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-oeffentlich-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-oeffentliche-dateien-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const PROJEKT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildApp } = await import('../app.js');
const { findeOeffentliche, PFADE } = await import('../scripts/pruefe-oeffentliche-dateien.js');
const fastify = await buildApp({ logger: false });

test('Sicherheits-Header auf Seiten und statischen Dateien; HSTS nur über HTTPS', async () => {
  for (const url of ['/login', '/static/css/app.css']) {
    const r = await fastify.inject({ url, headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(r.headers['referrer-policy'], 'same-origin', url);
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000', url);
  }
  const ohneTls = await fastify.inject({ url: '/login' });
  assert.equal(ohneTls.headers['strict-transport-security'], undefined, 'kein HSTS über http');
});

test('public/ (Dokumentenstamm) enthält nur unbedenkliche Dateien', () => {
  const dateien = fs.readdirSync(path.join(PROJEKT, 'public'), { recursive: true });
  assert.deepEqual(dateien.sort(), ['robots.txt']);
});

test('Prüfskript: meldet ausgelieferte Projektdateien, nicht aber 404/403', async () => {
  const offen = new Set(['/package.json', '/data/noten.sqlite3']);
  const server = http.createServer((req, res) => {
    if (offen.has(req.url)) { res.writeHead(206); return res.end('x'); }
    res.writeHead(req.url === '/.htaccess' ? 403 : 404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  try {
    const funde = await findeOeffentliche(basis);
    assert.deepEqual(funde.map((f) => f.pfad).sort(), [...offen].sort());
    assert.ok(PFADE.includes('/data/noten.sqlite3.vor-verschluesselung.bak'));
    // Als Kommandozeile: Exit-Code 1 bei Funden, 2 bei falschem Aufruf.
    const lauf = await new Promise((resolve) => {
      const kind = spawn(process.execPath, ['scripts/pruefe-oeffentliche-dateien.js', basis], { cwd: PROJEKT });
      let err = '';
      kind.stderr.on('data', (d) => { err += d; });
      kind.on('exit', (code) => resolve({ code, err }));
    });
    assert.equal(lauf.code, 1);
    assert.match(lauf.err, /\/package\.json/);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(spawnSync(process.execPath, ['scripts/pruefe-oeffentliche-dateien.js'], { cwd: PROJEKT }).status, 2);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

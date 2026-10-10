/**
 * Datensicherung: Einstellungen (Admin), Sicherungslauf in ein Verzeichnis und auf einen WebDAV-Speicher, Aufbewahrung,
 * Planer-Logik, verschlüsselte Sicherungsdatei und Wiederherstellung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-backup-'));
process.env.DB_PFAD = path.join(tempDir, 'daten', 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-backup-bitte-lang-genug-xxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb, DB_ENCRYPTION_KEY, SCHEMA_VERSION } = await import('../src/db.js');
const E = await import('../src/backup/einstellungen.js');
const B = await import('../src/backup/backup.js');
const W = await import('../src/backup/wiederherstellen.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) {
      opts.method = 'POST';
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body);
    }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const admin = client();
const lehrer = client();
const db = () => getDb();
const zielDir = path.join(tempDir, 'ziel');

// ---- einfacher WebDAV-Server (PUT, HEAD, PROPFIND, DELETE) mit Basic-Auth ----
const dav = new Map();
let davGesehen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    davGesehen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Basic ${Buffer.from('bk:geheim').toString('base64')}`) { res.writeHead(401); return res.end(); }
    const name = decodeURIComponent(req.url.replace(/^\/dav\//, '').split('?')[0]);
    if (req.method === 'PUT') { dav.set(name, Buffer.concat(chunks)); res.writeHead(201); return res.end(); }
    if (req.method === 'HEAD') { const d = dav.get(name); res.writeHead(d ? 200 : 404, d ? { 'Content-Length': d.length } : {}); return res.end(); }
    if (req.method === 'DELETE') { dav.delete(name); res.writeHead(204); return res.end(); }
    if (req.method === 'PROPFIND') {
      const eintraege = ['/dav/', ...[...dav.keys()].map((k) => `/dav/${encodeURIComponent(k)}`)];
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${eintraege.map((h) => `<d:response><d:href>${h}</d:href></d:response>`).join('')}</d:multistatus>`);
    }
    res.writeHead(405); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const davUrl = `http://127.0.0.1:${server.address().port}/dav`;

test('Vorbereitung: Admin, Lehrkraft, eine Klasse mit Schüler/in', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await admin('/admin/einladungen/neu', { display_name: 'lehrer', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations').get();
  await lehrer(`/einladung/${inv.token}`, { username: 'lehrer', display_name: 'lehrer', password: 'passwort123', password2: 'passwort123' });
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const k = db().prepare('SELECT id FROM klassen').get().id;
  await admin(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
});

test('Eingaben werden geprüft: Pfad, Adresse, Intervall, Aufbewahrung, Ziel nicht neben der Datenbank', () => {
  const ok = (b) => E.pruefeEingabe({ typ: 'verzeichnis', ziel: zielDir, intervall_stunden: '24', aufbewahren: '5', ...b });
  assert.equal(ok({}).ok, true);
  assert.match(ok({ ziel: 'relativ/pfad' }).fehler, /absoluter Pfad/);
  assert.match(ok({ ziel: path.dirname(process.env.DB_PFAD) }).fehler, /nicht das Verzeichnis der Datenbank/);
  assert.match(ok({ ziel: path.join(process.cwd(), 'static', 'x') }).fehler, /Anwendungsverzeichnis/);
  assert.match(ok({ intervall_stunden: '0' }).fehler, /Intervall/);
  assert.match(ok({ aufbewahren: '0' }).fehler, /Aufbewahrung/);
  assert.match(ok({ typ: 'ftp' }).fehler, /Speichertyp/);
  assert.match(ok({ aktiv: '1', ziel: '' }).fehler, /Ziel/);
  assert.match(E.pruefeEingabe({ typ: 'webdav', ziel: 'kein-link', intervall_stunden: '1', aufbewahren: '1' }).fehler, /gültige WebDAV-Adresse/);
  assert.match(E.pruefeEingabe({ typ: 'webdav', ziel: 'https://u:p@host/x', intervall_stunden: '1', aufbewahren: '1' }).fehler, /eigenen Felder/);
  assert.equal(E.pruefeEingabe({ typ: 'webdav', ziel: 'https://host/dav/', intervall_stunden: '1', aufbewahren: '1' }).werte.ziel, 'https://host/dav', 'Schrägstrich am Ende entfällt');
});

test('Nur die Administration erreicht die Datensicherung', async () => {
  assert.equal((await lehrer('/admin/backup')).status, 403);
  assert.equal((await lehrer('/admin/backup/jetzt', {})).status, 403);
  assert.equal((await lehrer('/admin/backup/herunterladen')).status, 403);
  const r = await admin('/admin/backup');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Datensicherung/);
});

test('Einstellungen speichern: Passwort bleibt verschlüsselt, wird nie angezeigt und bleibt bei leerem Feld erhalten', async () => {
  const r = await admin('/admin/backup', { aktiv: '1', typ: 'webdav', ziel: davUrl, benutzer: 'bk', passwort: 'geheim', intervall_stunden: '6', aufbewahren: '2' });
  assert.equal(r.status, 302);
  const row = db().prepare('SELECT * FROM backup_einstellungen').get();
  assert.ok(row.passwort_verschluesselt && !row.passwort_verschluesselt.includes('geheim'));
  assert.equal(E.ladeEinstellungenMitPasswort().passwort, 'geheim');
  const seite = await (await admin('/admin/backup')).text();
  assert.doesNotMatch(seite, /geheim/);
  assert.match(seite, /gespeichert – leer lassen/);
  await admin('/admin/backup', { aktiv: '1', typ: 'webdav', ziel: davUrl, benutzer: 'bk', passwort: '', intervall_stunden: '6', aufbewahren: '2' });
  assert.equal(E.ladeEinstellungenMitPasswort().passwort, 'geheim', 'leeres Feld behält das Passwort');
});

test('WebDAV: Verbindung testen, sichern, Aufbewahrung räumt auf; Datei ist verschlüsselt und lässt sich nur mit dem Schlüssel öffnen', async () => {
  assert.equal((await B.testeZiel()).ok, true);
  // zwei ältere Sicherungen liegen schon am Ziel
  dav.set('noten-backup-20240101-010101.sqlite3', Buffer.from('alt1'));
  dav.set('noten-backup-20240102-010101.sqlite3', Buffer.from('alt2'));
  dav.set('fremde-datei.txt', Buffer.from('bleibt'));
  const res = await B.fuehreBackupAus('manuell');
  assert.equal(res.ok, true, res.meldung);
  const namen = [...dav.keys()].filter((n) => n.startsWith('noten-backup-')).sort();
  assert.equal(namen.length, 2, 'Aufbewahrung: nur die 2 neuesten bleiben');
  assert.ok(!dav.has('noten-backup-20240101-010101.sqlite3'));
  assert.ok(dav.has('fremde-datei.txt'), 'fremde Dateien bleiben unangetastet');
  const hochgeladen = dav.get(res.dateiname);
  assert.notEqual(hochgeladen.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'keine Klartext-Datenbank');
  const datei = path.join(tempDir, 'aus-dav.sqlite3');
  fs.writeFileSync(datei, hochgeladen);
  const pruef = W.pruefeSicherung(datei, DB_ENCRYPTION_KEY, SCHEMA_VERSION);
  assert.equal(pruef.ok, true);
  assert.equal(pruef.zahlen.klassen, 1);
  assert.equal(pruef.zahlen.schueler, 1);
  assert.match(W.pruefeSicherung(datei, 'falscher-schluessel').fehler, /DB_ENCRYPTION_KEY/);
  const lauf = E.letzteLaeufe(1)[0];
  assert.equal(lauf.ok, 1);
  assert.equal(lauf.ausloeser, 'manuell');
});

test('WebDAV: falsche Zugangsdaten ergeben eine klare Meldung ohne Passwort, der Lauf wird als Fehler protokolliert', async () => {
  await admin('/admin/backup', { aktiv: '1', typ: 'webdav', ziel: davUrl, benutzer: 'bk', passwort: 'falsch', intervall_stunden: '6', aufbewahren: '2' });
  const t = await B.testeZiel();
  assert.equal(t.ok, false);
  assert.match(t.meldung, /Anmeldung abgelehnt/);
  const res = await B.fuehreBackupAus('manuell');
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.meldung, /falsch/);
  assert.equal(E.letzteLaeufe(1)[0].ok, 0);
});

test('Verzeichnis: „Jetzt sichern“ legt eine prüfbare Sicherung ab; Download liefert denselben verschlüsselten Inhalt', async () => {
  await admin('/admin/backup', { aktiv: '1', typ: 'verzeichnis', ziel: zielDir, intervall_stunden: '24', aufbewahren: '3' });
  assert.equal((await admin('/admin/backup/testen', {})).status, 302);
  const r = await admin('/admin/backup/jetzt', {});
  assert.equal(r.status, 302);
  const dateien = fs.readdirSync(zielDir).filter((n) => /^noten-backup-.*\.sqlite3$/.test(n));
  assert.equal(dateien.length, 1);
  assert.equal(W.pruefeSicherung(path.join(zielDir, dateien[0]), DB_ENCRYPTION_KEY).ok, true);
  assert.match(await (await admin('/admin/backup')).text(), new RegExp(dateien[0]));
  const dl = await admin('/admin/backup/herunterladen');
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /noten-backup-\d{8}-\d{6}\.sqlite3/);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.notEqual(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  const datei = path.join(tempDir, 'download.sqlite3');
  fs.writeFileSync(datei, bytes);
  assert.equal(W.pruefeSicherung(datei, DB_ENCRYPTION_KEY).ok, true);
});

test('Verzeichnis nicht beschreibbar: Fehler wird gemeldet und protokolliert', async () => {
  const blockiert = path.join(tempDir, 'datei-statt-ordner');
  fs.writeFileSync(blockiert, 'x');
  await admin('/admin/backup', { aktiv: '1', typ: 'verzeichnis', ziel: path.join(blockiert, 'unter'), intervall_stunden: '24', aufbewahren: '3' });
  const res = await B.fuehreBackupAus('geplant');
  assert.equal(res.ok, false);
  assert.equal(E.letzteLaeufe(1)[0].ausloeser, 'geplant');
  await admin('/admin/backup', { aktiv: '1', typ: 'verzeichnis', ziel: zielDir, intervall_stunden: '24', aufbewahren: '3' });
});

test('Planer: fällig beim ersten Mal, nach Ablauf des Intervalls, nach einem Fehler schon nach einer Stunde; aus = nie', () => {
  const cfg = { aktiv: true, ziel: '/x', intervall_stunden: 24 };
  const jetzt = new Date('2026-10-10T12:00:00Z');
  const vor = (h, ok) => ({ gestartet_at: new Date(jetzt.getTime() - h * 3600_000).toISOString(), ok });
  assert.equal(E.istFaellig(cfg, null, jetzt), true);
  assert.equal(E.istFaellig(cfg, vor(23, 1), jetzt), false);
  assert.equal(E.istFaellig(cfg, vor(25, 1), jetzt), true);
  assert.equal(E.istFaellig(cfg, vor(0.5, 0), jetzt), false, 'Fehler: erst nach einer Stunde erneut');
  assert.equal(E.istFaellig(cfg, vor(1.5, 0), jetzt), true);
  assert.equal(E.istFaellig({ ...cfg, aktiv: false }, null, jetzt), false);
  assert.equal(E.istFaellig({ ...cfg, ziel: '' }, null, jetzt), false);
});

test('Wiederherstellung: Sicherung ersetzt die Datenbank, die alte bleibt als Kopie; neuere Schema-Version wird abgelehnt', async () => {
  const sicherung = path.join(zielDir, fs.readdirSync(zielDir).find((n) => /^noten-backup-/.test(n)));
  const ziel = path.join(tempDir, 'neu', 'wieder.sqlite3');
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  fs.writeFileSync(ziel, 'alte-datenbank');
  const r = W.stelleWiederHer({ quelle: sicherung, zielPfad: ziel, schluessel: DB_ENCRYPTION_KEY, maxVersion: SCHEMA_VERSION });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(r.beiseite, 'utf8'), 'alte-datenbank');
  const neu = new Database(ziel, { readonly: true });
  neu.pragma("cipher='sqlcipher'");
  neu.pragma(`key='${DB_ENCRYPTION_KEY}'`);
  assert.equal(neu.prepare("SELECT nachname FROM schueler").get().nachname, 'Adler');
  neu.close();
  assert.match(W.stelleWiederHer({ quelle: sicherung, zielPfad: path.join(tempDir, 'x.sqlite3'), schluessel: DB_ENCRYPTION_KEY, maxVersion: 1 }).fehler, /neueren Programmversion/);
  assert.match(W.stelleWiederHer({ quelle: path.join(tempDir, 'gibts-nicht'), zielPfad: ziel, schluessel: DB_ENCRYPTION_KEY }).fehler, /nicht gefunden/);
  assert.ok(!fs.existsSync(path.join(tempDir, 'x.sqlite3')), 'bei Ablehnung wird nichts geschrieben');
});

test('Planer: sichert von selbst, sobald ein Lauf fällig ist', async () => {
  db().prepare('DELETE FROM backup_laeufe').run();
  const vorher = fs.readdirSync(zielDir).length;
  // gleiche Sekunde wie der vorige Lauf wäre derselbe Dateiname -- kurz warten
  await new Promise((r) => setTimeout(r, 1100));
  const stopp = B.starteBackupPlaner({ intervallMs: 50 });
  try {
    for (let i = 0; i < 60 && E.letzteLaeufe(1).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  } finally { stopp(); }
  const lauf = E.letzteLaeufe(1)[0];
  assert.ok(lauf, 'ein Lauf wurde angestoßen');
  assert.equal(lauf.ausloeser, 'geplant');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(E.letzteLaeufe(1)[0].ok, 1);
  assert.equal(fs.readdirSync(zielDir).length, vorher + 1);
});

test('Kommandozeile: npm run backup:wiederherstellen stellt eine Sicherung wieder her', async () => {
  const { spawnSync } = await import('node:child_process');
  const sicherung = path.join(zielDir, fs.readdirSync(zielDir).find((n) => /^noten-backup-/.test(n)));
  const ziel = path.join(tempDir, 'cli', 'noten.sqlite3');
  const lauf = (datei) => spawnSync(process.execPath, ['src/cli/backup-wiederherstellen.js', datei], {
    encoding: 'utf8', env: { ...process.env, DB_PFAD: ziel },
  });
  const ok = lauf(sicherung);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 Klassen, 1 Schüler\/innen/);
  assert.equal(fs.existsSync(ziel), true);
  const fehler = lauf(path.join(tempDir, 'fehlt.sqlite3'));
  assert.equal(fehler.status, 1);
  assert.match(fehler.stderr, /nicht gefunden/);
  const ohneArg = spawnSync(process.execPath, ['src/cli/backup-wiederherstellen.js'], { encoding: 'utf8', env: { ...process.env, DB_PFAD: ziel } });
  assert.equal(ohneArg.status, 2);
});

test.after(async () => {
  await fastify.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * UI/UX-Schnelle Gewinne: Kontraste der Knopf-Farben (mind. 4,5:1 mit weißer Schrift, in allen drei Farbschemata), Tabellen ohne
 * leeren Block daneben, Berührungsflächen, Beschriftungen für Icon-Knöpfe und Eingabefelder, Kurs-Hüllen nicht im Admin sichtbar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ux-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ux-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

const css = fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8');

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const kontrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Die drei Token-Blöcke: hell (:root), dunkel per System (@media), dunkel per Auswahl ([data-theme="dark"]). */
const bloecke = () => {
  const hell = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const dunkelSys = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'));
  const dunkelWahl = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('}', css.indexOf(':root[data-theme="dark"]')));
  return { hell, dunkelSys, dunkelWahl };
};
const token = (block, name) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];

test('Knopf-Farben: weiße Schrift hat in Hell, Dunkel (System) und Dunkel (Auswahl) mindestens 4,5:1 – auch beim Überfahren', () => {
  for (const [name, block] of Object.entries(bloecke())) {
    for (const t of ['--accent-fill', '--accent-fill-hover', '--danger-fill', '--danger-fill-hover']) {
      const farbe = token(block, t);
      assert.ok(farbe, `${name}: ${t} fehlt`);
      assert.ok(kontrast(farbe, '#ffffff') >= 4.5, `${name} ${t} ${farbe}: ${kontrast(farbe, '#ffffff').toFixed(2)}:1`);
    }
  }
  assert.match(css, /\.btn \{ background: var\(--accent-fill\); \}/);
  assert.match(css, /button\.danger \{ background: var\(--danger-fill\); \}/);
});

test('Rote Schrift (Löschen im Menü) hat auf der Kartenfläche mindestens 4,5:1', () => {
  const { hell, dunkelSys } = bloecke();
  assert.ok(kontrast(token(hell, '--danger'), token(hell, '--bg-card')) >= 4.5);
  assert.ok(kontrast(token(dunkelSys, '--danger'), token(dunkelSys, '--bg-card')) >= 4.5);
});

test('Tabellen schrumpfen auf ihre Breite (kein leerer weißer Block daneben) und scrollen bei Platzmangel weiter', () => {
  assert.match(css, /table\.data, table\.tafel \{ display: block; width: fit-content; max-width: 100%; overflow-x: auto;/);
});

test('Berührungsflächen: Fußzeile, Markenname, Kartenlinks, Fachlinks, Punktefelder am Handy', () => {
  assert.match(css, /\.footer-links a \{[^}]*min-height: 44px/);
  assert.match(css, /\.footer small \{ font-size: 0\.85rem; \}/, 'Fußzeile nicht kleiner als 12 px');
  assert.match(css, /\.kachel-aktionen a \{[^}]*min-height: 44px/);
  assert.match(css, /a\.fach-name \{[^}]*min-height: 44px/);
  assert.match(css, /@media \(pointer: coarse\), \(max-width: 600px\) \{[\s\S]*table\.tafel input\.punkt, \.aufgabe-feld input\[type=number\], input\.maxpunkt \{ min-height: 44px; \}/);
  assert.match(css, /\.nav-toggle \{ min-width: 44px; \}/);
  assert.match(css, /select, textarea \{ min-height: 44px; box-sizing: border-box; \}/, 'Eingabefelder am Handy mindestens 44 px hoch');
});

test('Fokusrahmen auch bei Eingabefeldern', () => {
  assert.match(css, /input:focus-visible, select:focus-visible, textarea:focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('Jeder Icon-Knopf (🗑, 💾) hat einen Namen für Screenreader; die Punktefelder und Konferenznoten sind beschriftet', () => {
  const dateien = [];
  const lauf = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) lauf(p); else if (p.endsWith('.ejs')) dateien.push(p); } };
  lauf(path.join(ROOT, 'views'));
  const ohne = [];
  for (const f of dateien) for (const m of fs.readFileSync(f, 'utf8').matchAll(/<button[^>]*>\s*(🗑|💾)\s*<\/button>/g)) if (!/aria-label=/.test(m[0])) ohne.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 60)}`);
  assert.deepEqual(ohne, [], 'Icon-Knöpfe ohne aria-label');
  const fach = fs.readFileSync(path.join(ROOT, 'views/teacher/fach_detail.ejs'), 'utf8');
  assert.equal((fach.match(/class="punkt" aria-label="Punkte /g) || []).length, 2, 'Klausur- und Zusatzleistungs-Punktefelder');
  const konferenz = fs.readFileSync(path.join(ROOT, 'views/teacher/konferenzmodus.ejs'), 'utf8');
  assert.match(konferenz, /name="note" step="0\.1" aria-label="Konferenznote /);
});

function client() {
  const cookies = new Map();
  return async (url, body) => {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=')); }
    return r;
  };
}

test('Admin → Zuweisungen: interne Kurs-Hüllen erscheinen als „Kurs“, nicht als „__kurshuelle_…“, und nicht bei der Klassenleitung', async () => {
  const admin = client(); const anna = client();
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await admin('/admin/einladungen/neu', { display_name: 'anna', ttl_days: '14' });
  await anna(`/einladung/${getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get().token}`, { username: 'anna', display_name: 'anna', password: 'passwort123', password2: 'passwort123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await anna('/teacher/kurse/neu', { schuljahr_id: String(sj), name: 'Philosophie AG', notenschluessel: 'BG' });
  assert.ok(getDb().prepare("SELECT 1 FROM klassen WHERE name LIKE '__kurshuelle%'").get(), 'Kurs-Hülle existiert');
  const html = await (await admin('/admin/zuweisungen')).text();
  assert.doesNotMatch(html, /__kurshuelle/, 'kein interner Name sichtbar');
  assert.match(html, /2025\/26 · Kurs · Philosophie AG/, 'Auswahl: Kurs');
  assert.match(html, /<td>Kurs<\/td>/, 'Tabelle der Zuweisungen');
  assert.match(html, /"huelle":1/, 'Hülle wird für die Klassenleitungs-Auswahl markiert');
  assert.match(html, /if \(f\.huelle\) return;/, 'und dort ausgeblendet');
  const einl = await (await admin('/admin/einladungen')).text();
  assert.doesNotMatch(einl, /__kurshuelle/);
});

/**
 * Suchfeld über Auswahllisten (static/js/select-filter.js): unscharfe Suche (Logik ohne Browser geprüft) und Einbindung in die Seiten:
 * Klassenauswahl, alle Lehrkräfte-Auswahllisten, Fach- und Zielklassen-Auswahl; „+ Neue Klasse anlegen“ neben „Klasse wählen“.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-selectfilter-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-selectfilter-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

// Das Skript ohne Browser laden: nur die reine Logik (window.selectFilter) wird benutzt.
const fenster = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'static/js/select-filter.js'), 'utf8'), {
  window: fenster, document: { readyState: 'complete', querySelectorAll: () => [], addEventListener() {} },
});
const { normalisiere, bewerteText, abstand } = fenster.selectFilter;
const passt = (suche, text) => bewerteText(normalisiere(suche).split(' ').filter(Boolean), normalisiere(text)) > 0;

test('Normalisierung: Umlaute, ae/oe/ue, ß, Akzente, Leerzeichen', () => {
  assert.equal(normalisiere('Müller'), normalisiere('Mueller'));
  assert.equal(normalisiere('Möller'), normalisiere('Moeller'));
  assert.equal(normalisiere('Bäcker'), normalisiere('Baecker'));
  assert.equal(normalisiere('Straße'), normalisiere('Strasse'));
  assert.equal(normalisiere('  José   Gómez '), 'jose gomez');
  assert.equal(normalisiere(null), '');
});

test('Unscharfe Suche: Teilwörter, mehrere Wörter, verstreute Buchstaben, Tippfehler; Unsinn passt nicht', () => {
  const t = 'Anna Muster (amuster)';
  assert.ok(passt('muster', t));
  assert.ok(passt('MUS', t), 'Groß-/Kleinschreibung egal');
  assert.ok(passt('anna mus', t), 'alle Wörter müssen passen, Reihenfolge egal');
  assert.ok(passt('mus anna', t));
  assert.ok(!passt('anna berger', t), 'ein Wort passt nicht');
  assert.ok(passt('mstr', t), 'verstreute Buchstaben');
  assert.ok(passt('mustr', t), 'ein Buchstabe fehlt');
  assert.ok(passt('musetr', t), 'Buchstaben vertauscht');
  assert.ok(passt('mustar', t), 'ein Buchstabe falsch');
  assert.ok(passt('amuster', t), 'Benutzername');
  assert.ok(passt('mueller', 'Müller, Hans'));
  assert.ok(passt('muller', 'Mueller, Hans'));
  assert.ok(!passt('xyz', t));
  assert.ok(!passt('q', t), 'ein einzelner Buchstabe, der nicht vorkommt');
  assert.equal(abstand('muster', 'mustre'), 1, 'Vertauschen zählt einmal');
  assert.equal(abstand('abc', 'abc'), 0);
});

test('Rangfolge: Wortanfang vor Teiltreffer vor Tippfehler vor verstreuten Buchstaben', () => {
  const suche = ['mus'];
  const wert = (text) => bewerteText(suche, normalisiere(text));
  assert.ok(wert('Muster, Max') > wert('Hamustermann'), 'Wortanfang schlägt Wortmitte');
  assert.ok(wert('Hamustermann') > 0);
  const tokens = ['muster'];
  assert.ok(bewerteText(tokens, 'muster') > bewerteText(['mustr'], 'muster'), 'exakt vor Tippfehler');
  assert.ok(bewerteText(['mustr'], 'muster') > bewerteText(['mstr'], 'muster'), 'Tippfehler vor verstreut');
});

function client() {
  const cookies = new Map();
  return async (url, body) => {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const admin = client(); const anna = client(); const cora = client();
const db = () => getDb();
let klasseId; let klasse2Id;

test('Vorbereitung: Admin, zwei LDAP-Lehrkräfte, Klassen mit Fach', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [cora, 'cora']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap'").run();
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12B', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  klasse2Id = db().prepare("SELECT id FROM klassen WHERE name = '12B'").get().id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  await anna(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
});

test('Skript wird ausgeliefert und auf allen Seiten eingebunden', async () => {
  const js = await fetch(`${base}/static/js/select-filter.js`);
  assert.equal(js.status, 200);
  const html = await (await anna('/teacher/klassen')).text();
  assert.match(html, /\/static\/js\/select-filter\.js\?v=/);
});

test('„Vorhandene Klasse wählen“: Suchfeld über der Auswahl, „+ Neue Klasse anlegen“ neben „Klasse wählen“', async () => {
  const html = await (await cora('/teacher/klassen')).text();
  const form = /<form method="post" action="\/teacher\/klassen\/neu">\s*<label>Klasse[\s\S]*?<\/form>/.exec(html)?.[0];
  assert.ok(form, 'Formular „Klasse wählen“');
  assert.match(form, /<select name="vorhandene_klasse_id"[^>]*data-filter/);
  const submit = form.indexOf('Klasse wählen</button>');
  const neu = form.indexOf('+ Neue Klasse anlegen</button>');
  assert.ok(submit > 0 && neu > submit, 'der Knopf steht gleich neben „Klasse wählen“');
  assert.match(form, /data-zu-reiter="klasse-anlegen-neu"/);
  assert.match(html, /id="klasse-anlegen-neu"/, 'Ziel-Panel existiert');
});

test('Lehrkräfte-Auswahllisten haben ein Suchfeld: Fach der Klasse, Klassenleitung (Lehrkraft und Klasse), Admin-Seiten', async () => {
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(klasseId, 'anna');
  const klasseHtml = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  const fachId = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathe'").get(klasseId).id;
  const fachHtml = await (await anna(`/teacher/faecher/${fachId}/lehrkraefte`)).text();
  assert.match(fachHtml, /<select name="user_id" required data-filter aria-label="Lehrkraft">/, 'Lehrkraft einem Fach zuordnen');
  assert.match(klasseHtml, /<select name="ziel_klasse_id" required data-filter/, 'Versetzen: Zielklasse');
  const zuw = await (await admin('/admin/zuweisungen')).text();
  assert.equal((zuw.match(/<select name="user_id" required data-filter/g) || []).length, 2, 'beide Lehrkräfte-Auswahlen der Zuweisungen');
  const adminKlasse = await (await admin(`/admin/klassen/${klasseId}`)).text();
  assert.match(adminKlasse, /<select name="user_id" required data-filter/, 'Admin: Klassenleitung eintragen');
  // Klassenleitung: Co-Klassenlehrkraft
  const kl = await (await anna(`/klassenlehrer/klasse/${klasseId}?tab=klassenleitung`)).text();
  assert.match(kl, /<select name="user_id" required data-filter/, 'Co-Klassenlehrkraft wählen');
  // Fach-Auswahl der Zuweisungen
  assert.match(zuw, /<select name="fach_id" required data-filter/);
});

test('Auswahllisten ohne Filter bleiben unverändert (Notenschlüssel, Schuljahr)', async () => {
  const html = await (await anna('/teacher/klassen')).text();
  assert.doesNotMatch(html, /<select name="notenschluessel"[^>]*data-filter/);
  assert.doesNotMatch(html, /<select name="schuljahr_id"[^>]*data-filter/);
});

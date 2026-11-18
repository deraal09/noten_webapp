/**
 * Klassenseite (Meine Klassen → Klasse): In der Kopfzeile ist nur der erste Knopf („← Meine Klassen“) immer sichtbar; alle weiteren
 * Aktionen (Noteneingabe, Sitzplan, Zeugnisübersicht, CSV-Export, Klassenleitung, Klasse löschen) stecken hinter den drei Balken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kopfmenue-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-kopfmenue-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

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
const admin = client(); const anna = client();
const db = () => getDb();
let klasseId; let spaId;

/** Kopfzeile (<div class="kopf-aktionen"> … </div>) der Klassenseite; ein <details> darf nicht in einem <p> stehen (der Browser würde es herausziehen). */
const kopf = (html) => /<div class="kopf-aktionen">([\s\S]*?)\n<\/div>/.exec(html)[1];

test('Vorbereitung: Admin, Anna (LDAP) mit Klassenleitung in einer IHK- und einer SPA-Klasse', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await admin('/admin/einladungen/neu', { display_name: 'anna', ttl_days: '14' });
  await anna(`/einladung/${db().prepare('SELECT token FROM invitations ORDER BY id DESC').get().token}`, { username: 'anna', display_name: 'anna', password: 'passwort123', password2: 'passwort123' });
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '13S', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  spaId = db().prepare("SELECT id FROM klassen WHERE name = '13S'").get().id;
  for (const id of [klasseId, spaId]) db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(id, 'anna');
});

test('Kopfzeile: nur „← Meine Klassen“ ist sichtbar, alle weiteren Aktionen stehen im Menü hinter den drei Balken', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  const k = kopf(html);
  const menueStart = k.indexOf('<details class="kopf-menue"');
  assert.ok(menueStart > 0, 'Menü vorhanden');
  const ausserhalb = k.slice(0, menueStart);
  assert.equal((ausserhalb.match(/<a class="btn"/g) || []).length, 1, 'genau ein Knopf außerhalb des Menüs');
  assert.match(ausserhalb, /href="\/teacher\/klassen">← Meine Klassen</);
  assert.match(k, /<summary class="kopf-menue-knopf" aria-label="Weitere Optionen" data-hinweis="Mehr Optionen"><span class="drei-balken"/, 'drei Balken');
  const menue = k.slice(menueStart);
  for (const text of ['📝 Noteneingabe', '🪑 Sitzplan', '➕ Schüler/innen hinzufügen', '📅 Einschulungsjahr festlegen', '🎓 Klassenleitung', '🗑 Klasse löschen']) assert.ok(menue.includes(text), `${text} im Menü`);
  // CSV-Export (nur mit Export-Recht) steht ebenfalls im Menü, nie offen daneben
  const adminKopf = kopf(await (await admin(`/teacher/klassen/${klasseId}`)).text());
  assert.ok(adminKopf.slice(adminKopf.indexOf('<details class="kopf-menue"')).includes('📥 CSV-Export'));
  assert.ok(!adminKopf.slice(0, adminKopf.indexOf('<details class="kopf-menue"')).includes('CSV-Export'));
  for (const text of ['📝 Noteneingabe', '🪑 Sitzplan', '🎓 Klassenleitung', '🗑 Klasse löschen']) assert.ok(!ausserhalb.includes(text), `${text} nicht mehr offen sichtbar`);
  assert.match(menue, new RegExp(`href="/klassenlehrer/klasse/${klasseId}"`));
  assert.match(menue, new RegExp(`action="/teacher/klassen/${klasseId}/loeschen"[^>]*onsubmit="return confirm\\(`), 'Löschen fragt weiter nach');
  assert.match(menue, /class="menue-eintrag danger" role="menuitem">🗑 Klasse löschen/);
});

test('SPA-Klasse: Zeugnisübersicht erscheint im Menü', async () => {
  const k = kopf(await (await anna(`/teacher/klassen/${spaId}`)).text());
  assert.ok(k.slice(k.indexOf('<details class="kopf-menue"')).includes('📋 Zeugnisübersicht'));
  assert.ok(!k.slice(0, k.indexOf('<details class="kopf-menue"')).includes('Zeugnisübersicht'));
});

test('Menü-Knopf hat eine eigene Klasse (das Skript der Personen-Menüs „.aktionen-knopf“ darf ihn nicht erfassen)', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.doesNotMatch(kopf(html), /aktionen-knopf/);
});

test('Menü funktioniert ohne JavaScript (details/summary); das gemeinsame Skript schließt es per Klick daneben und Escape', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /<details class="kopf-menue" id="kopf-menue">/);
  assert.match(html, /\/static\/js\/ui-menues\.js\?v=/, 'Skript eingebunden');
  const js = await (await fetch(`${base}/static/js/ui-menues.js`)).text();
  assert.match(js, /m\.open = false/);
  assert.match(js, /e\.key !== 'Escape'/);
  assert.match(js, /window\.zeigeAbschnitt = function/);
  assert.match(js, /aktiviereReiter/, 'ein Bereich in einem Reiter aktiviert zuerst den Reiter');
  assert.match(js, /location\.hash/, 'Adresse mit #… aktiviert den Reiter');
});

test('Löschen über das Menü geht weiter (Papierkorb)', async () => {
  const r = await anna(`/teacher/klassen/${spaId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.ok(db().prepare('SELECT 1 FROM klassen_geloescht WHERE klasse_id = ?').get(spaId));
});

test('Menü ist leer? Dann kein Menü: Fremde Lehrkraft ohne Rechte bekommt keine Klassenseite mit leerem Menü', async () => {
  // Das Menü erscheint nur, wenn es mindestens eine Aktion gibt: Admin sieht die Sammelklasse mit Löschen
  const ablage = db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_ablage) SELECT id, 'Ohne Klasse', 'IHK', '', 1 FROM schuljahre").run().lastInsertRowid;
  const html = await (await admin(`/teacher/klassen/${ablage}`)).text();
  const k = kopf(html);
  assert.match(k, /← Meine Klassen/);
  assert.match(k, /🗑 Klasse löschen/, 'Admin darf die Sammelklasse löschen');
  assert.doesNotMatch(k, /📝 Noteneingabe|🪑 Sitzplan/, 'keine Noteneingabe/Sitzplan für die Sammelklasse');
});

test('Schüler/innen hinzufügen und Einschulungsjahr festlegen: erst verborgen, das Menü blendet sie ein', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  // Menüeinträge öffnen die Bereiche
  assert.match(html, /data-zeige="schueler-hinzufuegen">➕ Schüler\/innen hinzufügen</);
  assert.match(html, /data-zeige="einschulungsjahr-festlegen">📅 Einschulungsjahr festlegen</);
  // beide Bereiche sind vorhanden (Formulare, Reiter), aber zunächst verborgen
  assert.match(html, /<div id="schueler-hinzufuegen" data-menue-abschnitt data-merken="klasse-\d+-schueler-offen" hidden>/);
  assert.match(html, /<details class="card" id="einschulungsjahr-festlegen" data-menue-abschnitt hidden>/);
  assert.match(html, new RegExp(`action="/teacher/klassen/${klasseId}/schueler/neu"`), 'Formular „Einzeln“ ist unverändert da');
  assert.match(html, /data-target="schueler-csv">CSV-Import</);
  assert.match(html, /data-verberge="schueler-hinzufuegen"/, 'Schließen-Knopf');
  // Einschulungsjahr nur für die Klassenleitung
  db().prepare("DELETE FROM klassenleitung WHERE klasse_id = ?").run(klasseId);
  const ohne = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.doesNotMatch(ohne, /data-zeige="einschulungsjahr-festlegen"/);
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(klasseId, 'anna');
});

test('Hinweis „Mehr Optionen“ an allen Knöpfen mit den drei Balken (Hauptmenü, Klassenmenü, Personen-Menü)', async () => {
  await anna(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /class="nav-toggle"[^>]*data-hinweis="Mehr Optionen"/, 'Hauptmenü ☰');
  assert.match(html, /class="kopf-menue-knopf"[^>]*data-hinweis="Mehr Optionen"/, 'Klassenmenü');
  assert.match(html, /class="aktionen-knopf"[^>]*data-hinweis="Mehr Optionen"/, 'Menü je Person');
  assert.doesNotMatch(html, /class="aktionen-knopf"[^>]*title="Aktionen"/, 'kein doppelter Hinweis über title');
  const css = await (await fetch(`${base}/static/css/app.css`)).text();
  assert.match(css, /\[data-hinweis\]::after/);
  assert.match(css, /\[data-menue-abschnitt\]\[hidden\] \{ display: none !important; \}/);
});

test('Klassenseite hat die Reiter Fächer · Schüler/innen · Einstellungen; Fächer sind voreingestellt', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /<div class="reiter reiter-leiste" data-storage-key="klasse-\d+-hauptreiter">/);
  assert.match(html, /data-target="panel-klasse-faecher">📚 Fächer</);
  assert.match(html, /data-target="panel-klasse-schueler">👥 Schüler\/innen \(\d+\)</);
  assert.match(html, /data-target="panel-klasse-einstellungen">⚙ Einstellungen</);
  assert.match(html, /<div id="panel-klasse-faecher" class="reiter-panel active">/);
  assert.match(html, /<div id="panel-klasse-schueler" class="reiter-panel">/);
  const teil = (id, nxt) => html.slice(html.indexOf(`id="${id}"`), nxt ? html.indexOf(`id="${nxt}"`) : undefined);
  const faecher = teil('panel-klasse-faecher', 'panel-klasse-schueler');
  const schueler = teil('panel-klasse-schueler', 'panel-klasse-einstellungen');
  const einst = html.slice(html.indexOf('id="panel-klasse-einstellungen"'), html.indexOf('id="aktionen-popover"'));
  assert.match(faecher, /id="faecher-lehrkraefte"/, 'Fächer im Fächer-Reiter');
  assert.match(schueler, /<h2>Schüler\/innen \(/);
  assert.match(schueler, /id="schueler-hinzufuegen"/);
  assert.match(schueler, /<table class="data">/);
  assert.match(einst, /✏️ Klasse umbenennen/, 'Umbenennen in den Einstellungen');
  assert.match(einst, /Automatisch für andere Lehrkräfte freigeben/, 'Freigabe in den Einstellungen');
  assert.match(einst, /id="einschulungsjahr-festlegen"/, 'Einschulungsjahr in den Einstellungen');
  assert.doesNotMatch(faecher, /Klasse umbenennen|Automatisch für andere/);
  assert.match(html.slice(0, html.indexOf('class="reiter reiter-leiste"')), /Klassenleitung:<\/strong>/, 'Klassenleitung bleibt über den Reitern sichtbar');
});

test('Sammelklasse „Ohne Klasse“: keine Reiter, nur die Schüler/innen', async () => {
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  const ablage = db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_ablage) VALUES (?, 'Ohne Klasse 2', 'IHK', '', 1)").run(sj).lastInsertRowid;
  const html = await (await admin(`/teacher/klassen/${ablage}`)).text();
  assert.doesNotMatch(html, /reiter-leiste/);
  assert.match(html, /<div id="panel-klasse-schueler" class="reiter-panel active">/);
  assert.doesNotMatch(html, /panel-klasse-faecher|panel-klasse-einstellungen/);
});

test('Klassenleitung ohne Eintrag: „Als Klassenleitung eintragen“ bleibt oberhalb der Reiter sichtbar', async () => {
  db().prepare('DELETE FROM klassenleitung WHERE klasse_id = ?').run(klasseId);
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' }); // der Knopf verlangt ein eigenes Fach in der Klasse
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  const oben = html.slice(0, html.indexOf('class="reiter reiter-leiste"'));
  assert.match(oben, /Als Klassenleitung eintragen/);
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(klasseId, 'anna');
});

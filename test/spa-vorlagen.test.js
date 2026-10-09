/**
 * SPA-Vorlagen: frei editierbare Fächervorgabe (Schema je Fach), als Vorlage speicherbar, beim Anlegen
 * einer SPA-Klasse (oder später) ladbar -- aber nicht verpflichtend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-spa-vorlagen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-vorlagen-test-bitte-lang-genug-xxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const S = await import('../src/spa-schema.js');
const { berechneFachFuerSchueler, spaKlassenKonfig, zeugnisFuerKlasse } = await import('../src/spa-noten-service.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
async function form(req, url, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
}

const admin = client();
const fremd = client();
let sjId;
const db = () => getDb();
const vorlageByName = (n) => db().prepare('SELECT * FROM spa_vorlagen WHERE name = ?').get(n);

/** Formularfelder für ein Fach mit vier gleichen Halbjahren. */
const fachFelder = (i, name, extra = {}, proHj = {}) => {
  const f = { [`f${i}_key`]: extra.key ?? '', [`f${i}_name`]: name, [`f${i}_typ`]: extra.typ ?? 'FACH' };
  for (let hj = 1; hj <= 4; hj++) {
    Object.assign(f, { [`f${i}_h${hj}_status`]: 'aktiv', [`f${i}_h${hj}_modus`]: 'direkt', [`f${i}_h${hj}_kum`]: 'keine' }, proHj[hj] ?? proHj.alle ?? {});
  }
  return f;
};

test('Vorbereitung: Admin, Schuljahr, zweite Lehrkraft', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = db().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'fremd', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, { username: 'fremd', display_name: 'fremd', password: 'passwort123', password2: 'passwort123' });
});

test('Prüfung: Standard-Vorgaben sind gültig; ungültige Schemata werden abgelehnt', () => {
  for (const bg of ['SPA_REGULAR', 'SPA_PIA']) assert.equal(S.pruefeKonfig(S.standardKonfig(bg)).ok, true, bg);
  const mit = (aendere) => {
    const k = S.standardKonfig('SPA_PIA');
    aendere(k);
    return S.pruefeKonfig(k);
  };
  assert.match(mit((k) => { k[1].schema[0].komponenten[0].gewichtFix = 0.9; }).fehler, /mehr als 100/);
  assert.match(mit((k) => { k[1].name = k[0].name; }).fehler, /doppelt/);
  assert.match(mit((k) => { k[0].schema[0].halbjahrModus = 'komplett anders'; }).fehler, /Bewertungsart/);
  // Praxis PiA verrechnet im 4. Hj. mit Blockpraxis; Blockpraxis darf nicht zurück auf Praxis zeigen
  const kreis = mit((k) => { k.find((f) => f.schluessel === 'BLOCKPRAXIS').schema[0] = { ...k.find((f) => f.schluessel === 'BLOCKPRAXIS').schema[0], kumulationModus: 'gewichtet_vorgaenger', gewichtExtern: 0.3, gewichtAktuell: 0.7, externFach: 'PRAXIS', externHalbjahr: 4 }; });
  assert.match(kreis.fehler, /Kreis/);
  assert.match(mit((k) => { k[0].schema[1].externFach = 'LF1'; k[0].schema[1].kumulationModus = 'gewichtet_vorgaenger'; k[0].schema[1].gewichtExtern = 0.3; }).fehler, /anderes Fach/);
});

test('Vorlage anlegen: Kopie des Standards, leere Vorlage, Namen frei', async () => {
  let r = await form(admin, '/teacher/spa-vorlagen/neu', { bildungsgang: 'SPA_REGULAR', basis: 'standard', name: 'Meine SPA' });
  assert.equal(r.status, 302);
  const v = vorlageByName('Meine SPA');
  assert.ok(v);
  assert.equal(JSON.parse(v.konfig).faecher.length, S.standardKonfig('SPA_REGULAR').length);
  assert.equal(r.headers.get('location'), `/teacher/spa-vorlagen/${v.id}`);
  r = await form(admin, '/teacher/spa-vorlagen/neu', { bildungsgang: 'SPA_PIA', basis: 'leer', name: 'Leer' });
  assert.equal(JSON.parse(vorlageByName('Leer').konfig).faecher.length, 0);
  // gleicher Name ist nicht doppelt möglich: ohne Namen wird einer vorgeschlagen
  await form(admin, '/teacher/spa-vorlagen/neu', { bildungsgang: 'SPA_PIA', basis: 'standard', name: 'Leer' });
  assert.equal(db().prepare("SELECT COUNT(*) AS c FROM spa_vorlagen WHERE name = 'Leer'").get().c, 1);
  const html = await (await admin('/teacher/spa-vorlagen')).text();
  assert.match(html, /Meine SPA/);
  assert.match(html, /Standard-Vorgabe des Bildungsgangs/);
});

test('Editor zeigt alle Einstellungen und lässt sich komplett ändern (Fächer, Komponenten, Verrechnung)', async () => {
  const v = vorlageByName('Meine SPA');
  let html = await (await admin(`/teacher/spa-vorlagen/${v.id}`)).text();
  assert.match(html, /name="f2_h1_komp"/);
  assert.match(html, /Pädagogik; 40/);
  assert.match(html, /Kunst; Rest/);
  assert.match(html, /name="f0_h1_status"/);
  assert.equal(html.includes('FEHLER'), false);

  // Vollständig neu belegen: zwei Fächer, eines mit eigenen Komponenten, eines verrechnet mit dem anderen
  const body = {
    name: 'Meine SPA', bildungsgang: 'SPA_REGULAR', fach_idx: ['0', '1'],
    ...fachFelder(0, 'Sport', { key: '', typ: 'FACH' }, {
      alle: { f: 1 }, 1: { [`f0_h1_modus`]: 'komponenten_gewichtet', [`f0_h1_komp`]: 'Theorie; 60\nPraxis; Rest' },
    }),
    f1_allg_abschluss: '1', f1_allg_abschluss_hj: '4', f0_allg_deakt: '1', f0_allg_komma: '1', f0_allg_pruefung: '1',
    ...fachFelder(1, 'Musik', { typ: 'LF' }, {
      4: { [`f1_h4_kum`]: 'gewichtet_vorgaenger', [`f1_h4_quelle`]: 'fach', [`f1_h4_extfach`]: 'SPORT', [`f1_h4_exthj`]: '1', [`f1_h4_extpct`]: '25' },
    }),
  };
  const r = await form(admin, `/teacher/spa-vorlagen/${v.id}`, body);
  assert.equal(r.status, 302);
  const konfig = JSON.parse(db().prepare('SELECT konfig FROM spa_vorlagen WHERE id = ?').get(v.id).konfig).faecher;
  assert.deepEqual(konfig.map((f) => `${f.schluessel}:${f.name}:${f.typ}`), ['SPORT:Sport:FACH', 'MUSIK:Musik:LF']);
  assert.deepEqual(konfig[0].schema[0].komponenten, [{ schluessel: 'Theorie', gewichtFix: 0.6 }, { schluessel: 'Praxis', restAnteil: true }]);
  const hj4 = konfig[1].schema[3];
  assert.equal(hj4.kumulationModus, 'gewichtet_vorgaenger');
  assert.equal(hj4.externFach, 'SPORT');
  assert.equal(hj4.gewichtExtern, 0.25);
  assert.equal(hj4.gewichtAktuell, 0.75);
  assert.equal(hj4.abschlussZeigen, true);
  // Fach-weite Optionen (Reiter "Allgemein"): Sport hat "n/a", Komma-Note und Prüfung (letztes Halbjahr) in allen Halbjahren
  assert.deepEqual(konfig[0].schema.map((x) => [x.deaktivierbar, x.kommaNote, x.pruefung, x.abschlussZeigen]),
    [[true, true, false, false], [true, true, false, false], [true, true, false, false], [true, true, true, false]]);
  assert.deepEqual(konfig[1].schema.map((x) => x.abschlussZeigen), [false, false, false, true]);
  assert.equal(konfig[1].schema.every((x) => !x.deaktivierbar && !x.kommaNote && !x.pruefung), true);

  // Fehler: Anzeige mit Meldung, nichts gespeichert
  const schlecht = await form(admin, `/teacher/spa-vorlagen/${v.id}`, { ...body, f0_h1_komp: 'Theorie; 80\nPraxis; 40' });
  assert.equal(schlecht.status, 200);
  assert.match(await schlecht.text(), /mehr als 100/);
  assert.equal(JSON.parse(db().prepare('SELECT konfig FROM spa_vorlagen WHERE id = ?').get(v.id).konfig).faecher[0].schema[0].komponenten.length, 2);

  // Fach hinzufügen: leere Karte erscheint, ohne zu speichern
  const neu = await form(admin, `/teacher/spa-vorlagen/${v.id}`, { ...body, aktion: 'fach_neu' });
  assert.equal(neu.status, 302);
  html = await (await admin(neu.headers.get('location').replace(/#.*/, ''))).text();
  assert.match(html, /name="f2_name"/);

  // Fach entfernen
  await form(admin, `/teacher/spa-vorlagen/${v.id}`, { ...body, f1_entfernen: '1' });
  assert.deepEqual(JSON.parse(db().prepare('SELECT konfig FROM spa_vorlagen WHERE id = ?').get(v.id).konfig).faecher.map((f) => f.schluessel), ['SPORT']);

  // fremde Lehrkräfte sehen und ändern fremde Vorlagen nicht
  assert.equal((await fremd(`/teacher/spa-vorlagen/${v.id}`)).status, 404);
  assert.equal((await form(fremd, `/teacher/spa-vorlagen/${v.id}`, body)).status, 404);
});

test('SPA-Klasse anlegen: Standard vorbelegt, Vorlage laden, oder gar keine Vorlage', async () => {
  const neueKlasse = (name, extra) => form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name, notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', ...extra });
  const faecherVon = (name) => db().prepare('SELECT f.* FROM faecher f JOIN klassen k ON k.id = f.klasse_id WHERE k.name = ? AND f.parent_fach_id IS NULL ORDER BY f.id').all(name);

  // ohne Angabe (und mit "standard"): Standard-Vorgabe wie bisher, Schema bleibt ungespeichert
  await neueKlasse('SPA-A', {});
  assert.equal(faecherVon('SPA-A').length, S.standardKonfig('SPA_REGULAR').length);
  assert.equal(faecherVon('SPA-A').every((f) => f.spa_schema === null), true);

  // eigene Vorlage: Fächer und Schema stammen aus der Vorlage (als Kopie)
  const v = vorlageByName('Meine SPA');
  await neueKlasse('SPA-B', { spa_vorlage: String(v.id) });
  const b = faecherVon('SPA-B');
  assert.deepEqual(b.map((f) => f.name), ['Sport']);
  assert.equal(b[0].spa_fach_key, 'SPORT');
  assert.ok(JSON.parse(b[0].spa_schema).length === 4);
  // Komponenten von Sport erscheinen als Unterfächer
  const kinder = db().prepare('SELECT kurzname FROM faecher WHERE parent_fach_id = ? ORDER BY id').all(b[0].id).map((x) => x.kurzname);
  assert.deepEqual(kinder, ['Theorie', 'Praxis']);

  // Änderung der Vorlage danach wirkt nicht auf die Klasse (Kopie)
  await form(admin, `/teacher/spa-vorlagen/${v.id}`, { name: 'Meine SPA', bildungsgang: 'SPA_REGULAR', fach_idx: '0', ...fachFelder(0, 'Sportunterricht', { key: 'SPORT' }) });
  assert.equal(faecherVon('SPA-B')[0].name, 'Sport');

  // keine Vorlage: Klasse ohne Fächer
  await neueKlasse('SPA-C', { spa_vorlage: 'keine' });
  assert.equal(faecherVon('SPA-C').length, 0);

  // fremde oder unbekannte Vorlage wird abgelehnt, die Klasse entsteht nicht
  const r = await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: 'SPA-D', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', spa_vorlage: '9999' });
  assert.equal(r.status, 302);
  assert.equal(db().prepare("SELECT COUNT(*) AS c FROM klassen WHERE name = 'SPA-D'").get().c, 0);

  // Das Anlegeformular bietet die Vorlage und die Möglichkeit "keine" an
  const html = await (await admin('/teacher/klassen')).text();
  assert.match(html, /name="spa_vorlage"/);
  assert.match(html, /Keine Vorlage/);
  assert.match(html, /Vorlage „Meine SPA“ laden/);
});

test('Vorlage später in eine bestehende SPA-Klasse laden: nur fehlende Fächer', async () => {
  const klasseC = db().prepare("SELECT * FROM klassen WHERE name = 'SPA-C'").get();
  const v = vorlageByName('Meine SPA');
  let r = await form(admin, `/teacher/klassen/${klasseC.id}/spa-vorlage/laden`, { quelle: String(v.id) });
  assert.equal(r.status, 302);
  assert.deepEqual(db().prepare('SELECT name FROM faecher WHERE klasse_id = ? AND parent_fach_id IS NULL').all(klasseC.id).map((f) => f.name), ['Sportunterricht']);
  // nochmal: nichts Neues; Standard ergänzt die übrigen Fächer
  await form(admin, `/teacher/klassen/${klasseC.id}/spa-vorlage/laden`, { quelle: String(v.id) });
  await form(admin, `/teacher/klassen/${klasseC.id}/spa-vorlage/laden`, { quelle: 'standard' });
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ? AND parent_fach_id IS NULL').get(klasseC.id).c, 1 + S.standardKonfig('SPA_REGULAR').length);
  // nur die Klassenleitung
  assert.equal((await form(fremd, `/teacher/klassen/${klasseC.id}/spa-vorlage/laden`, { quelle: 'standard' })).status, 403);
  const html = await (await admin(`/teacher/klassen/${klasseC.id}`)).text();
  assert.match(html, /SPA-Fächervorgabe laden/);
  assert.match(html, /\/teacher\/faecher\/\d+\/spa-schema/);
});

test('Eigenes Schema wird berechnet: Komponenten mit Gewichten, Verrechnung mit anderem Fach, Zeugnis', async () => {
  const klasse = db().prepare("SELECT * FROM klassen WHERE name = 'SPA-B'").get();
  await form(admin, `/teacher/klassen/${klasse.id}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  const sid = db().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  const sport = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'SPORT'").get(klasse.id);
  db().prepare('INSERT OR IGNORE INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(sport.id, sid);
  // Sport 1. Hj.: Theorie 60 %, Praxis = Rest (40 %) -- Schema stammt aus der ersten Fassung der Vorlage
  const eingabe = (feld, wert) => form(admin, `/teacher/fach/${sport.id}/spa/eingabe`, { schueler_id: String(sid), halbjahr: '1', feld, wert });
  assert.equal((await eingabe('komponente:Theorie', '10')).status, 200);
  assert.equal((await eingabe('komponente:Praxis', '5')).status, 200);
  const hj1 = berechneFachFuerSchueler(db(), sport.id, sid).find((e) => e.halbjahr === 1);
  assert.equal(hj1.zwischennote, 8);
  assert.equal(hj1.endpunkte, 8);
  // unbekannte Komponente wird abgelehnt
  assert.equal((await eingabe('komponente:Kunst', '5')).status, 400);
  // Zeugnisübersicht kennt das eigene Fach
  const z = zeugnisFuerKlasse(db(), klasse.id, 1);
  assert.deepEqual(z[0].faecher.map((f) => f.label), ['Sport']);
  assert.equal(spaKlassenKonfig(db(), klasse.id).name('SPORT'), 'Sport');
  // Eingabemaske zeigt die eigenen Komponenten
  const html = await (await admin(`/teacher/fach/${sport.id}?hj=1`)).text();
  assert.match(html, /Theorie/);
  assert.match(html, /Praxis/);
});

test('Schema eines einzelnen Fachs in der Klasse bearbeiten (nur Klassenleitung)', async () => {
  const klasse = db().prepare("SELECT * FROM klassen WHERE name = 'SPA-A'").get();
  const lf3 = db().prepare("SELECT * FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF3'").get(klasse.id);
  let html = await (await admin(`/teacher/faecher/${lf3.id}/spa-schema`)).text();
  assert.match(html, /Pädagogik; 40/);
  assert.equal((await fremd(`/teacher/faecher/${lf3.id}/spa-schema`)).status, 403);

  // 1. Hj. von LF3: nur Pädagogik 50 %, Kunst und Musik teilen den Rest; Name geändert
  const felder = fachFelder(0, 'Lernfeld Drei', { key: 'LF3', typ: 'LF' }, { alle: { f: 1 }, 1: { f0_h1_modus: 'komponenten_gewichtet', f0_h1_komp: 'Pädagogik; 50\nKunst; Rest\nMusik; Rest' } });
  const r = await form(admin, `/teacher/faecher/${lf3.id}/spa-schema`, felder);
  assert.equal(r.status, 302);
  const nach = db().prepare('SELECT * FROM faecher WHERE id = ?').get(lf3.id);
  assert.equal(nach.name, 'Lernfeld Drei');
  const hj1 = JSON.parse(nach.spa_schema).find((s) => s.halbjahr === 1);
  assert.deepEqual(hj1.komponenten.map((k) => k.schluessel), ['paedagogik', 'kunst', 'musik']);
  // Komponenten-Unterfächer wurden angepasst: Spiel/Bewegung (in allen Halbjahren weg, keine Daten) entfallen im 1. Hj.
  const kinder = db().prepare('SELECT kurzname, halbjahre FROM faecher WHERE parent_fach_id = ? ORDER BY id').all(lf3.id);
  assert.equal(kinder.some((k) => k.kurzname === 'Spiel'), false);

  // Verrechnung im Kreis wird abgelehnt
  const lf4 = db().prepare("SELECT * FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF4'").get(klasse.id);
  const kreis = fachFelder(0, 'Lernfeld 4', { key: 'LF4', typ: 'LF' }, { alle: {}, 2: { f0_h2_kum: 'gewichtet_vorgaenger', f0_h2_quelle: 'fach', f0_h2_extfach: 'LF3', f0_h2_exthj: '1', f0_h2_extpct: '30' } });
  assert.equal((await form(admin, `/teacher/faecher/${lf4.id}/spa-schema`, kreis)).status, 302, 'LF4 -> LF3 ist erlaubt');
  const kreis2 = fachFelder(0, 'Lernfeld Drei', { key: 'LF3', typ: 'LF' }, { alle: {}, 2: { f0_h2_kum: 'gewichtet_vorgaenger', f0_h2_quelle: 'fach', f0_h2_extfach: 'LF4', f0_h2_exthj: '1', f0_h2_extpct: '30' } });
  const abgelehnt = await form(admin, `/teacher/faecher/${lf3.id}/spa-schema`, kreis2);
  assert.equal(abgelehnt.status, 200);
  assert.match(await abgelehnt.text(), /Kreis/);
  // Doppelter Fachname in der Klasse
  const doppelt = await form(admin, `/teacher/faecher/${lf4.id}/spa-schema`, fachFelder(0, 'Praxis', { key: 'LF4', typ: 'LF' }));
  assert.equal(doppelt.status, 200);
  assert.match(await doppelt.text(), /schon ein Fach/);
  // Berechnung läuft mit dem Schema des Fachs
  assert.equal(S.pruefeKonfig([{ schluessel: 'X', name: 'X', typ: 'FACH', schema: JSON.parse(nach.spa_schema) }]).ok, true);
});

test('Fächervorgabe einer Klasse als Vorlage ablegen und wieder laden', async () => {
  const klasse = db().prepare("SELECT * FROM klassen WHERE name = 'SPA-A'").get();
  const r = await form(admin, `/teacher/klassen/${klasse.id}/spa-vorlage/speichern`, { name: 'Aus SPA-A' });
  assert.equal(r.status, 302);
  const v = vorlageByName('Aus SPA-A');
  const faecher = JSON.parse(v.konfig).faecher;
  assert.equal(faecher.length, S.standardKonfig('SPA_REGULAR').length);
  assert.equal(faecher.find((f) => f.schluessel === 'LF3').name, 'Lernfeld Drei', 'enthält die Änderungen der Klasse');
  assert.equal(S.pruefeKonfig(faecher).ok, true);
  assert.equal((await form(fremd, `/teacher/klassen/${klasse.id}/spa-vorlage/speichern`, { name: 'x' })).status, 403);
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: 'SPA-E', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', spa_vorlage: String(v.id) });
  const e = db().prepare("SELECT f.name FROM faecher f JOIN klassen k ON k.id = f.klasse_id WHERE k.name = 'SPA-E' AND f.parent_fach_id IS NULL").all().map((x) => x.name);
  assert.ok(e.includes('Lernfeld Drei') && e.length === faecher.length);
});

test('Vorlage löschen', async () => {
  const v = vorlageByName('Leer');
  assert.equal((await form(fremd, `/teacher/spa-vorlagen/${v.id}/loeschen`, {})).status, 302);
  assert.ok(vorlageByName('Leer'), 'fremde Vorlage bleibt');
  await form(admin, `/teacher/spa-vorlagen/${v.id}/loeschen`, {});
  assert.equal(vorlageByName('Leer'), undefined);
  // bereits angelegte Klassen bleiben unverändert
  assert.ok(db().prepare("SELECT 1 FROM faecher WHERE spa_fach_key = 'SPORT'").get());
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Allgemeine Einstellungen (Reiter): Abschlusszeugnis, Prüfung, „n/a“, Komma-Note gelten fürs ganze Fach', async () => {
  const V = await import('../src/spa-vorlagen.js');
  const modell = (bg, key) => V.editorModell(S.standardKonfig(bg)).find((f) => f.schluessel === key).allgemein;
  assert.deepEqual(modell('SPA_PIA', 'PRAXIS'), { abschluss: true, abschlussHj: '2, 4', pruefung: false, pruefungHj: '', deakt: false, komma: false });
  assert.deepEqual(modell('SPA_REGULAR', 'PRAXIS').abschlussHj, '2, 3');
  assert.deepEqual(modell('SPA_REGULAR', 'DEUTSCH'), { abschluss: true, abschlussHj: '4', pruefung: true, pruefungHj: '4', deakt: false, komma: false });
  assert.deepEqual(modell('SPA_REGULAR', 'WPK'), { abschluss: true, abschlussHj: '2', pruefung: false, pruefungHj: '', deakt: false, komma: true });
  assert.equal(modell('SPA_PIA', 'LF4').deakt, true);

  // Der Editor zeigt die Optionen im Reiter "Allgemein" und nicht mehr je Halbjahr
  const v = vorlageByName('Meine SPA');
  const html = await (await admin(`/teacher/spa-vorlagen/${v.id}`)).text();
  assert.match(html, /<button type="button" class="active" role="tab" data-tab="allg">Allgemein<\/button>/);
  assert.match(html, /name="f0_allg_abschluss"/);
  assert.match(html, /name="f0_allg_pruefung_hj"/);
  assert.doesNotMatch(html, /name="f0_h1_(abschluss|pruefung|deakt|komma)"/, 'keine Haken mehr je Halbjahr');

  // Rundlauf: Standard -> Formularfelder (wie der Editor sie sendet) -> gleiche Konfiguration
  for (const bg of ['SPA_REGULAR', 'SPA_PIA']) {
    const body = { fach_idx: [] };
    V.editorModell(S.standardKonfig(bg)).forEach((f, i) => {
      body.fach_idx.push(String(i));
      Object.assign(body, { [`f${i}_key`]: f.schluessel, [`f${i}_name`]: f.name, [`f${i}_typ`]: f.typ });
      const a = f.allgemein;
      if (a.abschluss) Object.assign(body, { [`f${i}_allg_abschluss`]: '1', [`f${i}_allg_abschluss_hj`]: a.abschlussHj });
      if (a.pruefung) Object.assign(body, { [`f${i}_allg_pruefung`]: '1', [`f${i}_allg_pruefung_hj`]: a.pruefungHj });
      if (a.deakt) body[`f${i}_allg_deakt`] = '1';
      if (a.komma) body[`f${i}_allg_komma`] = '1';
      for (const h of f.halbjahre) {
        const p = `f${i}_h${h.hj}_`;
        if (h.status === 'fehlt') { body[`${p}status`] = 'fehlt'; continue; }
        Object.assign(body, { [`${p}status`]: h.status, [`${p}modus`]: h.modus, [`${p}kum`]: h.kum, [`${p}komp`]: h.komp, [`${p}mw`]: h.mw.map(String), [`${p}quelle`]: h.quelle, [`${p}extfach`]: h.extFach, [`${p}exthj`]: String(h.extHj), [`${p}extpct`]: h.extPct });
      }
    });
    const gelesen = V.leseFaecherAusFormular(body);
    assert.equal(V.ersterFormularFehler(gelesen), null);
    const geprueft = S.pruefeKonfig(gelesen);
    assert.equal(geprueft.ok, true, geprueft.fehler);
    assert.deepEqual(geprueft.faecher, S.pruefeKonfig(S.standardKonfig(bg)).faecher, `${bg}: unverändert gespeichert`);
  }
});

test('Allgemeine Einstellungen: Halbjahre prüfen (nicht vorhanden / unverständlich), leer = letztes aktives Halbjahr', async () => {
  const V = await import('../src/spa-vorlagen.js');
  const basis = { fach_idx: '0', f0_name: 'Test', f0_typ: 'FACH', f0_h1_status: 'aktiv', f0_h1_modus: 'direkt', f0_h1_kum: 'keine', f0_h2_status: 'aktiv', f0_h2_modus: 'direkt', f0_h2_kum: 'keine', f0_h3_status: 'fehlt', f0_h4_status: 'fehlt' };
  const schema = (extra) => V.leseFaecherAusFormular({ ...basis, ...extra })[0];
  const f1 = schema({ f0_allg_abschluss: '1', f0_allg_pruefung: '1' });
  assert.deepEqual(f1.schema.map((x) => [x.abschlussZeigen, x.pruefung]), [[false, false], [true, true]], 'leer = letztes aktives (2.)');
  assert.match(V.ersterFormularFehler([schema({ f0_allg_abschluss: '1', f0_allg_abschluss_hj: '4' })]), /Abschlusszeugnis.*4\. Halbjahr nicht vorhanden/);
  assert.match(V.ersterFormularFehler([schema({ f0_allg_pruefung: '1', f0_allg_pruefung_hj: 'x' })]), /Prüfung.*nicht verständlich/);
  assert.equal(V.ersterFormularFehler([schema({ f0_allg_abschluss: '1', f0_allg_abschluss_hj: '1-2' })]), null);
  // Ohne Haken: nichts gesetzt, auch wenn ein Halbjahr eingetragen ist
  assert.deepEqual(schema({ f0_allg_abschluss_hj: '2' }).schema.map((x) => x.abschlussZeigen), [false, false]);
  // über die Route: Fehlermeldung statt Speichern
  const klasse = db().prepare("SELECT * FROM klassen WHERE name = 'SPA-A'").get();
  const lf4 = db().prepare("SELECT * FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF4'").get(klasse.id);
  const r = await form(admin, `/teacher/faecher/${lf4.id}/spa-schema`, { ...fachFelder(0, 'Lernfeld 4', { key: 'LF4', typ: 'LF' }), f0_allg_pruefung: '1', f0_allg_pruefung_hj: '7' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Prüfung: Halbjahr „7“ gibt es nicht/);
});

/**
 * Schüler/innen einzeln in eine andere Klasse versetzen (z. B. bei
 * Wiederholen/Überspringen einer Stufe) -- alle Noten bleiben erhalten, weil
 * sie am Schüler-Datensatz hängen -- und "Klasse löschen" rettet die
 * Schüler/innen (nur die Person, keine Noten der gelöschten Fächer) in die
 * Sammelklasse "Ohne Klasse" des Schuljahres.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-schueler-versetzen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-schueler-versetzen-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');
const { ladeAbgangszeugnisDaten } = await import('../src/fach-abschluss.js');
const { ladeFaecherFuerKlassenleitung } = await import('../src/noten-service.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

function client() {
  const cookies = new Map();
  function setCookie(setCookieHeader) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of arr) {
      const [pair] = raw.split(';');
      const [k, ...v] = pair.split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
  }
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  };
}

async function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

const admin = client();
const lehrerA = client();
const lehrerFremd = client();
let sjAltId, sjNeuId;
let klasse9A, klasse10A, klasse10B, mathId, deutschId, annaId, benId;

test('Vorbereitung: zwei Schuljahre, Klasse 9A (2024/25) mit Mathematik und Noten, Klasse 10A (2025/26) mit Deutsch, Klasse 10B mit anderem Notenschlüssel', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2024/25' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjAltId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2024/25'").get().id;
  sjNeuId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer Fremd']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerFremd, `/einladung/${invs[1].token}`, {
    username: 'lehrerfremd', display_name: 'Lehrer Fremd', password: 'passwortF1', password2: 'passwortF1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  const legeKlasseAn = async (sjId, name, ns) => {
    await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name, notenschluessel: ns });
    const id = getDb().prepare('SELECT id FROM klassen WHERE name = ?').get(name).id;
    await form(lehrerA, `/teacher/klassen/${id}/klassenlehrer/eintragen`, {});
    return id;
  };
  klasse9A = await legeKlasseAn(sjAltId, '9A', 'IHK');
  klasse10A = await legeKlasseAn(sjNeuId, '10A', 'IHK');
  klasse10B = await legeKlasseAn(sjNeuId, '10B', 'BG');

  await form(lehrerA, `/teacher/klassen/${klasse9A}/faecher/neu`, { name: 'Mathematik' });
  await form(lehrerA, `/teacher/klassen/${klasse10A}/faecher/neu`, { name: 'Deutsch' });
  mathId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathematik'").get(klasse9A).id;
  deutschId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasse10A).id;

  await form(lehrerA, `/teacher/klassen/${klasse9A}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasse9A}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  benId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;

  // Eine Note für Anna in Mathematik der 9A -- soll den Wechsel überleben.
  r = await form(lehrerA, `/teacher/fach/${mathId}/noten/hinzufuegen`, {
    schueler_id: String(annaId), typ: 'schriftlich', wert: '2', halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM noten WHERE fach_id = ? AND schueler_id = ?').get(mathId, annaId).c, 1);
});

test('Versetzen: nur wer die Klasse verwalten darf, und nur in eine Klasse mit gleichem Notenschlüssel', async () => {
  let r = await form(lehrerFremd, `/teacher/schueler/${annaId}/versetzen`, { ziel_klasse_id: String(klasse10A) });
  assert.equal(r.status, 403);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(annaId).klasse_id, klasse9A);

  r = await form(lehrerA, `/teacher/schueler/${annaId}/versetzen`, { ziel_klasse_id: String(klasse10B) });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(annaId).klasse_id, klasse9A, 'anderer Notenschlüssel -> nicht versetzt');
});

test('Versetzen 9A -> 10A: dieselbe Person, Noten und alte Fach-Teilnahme bleiben, neue Fächer kommen dazu', async () => {
  const r = await form(lehrerA, `/teacher/schueler/${annaId}/versetzen`, { ziel_klasse_id: String(klasse10A) });
  assert.equal(r.status, 302);

  const anna = getDb().prepare('SELECT * FROM schueler WHERE id = ?').get(annaId);
  assert.equal(anna.klasse_id, klasse10A, 'derselbe Datensatz, nur neue Klasse');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM noten WHERE fach_id = ? AND schueler_id = ?').get(mathId, annaId).c, 1, 'Note bleibt erhalten');
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(mathId, annaId), 'alte Teilnahme bleibt');
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(deutschId, annaId), 'neue Klasse: Teilnehmerin der Fächer');

  const zeugnis = ladeAbgangszeugnisDaten(annaId);
  assert.deepEqual(zeugnis.zeilen.map((z) => z.fach.name).sort(), ['Deutsch', 'Mathematik'], 'Abgangszeugnis zeigt Fächer beider Klassen');

  // Die alten Fächer einer anderen Klasse/eines anderen Schuljahres tauchen nicht als Spalte in der Übersicht der neuen Klasse auf.
  assert.deepEqual(ladeFaecherFuerKlassenleitung(klasse10A).map((f) => f.name), ['Deutsch']);
  // Die 9A hat Anna nicht mehr in der Klassenliste.
  const html9A = await (await lehrerA(`/teacher/klassen/${klasse9A}`)).text();
  assert.doesNotMatch(html9A, /Adler/);
  const html10A = await (await lehrerA(`/teacher/klassen/${klasse10A}`)).text();
  assert.match(html10A, /Adler/);
});

test('Versetzen: gleicher Name in der Zielklasse, Abgang und gleiche Klasse werden abgelehnt', async () => {
  // Zweiter "Berger, Ben" in der 10A -> Namenskollision.
  await form(lehrerA, `/teacher/klassen/${klasse10A}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  await form(lehrerA, `/teacher/schueler/${benId}/versetzen`, { ziel_klasse_id: String(klasse10A) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(benId).klasse_id, klasse9A);

  await form(lehrerA, `/teacher/schueler/${benId}/versetzen`, { ziel_klasse_id: String(klasse9A) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(benId).klasse_id, klasse9A);

  await form(lehrerA, `/teacher/schueler/${benId}/abgang`, {});
  await form(lehrerA, `/teacher/schueler/${benId}/versetzen`, { ziel_klasse_id: 'ohne-klasse' });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(benId).klasse_id, klasse9A, 'Abgang muss erst reaktiviert werden');
  await form(lehrerA, `/teacher/schueler/${benId}/reaktivieren`, {});
});

test('Versetzen nach "Ohne Klasse": Sammelklasse des Schuljahres wird angelegt und wiederverwendet', async () => {
  const r = await form(lehrerA, `/teacher/schueler/${benId}/versetzen`, { ziel_klasse_id: 'ohne-klasse' });
  assert.equal(r.status, 302);
  const ablage = getDb().prepare('SELECT * FROM klassen WHERE ist_ablage = 1').all();
  assert.equal(ablage.length, 1);
  assert.equal(ablage[0].name, 'Ohne Klasse');
  assert.equal(ablage[0].schuljahr_id, sjAltId, 'Sammelklasse liegt im Schuljahr der bisherigen Klasse');
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(benId).klasse_id, ablage[0].id);

});

test('Klasse löschen: Schüler/innen (nur die Person) wandern in "Ohne Klasse", Fächer und Noten der Klasse verschwinden, der Löschende wird Klassenleitung der Sammelklasse', async () => {
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjAltId), name: '9C', notenschluessel: 'IHK' });
  const klasse9C = getDb().prepare("SELECT id FROM klassen WHERE name = '9C'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasse9C}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasse9C}/faecher/neu`, { name: 'Physik' });
  const physikId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ?").get(klasse9C).id;
  await form(lehrerA, `/teacher/klassen/${klasse9C}/schueler/neu`, { nachname: 'Claus', vorname: 'Cem' });
  const cemId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Claus'").get().id;

  const r = await form(lehrerA, `/teacher/klassen/${klasse9C}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM klassen WHERE id = ?').get(klasse9C), undefined, 'Klasse ist weg');
  assert.equal(getDb().prepare('SELECT 1 FROM faecher WHERE id = ?').get(physikId), undefined, 'Fächer sind weg');

  const ablage = getDb().prepare('SELECT * FROM klassen WHERE ist_ablage = 1').get();
  const cem = getDb().prepare('SELECT * FROM schueler WHERE id = ?').get(cemId);
  assert.ok(cem, 'Person bleibt als Datensatz erhalten');
  assert.equal(cem.klasse_id, ablage.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE ist_ablage = 1').get().c, 1, 'Sammelklasse wird wiederverwendet');
  const lehrerAId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrera'").get().id;
  assert.ok(getDb().prepare('SELECT 1 FROM klassenleitung WHERE klasse_id = ? AND user_id = ?').get(ablage.id, lehrerAId));

  // Aus der Sammelklasse lässt sich die Person wieder in eine echte Klasse versetzen.
  const r2 = await form(lehrerA, `/teacher/schueler/${cemId}/versetzen`, { ziel_klasse_id: String(klasse10A) });
  assert.equal(r2.status, 302);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(cemId).klasse_id, klasse10A);
});

test('Sammelklasse ist für jede Lehrkraft einsehbar; übernehmen geht per Reiter nur in Klassen, die man verwalten darf', async () => {
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjAltId), name: '9D', notenschluessel: 'IHK' });
  const klasse9D = getDb().prepare("SELECT id FROM klassen WHERE name = '9D'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasse9D}/schueler/neu`, { nachname: 'Dietz', vorname: 'Dora' });
  const doraId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Dietz'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasse9D}/loeschen`, {});
  const ablage = getDb().prepare('SELECT * FROM klassen WHERE ist_ablage = 1').get();
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(doraId).klasse_id, ablage.id);

  // Lehrer Fremd hat nichts mit den Klassen zu tun und sieht trotzdem die Sammelklasse -- ohne Lösch-/Abgangs-Aktionen.
  const liste = await (await lehrerFremd('/teacher/klassen')).text();
  assert.match(liste, /Ohne Klasse/);
  let r = await lehrerFremd(`/teacher/klassen/${ablage.id}`);
  assert.equal(r.status, 200);
  const htmlAblage = await r.text();
  assert.match(htmlAblage, /Dietz/);
  assert.match(htmlAblage, /data-versetzen data-sid="\d+"/);
  assert.match(htmlAblage, /<dialog id="versetzen-dialog"/);
  assert.doesNotMatch(htmlAblage, /Klasse löschen/);
  assert.doesNotMatch(htmlAblage, /\/abgang/);
  assert.equal((await form(lehrerFremd, `/teacher/klassen/${ablage.id}/loeschen`, {})).status, 403);
  assert.equal((await form(lehrerFremd, `/teacher/schueler/${doraId}/loeschen`, {})).status, 403);

  // Übernehmen in eine Klasse, die man nicht verwaltet: abgelehnt.
  assert.equal((await form(lehrerFremd, `/teacher/klassen/${klasse10A}/schueler/aus-ablage`, { schueler_id: String(doraId) })).status, 403);

  // Als Klassenleitung der 10A sieht Lehrer Fremd oben den Reiter und kann Personen übernehmen.
  const fremdId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerfremd'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasse10A}/klassenleitung/hinzufuegen`, { user_id: String(fremdId) });
  const html10A = await (await lehrerFremd(`/teacher/klassen/${klasse10A}`)).text();
  assert.match(html10A, /data-target="schueler-ablage"/);
  assert.match(html10A, /Dietz, Dora/);

  // Nur Personen, die wirklich in einer Sammelklasse stehen, sind über diesen Weg übernehmbar.
  r = await form(lehrerFremd, `/teacher/klassen/${klasse10A}/schueler/aus-ablage`, { schueler_id: [String(doraId), String(benId + 9999)] });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(doraId).klasse_id, klasse10A);
  const htmlDanach = await (await lehrerFremd(`/teacher/klassen/${klasse10A}`)).text();
  assert.doesNotMatch(htmlDanach, /<input type="checkbox" name="schueler_id" value="\d+">\s*Dietz/);

  // Aus einer echten Klasse lässt sich niemand über den Ablage-Weg herausziehen.
  const annaKlasseVorher = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(annaId).klasse_id;
  await form(lehrerA, `/teacher/klassen/${klasse10B}/schueler/aus-ablage`, { schueler_id: String(annaId) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(annaId).klasse_id, annaKlasseVorher);
});

test('SPA-Klassen: Personen aus "Ohne Klasse" übernehmen, nach "Ohne Klasse" versetzen, und zwischen SPA-Klassen nur bei gleichem Bildungsgang', async () => {
  const legeSpaKlasseAn = async (name, bildungsgang) => {
    await form(lehrerA, '/teacher/klassen/neu', {
      schuljahr_id: String(sjNeuId), name, notenschluessel: 'SPA', spa_bildungsgang: bildungsgang,
    });
    const id = getDb().prepare('SELECT id FROM klassen WHERE name = ?').get(name).id;
    await form(lehrerA, `/teacher/klassen/${id}/klassenlehrer/eintragen`, {});
    return id;
  };
  const spaA = await legeSpaKlasseAn('13SPA1', 'SPA_REGULAR');
  const spaB = await legeSpaKlasseAn('13SPA2', 'SPA_REGULAR');
  const spaPia = await legeSpaKlasseAn('13PIA', 'SPA_PIA');
  assert.ok(getDb().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(spaA).c > 0, 'SPA-Klasse hat ihre festen Fächer');

  // Person in die Sammelklasse rutschen lassen (z. B. durch Löschen einer Klasse) ...
  await form(lehrerA, `/teacher/klassen/${spaB}/schueler/neu`, { nachname: 'Ebert', vorname: 'Eva' });
  const evaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Ebert'").get().id;
  let r = await form(lehrerA, `/teacher/schueler/${evaId}/versetzen`, { ziel_klasse_id: 'ohne-klasse' });
  assert.equal(r.status, 302);
  const ablage = getDb().prepare('SELECT * FROM klassen WHERE ist_ablage = 1 AND schuljahr_id = ?').get(sjNeuId);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(evaId).klasse_id, ablage.id);

  // ... und über den Reiter in eine SPA-Klasse übernehmen, inkl. Teilnahme an deren Fächern.
  const html = await (await lehrerA(`/teacher/klassen/${spaA}`)).text();
  assert.match(html, /data-target="schueler-ablage"/);
  assert.match(html, /Ebert, Eva/);
  r = await form(lehrerA, `/teacher/klassen/${spaA}/schueler/aus-ablage`, { schueler_id: String(evaId) });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(evaId).klasse_id, spaA);
  const spaFaecher = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').all(spaA);
  for (const f of spaFaecher) {
    assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(f.id, evaId));
  }

  // Zwischen echten SPA-Klassen: gleicher Bildungsgang ja, anderer nein.
  await form(lehrerA, `/teacher/schueler/${evaId}/versetzen`, { ziel_klasse_id: String(spaPia) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(evaId).klasse_id, spaA, 'anderer SPA-Bildungsgang -> nicht versetzt');
  await form(lehrerA, `/teacher/schueler/${evaId}/versetzen`, { ziel_klasse_id: String(spaB) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(evaId).klasse_id, spaB);
  // Das Zeugnis für eine SPA-Person enthält deren SPA-Fächer (noch ohne Noten) und läuft ohne Fehler durch.
  const spaZeugnis = ladeAbgangszeugnisDaten(evaId);
  assert.ok(spaZeugnis.zeilen.length >= spaFaecher.length);
  assert.ok(spaZeugnis.zeilen.every((z) => Array.isArray(z.eintraege)));
  // SPA -> IHK-Klasse bleibt verboten.
  await form(lehrerA, `/teacher/schueler/${evaId}/versetzen`, { ziel_klasse_id: String(klasse10A) });
  assert.equal(getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(evaId).klasse_id, spaB);
});

test('Die Sammelklasse selbst zu löschen entfernt ihre Schüler/innen endgültig', async () => {
  const ablage = getDb().prepare('SELECT * FROM klassen WHERE ist_ablage = 1').get();
  const r = await form(lehrerA, `/teacher/klassen/${ablage.id}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM klassen WHERE id = ?').get(ablage.id), undefined);
  assert.equal(getDb().prepare('SELECT 1 FROM schueler WHERE id = ?').get(benId), undefined, 'Ben war in der Sammelklasse -> mit ihr gelöscht');
});

test('Klassenansicht: Aktionen je Person hinter den drei Balken, Versetzen öffnet einen Dialog mit Klassenauswahl', async () => {
  const html = await (await lehrerA(`/teacher/klassen/${klasse10A}`)).text();
  assert.match(html, /class="aktionen-knopf"[^>]*aria-haspopup="true"/);
  assert.match(html, /<span class="drei-balken"/);
  // Die einzelnen Buttons stehen im Menü (versteckt), nicht mehr offen in der Tabelle
  assert.match(html, /<div class="aktionen-inhalt" hidden>[\s\S]*?↔ Versetzen …[\s\S]*?🚪 Abgang[\s\S]*?🗑 Löschen/);
  assert.doesNotMatch(html, /<option value="">↔ Versetzen nach …<\/option>/);
  // Dialog mit Zielklassen
  const dialog = html.slice(html.indexOf('<dialog id="versetzen-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="versetzen-dialog"')));
  assert.match(dialog, /name="ziel_klasse_id"/);
  assert.match(dialog, /Ohne Klasse/);
  assert.match(dialog, /<option value="\d+">9A \(2024\/25\)/);
  assert.match(html, /<div id="aktionen-popover"/);
});

test.after(async () => {
  await fastify.close();
});

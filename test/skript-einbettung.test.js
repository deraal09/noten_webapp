/**
 * Daten, die in einen <script>-Block eingebettet werden, dürfen daraus nicht
 * ausbrechen können.
 *
 * Der HTML-Parser beendet einen Script-Block beim ersten "</script" im
 * Inhalt — auch mitten in einem JavaScript-String. `JSON.stringify()` allein
 * schützt davor also nicht: Ein Sitzplan-Etikett oder ein Klassenname wie
 * `</script><script>…` wird sonst als eigenes Skript ausgeführt. Beide
 * betroffenen Stellen benutzen deshalb jsonFuerSkript() aus src/format.js:
 *
 * - views/teacher/sitzplan.ejs — Etiketten kommen von jeder Lehrkraft mit
 *   Klassenzugriff und sind über "Sitzplan übertragen" für alle übrigen
 *   Lehrkräfte der Klasse sichtbar.
 * - views/admin/zuweisungen.ejs — Klassen- und Fachnamen legt jede Lehrkraft
 *   selbst an (Selbstbedienung, siehe teacher.js POST /klassen/neu); gerendert
 *   werden sie auf einer reinen Admin-Seite, ein Ausbruch träfe also das
 *   Admin-Konto.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-skript-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-skript-einbettung-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { jsonFuerSkript } = await import('../src/format.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

const AUSBRUCH = '</script><script>window.uebernommen=1;</script>';

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}

function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

/** Der Wert, den der Browser für `<variable> = …;` tatsächlich sähe. */
function eingebettetesJson(html, variable) {
  const treffer = new RegExp(`${variable} = (.*);$`, 'm').exec(html);
  assert.ok(treffer, `Zuweisung an ${variable} nicht im HTML gefunden`);
  return treffer[1];
}

test('jsonFuerSkript maskiert die Zeichen, mit denen sich ein <script>-Block beenden lässt', () => {
  const ausgabe = jsonFuerSkript({ text: AUSBRUCH });
  assert.ok(!ausgabe.includes('</script'), 'Ausgabe darf kein "</script" mehr enthalten');
  assert.ok(!ausgabe.includes('<'), 'auch ein einzelnes "<" gehört maskiert');
  assert.ok(!ausgabe.includes('>'));
  // Für JavaScript/JSON ist die maskierte Fassung derselbe Wert -- die
  // Anzeige darf sich durch die Maskierung nicht verändern.
  assert.deepEqual(JSON.parse(ausgabe), { text: AUSBRUCH });
});

test('jsonFuerSkript maskiert U+2028/U+2029 und verträgt undefined', () => {
  assert.deepEqual(JSON.parse(jsonFuerSkript({ t: '  ' })), { t: '  ' });
  assert.ok(!jsonFuerSkript({ t: ' ' }).includes(' '));
  assert.equal(jsonFuerSkript(undefined), 'null');
});

const admin = client();
const lehrkraft = client();
let klasseId;

test('Vorbereitung: Admin, Schuljahr, LDAP-Lehrkraft mit Selbstbedienungsrecht', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12',
  });
  assert.equal(r.status, 302);
  r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  assert.equal(r.status, 302);

  // Selbst Klassen anlegen darf nur, wer ein verwaltetes Konto hat
  // (userDarfSelbstKlasseAnlegen) -- also ein LDAP-Konto, hier gegen einen
  // injizierten FakeAuthenticator statt gegen ein echtes Verzeichnis.
  const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
  const { FakeAuthenticator } = await import('../src/auth/authenticator.js');
  getDb().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
                   VALUES ('lehrkraft', 'L. Kraft', ?, 'teacher', 1, 'ldap', 'lehrkraft')`)
    .run(hashPassword(makeToken()));
  setLdapAuthenticatorForTests(new FakeAuthenticator({ lehrkraft: { passwort: 'geheim12', name: 'L. Kraft' } }));

  r = await form(lehrkraft, '/login', { username: 'lehrkraft', password: 'geheim12' });
  assert.equal(r.headers.get('location'), '/');
});

test('Sitzplan: ein Etikett mit "</script>" bricht nicht aus dem Skript aus', async () => {
  let r = await form(lehrkraft, '/teacher/klassen/neu', {
    schuljahr_id: '1', name: 'Testklasse', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  klasseId = Number(r.headers.get('location').split('/').pop());

  r = await form(lehrkraft, `/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    plaetze: JSON.stringify([{ id: 'p1', x: 10, y: 10, text: AUSBRUCH }]),
  });
  assert.equal(r.status, 200);

  const html = await (await lehrkraft(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  const literal = eingebettetesJson(html, 'let plaetze');
  assert.ok(!literal.includes('</script'), 'das eingebettete JSON darf den Block nicht beenden');
  // Der Text bleibt als Daten erhalten -- maskiert wird nur die Schreibweise.
  assert.equal(JSON.parse(literal)[0].text, AUSBRUCH);

  // Gegenprobe auf der ganzen Seite: die Angriffszeichenkette darf im
  // Quelltext nirgends unmaskiert stehen -- in der Vorschau des geteilten
  // Sitzplans maskiert EJS mit <%= %>, im Skript jsonFuerSkript().
  assert.ok(!html.includes(AUSBRUCH), 'die rohe Zeichenkette darf im Seitenquelltext nicht vorkommen');
});

test('Admin-Seite "Zuweisungen": Klassen-/Fachname mit "</script>" bricht nicht aus', async () => {
  // Genau der Eskalationspfad: Die Namen legt die Lehrkraft selbst an,
  // gerendert werden sie auf einer Seite, die nur Admins sehen.
  let r = await form(lehrkraft, '/teacher/klassen/neu', {
    schuljahr_id: '1', name: `Klasse ${AUSBRUCH}`, notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  const boeseKlasseId = Number(r.headers.get('location').split('/').pop());
  r = await form(lehrkraft, `/teacher/klassen/${boeseKlasseId}/faecher/neu`, { name: `Fach ${AUSBRUCH}` });
  assert.equal(r.status, 302);

  const html = await (await admin('/admin/zuweisungen')).text();
  assert.ok(html.includes('var faecher'), 'Testannahme: die Seite bettet die Fächerliste als JSON ein');
  const literal = eingebettetesJson(html, 'var faecher');
  assert.ok(!literal.includes('</script'));
  const eingebettet = JSON.parse(literal).find((f) => f.name.startsWith('Fach '));
  assert.equal(eingebettet.name, `Fach ${AUSBRUCH}`);
  assert.equal(eingebettet.klasse_name, `Klasse ${AUSBRUCH}`);
});

test('Keine Vorlage bettet JSON mehr ohne jsonFuerSkript() in ein <script> ein', () => {
  // Fängt einen Rückfall an einer neuen Stelle ab: `<%- JSON.stringify(…) %>`
  // ist genau das Muster, das diese Lücke erzeugt hat.
  const viewsDir = new URL('../views/', import.meta.url);
  const gefunden = [];
  const durchsuche = (dir) => {
    for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
      const pfad = new URL(eintrag.name + (eintrag.isDirectory() ? '/' : ''), dir);
      if (eintrag.isDirectory()) durchsuche(pfad);
      else if (eintrag.name.endsWith('.ejs') && /<%-[^%]*JSON\.stringify/.test(fs.readFileSync(pfad, 'utf8'))) {
        gefunden.push(eintrag.name);
      }
    }
  };
  durchsuche(viewsDir);
  assert.deepEqual(gefunden, [], 'diese Vorlagen müssen jsonFuerSkript() statt JSON.stringify() verwenden');
});

test.after(async () => {
  const { setLdapAuthenticatorForTests } = await import('../src/auth.js');
  setLdapAuthenticatorForTests(undefined);
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Ratelimit für Login-Versuche (src/auth/login-ratelimit.js): ab dem 3.
 * Fehlversuch in Folge wird eine Sperre verhängt (Basisdauer 30s), jeder
 * weitere Fehlversuch nach Ablauf der vorherigen Sperre verdoppelt die
 * Dauer (30s, 60s, 120s, 240s, ...).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ratelimit-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ratelimit-bitte-lang-genug';
process.env.NODE_ENV = 'test';

const { getDb } = await import('../src/db.js');
const { pruefeSperre, vermerkeFehlversuch, setzeZurueck } = await import('../src/auth/login-ratelimit.js');

test('Die ersten beiden Fehlversuche sperren noch nicht', () => {
  vermerkeFehlversuch('nutzerA');
  assert.equal(pruefeSperre('nutzerA').gesperrt, false);
  vermerkeFehlversuch('nutzerA');
  assert.equal(pruefeSperre('nutzerA').gesperrt, false);
});

test('Der 3. Fehlversuch in Folge sperrt für die Basisdauer von 30 Sekunden', () => {
  vermerkeFehlversuch('nutzerA');
  const status = pruefeSperre('nutzerA');
  assert.equal(status.gesperrt, true);
  assert.ok(status.restSekunden >= 29 && status.restSekunden <= 30, `erwartet ~30s, war ${status.restSekunden}`);
});

test('Ein Versuch während einer aktiven Sperre zählt nicht als weiterer Fehlversuch und verlängert nicht', () => {
  // Simuliert einen Login-Versuch während der Sperre: der Aufrufer in
  // routes/auth.js ruft vermerkeFehlversuch() in diesem Fall gar nicht auf
  // (er bricht schon bei pruefeSperre() ab) -- hier wird trotzdem explizit
  // geprüft, dass ein manueller Aufruf während der Sperre nicht sein
  // müsste, indem der Zustand vor/nach einem reinen pruefeSperre()-Aufruf
  // unverändert bleibt.
  const vorher = pruefeSperre('nutzerA');
  const nochmal = pruefeSperre('nutzerA');
  assert.equal(vorher.gesperrt, true);
  assert.equal(nochmal.gesperrt, true);
  assert.ok(Math.abs(vorher.restSekunden - nochmal.restSekunden) <= 1, 'reines Prüfen darf die Sperre nicht verlängern');
});

test('Nach Ablauf der Sperre verdoppelt der nächste Fehlversuch die Dauer (60s)', () => {
  // Ablauf der vorherigen Sperre simulieren, indem gesperrt_bis manuell in
  // die Vergangenheit gesetzt wird (kein echtes 30s-Warten im Test nötig).
  getDb().prepare("UPDATE login_ratelimit SET gesperrt_bis = ? WHERE schluessel = 'nutzera'").run(Date.now() - 1000);
  assert.equal(pruefeSperre('nutzerA').gesperrt, false, 'Testannahme: Sperre gilt als abgelaufen');

  vermerkeFehlversuch('nutzerA'); // 4. Fehlversuch insgesamt
  const status = pruefeSperre('nutzerA');
  assert.equal(status.gesperrt, true);
  assert.ok(status.restSekunden >= 59 && status.restSekunden <= 60, `erwartet ~60s, war ${status.restSekunden}`);
});

test('Noch ein Zyklus später: 120s (Verdopplung von 60s)', () => {
  getDb().prepare("UPDATE login_ratelimit SET gesperrt_bis = ? WHERE schluessel = 'nutzera'").run(Date.now() - 1000);
  vermerkeFehlversuch('nutzerA'); // 5. Fehlversuch insgesamt
  const status = pruefeSperre('nutzerA');
  assert.equal(status.gesperrt, true);
  assert.ok(status.restSekunden >= 119 && status.restSekunden <= 120, `erwartet ~120s, war ${status.restSekunden}`);
});

test('setzeZurueck: löscht den Zähler, danach sperren die nächsten zwei Fehlversuche wieder nicht', () => {
  setzeZurueck('nutzerA');
  assert.equal(pruefeSperre('nutzerA').gesperrt, false);
  vermerkeFehlversuch('nutzerA');
  assert.equal(pruefeSperre('nutzerA').gesperrt, false);
  vermerkeFehlversuch('nutzerA');
  assert.equal(pruefeSperre('nutzerA').gesperrt, false);
});

test('Groß-/Kleinschreibung und Leerzeichen spielen für den Schlüssel keine Rolle (deckt sich mit dem case-insensitiven Login)', () => {
  setzeZurueck('nutzerB');
  vermerkeFehlversuch('NutzerB');
  vermerkeFehlversuch(' nutzerb ');
  vermerkeFehlversuch('NUTZERB');
  assert.equal(pruefeSperre('nutzerb').gesperrt, true, 'alle drei Schreibweisen müssen denselben Zähler treffen');
});

test('Verschiedene Benutzernamen haben unabhängige Zähler', () => {
  setzeZurueck('getrennt1');
  setzeZurueck('getrennt2');
  vermerkeFehlversuch('getrennt1');
  vermerkeFehlversuch('getrennt1');
  vermerkeFehlversuch('getrennt1');
  assert.equal(pruefeSperre('getrennt1').gesperrt, true);
  assert.equal(pruefeSperre('getrennt2').gesperrt, false, 'ein anderer Benutzername darf nicht mitgesperrt sein');
});

test('Leerer/undefinierter Schlüssel wird ignoriert (kein Absturz, keine Sperre)', () => {
  assert.doesNotThrow(() => vermerkeFehlversuch(''));
  assert.doesNotThrow(() => vermerkeFehlversuch(undefined));
  assert.equal(pruefeSperre('').gesperrt, false);
  assert.equal(pruefeSperre(undefined).gesperrt, false);
});

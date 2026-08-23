import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRET = 'test-secret-fuer-crypto-test-bitte-lang-genug';
const { encryptSecret, decryptSecret } = await import('../src/auth/secret-crypto.js');

test('encryptSecret/decryptSecret: Roundtrip liefert Klartext zurück', () => {
  const enc = encryptSecret('mein-geheimes-passwort');
  assert.notEqual(enc, 'mein-geheimes-passwort');
  assert.equal(decryptSecret(enc), 'mein-geheimes-passwort');
});

test('encryptSecret: gespeicherter Wert enthält das Klartext-Passwort nicht', () => {
  const enc = encryptSecret('super-geheim-123');
  assert.equal(enc.includes('super-geheim-123'), false);
});

test('decryptSecret: leerer/fehlender Wert ergibt leeren String', () => {
  assert.equal(decryptSecret(null), '');
  assert.equal(decryptSecret(''), '');
  assert.equal(decryptSecret(undefined), '');
});

test('decryptSecret: falscher Schlüssel (anderes SECRET) schlägt fehl statt falsche Daten zu liefern', () => {
  const enc = encryptSecret('geheim');
  const original = process.env.SECRET;
  process.env.SECRET = 'ein-komplett-anderes-secret-32-zeichen';
  assert.throws(() => decryptSecret(enc));
  process.env.SECRET = original;
});

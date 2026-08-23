/**
 * Symmetrische Verschlüsselung für Geheimnisse, die in der DB liegen aber
 * nie im Klartext gespeichert oder angezeigt werden dürfen (aktuell: das
 * LDAP-Service-Account-Passwort aus den Admin-Einstellungen).
 *
 * Der Schlüssel wird aus der ENV-Variable SECRET abgeleitet (Session-Secret,
 * ohnehin Pflicht in Produktion). Ändert sich SECRET, werden bestehende
 * verschlüsselte Werte unlesbar — genau wie bestehende Sessions dann auch
 * ungültig werden. Das ist ein bewusster Kompromiss: kein zweites,
 * separat zu pflegendes Secret nötig.
 */

import crypto from 'node:crypto';

function deriveKey() {
  const secret = process.env.SECRET;
  if (!secret) {
    throw new Error('SECRET fehlt — Verschlüsselung von Geheimnissen ist ohne Session-Secret nicht möglich.');
  }
  return crypto.scryptSync(secret, 'noten-webapp-secret-crypto-v1', 32);
}

/** Verschlüsselt einen Klartext-String zu einem base64-kodierten Blob (iv + authTag + ciphertext). */
export function encryptSecret(plain) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Entschlüsselt einen mit encryptSecret erzeugten Blob. Leerer/fehlender Wert → ''. */
export function decryptSecret(stored) {
  if (!stored) return '';
  const key = deriveKey();
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

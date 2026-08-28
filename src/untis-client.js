/**
 * Client für die (inoffizielle, reverse-engineerte) WebUntis JSON-RPC-API.
 * Es gibt keine öffentlich dokumentierte, offizielle Schnittstelle für
 * Lehrkraft-Logins — Untis selbst bietet dafür nur eine Partner-API mit
 * schulweiten OAuth-Client-Credentials an, die ein Admin einrichten müsste.
 * Diese Anbindung nutzt bewusst NUR das, was ein normaler Lehrkraft-Login
 * in Untis selbst sehen kann, und speichert nie ein Untis-Passwort/-Secret —
 * die Lehrkraft meldet sich bei jeder Verbindung neu an (siehe
 * routes/untis-import.js).
 *
 * ZWEI ANMELDEARTEN:
 * - Benutzername + Passwort → POST /WebUntis/jsonrpc.do, Methode
 *   "authenticate". Funktioniert nur, wenn am Konto KEINE
 *   Zwei-Faktor-Authentifizierung erzwungen wird.
 * - Benutzername + "Secret" → POST /WebUntis/jsonrpc_intern.do,
 *   Methode "getUserData2017" mit einem aus dem Secret berechneten
 *   6-stelligen TOTP-Code (otp) + clientTime, genau der Mechanismus, den
 *   Untis Mobile für den Login bei aktiver Zwei-Faktor-Authentifizierung
 *   nutzt. Das Secret bekommt man im WebUntis-Profil unter
 *   "Freigaben"/"Mobile-Zugriff" → "QR-Code anzeigen" (das Secret steckt
 *   im QR-Code, meist auch als Klartext daneben). ACHTUNG: erneutes
 *   Anzeigen/Erzeugen des QR-Codes kann eine bereits gekoppelte
 *   Untis-Mobile-App-Anmeldung auf dem Handy ungültig machen.
 *
 * WICHTIGE EINSCHRÄNKUNG (unabhängig von der Anmeldeart): getStudents()
 * liefert ALLE Schüler/innen der Schule ohne Klassen-Zuordnung — es gibt
 * keine dokumentierte Methode, die direkt "Schüler/innen einer Klasse"
 * liefert. Als bester verfügbarer Ansatz wird getStudentGroupMembers(klasseId)
 * versucht (in vielen Untis-Konfigurationen ist eine feste Klasse zugleich
 * eine "Studentengruppe" mit derselben ID) — das kann je nach Schule/Rechten
 * leer bleiben oder fehlschlagen; das ist kein Bug, siehe Kommentar in
 * routes/untis-import.js.
 */

import crypto from 'node:crypto';

const CLIENT_NAME = 'notenverwaltung';

function bereinigeHost(server) {
  // Robust gegen versehentlich mit eingegebenes "https://" oder einen
  // Pfad/Slash im Server-Feld (führt sonst zu einer kaputten URL bzw.
  // einem irreführenden Fehler, ohne dass der eigentliche Tippfehler auffällt).
  return String(server).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function baueCookie(school, sessionId) {
  const schoolBase64 = Buffer.from(school, 'utf8').toString('base64');
  return `JSESSIONID=${sessionId}; schoolname=_${schoolBase64}`;
}

function fehlerAusAntwort(res, url, bodyText) {
  const kurzerBody = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`Untis antwortet mit HTTP ${res.status} für ${url}` + (kurzerBody ? ` — Antwort: "${kurzerBody}"` : ''));
}

async function rpc(server, school, method, params, cookie) {
  const host = bereinigeHost(server);
  const url = `https://${host}/WebUntis/jsonrpc.do?school=${encodeURIComponent(school)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'req1', method, params: params || {}, jsonrpc: '2.0' }),
    });
  } catch (e) {
    throw new Error(`Untis-Server nicht erreichbar (${url}): ${e.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) throw fehlerAusAntwort(res, url, bodyText);
  const data = JSON.parse(bodyText);
  if (data.error) {
    throw new Error(`Untis-Fehler ${data.error.code ?? ''}: ${data.error.message || 'unbekannt'}`.trim());
  }
  return data.result;
}

// ---------- TOTP (RFC 6238) für die Secret-basierte Anmeldung ----------

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const zeichen of clean) {
    const wert = alphabet.indexOf(zeichen);
    if (wert === -1) continue;
    bits += wert.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function berechneTotp(secret, zeitMs, schrittSekunden = 30, stellen = 6) {
  const key = base32Decode(secret);
  const counter = Math.floor(zeitMs / 1000 / schrittSekunden);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return binCode % 10 ** stellen;
}

async function anmeldenMitSecret({ server, school, username, secret }) {
  const host = bereinigeHost(server);
  const clientTime = Date.now();
  const otp = berechneTotp(secret, clientTime);
  const url = `https://${host}/WebUntis/jsonrpc_intern.do?m=getUserData2017&school=${encodeURIComponent(school)}&v=i2.2`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req1', method: 'getUserData2017', jsonrpc: '2.0',
        params: [{ auth: { user: username, otp, clientTime } }],
      }),
    });
  } catch (e) {
    throw new Error(`Untis-Server nicht erreichbar (${url}): ${e.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) throw fehlerAusAntwort(res, url, bodyText);
  const setCookieHeader = res.headers.get('set-cookie') || '';
  const treffer = setCookieHeader.match(/JSESSIONID=([^;]+)/);
  if (!treffer) {
    let meldung = 'Untis-Anmeldung mit Secret fehlgeschlagen — keine Sitzung erhalten. Benutzername/Secret prüfen.';
    try {
      const data = JSON.parse(bodyText);
      if (data?.error?.message) meldung += ` (${data.error.message})`;
    } catch { /* Antwort war kein JSON */ }
    throw new Error(meldung);
  }
  return { sessionId: treffer[1] };
}

const echterClient = {
  async anmelden({ server, school, username, password, secret }) {
    if (secret) {
      return anmeldenMitSecret({ server, school, username, secret });
    }
    const result = await rpc(server, school, 'authenticate', { user: username, password, client: CLIENT_NAME });
    if (!result || !result.sessionId) {
      const code = result?.code;
      throw new Error(code
        ? `Untis-Anmeldung fehlgeschlagen (Code ${code}) — Benutzername/Passwort prüfen.`
        : 'Untis-Anmeldung fehlgeschlagen — Benutzername/Passwort prüfen.');
    }
    return {
      sessionId: result.sessionId, personId: result.personId,
      personType: result.personType, klasseId: result.klasseId,
    };
  },

  async abmelden({ server, school, sessionId }) {
    await rpc(server, school, 'logout', {}, baueCookie(school, sessionId));
  },

  async klassen({ server, school, sessionId }) {
    const result = await rpc(server, school, 'getKlassen', {}, baueCookie(school, sessionId));
    return Array.isArray(result) ? result : [];
  },

  async studentGroupMitglieder({ server, school, sessionId, groupId }) {
    const result = await rpc(
      server, school, 'getStudentGroupMembers', { groupId }, baueCookie(school, sessionId),
    );
    return Array.isArray(result) ? result : [];
  },
};

let _override;

/** Nur für Tests: injiziert einen Fake-Client (oder setzt zurück mit `undefined`). */
export function setUntisClientForTests(client) {
  _override = client;
}

function client() {
  return _override || echterClient;
}

export async function untisAnmelden(args) { return client().anmelden(args); }
export async function untisAbmelden(args) { return client().abmelden(args); }
export async function untisKlassen(args) { return client().klassen(args); }
export async function untisStudentGroupMitglieder(args) { return client().studentGroupMitglieder(args); }

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
 * SESSION-COOKIE: Bei beiden Anmeldearten werden ALLE vom Server per
 * Set-Cookie gesendeten Cookies unverändert für die folgenden Aufrufe
 * wiederverwendet (statt nur die JSESSIONID herauszulesen und einen
 * schoolname-Cookie von Hand nachzubauen) — ein von Hand falsch
 * zusammengesetzter Cookie führte zuvor zu "-8520: not authenticated" bei
 * an sich erfolgreicher Anmeldung.
 *
 * WICHTIGE EINSCHRÄNKUNG (unabhängig von der Anmeldeart): getKlassen()
 * liefert ausnahmslos ALLE Klassen der ganzen Schule, nicht nur die der
 * anmeldenden Lehrkraft — deshalb wird zusätzlich versucht, über den
 * eigenen Stundenplan (getTimetable für die eigene Person, siehe zeitplan()
 * unten) einzugrenzen, welche Klassen die Lehrkraft im Import-Zeitraum
 * tatsächlich unterrichtet (Details in routes/untis-import.js). Schlägt das
 * fehl, werden wie bisher alle Klassen der Schule angezeigt.
 * Für Schülerlisten je Klasse gibt es KEINE dokumentierte Methode:
 * getStudentGroupMembers(klasseId) existiert auf manchen Untis-Instanzen
 * gar nicht (-32601), und der schulweite Fallback getStudents() benötigt
 * das Recht "masterdata students read for all" (schlägt ohne dieses Recht
 * mit -8509 fehl) — siehe routes/untis-import.js für den CSV-Datei-Upload
 * als praktikable Alternative in diesem Fall.
 */

import crypto from 'node:crypto';

const CLIENT_NAME = 'notenverwaltung';

function bereinigeHost(server) {
  // Robust gegen versehentlich mit eingegebenes "https://" oder einen
  // Pfad/Slash im Server-Feld (führt sonst zu einer kaputten URL bzw.
  // einem irreführenden Fehler, ohne dass der eigentliche Tippfehler auffällt).
  return String(server).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

/** Alle Set-Cookie-Header einer Antwort als Array roher Cookie-Strings. */
function alleSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const einzeln = res.headers.get('set-cookie');
  return einzeln ? [einzeln] : [];
}

/** Baut aus mehreren Set-Cookie-Strings einen kombinierten Cookie-Header (nur name=value, ohne Attribute). */
export function cookieHeaderAus(setCookieStrings) {
  return setCookieStrings
    .map((s) => s.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

export function findeCookieWert(cookieHeader, name) {
  const treffer = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader || '');
  return treffer ? treffer[1] : null;
}

// Fallback, falls der Server ausnahmsweise keinen schoolname-Cookie mitschickt
// (siehe Dokumentation der Community-Reverse-Engineering-Projekte) — wird nur
// verwendet, wenn aus den echten Set-Cookie-Headern kein cookieHeader entsteht.
function baueFallbackCookie(school, sessionId) {
  const schoolBase64 = Buffer.from(school, 'utf8').toString('base64');
  return `JSESSIONID=${sessionId}; schoolname=_${schoolBase64}`;
}

function fehlerAusAntwort(res, url, bodyText) {
  const kurzerBody = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`Untis antwortet mit HTTP ${res.status} für ${url}` + (kurzerBody ? ` — Antwort: "${kurzerBody}"` : ''));
}

async function rpc(server, school, method, params, cookieHeader) {
  const host = bereinigeHost(server);
  const url = `https://${host}/WebUntis/jsonrpc.do?school=${encodeURIComponent(school)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers.Cookie = cookieHeader;
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
  return { result: data.result, neuerCookieHeader: cookieHeaderAus(alleSetCookies(res)) || null };
}

/**
 * Ermittelt personId/personType der eingeloggten Person über den
 * dokumentierten REST-Endpunkt /WebUntis/api/app/config (denselben, den
 * Untis Mobile nach dem Login abfragt) — funktioniert mit derselben Session
 * unabhängig davon, ob per Passwort oder per Secret/TOTP angemeldet wurde.
 * Wird für den optionalen "nur meine Klassen"-Filter beim Import genutzt
 * (siehe routes/untis-import.js); schlägt der Aufruf fehl, zeigt der Import
 * wie bisher alle Klassen der Schule.
 */
async function eigeneIdentitaet({ server, school, cookieHeader }) {
  const host = bereinigeHost(server);
  const url = `https://${host}/WebUntis/api/app/config`;
  let res;
  try {
    res = await fetch(url, { headers: { Cookie: cookieHeader } });
  } catch (e) {
    throw new Error(`Untis-Server nicht erreichbar (${url}): ${e.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) throw fehlerAusAntwort(res, url, bodyText);
  const data = JSON.parse(bodyText);
  const user = data?.data?.loginServiceConfig?.user;
  const personId = user?.personId;
  if (personId === undefined || personId === null) {
    throw new Error('Untis-Profildaten (app/config) enthalten keine personId.');
  }
  const personType = (user.persons || []).find((p) => p.id === personId)?.type ?? null;
  return { personId, personType };
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
  const cookieHeader = cookieHeaderAus(alleSetCookies(res));
  const sessionId = findeCookieWert(cookieHeader, 'JSESSIONID');
  if (!sessionId) {
    let meldung = 'Untis-Anmeldung mit Secret fehlgeschlagen — keine Sitzung erhalten. Benutzername/Secret prüfen.';
    try {
      const data = JSON.parse(bodyText);
      if (data?.error?.message) meldung += ` (${data.error.message})`;
    } catch { /* Antwort war kein JSON */ }
    throw new Error(meldung);
  }
  return { sessionId, cookieHeader };
}

const echterClient = {
  async anmelden({ server, school, username, password, secret }) {
    if (secret) {
      return anmeldenMitSecret({ server, school, username, secret });
    }
    const { result, neuerCookieHeader } = await rpc(
      server, school, 'authenticate', { user: username, password, client: CLIENT_NAME },
    );
    if (!result || !result.sessionId) {
      const code = result?.code;
      throw new Error(code
        ? `Untis-Anmeldung fehlgeschlagen (Code ${code}) — Benutzername/Passwort prüfen.`
        : 'Untis-Anmeldung fehlgeschlagen — Benutzername/Passwort prüfen.');
    }
    return {
      sessionId: result.sessionId, personId: result.personId,
      personType: result.personType, klasseId: result.klasseId,
      cookieHeader: neuerCookieHeader || baueFallbackCookie(school, result.sessionId),
    };
  },

  async abmelden({ server, school, cookieHeader }) {
    await rpc(server, school, 'logout', {}, cookieHeader);
  },

  async klassen({ server, school, cookieHeader }) {
    const { result } = await rpc(server, school, 'getKlassen', {}, cookieHeader);
    return Array.isArray(result) ? result : [];
  },

  async studentGroupMitglieder({ server, school, cookieHeader, groupId }) {
    const { result } = await rpc(server, school, 'getStudentGroupMembers', { groupId }, cookieHeader);
    return Array.isArray(result) ? result : [];
  },

  // Liefert ALLE Schüler/innen der ganzen Schule (kein Klassenbezug in den
  // Feldern dokumentiert) — Fallback, seit getStudentGroupMembers auf
  // manchen Untis-Instanzen mit "-32601: Method not found" gar nicht
  // existiert. Siehe routes/untis-import.js für den Zuordnungsversuch.
  // getStudents() benötigt laut Community-Dokumentation das Recht
  // "masterdata students read for all" — schlägt der schulweite Abruf mit
  // "-8509: no right for getStudents()" fehl, kann optional ein
  // klassenbezogener Filter mitgegeben werden (undokumentiert, nicht
  // offiziell belegt, ob dafür ein engeres Recht ausreicht).
  async studenten({ server, school, cookieHeader, filter }) {
    const { result } = await rpc(server, school, 'getStudents', filter || {}, cookieHeader);
    return Array.isArray(result) ? result : [];
  },

  async identitaet(args) {
    return eigeneIdentitaet(args);
  },

  // Eigener Stundenplan (getTimetable, element type 2 = Lehrkraft) im
  // angegebenen Datumsbereich (Format YYYYMMDD) — jede Stunde enthält ein
  // "kl"-Array mit den beteiligten Klassen. Daraus lässt sich ableiten,
  // welche Klassen die Lehrkraft im abgefragten Zeitraum tatsächlich
  // unterrichtet, im Unterschied zu getKlassen() (liefert ausnahmslos ALLE
  // Klassen der Schule). Für den eigenen Stundenplan ist laut
  // Community-Dokumentation kein zusätzliches Recht dokumentiert.
  async zeitplan({ server, school, cookieHeader, personId, personType, startDate, endDate }) {
    const { result } = await rpc(server, school, 'getTimetable', {
      options: {
        element: { id: personId, type: personType },
        startDate, endDate,
        showLsText: true, showStudentgroup: true,
      },
    }, cookieHeader);
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
export async function untisStudenten(args) { return client().studenten(args); }
export async function untisIdentitaet(args) { return client().identitaet(args); }
export async function untisZeitplan(args) { return client().zeitplan(args); }

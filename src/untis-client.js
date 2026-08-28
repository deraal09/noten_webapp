/**
 * Client für die (inoffizielle, reverse-engineerte) WebUntis JSON-RPC-API
 * (POST /WebUntis/jsonrpc.do?school=...). Es gibt keine öffentlich
 * dokumentierte, offizielle Schnittstelle für Lehrkraft-Logins — Untis
 * selbst bietet dafür nur eine Partner-API mit schulweiten OAuth-Client-
 * Credentials an, die ein Admin einrichten müsste. Diese Anbindung nutzt
 * bewusst NUR das, was ein normaler Lehrkraft-Login in Untis selbst sehen
 * kann, und speichert nie ein Untis-Passwort — die Lehrkraft meldet sich
 * bei jeder Verbindung neu an (siehe routes/untis-import.js).
 *
 * WICHTIGE EINSCHRÄNKUNG: getStudents() liefert ALLE Schüler/innen der
 * Schule ohne Klassen-Zuordnung — es gibt keine dokumentierte Methode, die
 * direkt "Schüler/innen einer Klasse" liefert. Als bester verfügbarer
 * Ansatz wird getStudentGroupMembers(klasseId) versucht (in vielen Untis-
 * Konfigurationen ist eine feste Klasse zugleich eine "Studentengruppe"
 * mit derselben ID) — das kann je nach Schule/Rechten leer bleiben oder
 * fehlschlagen; das ist kein Bug, siehe Kommentar in routes/untis-import.js.
 */

const CLIENT_NAME = 'notenverwaltung';

function baueCookie(school, sessionId) {
  const schoolBase64 = Buffer.from(school, 'utf8').toString('base64');
  return `JSESSIONID=${sessionId}; schoolname=_${schoolBase64}`;
}

async function rpc(server, school, method, params, cookie) {
  const url = `https://${server}/WebUntis/jsonrpc.do?school=${encodeURIComponent(school)}`;
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
    throw new Error(`Untis-Server nicht erreichbar (${server}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Untis antwortet mit HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    throw new Error(`Untis-Fehler ${data.error.code ?? ''}: ${data.error.message || 'unbekannt'}`.trim());
  }
  return data.result;
}

const echterClient = {
  async anmelden({ server, school, username, password }) {
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

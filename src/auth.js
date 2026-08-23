/**
 * Auth-Helfer: Session-basierte Authentifizierung, Passwort-Hashing,
 * Rollen-/Berechtigungs-Checks.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { LdapAuthenticator } from './auth/ldap.js';
import {
  isLdapConfigured as isLdapConfiguredIntern,
  isAutoProvisionEnabled as isAutoProvisionEnabledIntern,
  resolveLdapConfig,
} from './auth/ldap-settings.js';

export const SESSION_COOKIE = 'noten_session';

export function isLdapConfigured() {
  return isLdapConfiguredIntern();
}

export function isAutoProvisionEnabled() {
  return isAutoProvisionEnabledIntern();
}

let _ldapConfigOverride;

/**
 * Baut bei jedem Aufruf einen neuen LDAP-Authenticator aus der aktuellen
 * Konfiguration (DB-Einstellungen haben Vorrang vor ENV-Variablen, siehe
 * ldap-settings.js). Kein Caching über Requests hinweg, weil sich die
 * DB-Einstellungen zur Laufzeit ändern können (Admin-Oberfläche) — der
 * LDAP-Client selbst verbindet erst beim tatsächlichen Bind, das Bauen ist
 * also günstig.
 *
 * Gibt `null` zurück, wenn LDAP nicht konfiguriert ist. Wirft, wenn LDAP
 * konfiguriert, aber unvollständig ist (z. B. Base-DN fehlt) — der Aufrufer
 * entscheidet, wie er das dem Nutzer meldet.
 */
export function getLdapAuthenticator() {
  if (_ldapConfigOverride !== undefined) return _ldapConfigOverride;
  if (!isLdapConfigured()) return null;
  return new LdapAuthenticator(resolveLdapConfig());
}

/** Nur für Tests: injiziert einen Fake-Authenticator (oder setzt zurück mit `undefined`). */
export function setLdapAuthenticatorForTests(authenticator) {
  _ldapConfigOverride = authenticator;
}

/**
 * Legt bei erfolgreicher LDAP-Anmeldung eines noch unbekannten Nutzers
 * automatisch ein Konto an (nur wenn auto_provision aktiv ist, siehe
 * routes/auth.js). Bei einem Wettlauf zweier gleichzeitiger Erst-Logins
 * derselben Person wird die bereits angelegte Zeile verwendet statt ein
 * zweites Mal anzulegen.
 */
export function provisionLdapUser(ergebnis, eingegebenerName) {
  const db = getDb();
  const loginSub = ergebnis.loginSub || eingegebenerName;
  const username = loginSub;
  try {
    const info = db.prepare(`INSERT INTO users
      (username, display_name, password_hash, role, active, auth_source, login_sub)
      VALUES (?, ?, ?, 'teacher', 1, 'ldap', ?)`)
      .run(username, ergebnis.name || username, hashPassword(makeToken()), loginSub);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    const existing = db.prepare("SELECT * FROM users WHERE login_sub = ? AND auth_source = 'ldap'").get(loginSub);
    if (existing) return existing;
    throw new Error(
      `Automatische Kontoerstellung fehlgeschlagen: Benutzername "${username}" ist bereits vergeben. ` +
      'Bitte den Admin bitten, das Konto manuell mit abweichendem Benutzernamen anzulegen (Admin → LDAP-Import).',
    );
  }
}

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

export function checkPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

export function makeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Fastify-Preload: Session-User in request.user ablegen,
 * Login-Pflicht auf bestimmte Routen.
 */
export async function authPreHandler(request, reply) {
  const session = request.session;
  if (!session?.userId) return; // anonymous OK
  const user = getDb()
    .prepare('SELECT id, username, email, role, display_name, active FROM users WHERE id = ?')
    .get(session.userId);
  if (!user || !user.active) {
    await destroySession(request);
    return;
  }
  request.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    displayName: user.display_name,
    isAdmin: user.role === 'admin',
  };
}

// WICHTIG: Diese Funktionen werden als Fastify-preHandler eingesetzt und
// MÜSSEN async sein. Ein synchroner Hook mit Arität 2, der undefined
// zurückgibt (ohne done()), lässt Fastify v4 unendlich auf den Abschluss
// warten → jede geschützte Route hängt.
export async function requireAuth(request, reply) {
  if (!request.user) {
    return reply.code(401).redirect('/login?next=' + encodeURIComponent(request.url));
  }
}

/**
 * Zerstört die Session zuverlässig (Callback-API von @fastify/session
 * promisifiziert).
 */
export function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function requireAdmin(request, reply) {
  if (!request.user || !request.user.isAdmin) {
    return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
  }
}

/**
 * Berechtigungs-Check: Hat der User Zugriff auf die LIVE-Notentafel des
 * Fachs? Admins dürfen alles; sonst nur per FachZuweisung (eigenes oder
 * zugewiesenes Fach) — bewusst KEIN Blanket-Zugriff für die Klassenleitung:
 * Die soll nicht permanent live in fremde Notentafeln schauen können,
 * sondern nur über den Sync-Stand (siehe noten-sync.js, Halbjahresübersicht
 * unter /teacher/klassen/:id/uebersicht).
 */
export function userHatFachZgriff(user, fachId) {
  if (user.isAdmin) return true;
  const row = getDb()
    .prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?')
    .get(user.id, fachId);
  return Boolean(row);
}

/**
 * Klassenleitung: entweder in `klassenleitung` (klassenweit, siehe
 * routes/teacher.js Selbstregistrierung) oder in `klassen_lehrkraefte`
 * (Admin-Zuweisung, historisch je Fach eine Zeile, aber als klassenweite
 * Rolle geprüft — der fach_id-Wert dort spielt für diesen Check keine Rolle).
 */
export function userIstKlassenlehrer(user, klasseId) {
  if (user.isAdmin) return true;
  const db = getDb();
  const neu = db.prepare('SELECT 1 FROM klassenleitung WHERE user_id = ? AND klasse_id = ?')
    .get(user.id, klasseId);
  if (neu) return true;
  const alt = db.prepare('SELECT 1 FROM klassen_lehrkraefte WHERE user_id = ? AND klasse_id = ?')
    .get(user.id, klasseId);
  return Boolean(alt);
}

/**
 * Berechtigungs-Check fürs Selbstbedienungs-Klassenmanagement (Admin →
 * Klassenlisten können von allen selbst erstellt werden, siehe
 * routes/teacher.js): Ersteller/in einer Klasse behält immer Zugriff, auch
 * ohne separate Fach-Zuweisung; ebenso jede Lehrkraft mit Fach-Zuweisung
 * oder Klassenlehrer-Eintrag in dieser Klasse.
 */
export function userHatKlassenZugriff(user, klasseId) {
  if (user.isAdmin) return true;
  const db = getDb();
  const erstellt = db.prepare('SELECT 1 FROM klassen WHERE id = ? AND created_by_id = ?')
    .get(klasseId, user.id);
  if (erstellt) return true;
  const fach = db.prepare(`
    SELECT 1 FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id
    WHERE f.klasse_id = ? AND fz.user_id = ?
  `).get(klasseId, user.id);
  if (fach) return true;
  return userIstKlassenlehrer(user, klasseId);
}

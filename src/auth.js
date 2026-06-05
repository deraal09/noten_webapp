/**
 * Auth-Helfer: Session-basierte Authentifizierung, Passwort-Hashing,
 * Rollen-/Berechtigungs-Checks.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from './db.js';

export const SESSION_COOKIE = 'noten_session';

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
    request.session.destroy();
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

export function requireAuth(request, reply) {
  if (!request.user) {
    reply.code(401).redirect('/login?next=' + encodeURIComponent(request.url));
    return reply;
  }
}

export function requireAdmin(request, reply) {
  if (!request.user || !request.user.isAdmin) {
    reply.code(403);
    return reply.viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
  }
}

/**
 * Berechtigungs-Check: Hat der User Zugriff auf das Fach?
 * Admins dürfen alles; Lehrkräfte nur per FachZuweisung.
 */
export function userHatFachZgriff(user, fachId) {
  if (user.isAdmin) return true;
  const row = getDb()
    .prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?')
    .get(user.id, fachId);
  return Boolean(row);
}

export function userIstKlassenlehrer(user, klasseId) {
  if (user.isAdmin) return true;
  const row = getDb()
    .prepare('SELECT 1 FROM klassen_lehrkraefte WHERE user_id = ? AND klasse_id = ?')
    .get(user.id, klasseId);
  return Boolean(row);
}

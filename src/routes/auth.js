/**
 * Auth-Routen: Login, Logout, /setup (erster Admin), /einladung/<token>
 */

import { getDb } from '../db.js';
import {
  hashPassword, checkPassword, makeToken, SESSION_COOKIE, requireAuth, destroySession,
  getLdapAuthenticator, isLdapConfigured, isAutoProvisionEnabled, provisionLdapUser,
} from '../auth.js';

const MIN_PW_LEN = 8;
const MIN_USER_LEN = 3;

export default async function authRoutes(fastify) {
  // ---------- /setup (nur solange noch kein User existiert) ----------
  fastify.get('/setup', async (request, reply) => {
    const userCount = getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount > 0) {
      return reply.redirect('/login?msg=exists');
    }
    return reply.viewEjs('auth/setup.ejs', { user: request.user, error: null });
  });

  fastify.post('/setup', async (request, reply) => {
    const { username = '', display_name = '', password = '', password2 = '' } = request.body || {};
    const userCount = getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount > 0) return reply.redirect('/login');

    const u = String(username).trim();
    if (u.length < MIN_USER_LEN) {
      return reply.viewEjs('auth/setup.ejs', {
        user: null, error: 'Benutzername muss mindestens 3 Zeichen haben.',
      });
    }
    if (password !== password2) {
      return reply.viewEjs('auth/setup.ejs', { user: null, error: 'Passwörter stimmen nicht überein.' });
    }
    if (password.length < MIN_PW_LEN) {
      return reply.viewEjs('auth/setup.ejs', {
        user: null, error: 'Passwort muss mindestens 8 Zeichen haben.',
      });
    }
    try {
      const info = getDb()
        .prepare(`INSERT INTO users (username, display_name, password_hash, role, active)
                  VALUES (?, ?, ?, 'admin', 1)`)
        .run(u, String(display_name).trim() || u, hashPassword(password));
      request.session.userId = info.lastInsertRowid;
      return reply.redirect('/admin');
    } catch (e) {
      return reply.viewEjs('auth/setup.ejs', {
        user: null, error: 'Benutzername ist bereits vergeben.',
      });
    }
  });

  // ---------- /login ----------
  fastify.get('/login', async (request, reply) => {
    if (request.user) return reply.redirect('/');
    const userCount = getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount === 0) return reply.redirect('/setup');
    return reply.viewEjs('auth/login.ejs', { user: request.user, error: null, next: request.query.next || '' });
  });

  fastify.post('/login', async (request, reply) => {
    const { username = '', password = '' } = request.body || {};
    const next = request.body?.next || '';
    const uname = String(username).trim();
    let row = getDb()
      .prepare('SELECT id, username, password_hash, active, auth_source, login_sub FROM users WHERE username = ?')
      .get(uname);

    // Kein lokales/importiertes Konto bekannt: Ist Auto-Provisioning aktiv,
    // bei erfolgreicher LDAP-Anmeldung automatisch ein Konto anlegen statt
    // den Login abzulehnen (siehe Admin → LDAP-Einstellungen).
    if (!row && isLdapConfigured() && isAutoProvisionEnabled() && uname && password) {
      let ergebnis;
      try {
        const ldap = getLdapAuthenticator();
        ergebnis = ldap ? await ldap.authenticate(uname, password) : null;
      } catch (e) {
        request.log.error({ err: e }, 'Auto-Provisioning: LDAP-Anmeldung fehlgeschlagen (technischer Fehler)');
      }
      if (ergebnis) {
        try {
          const neu = provisionLdapUser(ergebnis, uname);
          request.session.userId = neu.id;
          const safeNext = /^\/(?!\/)/.test(String(next)) ? String(next) : '/';
          return reply.redirect(safeNext);
        } catch (e) {
          request.log.error({ err: e }, 'Auto-Provisioning: Kontoerstellung fehlgeschlagen');
          return reply.viewEjs('auth/login.ejs', { user: null, error: e.message, next: '' });
        }
      }
    }

    if (!row) {
      return reply.viewEjs('auth/login.ejs', {
        user: null, error: 'Benutzername oder Passwort ist falsch.', next,
      });
    }
    if (!row.active) {
      return reply.viewEjs('auth/login.ejs', {
        user: null, error: 'Konto ist deaktiviert. Bitte an den Admin wenden.', next: '',
      });
    }

    if (row.auth_source === 'ldap') {
      let ergebnis;
      try {
        const ldap = getLdapAuthenticator();
        if (!ldap) throw new Error('LDAP_URL fehlt');
        ergebnis = await ldap.authenticate(row.login_sub || row.username, password);
      } catch (e) {
        request.log.error({ err: e }, 'LDAP-Login fehlgeschlagen (technischer Fehler)');
        return reply.viewEjs('auth/login.ejs', {
          user: null,
          error: 'LDAP-Anmeldung ist gerade nicht verfügbar. Bitte später erneut versuchen oder an den Admin wenden.',
          next: '',
        });
      }
      if (!ergebnis) {
        return reply.viewEjs('auth/login.ejs', {
          user: null, error: 'Benutzername oder Passwort ist falsch.', next,
        });
      }
    } else if (!checkPassword(password, row.password_hash)) {
      return reply.viewEjs('auth/login.ejs', {
        user: null, error: 'Benutzername oder Passwort ist falsch.', next,
      });
    }

    request.session.userId = row.id;
    // Nur relative Pfade ohne Host erlauben (Open-Redirect-Schutz).
    const safeNext = /^\/(?!\/)/.test(String(next)) ? String(next) : '/';
    return reply.redirect(safeNext);
  });

  // ---------- /logout ----------
  fastify.get('/logout', { preHandler: requireAuth }, async (request, reply) => {
    await destroySession(request);
    return reply.redirect('/login');
  });

  // ---------- /einladung/<token> ----------
  fastify.get('/einladung/:token', async (request, reply) => {
    const inv = getDb()
      .prepare(`SELECT id, token, email, display_name, role, expires_at, used_at
                FROM invitations WHERE token = ?`)
      .get(request.params.token);
    if (!inv) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: null, error: 'Einladung nicht gefunden.',
      });
    }
    const valid =
      !inv.used_at && (!inv.expires_at || new Date(inv.expires_at) > new Date());
    if (!valid) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: null,
        error: 'Dieser Einladungslink ist abgelaufen oder bereits eingelöst.',
      });
    }
    return reply.viewEjs('auth/accept_invitation.ejs', {
      user: request.user, invitation: inv, error: null,
    });
  });

  fastify.post('/einladung/:token', async (request, reply) => {
    const inv = getDb()
      .prepare(`SELECT id, token, email, display_name, role, expires_at, used_at
                FROM invitations WHERE token = ?`)
      .get(request.params.token);
    if (!inv) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Einladung nicht gefunden.' });
    const valid = !inv.used_at && (!inv.expires_at || new Date(inv.expires_at) > new Date());
    if (!valid) return reply.redirect('/login?msg=invite_expired');

    const { username = '', display_name = '', password = '', password2 = '' } = request.body || {};
    const u = String(username).trim();
    if (u.length < MIN_USER_LEN) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: inv, error: 'Benutzername muss mindestens 3 Zeichen haben.',
      });
    }
    if (password !== password2) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: inv, error: 'Passwörter stimmen nicht überein.',
      });
    }
    if (password.length < MIN_PW_LEN) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: inv, error: 'Passwort muss mindestens 8 Zeichen haben.',
      });
    }
    try {
      const tx = getDb().transaction(() => {
        const info = getDb()
          .prepare(`INSERT INTO users (username, display_name, email, password_hash, role, active, invited_by_id)
                    VALUES (?, ?, ?, ?, ?, 1, ?)`)
          .run(u, String(display_name).trim() || inv.display_name || u,
               inv.email, hashPassword(password), inv.role, inv.created_by_id);
        getDb()
          .prepare(`UPDATE invitations SET used_at = datetime('now'), used_by_id = ? WHERE id = ?`)
          .run(info.lastInsertRowid, inv.id);
        return info.lastInsertRowid;
      });
      const newId = tx();
      request.session.userId = newId;
      return reply.redirect('/');
    } catch (e) {
      return reply.viewEjs('auth/accept_invitation.ejs', {
        user: request.user, invitation: inv, error: 'Benutzername ist bereits vergeben – bitte einen anderen wählen.',
      });
    }
  });
}

/**
 * Admin-Routen: Schuljahre, Klassen, Schüler, Fächer, Einladungen,
 * Zuweisungen, Notenschlüssel, User-Verwaltung.
 */

import { getDb } from '../db.js';
import { requireAdmin, makeToken, hashPassword, isLdapConfigured } from '../auth.js';
import { DEFAULT_NS_CSV, DEFAULT_GEWICHTUNG } from '../grade-calc.js';
import { searchLehrkraefte } from '../auth/ldap.js';
import {
  getLdapSettingsRow, saveLdapSettings, clearLdapBindPassword, resolveLdapConfig,
} from '../auth/ldap-settings.js';

export default async function adminRoutes(fastify) {
  fastify.addHook('preHandler', requireAdmin);

  // ---------- Dashboard ----------
  fastify.get('/', async (request, reply) => {
    const db = getDb();
    const stats = {
      users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      schuljahre: db.prepare('SELECT COUNT(*) AS c FROM schuljahre').get().c,
      klassen: db.prepare('SELECT COUNT(*) AS c FROM klassen').get().c,
      schueler: db.prepare('SELECT COUNT(*) AS c FROM schueler').get().c,
      faecher: db.prepare('SELECT COUNT(*) AS c FROM faecher').get().c,
      offene_einladungen: db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE used_at IS NULL').get().c,
    };
    const schuljahre = db.prepare(
      'SELECT * FROM schuljahre ORDER BY bezeichnung DESC'
    ).all();
    return reply.viewEjs('admin/dashboard.ejs', { user: request.user, stats, schuljahre });
  });

  // ---------- Schuljahre ----------
  fastify.post('/schuljahre/neu', async (request, reply) => {
    const bez = String(request.body?.bezeichnung || '').trim();
    if (!bez) {
      request.flash?.('error', 'Bezeichnung fehlt.');
      return reply.redirect('/admin');
    }
    try {
      getDb().prepare('INSERT INTO schuljahre (bezeichnung, gewichtung_muendlich) VALUES (?, ?)')
        .run(bez, DEFAULT_GEWICHTUNG);
    } catch (e) {
      request.flash?.('error', 'Schuljahr existiert bereits.');
    }
    return reply.redirect('/admin');
  });

  fastify.post('/schuljahre/:id/loeschen', async (request, reply) => {
    getDb().prepare('DELETE FROM schuljahre WHERE id = ?').run(request.params.id);
    return reply.redirect('/admin');
  });

  fastify.post('/schuljahre/:id/gewichtung', async (request, reply) => {
    const wert = parseInt(request.body?.gewichtung, 10);
    if (!Number.isFinite(wert) || wert < 0 || wert > 100) {
      request.flash?.('error', 'Ungültige Gewichtung (0–100).');
    } else {
      getDb().prepare('UPDATE schuljahre SET gewichtung_muendlich = ? WHERE id = ?')
        .run(wert, request.params.id);
    }
    return reply.redirect('/admin');
  });

  // ---------- Schuljahr-Detail (Klassen) ----------
  fastify.get('/schuljahre/:id', async (request, reply) => {
    const sj = getDb().prepare('SELECT * FROM schuljahre WHERE id = ?').get(request.params.id);
    if (!sj) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schuljahr nicht gefunden.' });
    const klassen = getDb().prepare(
      'SELECT * FROM klassen WHERE schuljahr_id = ? ORDER BY name'
    ).all(sj.id);
    return reply.viewEjs('admin/schuljahr_detail.ejs', { user: request.user, schuljahr: sj, klassen });
  });

  fastify.post('/schuljahre/:id/klassen/neu', async (request, reply) => {
    const name = String(request.body?.name || '').trim();
    let ns = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG'].includes(ns)) ns = 'IHK';
    if (!name) return reply.redirect(`/admin/schuljahre/${request.params.id}`);
    try {
      getDb().prepare(
        'INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv) VALUES (?, ?, ?, ?)'
      ).run(request.params.id, name, ns, DEFAULT_NS_CSV[ns]);
    } catch (e) {
      request.flash?.('error', 'Klasse existiert bereits.');
    }
    return reply.redirect(`/admin/schuljahre/${request.params.id}`);
  });

  // ---------- Klassen ----------
  fastify.get('/klassen/:id', async (request, reply) => {
    const klasse = getKlasseMitSchuljahr(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(klasse.id);
    const faecher = getDb().prepare(
      'SELECT f.*, '
      + '  (SELECT GROUP_CONCAT(u.display_name || COALESCE(NULLIF(\' / \' || u.username, \' / \'), \'\'), \', \') '
      + '     FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id WHERE fz.fach_id = f.id) AS lehrer_liste '
      + 'FROM faecher f WHERE f.klasse_id = ? ORDER BY f.name'
    ).all(klasse.id);
    return reply.viewEjs('admin/klasse_detail.ejs', {
      user: request.user, klasse, schueler, faecher,
    });
  });

  fastify.post('/klassen/:id/loeschen', async (request, reply) => {
    const sjId = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(request.params.id)?.schuljahr_id;
    getDb().prepare('DELETE FROM klassen WHERE id = ?').run(request.params.id);
    return reply.redirect(`/admin/schuljahre/${sjId}`);
  });

  // ---------- Schüler ----------
  fastify.post('/klassen/:id/schueler/neu', async (request, reply) => {
    const nn = String(request.body?.nachname || '').trim();
    const vn = String(request.body?.vorname || '').trim();
    if (nn && vn) {
      getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
        .run(request.params.id, nn, vn);
    }
    return reply.redirect(`/admin/klassen/${request.params.id}`);
  });

  fastify.post('/klassen/:id/schueler/bulk', async (request, reply) => {
    const text = String(request.body?.text || '');
    const ins = getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)');
    const tx = getDb().transaction((lines) => {
      let count = 0;
      for (const line of lines) {
        const [nn, vn] = line.split(',', 2).map((s) => s.trim());
        if (!nn) continue;
        ins.run(request.params.id, nn, vn || '');
        count++;
      }
      return count;
    });
    tx(text.split(/\r?\n/));
    return reply.redirect(`/admin/klassen/${request.params.id}`);
  });

  fastify.post('/schueler/:id/loeschen', async (request, reply) => {
    const klasseId = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?')
      .get(request.params.id)?.klasse_id;
    getDb().prepare('DELETE FROM schueler WHERE id = ?').run(request.params.id);
    return reply.redirect(`/admin/klassen/${klasseId}`);
  });

  // ---------- Fächer ----------
  fastify.post('/klassen/:id/faecher/neu', async (request, reply) => {
    const name = String(request.body?.name || '').trim();
    if (name) {
      try {
        getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)')
          .run(request.params.id, name);
      } catch (e) {
        request.flash?.('error', 'Fach existiert bereits in dieser Klasse.');
      }
    }
    return reply.redirect(`/admin/klassen/${request.params.id}`);
  });

  fastify.post('/faecher/:id/loeschen', async (request, reply) => {
    const klasseId = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?')
      .get(request.params.id)?.klasse_id;
    getDb().prepare('DELETE FROM faecher WHERE id = ?').run(request.params.id);
    return reply.redirect(`/admin/klassen/${klasseId}`);
  });

  // ---------- Notenschlüssel ----------
  fastify.get('/klassen/:id/notenschluessel', async (request, reply) => {
    const klasse = getKlasseMitSchuljahr(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    return reply.viewEjs('admin/notenschluessel.ejs', { user: request.user, klasse });
  });

  fastify.post('/klassen/:id/notenschluessel', async (request, reply) => {
    const csv = String(request.body?.csv || '').trim();
    let ns = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG'].includes(ns)) ns = 'IHK';
    getDb().prepare('UPDATE klassen SET notenschluessel = ?, notenschluessel_csv = ? WHERE id = ?')
      .run(ns, csv, request.params.id);
    return reply.redirect(`/admin/klassen/${request.params.id}/notenschluessel`);
  });

  // ---------- User-Verwaltung ----------
  fastify.get('/users', async (request, reply) => {
    const users = getDb().prepare(
      'SELECT * FROM users ORDER BY role, username'
    ).all();
    return reply.viewEjs('admin/users.ejs', { user: request.user, users });
  });

  fastify.post('/users/:id/toggle', async (request, reply) => {
    if (Number(request.params.id) === request.user.id) {
      request.flash?.('error', 'Du kannst dich nicht selbst deaktivieren.');
      return reply.redirect('/admin/users');
    }
    getDb().prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(request.params.id);
    return reply.redirect('/admin/users');
  });

  fastify.post('/users/:id/reset', async (request, reply) => {
    const ziel = getDb().prepare('SELECT auth_source FROM users WHERE id = ?').get(request.params.id);
    if (ziel?.auth_source === 'ldap') {
      request.flash?.('error', 'LDAP-Konten haben kein lokales Passwort — das Passwort wird im Verzeichnis verwaltet.');
      return reply.redirect('/admin/users');
    }
    const pw = String(request.body?.password || '');
    if (pw.length < 8) {
      request.flash?.('error', 'Passwort muss mindestens 8 Zeichen haben.');
    } else {
      getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(pw), request.params.id);
    }
    return reply.redirect('/admin/users');
  });

  // ---------- LDAP: Einstellungen ----------
  fastify.get('/ldap/einstellungen', async (request, reply) => {
    const settings = getLdapSettingsRow();
    return reply.viewEjs('admin/ldap_einstellungen.ejs', {
      user: request.user,
      settings,
      envGesetzt: Boolean(process.env.LDAP_URL),
    });
  });

  fastify.post('/ldap/einstellungen', async (request, reply) => {
    const b = request.body || {};
    try {
      saveLdapSettings({
        url: String(b.url || '').trim(),
        base_dn: String(b.base_dn || '').trim(),
        user_filter: String(b.user_filter || '').trim(),
        bind_user_template: String(b.bind_user_template || '').trim(),
        bind_dn: String(b.bind_dn || '').trim(),
        bind_pw: String(b.bind_pw || ''), // leer = bestehendes Passwort unverändert lassen
        login_attr: String(b.login_attr || '').trim(),
        name_attr: String(b.name_attr || '').trim(),
        teacher_search_filter: String(b.teacher_search_filter || '').trim(),
        tls_ca_pem: String(b.tls_ca_pem || '').trim(),
        tls_reject_unauthorized: !b.tls_insecure,
        auto_provision: Boolean(b.auto_provision),
      });
      request.flash?.('success', 'LDAP-Einstellungen gespeichert.');
    } catch (e) {
      request.flash?.('error', 'Speichern fehlgeschlagen: ' + e.message);
    }
    return reply.redirect('/admin/ldap/einstellungen');
  });

  fastify.post('/ldap/einstellungen/passwort-loeschen', async (request, reply) => {
    clearLdapBindPassword();
    request.flash?.('success', 'Service-Account-Passwort entfernt.');
    return reply.redirect('/admin/ldap/einstellungen');
  });

  // ---------- LDAP: Lehrkräfte-Import ----------
  fastify.get('/ldap', async (request, reply) => {
    const konfiguriert = isLdapConfigured();
    const q = String(request.query?.q || '').trim();
    let ergebnisse = [];
    let error = null;
    if (konfiguriert && q) {
      try {
        ergebnisse = await searchLehrkraefte(resolveLdapConfig(), { query: q });
      } catch (e) {
        error = e.message;
      }
    } else if (!konfiguriert) {
      error = 'LDAP ist nicht konfiguriert. Unter „LDAP-Einstellungen" konfigurieren.';
    }
    const bekannt = new Set(
      getDb().prepare("SELECT login_sub FROM users WHERE auth_source = 'ldap'").all()
        .map((r) => r.login_sub),
    );
    return reply.viewEjs('admin/ldap.ejs', {
      user: request.user, konfiguriert, q, ergebnisse, error, bekannt,
    });
  });

  fastify.post('/ldap/import', async (request, reply) => {
    const loginSub = String(request.body?.login_sub || '').trim();
    const displayName = String(request.body?.display_name || '').trim();
    const username = String(request.body?.username || '').trim() || loginSub;
    const q = String(request.body?.q || '');
    if (!loginSub || !username) {
      request.flash?.('error', 'Kein LDAP-Kennzeichen übergeben.');
      return reply.redirect('/admin/ldap?q=' + encodeURIComponent(q));
    }
    try {
      getDb().prepare(`INSERT INTO users
        (username, display_name, password_hash, role, active, auth_source, login_sub)
        VALUES (?, ?, ?, 'teacher', 1, 'ldap', ?)`)
        .run(username, displayName || username, hashPassword(makeToken()), loginSub);
      request.flash?.('success', `Lehrkraft „${displayName || username}" wurde aus LDAP importiert und kann sich jetzt anmelden.`);
    } catch (e) {
      request.flash?.('error', 'Import fehlgeschlagen: Benutzername oder LDAP-Kennzeichen ist bereits vergeben.');
    }
    return reply.redirect('/admin/ldap?q=' + encodeURIComponent(q));
  });

  // ---------- Einladungen ----------
  fastify.get('/einladungen', async (request, reply) => {
    const einl = getDb().prepare(`
      SELECT i.*, u.username AS erstellt_von, bu.username AS verwendet_von
      FROM invitations i
      JOIN users u ON u.id = i.created_by_id
      LEFT JOIN users bu ON bu.id = i.used_by_id
      ORDER BY i.created_at DESC
    `).all();
    const users = getDb().prepare(
      "SELECT id, username, display_name FROM users WHERE role != 'admin' ORDER BY username"
    ).all();
    const faecher = getDb().prepare(`
      SELECT f.id, f.name, k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung
      FROM faecher f
      JOIN klassen k ON k.id = f.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      ORDER BY s.bezeichnung DESC, k.name, f.name
    `).all();
    return reply.viewEjs('admin/einladungen.ejs', {
      user: request.user, einladungen: einl, users, faecher,
    });
  });

  fastify.post('/einladungen/neu', async (request, reply) => {
    const email = String(request.body?.email || '').trim() || null;
    const display_name = String(request.body?.display_name || '').trim() || null;
    const ttl = parseInt(request.body?.ttl_days, 10) || 14;
    const expires = new Date(Date.now() + ttl * 86400 * 1000).toISOString();
    getDb().prepare(`INSERT INTO invitations
      (token, email, display_name, role, created_by_id, expires_at)
      VALUES (?, ?, ?, 'teacher', ?, ?)`)
      .run(makeToken(), email, display_name, request.user.id, expires);
    return reply.redirect('/admin/einladungen');
  });

  fastify.post('/einladungen/:id/loeschen', async (request, reply) => {
    getDb().prepare('DELETE FROM invitations WHERE id = ?').run(request.params.id);
    return reply.redirect('/admin/einladungen');
  });

  // ---------- Zuweisungen ----------
  fastify.get('/zuweisungen', async (request, reply) => {
    const users = getDb().prepare(
      "SELECT * FROM users WHERE role != 'admin' AND active = 1 ORDER BY username"
    ).all();
    const faecher = getDb().prepare(`
      SELECT f.id, f.name, k.id AS klasse_id, k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung
      FROM faecher f
      JOIN klassen k ON k.id = f.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      ORDER BY s.bezeichnung DESC, k.name, f.name
    `).all();
    const zuweisungen = getDb().prepare(`
      SELECT fz.id, u.username, u.display_name, f.name AS fach_name,
             k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung
      FROM fach_zuweisungen fz
      JOIN users u ON u.id = fz.user_id
      JOIN faecher f ON f.id = fz.fach_id
      JOIN klassen k ON k.id = f.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      ORDER BY u.username, s.bezeichnung, k.name
    `).all();
    const klassenlehrer = getDb().prepare(`
      SELECT kl.id, u.username, u.display_name, f.name AS fach_name,
             k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen_lehrkraefte kl
      JOIN users u ON u.id = kl.user_id
      JOIN faecher f ON f.id = kl.fach_id
      JOIN klassen k ON k.id = kl.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      ORDER BY u.username, s.bezeichnung, k.name
    `).all();
    return reply.viewEjs('admin/zuweisungen.ejs', {
      user: request.user, users, faecher, zuweisungen, klassenlehrer,
    });
  });

  fastify.post('/zuweisungen/neu', async (request, reply) => {
    const user_id = parseInt(request.body?.user_id, 10);
    const fach_id = parseInt(request.body?.fach_id, 10);
    if (!user_id || !fach_id) return reply.redirect('/admin/zuweisungen');
    try {
      getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
        .run(user_id, fach_id);
    } catch {}
    return reply.redirect('/admin/zuweisungen');
  });

  fastify.post('/zuweisungen/:id/loeschen', async (request, reply) => {
    getDb().prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(request.params.id);
    return reply.redirect('/admin/zuweisungen');
  });

  fastify.post('/klassenlehrer/neu', async (request, reply) => {
    const user_id = parseInt(request.body?.user_id, 10);
    const klasse_id = parseInt(request.body?.klasse_id, 10);
    const fach_id = parseInt(request.body?.fach_id, 10);
    if (!user_id || !klasse_id || !fach_id) return reply.redirect('/admin/zuweisungen');
    try {
      getDb().prepare('INSERT INTO klassen_lehrkraefte (user_id, klasse_id, fach_id) VALUES (?, ?, ?)')
        .run(user_id, klasse_id, fach_id);
    } catch {}
    return reply.redirect('/admin/zuweisungen');
  });

  fastify.post('/klassenlehrer/:id/loeschen', async (request, reply) => {
    getDb().prepare('DELETE FROM klassen_lehrkraefte WHERE id = ?').run(request.params.id);
    return reply.redirect('/admin/zuweisungen');
  });
}

function getKlasseMitSchuljahr(id) {
  return getDb().prepare(`
    SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE k.id = ?
  `).get(id);
}

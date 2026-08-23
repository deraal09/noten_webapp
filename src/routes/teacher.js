/**
 * Lehrkraft-Routen: Notentafel (AJAX), Klausuren, ULs, mündlich/schriftlich.
 * Zugriffsschutz: User muss dem Fach zugewiesen sein (oder Admin).
 */

import { getDb } from '../db.js';
import { requireAuth, userHatFachZgriff, userHatKlassenZugriff, userIstKlassenlehrer } from '../auth.js';
import { HALBJAHRE, NOTE_TYPEN, autoDistribute, DEFAULT_GEWICHTUNG, DEFAULT_NS_CSV } from '../grade-calc.js';
import { starteVerknuepfung, beantworteVerknuepfung } from '../klassen-verknuepfung.js';
import { ladeFachMitUmfeld, ladeNotenuebersicht } from '../noten-service.js';
import { syncFach, syncFallsAutoAktiv, holeSyncMeta } from '../noten-sync.js';

export default async function teacherRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ---------- Dashboard (Lehrkraft) ----------
  fastify.get('/', async (request, reply) => {
    if (request.user.isAdmin) {
      const schuljahre = getDb().prepare(
        'SELECT * FROM schuljahre ORDER BY bezeichnung DESC'
      ).all();
      return reply.viewEjs('teacher/dashboard_admin.ejs', { user: request.user, schuljahre });
    }
    // Faecher des Users, nach Klasse gruppiert
    const rows = getDb().prepare(`
      SELECT f.id, f.name, k.id AS klasse_id, k.name AS klasse_name, k.notenschluessel,
             s.id AS schuljahr_id, s.bezeichnung AS schuljahr_bezeichnung,
             (SELECT COUNT(*) FROM klausuren kk WHERE kk.fach_id = f.id) AS anzahl_klausuren,
             (SELECT COUNT(*) FROM unterrichtsleistungen uu WHERE uu.fach_id = f.id) AS anzahl_uls
      FROM fach_zuweisungen fz
      JOIN faecher f ON f.id = fz.fach_id
      JOIN klassen k ON k.id = f.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE fz.user_id = ?
      ORDER BY s.bezeichnung DESC, k.name, f.name
    `).all(request.user.id);
    const byKlasse = new Map();
    for (const r of rows) {
      if (!byKlasse.has(r.klasse_id)) byKlasse.set(r.klasse_id, {
        id: r.klasse_id, name: r.klasse_name, notenschluessel: r.notenschluessel,
        schuljahr_bezeichnung: r.schuljahr_bezeichnung, faecher: [],
      });
      byKlasse.get(r.klasse_id).faecher.push({
        id: r.id, name: r.name, anzahl_klausuren: r.anzahl_klausuren, anzahl_uls: r.anzahl_uls,
      });
    }
    return reply.viewEjs('teacher/dashboard.ejs', {
      user: request.user, byKlasse: Array.from(byKlasse.values()),
    });
  });

  // ---------- Fach-Detail (Noteneingabe) ----------
  fastify.get('/fach/:id', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    const zuweisung = getDb().prepare('SELECT auto_sync FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
      .get(fach.id, request.user.id);
    const syncMeta = holeSyncMeta(fach.id, halbjahr);
    return reply.viewEjs('teacher/fach_detail.ejs', {
      user: request.user, fach, halbjahr,
      schueler: uebersicht.schueler, klausuren: uebersicht.klausuren, uls: uebersicht.uls,
      rows: uebersicht.rows, schriftlichPct: uebersicht.schriftlichPct, ulPct: uebersicht.ulPct,
      autoSync: Boolean(zuweisung?.auto_sync), syncMeta,
    });
  });

  // ---------- Sync mit Klassenleitung ----------
  fastify.post('/fach/:id/sync', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    syncFach(request.params.id, halbjahr, request.user.id);
    request.flash?.('success', 'Noten mit der Klassenleitung synchronisiert.');
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/fach/:id/auto-sync', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    const aktiv = request.body?.aktiv === '1';
    getDb().prepare('UPDATE fach_zuweisungen SET auto_sync = ? WHERE fach_id = ? AND user_id = ?')
      .run(aktiv ? 1 : 0, request.params.id, request.user.id);
    if (aktiv) syncFach(request.params.id, halbjahr, request.user.id); // sofort auf aktuellen Stand bringen
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  // ---------- Noten-API (JSON für Live-Aktualisierung) ----------
  fastify.get('/fach/:id/noten', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).send({ error: 'not found' });
    if (!userHatFachZgriff(request.user, fach.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    return reply.send({
      schueler: uebersicht.rows, halbjahr, csv_typ: fach.notenschluessel,
      schriftlich_pct: uebersicht.schriftlichPct, ul_pct: uebersicht.ulPct,
    });
  });

  // ---------- Notenbesprechungsmodus (eine Schüler:in nach der anderen) ----------
  fastify.get('/fach/:id/besprechung/:schuelerId', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    const idx = uebersicht.rows.findIndex((r) => r.schueler_id === Number(request.params.schuelerId));
    if (idx === -1) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht in diesem Fach.' });
    const zeile = uebersicht.rows[idx];
    const notizen = getDb().prepare(`
      SELECT n.*, u.display_name, u.username FROM notenbesprechung_notizen n
      LEFT JOIN users u ON u.id = n.created_by_id
      WHERE n.schueler_id = ? AND n.halbjahr = ? AND (n.fach_id = ? OR n.fach_id IS NULL)
      ORDER BY n.created_at DESC
    `).all(zeile.schueler_id, halbjahr, fach.id);
    return reply.viewEjs('teacher/notenbesprechung.ejs', {
      user: request.user, fach, halbjahr, zeile, notizen,
      vorherige: idx > 0 ? uebersicht.rows[idx - 1] : null,
      naechste: idx < uebersicht.rows.length - 1 ? uebersicht.rows[idx + 1] : null,
      position: idx + 1, anzahl: uebersicht.rows.length,
    });
  });

  fastify.post('/fach/:id/besprechung/:schuelerId/notiz', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    const typ = request.body?.typ === 'konferenz' ? 'konferenz' : 'besprechung';
    const text = String(request.body?.text || '').trim();
    if (text) {
      getDb().prepare(`
        INSERT INTO notenbesprechung_notizen (schueler_id, fach_id, halbjahr, typ, text, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(request.params.schuelerId, typ === 'konferenz' ? null : request.params.id, halbjahr, typ, text, request.user.id);
    }
    return reply.redirect(`/teacher/fach/${request.params.id}/besprechung/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  // ---------- Klausuren ----------
  fastify.post('/fach/:id/klausuren/neu', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    const name = String(request.body?.name || '').trim();
    const aufgaben = Math.max(1, parseInt(request.body?.aufgaben, 10) || 1);
    if (!name) return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    getDb().prepare(`INSERT INTO klausuren (fach_id, halbjahr, name, max_punkte_pro_aufgabe, gewichtung)
                     VALUES (?, ?, ?, ?, 0)`)
      .run(request.params.id, halbjahr, name, JSON.stringify(Array(aufgaben).fill(1)));
    autoVerteileKlausuren(request.params.id, halbjahr);
    syncFallsAutoAktiv(request.params.id, halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/klausuren/:id/loeschen', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM klausuren WHERE id = ?').run(request.params.id);
    autoVerteileKlausuren(k.fach_id, k.halbjahr);
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/gewichtung', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE klausuren SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/maxpunkte', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const anzahl = Math.max(1, parseInt(request.body?.anzahl_aufgaben, 10) || JSON.parse(k.max_punkte_pro_aufgabe).length);
    const neueWerte = [];
    for (let i = 0; i < anzahl; i++) {
      neueWerte.push(Number(request.body?.['mp_' + i]) || 1);
    }
    getDb().prepare('UPDATE klausuren SET max_punkte_pro_aufgabe = ? WHERE id = ?')
      .run(JSON.stringify(neueWerte), request.params.id);
    // bestehende Ergebnisse anpassen
    const ergebnisse = getDb().prepare('SELECT id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(request.params.id);
    for (const e of ergebnisse) {
      const arr = JSON.parse(e.punkte);
      if (arr.length !== anzahl) {
        const extended = arr.slice(0, anzahl);
        while (extended.length < anzahl) extended.push(null);
        getDb().prepare('UPDATE klausur_ergebnisse SET punkte = ? WHERE id = ?')
          .run(JSON.stringify(extended), e.id);
      }
    }
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/punkte', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const maxArr = JSON.parse(k.max_punkte_pro_aufgabe);
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const idx = parseInt(request.body?.aufgabe_idx, 10);
    if (!Number.isFinite(schuelerId) || !Number.isFinite(idx) || idx < 0 || idx >= maxArr.length) {
      return reply.code(400).send({ ok: false, error: 'bad params' });
    }
    let wert = null;
    if (request.body?.wert !== '' && request.body?.wert !== null && request.body?.wert !== undefined) {
      wert = Number(request.body.wert);
      if (!Number.isFinite(wert) || wert < 0 || wert > maxArr[idx]) {
        return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb des Bereichs' });
      }
    }
    const existing = getDb().prepare(
      'SELECT id, punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?'
    ).get(request.params.id, schuelerId);
    let arr;
    if (existing) {
      arr = JSON.parse(existing.punkte);
      if (arr.length !== maxArr.length) {
        while (arr.length < maxArr.length) arr.push(null);
        arr = arr.slice(0, maxArr.length);
      }
      arr[idx] = wert;
      getDb().prepare('UPDATE klausur_ergebnisse SET punkte = ? WHERE id = ?')
        .run(JSON.stringify(arr), existing.id);
    } else {
      arr = new Array(maxArr.length).fill(null);
      arr[idx] = wert;
      getDb().prepare('INSERT INTO klausur_ergebnisse (klausur_id, schueler_id, punkte) VALUES (?, ?, ?)')
        .run(request.params.id, schuelerId, JSON.stringify(arr));
    }
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.send({ ok: true });
  });

  // ---------- Unterrichtsleistungen ----------
  fastify.post('/fach/:id/uls/neu', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    const name = String(request.body?.name || '').trim();
    const aufgaben = Math.max(1, parseInt(request.body?.aufgaben, 10) || 1);
    if (!name) return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    getDb().prepare(`INSERT INTO unterrichtsleistungen (fach_id, halbjahr, name, max_punkte_pro_aufgabe, gewichtung)
                     VALUES (?, ?, ?, ?, 0)`)
      .run(request.params.id, halbjahr, name, JSON.stringify(Array(aufgaben).fill(1)));
    autoVerteileUls(request.params.id, halbjahr);
    syncFallsAutoAktiv(request.params.id, halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/uls/:id/loeschen', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM unterrichtsleistungen WHERE id = ?').run(request.params.id);
    autoVerteileUls(u.fach_id, u.halbjahr);
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/gewichtung', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE unterrichtsleistungen SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/maxpunkte', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const anzahl = Math.max(1, parseInt(request.body?.anzahl_aufgaben, 10) || JSON.parse(u.max_punkte_pro_aufgabe).length);
    const neueWerte = [];
    for (let i = 0; i < anzahl; i++) neueWerte.push(Number(request.body?.['mp_' + i]) || 1);
    getDb().prepare('UPDATE unterrichtsleistungen SET max_punkte_pro_aufgabe = ? WHERE id = ?')
      .run(JSON.stringify(neueWerte), request.params.id);
    const ergebnisse = getDb().prepare('SELECT id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(request.params.id);
    for (const e of ergebnisse) {
      const arr = JSON.parse(e.punkte);
      if (arr.length !== anzahl) {
        const extended = arr.slice(0, anzahl);
        while (extended.length < anzahl) extended.push(null);
        getDb().prepare('UPDATE ul_ergebnisse SET punkte = ? WHERE id = ?')
          .run(JSON.stringify(extended), e.id);
      }
    }
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/punkte', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const maxArr = JSON.parse(u.max_punkte_pro_aufgabe);
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const idx = parseInt(request.body?.aufgabe_idx, 10);
    if (!Number.isFinite(schuelerId) || !Number.isFinite(idx) || idx < 0 || idx >= maxArr.length) {
      return reply.code(400).send({ ok: false, error: 'bad params' });
    }
    let wert = null;
    if (request.body?.wert !== '' && request.body?.wert !== null && request.body?.wert !== undefined) {
      wert = Number(request.body.wert);
      if (!Number.isFinite(wert) || wert < 0 || wert > maxArr[idx]) {
        return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb des Bereichs' });
      }
    }
    const existing = getDb().prepare(
      'SELECT id, punkte FROM ul_ergebnisse WHERE ul_id = ? AND schueler_id = ?'
    ).get(request.params.id, schuelerId);
    let arr;
    if (existing) {
      arr = JSON.parse(existing.punkte);
      if (arr.length !== maxArr.length) {
        while (arr.length < maxArr.length) arr.push(null);
        arr = arr.slice(0, maxArr.length);
      }
      arr[idx] = wert;
      getDb().prepare('UPDATE ul_ergebnisse SET punkte = ? WHERE id = ?')
        .run(JSON.stringify(arr), existing.id);
    } else {
      arr = new Array(maxArr.length).fill(null);
      arr[idx] = wert;
      getDb().prepare('INSERT INTO ul_ergebnisse (ul_id, schueler_id, punkte) VALUES (?, ?, ?)')
        .run(request.params.id, schuelerId, JSON.stringify(arr));
    }
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.send({ ok: true });
  });

  // ---------- Manuelle Noten ----------
  fastify.post('/fach/:id/noten/hinzufuegen', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.body?.halbjahr) ? request.body.halbjahr : HALBJAHRE[0];
    const typ = NOTE_TYPEN.includes(request.body?.typ) ? request.body.typ : null;
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const wert = Number(request.body?.wert);
    if (!typ || !Number.isFinite(schuelerId) || !Number.isFinite(wert)) {
      return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    }
    const fach = ladeFachMitUmfeld(request.params.id);
    const [min, max] = fach.notenschluessel === 'BG' ? [0, 15] : [1, 6];
    if (wert < min || wert > max) {
      request.flash?.('error', `Note außerhalb des Bereichs ${min}–${max}.`);
      return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    }
    const pos = getDb().prepare(
      'SELECT COUNT(*) AS c FROM noten WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ? AND typ = ?'
    ).get(request.params.id, halbjahr, schuelerId, typ).c;
    getDb().prepare(
      'INSERT INTO noten (schueler_id, fach_id, halbjahr, typ, wert, position) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(schuelerId, request.params.id, halbjahr, typ, wert, pos);
    syncFallsAutoAktiv(request.params.id, halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/noten/:id/loeschen', async (request, reply) => {
    const n = getDb().prepare('SELECT fach_id, halbjahr FROM noten WHERE id = ?').get(request.params.id);
    if (!n) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, n.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM noten WHERE id = ?').run(request.params.id);
    syncFallsAutoAktiv(n.fach_id, n.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${n.fach_id}?hj=${encodeURIComponent(n.halbjahr)}`);
  });

  // ---------- Selbstbedienung: Klassen anlegen/verwalten ohne Admin-Zuweisung ----------
  // Jede angemeldete Lehrkraft kann eigene Klassen anlegen (Ersteller/in
  // behält automatisch Zugriff, siehe userHatKlassenZugriff). Eine spätere
  // Zuweisung weiterer Lehrkräfte über Admin → Zuweisungen bleibt optional.

  fastify.get('/klassen', async (request, reply) => {
    const db = getDb();
    const schuljahre = db.prepare('SELECT * FROM schuljahre ORDER BY bezeichnung DESC').all();
    const klassen = db.prepare(`
      SELECT DISTINCT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k
      JOIN schuljahre s ON s.id = k.schuljahr_id
      LEFT JOIN faecher f ON f.klasse_id = k.id
      LEFT JOIN fach_zuweisungen fz ON fz.fach_id = f.id AND fz.user_id = ?
      LEFT JOIN klassen_lehrkraefte kl ON kl.klasse_id = k.id AND kl.user_id = ?
      LEFT JOIN klassenleitung kls ON kls.klasse_id = k.id AND kls.user_id = ?
      WHERE k.created_by_id = ? OR fz.user_id IS NOT NULL OR kl.user_id IS NOT NULL OR kls.user_id IS NOT NULL
      ORDER BY s.bezeichnung DESC, k.name
    `).all(request.user.id, request.user.id, request.user.id, request.user.id);

    // Verknüpfungsanfragen, auf deren Zustimmung ich noch warte
    const wartetAufMich = db.prepare(`
      SELECT a.id, a.vorgeschlagenes_fach, a.created_at,
             k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung,
             u.display_name AS angefragt_von_name, u.username AS angefragt_von_username
      FROM klassen_verknuepfungsantworten ant
      JOIN klassen_verknuepfungsanfragen a ON a.id = ant.anfrage_id
      JOIN klassen k ON k.id = a.ziel_klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      JOIN users u ON u.id = a.angefragt_von_id
      WHERE ant.user_id = ? AND ant.zustimmung IS NULL AND a.status = 'offen'
      ORDER BY a.created_at
    `).all(request.user.id);

    // Meine eigenen gestellten Anfragen (offen/entschieden)
    const meineAnfragen = db.prepare(`
      SELECT a.id, a.vorgeschlagenes_fach, a.status, a.created_at,
             k.name AS klasse_name, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen_verknuepfungsanfragen a
      JOIN klassen k ON k.id = a.ziel_klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE a.angefragt_von_id = ?
      ORDER BY a.created_at DESC
      LIMIT 20
    `).all(request.user.id);

    return reply.viewEjs('teacher/klassen_liste.ejs', {
      user: request.user, schuljahre, klassen, wartetAufMich, meineAnfragen,
    });
  });

  fastify.post('/klassen/neu', async (request, reply) => {
    const schuljahrId = parseInt(request.body?.schuljahr_id, 10);
    const name = String(request.body?.name || '').trim();
    let ns = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG'].includes(ns)) ns = 'IHK';
    if (!schuljahrId || !name) {
      request.flash?.('error', 'Schuljahr und Name sind erforderlich.');
      return reply.redirect('/teacher/klassen');
    }
    try {
      const info = getDb().prepare(`
        INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(schuljahrId, name, ns, DEFAULT_NS_CSV[ns], request.user.id);
      return reply.redirect(`/teacher/klassen/${info.lastInsertRowid}`);
    } catch (e) {
      // Name in diesem Schuljahr bereits vergeben → statt Fehlermeldung zur
      // Verknüpfungsanfrage weiterleiten, damit die Klasse nicht doppelt entsteht.
      const bestehend = getDb().prepare('SELECT id FROM klassen WHERE schuljahr_id = ? AND name = ?')
        .get(schuljahrId, name);
      if (bestehend) return reply.redirect(`/teacher/klassen/${bestehend.id}/verknuepfen`);
      request.flash?.('error', 'Klasse existiert in diesem Schuljahr bereits.');
      return reply.redirect('/teacher/klassen');
    }
  });

  // ---------- Verknüpfungsanfrage für eine bereits bestehende Klasse ----------
  fastify.get('/klassen/:id/verknuepfen', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (userHatKlassenZugriff(request.user, klasse.id)) return reply.redirect(`/teacher/klassen/${klasse.id}`);
    return reply.viewEjs('teacher/klasse_verknuepfen.ejs', { user: request.user, klasse });
  });

  fastify.post('/klassen/:id/verknuepfen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    const fach = String(request.body?.fach || '').trim();
    if (!fach) {
      request.flash?.('error', 'Bitte ein Fach angeben.');
      return reply.redirect(`/teacher/klassen/${klasse.id}/verknuepfen`);
    }
    const ergebnis = starteVerknuepfung({
      klasseId: klasse.id, angefragtVonId: request.user.id, vorgeschlagenesFach: fach,
    });
    if (ergebnis.direkterBeitritt) {
      request.flash?.('success', `Klasse war noch niemandem zugeordnet — du hast direkten Zugriff mit dem Fach „${fach}" erhalten.`);
      return reply.redirect(`/teacher/klassen/${klasse.id}`);
    }
    request.flash?.('success', 'Verknüpfungsanfrage gestellt. Sobald alle bereits zugeordneten Personen zustimmen, erhältst du Zugriff.');
    return reply.redirect('/teacher/klassen');
  });

  fastify.post('/verknuepfungen/:id/antwort', async (request, reply) => {
    const zustimmung = request.body?.zustimmung === '1';
    const ergebnis = beantworteVerknuepfung({
      anfrageId: request.params.id, userId: request.user.id, zustimmung,
    });
    if (!ergebnis) {
      request.flash?.('error', 'Diese Anfrage betrifft dich nicht (mehr).');
    } else if (ergebnis.status === 'abgelehnt') {
      request.flash?.('success', 'Anfrage abgelehnt.');
    } else if (ergebnis.status === 'angenommen') {
      request.flash?.('success', 'Anfrage angenommen — die Klasse ist jetzt verknüpft.');
    } else {
      request.flash?.('success', 'Deine Zustimmung wurde gespeichert — es fehlen noch andere.');
    }
    return reply.redirect('/teacher/klassen');
  });

  // ---------- Halbjahresübersicht (Klassenleitung/Admin) ----------
  // Zeigt NUR den zuletzt synchronisierten Stand (fach_sync_stand), nie
  // Live-Werte — das ist genau der Punkt des Sync-Mechanismus.
  fastify.get('/klassen/:id/uebersicht', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin haben Zugriff auf die Übersicht.' });
    }
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const db = getDb();
    const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
    const faecher = db.prepare('SELECT * FROM faecher WHERE klasse_id = ? ORDER BY name').all(klasse.id);
    const syncMeta = new Map(faecher.map((f) => [f.id, holeSyncMeta(f.id, halbjahr)]));
    const standRows = faecher.length ? db.prepare(`
      SELECT fach_id, schueler_id, note FROM fach_sync_stand
      WHERE halbjahr = ? AND fach_id IN (${faecher.map(() => '?').join(',')})
    `).all(halbjahr, ...faecher.map((f) => f.id)) : [];
    const stand = new Map(); // schueler_id -> Map(fach_id -> note)
    for (const s of schueler) stand.set(s.id, new Map());
    for (const r of standRows) stand.get(r.schueler_id)?.set(r.fach_id, r.note);

    const notizRows = schueler.length ? db.prepare(`
      SELECT n.*, u.display_name, u.username, f.name AS fach_name FROM notenbesprechung_notizen n
      LEFT JOIN users u ON u.id = n.created_by_id
      LEFT JOIN faecher f ON f.id = n.fach_id
      WHERE n.halbjahr = ? AND n.schueler_id IN (${schueler.map(() => '?').join(',')})
      ORDER BY n.created_at DESC
    `).all(halbjahr, ...schueler.map((s) => s.id)) : [];
    const notizenNachSchueler = new Map();
    for (const n of notizRows) {
      if (!notizenNachSchueler.has(n.schueler_id)) notizenNachSchueler.set(n.schueler_id, []);
      notizenNachSchueler.get(n.schueler_id).push(n);
    }

    const zeilen = schueler.map((s) => {
      const noten = faecher.map((f) => stand.get(s.id)?.get(f.id) ?? null);
      const vorhanden = noten.filter((n) => n !== null && n !== undefined);
      const schnitt = vorhanden.length ? vorhanden.reduce((a, b) => a + b, 0) / vorhanden.length : null;
      return { schueler: s, noten, schnitt, notizen: notizenNachSchueler.get(s.id) || [] };
    });

    return reply.viewEjs('teacher/klasse_uebersicht.ejs', {
      user: request.user, klasse, halbjahr, faecher, zeilen, syncMeta,
    });
  });

  fastify.get('/klassen/:id', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(klasse.id);
    const faecher = getDb().prepare(`
      SELECT f.*,
        (SELECT GROUP_CONCAT(u.display_name || COALESCE(NULLIF(' / ' || u.username, ' / '), ''), ', ')
           FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id WHERE fz.fach_id = f.id) AS lehrer_liste
      FROM faecher f WHERE f.klasse_id = ? ORDER BY f.name
    `).all(klasse.id);
    const eigentuemer = klasse.created_by_id === request.user.id || request.user.isAdmin;
    const istKlassenlehrer = userIstKlassenlehrer(request.user, klasse.id);
    const kannSelbstAlsKlassenlehrerEintragen = !istKlassenlehrer
      && (klasse.created_by_id === request.user.id || request.user.isAdmin);

    let zuweisbareLehrkraefte = [];
    let zuweisungen = [];
    if (istKlassenlehrer) {
      zuweisbareLehrkraefte = getDb().prepare(
        "SELECT id, username, display_name FROM users WHERE role != 'admin' AND active = 1 ORDER BY username"
      ).all();
      zuweisungen = getDb().prepare(`
        SELECT fz.id, fz.fach_id, f.name AS fach_name, u.display_name, u.username
        FROM fach_zuweisungen fz
        JOIN faecher f ON f.id = fz.fach_id
        JOIN users u ON u.id = fz.user_id
        WHERE f.klasse_id = ?
        ORDER BY f.name, u.username
      `).all(klasse.id);
    }

    return reply.viewEjs('teacher/klasse_detail.ejs', {
      user: request.user, klasse, schueler, faecher, eigentuemer,
      istKlassenlehrer, kannSelbstAlsKlassenlehrerEintragen, zuweisbareLehrkraefte, zuweisungen,
    });
  });

  fastify.post('/klassen/:id/klassenlehrer/eintragen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT created_by_id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/teacher/klassen');
    if (klasse.created_by_id !== request.user.id && !request.user.isAdmin) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die erstellende Lehrkraft oder der Admin kann sich hier als Klassenleitung eintragen.' });
    }
    getDb().prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)')
      .run(request.params.id, request.user.id);
    request.flash?.('success', 'Du bist jetzt als Klassenleitung eingetragen und siehst alle Noten dieser Klasse.');
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/klassen/:id/zuweisungen/neu', async (request, reply) => {
    if (!userIstKlassenlehrer(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Lehrkräfte zuweisen.' });
    }
    const userId = parseInt(request.body?.user_id, 10);
    const fachId = parseInt(request.body?.fach_id, 10);
    const fach = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?').get(fachId);
    if (!userId || !fach || fach.klasse_id !== Number(request.params.id)) {
      request.flash?.('error', 'Ungültige Auswahl.');
      return reply.redirect(`/teacher/klassen/${request.params.id}`);
    }
    try {
      getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(userId, fachId);
    } catch (e) {
      request.flash?.('error', 'Diese Zuweisung besteht bereits.');
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/zuweisungen/:id/loeschen', async (request, reply) => {
    const z = getDb().prepare(`
      SELECT fz.id, f.klasse_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE fz.id = ?
    `).get(request.params.id);
    if (!z) return reply.redirect('/teacher/klassen');
    if (!userIstKlassenlehrer(request.user, z.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Zuweisungen entfernen.' });
    }
    getDb().prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(request.params.id);
    return reply.redirect(`/teacher/klassen/${z.klasse_id}`);
  });

  fastify.post('/klassen/:id/loeschen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT created_by_id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/teacher/klassen');
    if (klasse.created_by_id !== request.user.id && !request.user.isAdmin) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die erstellende Lehrkraft oder der Admin kann diese Klasse löschen.' });
    }
    getDb().prepare('DELETE FROM klassen WHERE id = ?').run(request.params.id);
    return reply.redirect('/teacher/klassen');
  });

  fastify.post('/klassen/:id/schueler/neu', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const nn = String(request.body?.nachname || '').trim();
    const vn = String(request.body?.vorname || '').trim();
    if (nn && vn) {
      getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
        .run(request.params.id, nn, vn);
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/klassen/:id/schueler/bulk', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const text = String(request.body?.text || '');
    const ins = getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)');
    const tx = getDb().transaction((lines) => {
      for (const line of lines) {
        const [nn, vn] = line.split(',', 2).map((s) => s.trim());
        if (!nn) continue;
        ins.run(request.params.id, nn, vn || '');
      }
    });
    tx(text.split(/\r?\n/));
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/schueler/:id/loeschen', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.redirect('/teacher/klassen');
    if (!userHatKlassenZugriff(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    getDb().prepare('DELETE FROM schueler WHERE id = ?').run(request.params.id);
    return reply.redirect(`/teacher/klassen/${s.klasse_id}`);
  });

  fastify.post('/klassen/:id/faecher/neu', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const name = String(request.body?.name || '').trim();
    if (name) {
      try {
        const info = getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)')
          .run(request.params.id, name);
        // Ersteller/in wird automatisch dem eigenen Fach zugewiesen — eine
        // spätere Zuweisung weiterer Lehrkräfte (Admin → Zuweisungen) bleibt
        // zusätzlich möglich, ist aber nicht Voraussetzung.
        getDb().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
          .run(request.user.id, info.lastInsertRowid);
      } catch (e) {
        request.flash?.('error', 'Fach existiert bereits in dieser Klasse.');
      }
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/faecher/:id/loeschen', async (request, reply) => {
    const f = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?').get(request.params.id);
    if (!f) return reply.redirect('/teacher/klassen');
    if (!userHatKlassenZugriff(request.user, f.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    getDb().prepare('DELETE FROM faecher WHERE id = ?').run(request.params.id);
    return reply.redirect(`/teacher/klassen/${f.klasse_id}`);
  });
}

function autoVerteileKlausuren(fachId, halbjahr) {
  const klausuren = getDb().prepare(
    'SELECT id, gewichtung FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
  ).all(fachId, halbjahr);
  if (!klausuren.length) return;
  if (klausuren.some((k) => k.gewichtung !== 0)) return;
  const fach = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?').get(fachId);
  const sj = getDb().prepare(`
    SELECT s.gewichtung_muendlich FROM schuljahre s JOIN klassen k ON k.schuljahr_id = s.id WHERE k.id = ?
  `).get(fach.klasse_id);
  const schriftlichPct = 100 - (sj?.gewichtung_muendlich || DEFAULT_GEWICHTUNG);
  const weights = autoDistribute(klausuren.length, schriftlichPct);
  const upd = getDb().prepare('UPDATE klausuren SET gewichtung = ? WHERE id = ?');
  for (let i = 0; i < klausuren.length; i++) upd.run(weights[i], klausuren[i].id);
}

function autoVerteileUls(fachId, halbjahr) {
  const uls = getDb().prepare(
    'SELECT id, gewichtung FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
  ).all(fachId, halbjahr);
  if (!uls.length) return;
  if (uls.some((u) => u.gewichtung !== 0)) return;
  const fach = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?').get(fachId);
  const sj = getDb().prepare(`
    SELECT s.gewichtung_muendlich FROM schuljahre s JOIN klassen k ON k.schuljahr_id = s.id WHERE k.id = ?
  `).get(fach.klasse_id);
  const ulPct = sj?.gewichtung_muendlich || DEFAULT_GEWICHTUNG;
  const weights = autoDistribute(uls.length, ulPct);
  const upd = getDb().prepare('UPDATE unterrichtsleistungen SET gewichtung = ? WHERE id = ?');
  for (let i = 0; i < uls.length; i++) upd.run(weights[i], uls[i].id);
}

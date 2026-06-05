/**
 * Lehrkraft-Routen: Notentafel (AJAX), Klausuren, ULs, mündlich/schriftlich.
 * Zugriffsschutz: User muss dem Fach zugewiesen sein (oder Admin).
 */

import { getDb } from '../db.js';
import { requireAuth, userHatFachZgriff } from '../auth.js';
import {
  HALBJAHRE, NOTE_TYPEN, noteAusPunkten, gesamtnoteHj, gesamtnoteJahr,
  autoDistribute, nichtBestanden, formatNote, DEFAULT_GEWICHTUNG,
} from '../grade-calc.js';

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

  // ---------- Fach-Detail (Notentafel) ----------
  fastify.get('/fach/:id', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).view('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).view('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(fach.klasse_id);
    const klausuren = getDb().prepare(
      'SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
    ).all(fach.id, halbjahr);
    const uls = getDb().prepare(
      'SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
    ).all(fach.id, halbjahr);
    // Ergebnisse / Noten
    const ergebnisseMap = {};
    const notenMap = {};
    for (const s of schueler) {
      ergebnisseMap[s.id] = {};
      notenMap[s.id] = { muendlich: [], schriftlich: [] };
    }
    for (const k of klausuren) {
      const rows = getDb().prepare(
        'SELECT schueler_id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?'
      ).all(k.id);
      for (const r of rows) {
        if (ergebnisseMap[r.schueler_id]) ergebnisseMap[r.schueler_id]['k' + k.id] = JSON.parse(r.punkte);
      }
    }
    for (const u of uls) {
      const rows = getDb().prepare(
        'SELECT schueler_id, punkte FROM ul_ergebnisse WHERE ul_id = ?'
      ).all(u.id);
      for (const r of rows) {
        if (ergebnisseMap[r.schueler_id]) ergebnisseMap[r.schueler_id]['u' + u.id] = JSON.parse(r.punkte);
      }
    }
    const notenRows = getDb().prepare(
      'SELECT schueler_id, typ, wert FROM noten WHERE fach_id = ? AND halbjahr = ? ORDER BY position, id'
    ).all(fach.id, halbjahr);
    for (const n of notenRows) {
      if (notenMap[n.schueler_id]) notenMap[n.schueler_id][n.typ].push(n.wert);
    }
    const schuljahr = getDb().prepare('SELECT gewichtung_muendlich FROM schuljahre WHERE id = ?').get(fach.schuljahr_id);
    const schriftlichPct = 100 - (schuljahr?.gewichtung_muendlich ?? DEFAULT_GEWICHTUNG);
    const ulPct = schuljahr?.gewichtung_muendlich ?? DEFAULT_GEWICHTUNG;
    return reply.viewEjs('teacher/fach_detail.ejs', {
      user: request.user, fach, halbjahr, schueler, klausuren, uls,
      ergebnisseMap, notenMap, schriftlichPct, ulPct,
    });
  });

  // ---------- Noten-API (JSON für Live-Tafel) ----------
  fastify.get('/fach/:id/noten', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).send({ error: 'not found' });
    if (!userHatFachZgriff(request.user, fach.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(fach.klasse_id);
    const klausuren = getDb().prepare(
      'SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
    ).all(fach.id, halbjahr);
    const uls = getDb().prepare(
      'SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
    ).all(fach.id, halbjahr);
    const csvStr = getNotenschluesselCsv(fach);
    const schuljahr = getDb().prepare('SELECT gewichtung_muendlich FROM schuljahre WHERE id = ?').get(fach.schuljahr_id);
    const schriftlichPct = 100 - (schuljahr?.gewichtung_muendlich ?? DEFAULT_GEWICHTUNG);
    const ulPct = schuljahr?.gewichtung_muendlich ?? DEFAULT_GEWICHTUNG;
    // Ergebnisse
    const klausurErgs = new Map();
    for (const k of klausuren) {
      const rows = getDb().prepare('SELECT schueler_id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(k.id);
      klausurErgs.set(k.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
    }
    const ulErgs = new Map();
    for (const u of uls) {
      const rows = getDb().prepare('SELECT schueler_id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(u.id);
      ulErgs.set(u.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
    }
    const notenRows = getDb().prepare(
      'SELECT schueler_id, typ, wert FROM noten WHERE fach_id = ? AND halbjahr = ? ORDER BY position, id'
    ).all(fach.id, halbjahr);
    const noten = new Map();
    for (const n of notenRows) {
      if (!noten.has(n.schueler_id)) noten.set(n.schueler_id, { muendlich: [], schriftlich: [] });
      noten.get(n.schueler_id)[n.typ].push(n.wert);
    }
    const rows = schueler.map((s) => {
      const klausurData = klausuren.map((k) => {
        const punkte = klausurErgs.get(k.id)?.get(s.id) || null;
        const note = punkte ? noteAusPunkten(punkte, JSON.parse(k.max_punkte_pro_aufgabe), csvStr) : null;
        return { id: k.id, name: k.name, gewichtung: k.gewichtung, punkte, note };
      });
      const ulData = uls.map((u) => {
        const punkte = ulErgs.get(u.id)?.get(s.id) || null;
        const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csvStr) : null;
        return { id: u.id, name: u.name, gewichtung: u.gewichtung, punkte, note };
      });
      const manuelle = noten.get(s.id) || { muendlich: [], schriftlich: [] };
      const gn = gesamtnoteHj(schriftlichPct, ulPct, klausurData, ulData, csvStr);
      return {
        schueler_id: s.id, nachname: s.nachname, vorname: s.vorname,
        klausuren: klausurData, uls: ulData,
        muendlich: manuelle.muendlich, schriftlich: manuelle.schriftlich,
        gesamt: gn,
        nicht_bestanden: gn !== null ? nichtBestanden(gn, fach.notenschluessel) : false,
      };
    });
    return reply.send({
      schueler: rows, halbjahr, csv_typ: fach.notenschluessel,
      schriftlich_pct: schriftlichPct, ul_pct: ulPct,
    });
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
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/klausuren/:id/loeschen', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM klausuren WHERE id = ?').run(request.params.id);
    autoVerteileKlausuren(k.fach_id, k.halbjahr);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/gewichtung', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE klausuren SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
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
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/punkte', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(request.params.id);
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
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/uls/:id/loeschen', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM unterrichtsleistungen WHERE id = ?').run(request.params.id);
    autoVerteileUls(u.fach_id, u.halbjahr);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/gewichtung', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE unterrichtsleistungen SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
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
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/punkte', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, max_punkte_pro_aufgabe FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
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
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/noten/:id/loeschen', async (request, reply) => {
    const n = getDb().prepare('SELECT fach_id, halbjahr FROM noten WHERE id = ?').get(request.params.id);
    if (!n) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, n.fach_id)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM noten WHERE id = ?').run(request.params.id);
    return reply.redirect(`/teacher/fach/${n.fach_id}?hj=${encodeURIComponent(n.halbjahr)}`);
  });
}

function ladeFachMitUmfeld(id) {
  return getDb().prepare(`
    SELECT f.*, k.name AS klasse_name, k.schuljahr_id, k.notenschluessel,
           s.bezeichnung AS schuljahr_bezeichnung
    FROM faecher f
    JOIN klassen k ON k.id = f.klasse_id
    JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE f.id = ?
  `).get(id);
}

function getNotenschluesselCsv(fach) {
  const k = getDb().prepare('SELECT notenschluessel_csv, notenschluessel FROM klassen WHERE id = ?')
    .get(fach.klasse_id);
  if (k?.notenschluessel_csv) return k.notenschluessel_csv;
  return require('../grade-calc.js').DEFAULT_NS_CSV[k?.notenschluessel] || '';
}

function autoVerteileKlausuren(fachId, halbjahr) {
  const klausuren = getDb().prepare(
    'SELECT id FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
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
    'SELECT id FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
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

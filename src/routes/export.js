/**
 * CSV-Export: pro Klasse oder pro Schuljahr.
 * Excel-freundlich (UTF-8 BOM, ; als Trennzeichen).
 */

import { getDb } from '../db.js';
import { requireAuth, userHatFachZgriff, userIstKlassenlehrer } from '../auth.js';
import { HALBJAHRE, noteAusPunkten, gesamtnoteHj, gesamtnoteJahr, formatNote } from '../grade-calc.js';

export default async function exportRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/klasse/:id.csv', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse) return reply.code(404).send('Klasse nicht gefunden');
    if (!darfExportieren(request.user, klasse)) return reply.code(403).send('Keine Berechtigung');

    const csv = '\ufeff' + [HEADER.join(';'), ...baueKlasseCsv(klasse)].join('\n');
    const filename = `Noten_${klasse.schuljahr_bezeichnung}_${klasse.name}.csv`.replace(/[^\w.-]/g, '_');
    return bauReply(reply, csv, filename);
  });

  fastify.get('/schuljahr/:id.csv', async (request, reply) => {
    const sj = getDb().prepare('SELECT * FROM schuljahre WHERE id = ?').get(request.params.id);
    if (!sj) return reply.code(404).send('Schuljahr nicht gefunden');

    let klassen;
    if (request.user.isAdmin) {
      klassen = getDb().prepare(
        'SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE s.id = ? ORDER BY k.name'
      ).all(sj.id);
    } else {
      const ids = new Set();
      const kls = getDb().prepare(`
        SELECT DISTINCT k.id, k.name, k.schuljahr_id, k.notenschluessel, k.notenschluessel_csv, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k
        JOIN schuljahre s ON s.id = k.schuljahr_id
        LEFT JOIN klassen_lehrkraefte kl ON kl.klasse_id = k.id
        LEFT JOIN fach_zuweisungen fz ON fz.fach_id IN (SELECT id FROM faecher WHERE klasse_id = k.id)
        WHERE (kl.user_id = ? OR fz.user_id = ?) AND s.id = ?
        ORDER BY k.name
      `).all(request.user.id, request.user.id, sj.id);
      klassen = kls;
    }
    if (!klassen.length) return reply.code(403).send('Keine Berechtigung');

    const bufs = ['\ufeff'];
    bufs.push(HEADER.join(';'));
    for (const klasse of klassen) {
      bufs.push(...baueKlasseCsv(klasse));
    }
    const filename = `Noten_${sj.bezeichnung}_komplett.csv`.replace(/[^\w.-]/g, '_');
    return bauReply(reply, bufs.join('\n'), filename);
  });
}

const HEADER = [
  'Schuljahr', 'Klasse', 'Notenschlüssel',
  'Fach', 'Nachname', 'Vorname', 'Halbjahr',
  'Mündlich (manuell)', 'Mündlich (bewertet)',
  'Schriftlich (manuell)', 'Klausuren',
  'Gesamtnote Halbjahr',
  'Fehlzeiten entschuldigt (h)', 'Fehlzeiten unentschuldigt (h)',
  'Fehlzeiten betrieblich (h)',
];

function ladeKlasse(id) {
  return getDb().prepare(`
    SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE k.id = ?
  `).get(id);
}

function darfExportieren(user, klasse) {
  if (user.isAdmin) return true;
  if (klasse.created_by_id === user.id) return true;
  if (userIstKlassenlehrer(user, klasse.id)) return true;
  const row = getDb().prepare(`
    SELECT 1 FROM fach_zuweisungen fz
    JOIN faecher f ON f.id = fz.fach_id
    WHERE fz.user_id = ? AND f.klasse_id = ? LIMIT 1
  `).get(user.id, klasse.id);
  return Boolean(row);
}

function escapeCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function fmtNote(n) {
  if (n === null || n === undefined) return '-';
  return formatNote(n).replace('.', ',');
}

function bauReply(reply, csv, filename) {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(csv);
}

function baueKlasseCsv(klasse) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
  const faecher = db.prepare('SELECT * FROM faecher WHERE klasse_id = ? ORDER BY name').all(klasse.id);
  const csv = klasse.notenschluessel_csv || '';
  const fzRows = db.prepare(`
    SELECT fz.schueler_id, fz.halbjahr, fz.typ, fz.stunden
    FROM fehlzeiten fz JOIN schueler s ON s.id = fz.schueler_id
    WHERE s.klasse_id = ?
  `).all(klasse.id);
  const fzMap = {};
  for (const fz of fzRows) {
    fzMap[fz.schueler_id] ??= {};
    fzMap[fz.schueler_id][fz.halbjahr] ??= {};
    fzMap[fz.schueler_id][fz.halbjahr][fz.typ] = fz.stunden;
  }
  const lines = [];
  for (const f of faecher) {
    for (const s of schueler) {
      for (const hj of HALBJAHRE) {
        const zeile = zeileFuerSchuelerFachHj(klasse, csv, f, s, hj);
        const fzHj = fzMap[s.id]?.[hj] || {};
        lines.push([
          klasse.schuljahr_bezeichnung, klasse.name, klasse.notenschluessel,
          f.name, s.nachname, s.vorname, hj,
          zeile.muendlich_manuell, zeile.muendlich_bewertet,
          zeile.schriftlich_manuell, zeile.klausuren,
          fmtNote(zeile.gn),
          fzHj.entschuldigt ?? '', fzHj.unentschuldigt ?? '', fzHj.betrieblich ?? '',
        ].map(escapeCell).join(';'));
      }
    }
  }
  // Jahresnoten
  lines.push('');
  lines.push(['=== Jahresnoten ==='].map(escapeCell).join(';'));
  lines.push(['Schuljahr', 'Klasse', 'Fach', 'Nachname', 'Vorname', 'Jahresnote'].map(escapeCell).join(';'));
  for (const f of faecher) {
    for (const s of schueler) {
      const hjNoten = HALBJAHRE.map((hj) => zeileFuerSchuelerFachHj(klasse, csv, f, s, hj).gn);
      const jn = gesamtnoteJahr(hjNoten);
      lines.push([
        klasse.schuljahr_bezeichnung, klasse.name, f.name, s.nachname, s.vorname, fmtNote(jn),
      ].map(escapeCell).join(';'));
    }
  }
  return lines;
}

function zeileFuerSchuelerFachHj(klasse, csv, fach, schueler, halbjahr) {
  const db = getDb();
  const klausuren = db.prepare(
    'SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
  ).all(fach.id, halbjahr);
  const uls = db.prepare(
    'SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
  ).all(fach.id, halbjahr);
  const klausurData = klausuren.map((k) => {
    const row = db.prepare('SELECT punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?')
      .get(k.id, schueler.id);
    const punkte = row ? JSON.parse(row.punkte) : null;
    const note = punkte ? noteAusPunkten(punkte, JSON.parse(k.max_punkte_pro_aufgabe), csv) : null;
    return { note, gewichtung: k.gewichtung };
  });
  const ulData = uls.map((u) => {
    const row = db.prepare('SELECT punkte FROM ul_ergebnisse WHERE ul_id = ? AND schueler_id = ?')
      .get(u.id, schueler.id);
    const punkte = row ? JSON.parse(row.punkte) : null;
    const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csv) : null;
    return { note, gewichtung: u.gewichtung };
  });
  const sj = db.prepare(`
    SELECT s.gewichtung_muendlich FROM schuljahre s JOIN klassen k ON k.schuljahr_id = s.id WHERE k.id = ?
  `).get(klasse.id);
  const ulPct = sj?.gewichtung_muendlich || 60;
  const schriftlichPct = 100 - ulPct;
  const manuelle = { muendlich: [], schriftlich: [] };
  const notenRows = db.prepare(
    'SELECT typ, wert FROM noten WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ? ORDER BY position'
  ).all(fach.id, halbjahr, schueler.id);
  for (const n of notenRows) manuelle[n.typ].push(n.wert);
  const gn = gesamtnoteHj(schriftlichPct, ulPct, klausurData, ulData, csv);
  return {
    muendlich_manuell: manuelle.muendlich.map((n) => Number(n).toString()).join(', '),
    schriftlich_manuell: manuelle.schriftlich.map((n) => Number(n).toString()).join(', '),
    muendlich_bewertet: ulData.filter((u) => u.note !== null).map((u) => `${formatNote(u.note)}(${Math.round(u.gewichtung)}%)`).join(' | '),
    klausuren: klausurData.filter((k) => k.note !== null).map((k) => `${formatNote(k.note)}(${Math.round(k.gewichtung)}%)`).join(' | '),
    gn,
  };
}

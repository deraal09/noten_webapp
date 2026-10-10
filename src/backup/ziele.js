/**
 * Sicherungsziele: ein Verzeichnis (lokal oder eingebundenes Netzlaufwerk) oder ein WebDAV-Speicher. Jedes Ziel kann
 * eine Datei ablegen, die Sicherungsdateien auflisten und eine löschen (für die Aufbewahrung) sowie sich testen lassen.
 * Weitere Ziele (SFTP, S3 …) lassen sich hier ergänzen, sobald feststeht, was die IT bereitstellt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const DATEI_MUSTER = /^noten-backup-\d{8}-\d{6}\.sqlite3$/;
const TIMEOUT_MS = 15 * 60 * 1000;

/** Entfernt Zugangsdaten aus Fehlermeldungen (Adressen der Form https://benutzer:passwort@host). */
export function bereinige(text) {
  return String(text ?? '').replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@');
}

// ---------- Verzeichnis ----------
const verzeichnis = {
  async teste(cfg) {
    await fs.promises.mkdir(cfg.ziel, { recursive: true });
    const probe = path.join(cfg.ziel, `.schreibtest-${process.pid}`);
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe, { force: true });
    return 'Das Verzeichnis ist vorhanden und beschreibbar.';
  },
  async schreibe(cfg, quellPfad, dateiname) {
    await fs.promises.mkdir(cfg.ziel, { recursive: true });
    const tmp = path.join(cfg.ziel, `${dateiname}.teil`);
    await fs.promises.copyFile(quellPfad, tmp);
    await fs.promises.rename(tmp, path.join(cfg.ziel, dateiname));
    return (await fs.promises.stat(path.join(cfg.ziel, dateiname))).size;
  },
  async liste(cfg) {
    const namen = await fs.promises.readdir(cfg.ziel);
    return namen.filter((n) => DATEI_MUSTER.test(n)).sort();
  },
  async loesche(cfg, name) {
    await fs.promises.rm(path.join(cfg.ziel, name), { force: true });
  },
};

// ---------- WebDAV ----------
function kopf(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.benutzer || cfg.passwort) h.Authorization = `Basic ${Buffer.from(`${cfg.benutzer}:${cfg.passwort}`).toString('base64')}`;
  return h;
}
async function dav(cfg, methode, name, opts = {}) {
  const url = name ? `${cfg.ziel}/${encodeURIComponent(name)}` : `${cfg.ziel}/`;
  return fetch(url, { method: methode, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual', ...opts, headers: kopf(cfg, opts.headers) });
}
function pruefeStatus(res, erlaubt, tun) {
  if (erlaubt.includes(res.status)) return;
  if (res.status === 401 || res.status === 403) throw new Error(`${tun}: Anmeldung abgelehnt (HTTP ${res.status}) -- Benutzer/Passwort bzw. Rechte prüfen.`);
  if (res.status === 404) throw new Error(`${tun}: Adresse nicht gefunden (HTTP 404) -- existiert der Ordner?`);
  if (res.status >= 300 && res.status < 400) throw new Error(`${tun}: Weiterleitung (HTTP ${res.status}) -- bitte die endgültige Adresse eintragen.`);
  throw new Error(`${tun}: unerwartete Antwort (HTTP ${res.status}).`);
}
const webdav = {
  async teste(cfg) {
    const res = await dav(cfg, 'PROPFIND', '', { headers: { Depth: '0' } });
    pruefeStatus(res, [200, 207], 'Verbindung');
    // Schreibrecht prüfen: eine kleine Testdatei anlegen und wieder löschen.
    const name = `.schreibtest-${process.pid}.txt`;
    const put = await dav(cfg, 'PUT', name, { body: 'ok' });
    pruefeStatus(put, [200, 201, 204], 'Schreiben');
    await dav(cfg, 'DELETE', name).catch(() => {});
    return 'Die Verbindung steht und der Ordner ist beschreibbar.';
  },
  async schreibe(cfg, quellPfad, dateiname) {
    const groesse = (await fs.promises.stat(quellPfad)).size;
    const res = await dav(cfg, 'PUT', dateiname, {
      body: Readable.toWeb(fs.createReadStream(quellPfad)), duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(groesse) },
    });
    pruefeStatus(res, [200, 201, 204], 'Hochladen');
    const head = await dav(cfg, 'HEAD', dateiname);
    const remote = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(remote) && remote !== groesse) {
      throw new Error(`Hochladen: die Datei am Ziel hat ${remote} statt ${groesse} Bytes.`);
    }
    return groesse;
  },
  async liste(cfg) {
    const res = await dav(cfg, 'PROPFIND', '', { headers: { Depth: '1' } });
    pruefeStatus(res, [200, 207], 'Auflisten');
    const xml = await res.text();
    const namen = new Set();
    for (const m of xml.matchAll(/<(?:[a-z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?href>/gi)) {
      let teil = m[1].trim();
      try { teil = decodeURIComponent(teil); } catch { /* unverändert lassen */ }
      const name = teil.replace(/\/+$/, '').split('/').pop();
      if (DATEI_MUSTER.test(name)) namen.add(name);
    }
    return [...namen].sort();
  },
  async loesche(cfg, name) {
    const res = await dav(cfg, 'DELETE', name);
    pruefeStatus(res, [200, 202, 204, 404], 'Löschen');
  },
};

const ZIELE = { verzeichnis, webdav };

export function ziel(typ) {
  const z = ZIELE[typ];
  if (!z) throw new Error(`Unbekannter Speichertyp: ${typ}`);
  return z;
}

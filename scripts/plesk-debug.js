#!/usr/bin/env node
/**
 * Plesk-Debug-Helfer.
 *
 * Führt die gleichen Schritte aus wie app.js (DB initialisieren, Fastify
 * aufbauen), fängt aber Fehler ab und gibt sie aus.
 *
 * Aufruf in Plesk (Node.js-UI → „Anwendungs-Startdatei" temporär auf dieses
 * Skript setzen → „Anwendung neu starten") oder per SSH:
 *   node scripts/plesk-debug.js
 *
 * Kein Top-Level-await: Passengers node-loader.js lädt die Startdatei per
 * CommonJS require(), das schlägt bei einem ESM-Graphen mit Top-Level-await
 * sofort mit ERR_REQUIRE_ASYNC_MODULE fehl (siehe app.js-Kommentar zum
 * gleichen Problem). Deshalb steckt die gesamte Logik in einer async IIFE.
 */

import process from 'node:process';

(async () => {
  console.log('=== Plesk-Debug-Start ===');
  console.log('Node-Version:', process.version);
  console.log('NODE_ENV:', process.env.NODE_ENV || '(nicht gesetzt)');
  console.log('PORT:', process.env.PORT || '(nicht gesetzt)');
  console.log('SECRET gesetzt:', process.env.SECRET ? 'ja (' + process.env.SECRET.length + ' Zeichen)' : 'NEIN');
  console.log('DB_ENCRYPTION_KEY gesetzt:', process.env.DB_ENCRYPTION_KEY ? 'ja (' + process.env.DB_ENCRYPTION_KEY.length + ' Zeichen)' : 'NEIN');
  console.log('DB_PFAD:', process.env.DB_PFAD || '(default)');
  console.log('CWD:', process.cwd());

  try {
    console.log('\n--- Modul better-sqlite3-multiple-ciphers laden ---');
    await import('better-sqlite3-multiple-ciphers');
    console.log('better-sqlite3-multiple-ciphers geladen');

    console.log('\n--- Datenbank initialisieren ---');
    const { getDb } = await import('../src/db.js');
    const db = getDb();
    console.log('DB initialisiert:', db.name);

    console.log('\n--- Fastify-App bauen ---');
    // NODE_ENV=test verhindert, dass app.js beim Import selbst automatisch
    // startet (siehe Guard am Dateiende von app.js) – sonst würde dieses
    // Skript gleich zweimal versuchen, denselben Port zu binden.
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../app.js');
    const app = await buildApp({ logger: true });
    console.log('Fastify-App gebaut');

    console.log('\n--- Server starten ---');
    const portEnv = process.env.PORT;
    const HOST = process.env.HOST || '0.0.0.0';
    const listenOpts = /^\d+$/.test(portEnv ?? '')
      ? { port: Number(portEnv), host: HOST }
      : portEnv
        ? { path: portEnv }
        : { port: 3001, host: HOST };
    const address = await app.listen(listenOpts);
    console.log('Server läuft auf', address);
  } catch (err) {
    console.error('\n=== FEHLER ===');
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
})();

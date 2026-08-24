/**
 * Fastify-Builder. Exportiert `buildApp()` (für Tests) und
 * `start()` (für den normalen Plesk-Start).
 *
 * Plesk-Node.js ruft diese Datei direkt auf — kein gunicorn, kein Proxy.
 *
 * ENV-Variablen:
 *   PORT        – Server-Port (Plesk setzt das selbst, Default 3000)
 *   HOST        – Default 0.0.0.0
 *   SECRET      – Session-Secret (in Produktion ZWINGEND setzen, ≥32 Zeichen)
 *   DB_PFAD     – Pfad zur SQLite-Datei (Default: data/noten.sqlite3)
 *   PUBLIC_URL  – Basis-URL für Einladungslinks (Default: http(s)://Host:Port)
 *   NODE_ENV    – 'production' für Cookie-Secure, kompakteres Logging
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import ejs from 'ejs';
import { readFile } from 'node:fs/promises';

import { getDb } from './src/db.js';
import { authPreHandler, SESSION_COOKIE } from './src/auth.js';
import {
  HALBJAHRE, NOTE_TYPEN, FEHLZEIT_TYPEN, formatNote, formatNoteG,
} from './src/grade-calc.js';
import { formatZeitLokal } from './src/format.js';
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import teacherRoutes from './src/routes/teacher.js';
import klassenlehrerRoutes from './src/routes/klassenlehrer.js';
import exportRoutes from './src/routes/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const SECRET = process.env.SECRET || (isProd ? null : crypto.randomBytes(32).toString('hex'));
const PUBLIC_URL = process.env.PUBLIC_URL || null;

if (!SECRET) {
  console.error('FEHLER: ENV-Variable SECRET muss in Produktion gesetzt sein (mind. 32 Zeichen).');
  process.exit(1);
}

export async function buildApp(opts = {}) {
  const app = fastify({
    logger: opts.logger ?? (isProd
      ? { level: 'info' }
      : { level: 'debug' }),
    bodyLimit: 2 * 1024 * 1024,
    // Hinter Plesks nginx/Passenger terminiert ein Proxy TLS – damit Fastify
    // Protokoll/Host korrekt aus X-Forwarded-* ableitet.
    trustProxy: true,
  });

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: SECRET,
    cookieName: SESSION_COOKIE,
    cookie: {
      secure: isProd,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 12, // 12 h
    },
    saveUninitialized: false,
  });
  await app.register(fastifyFormbody);
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'static'),
    prefix: '/static/',
  });

  // EJS-View-Engine registrieren, ohne @fastify/view (Plesk-Node-Workaround).
  // Wir lesen das Layout manuell und binden den Body ein.
  app.decorateReply('viewEjs', async function(template, data) {
    // Aufrufer übergeben den Namen mal mit, mal ohne '.ejs' – normalisieren,
    // sonst entsteht 'setup.ejs.ejs' → ENOENT → 500.
    const rel = template.endsWith('.ejs') ? template : template + '.ejs';
    const tplPath = path.join(__dirname, 'views', rel);
    const layoutPath = path.join(__dirname, 'views', 'partials', 'layout.ejs');
    const body = await ejs.renderFile(tplPath, { ...(this.locals || {}), ...(data || {}) }, { async: true });
    let html;
    try {
      const layoutTpl = await readFile(layoutPath, 'utf8');
      html = await ejs.render(layoutTpl, { ...(this.locals || {}), ...(data || {}), body }, { async: true });
    } catch (e) {
      // Falls kein Layout (z. B. error.ejs): nur Body
      html = body;
    }
    this.type('text/html; charset=utf-8');
    this.send(html);
  });

  // Flash-Messages: in der Session gepuffert, überleben den Redirect,
  // werden beim nächsten Request angezeigt und geleert.
  app.decorateRequest('flash', function (type, message) {
    this.session.flash = this.session.flash || [];
    this.session.flash.push({ type, message });
  });

  // DB initialisieren
  getDb();

  app.addHook('preHandler', authPreHandler);

  app.addHook('preHandler', (request, reply, done) => {
    reply.locals = reply.locals || {};
    reply.locals.appName = 'Notenverwaltung';
    reply.locals.now = new Date();
    reply.locals.PUBLIC_URL = PUBLIC_URL;
    // Geteilte Anzeige-Konstanten/-Helfer für alle Templates verfügbar machen.
    reply.locals.HALBJAHRE = HALBJAHRE;
    reply.locals.NOTE_TYPEN = NOTE_TYPEN;
    reply.locals.FEHLZEIT_TYPEN = FEHLZEIT_TYPEN;
    reply.locals.formatNote = formatNote;
    reply.locals.formatNoteG = formatNoteG;
    reply.locals.formatZeitLokal = formatZeitLokal;
    const pending = request.session?.flash;
    reply.locals.flash = pending && pending.length ? pending : null;
    if (pending && pending.length) request.session.flash = [];
    done();
  });

  // Index → Login / Setup / Rolle
  app.get('/', async (request, reply) => {
    const userCount = getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (!request.user) {
      if (userCount === 0) return reply.redirect('/setup');
      return reply.redirect('/login');
    }
    if (request.user.isAdmin) return reply.redirect('/admin');
    return reply.redirect('/teacher');
  });

  await app.register(authRoutes, { prefix: '' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(teacherRoutes, { prefix: '/teacher' });
  await app.register(klassenlehrerRoutes, { prefix: '/klassenlehrer' });
  await app.register(exportRoutes, { prefix: '/export' });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).viewEjs('error', { code: 404, message: 'Seite nicht gefunden.' });
  });

  app.setErrorHandler((err, request, reply) => {
    app.log.error({ err, url: request.url }, 'Request-Fehler');
    if (reply.sent) return;
    if (request.headers.accept && request.headers.accept.includes('application/json')) {
      return reply.code(500).send({ error: 'server error' });
    }
    reply.code(500).viewEjs('error', { code: 500, message: 'Interner Serverfehler.' });
  });

  return app;
}

async function start() {
  const app = await buildApp();
  const portEnv = process.env.PORT;
  const HOST = process.env.HOST || '0.0.0.0';
  // Plesk/Passenger übergibt PORT häufig als Unix-Socket-PFAD (keine Zahl).
  // parseInt() würde das in NaN→3001 verwandeln → Passenger erreicht die App
  // nicht → 504. Deshalb numerisch vs. Socket-Pfad unterscheiden.
  const listenOpts = /^\d+$/.test(portEnv ?? '')
    ? { port: Number(portEnv), host: HOST }
    : portEnv
      ? { path: portEnv }
      : { port: 3001, host: HOST };
  try {
    const address = await app.listen(listenOpts);
    app.log.info(`Notenverwaltung läuft auf ${address}`);
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

// Plesk/Passenger lädt diese Datei über einen eigenen node-loader.js per
// require() – dabei stimmt process.argv[1] nie mit dieser Datei überein,
// ein import.meta.url-Vergleich schlägt unter Passenger also IMMER fehl
// und start() würde nie aufgerufen (→ Passenger-Timeout, kein Listener).
// Tests setzen NODE_ENV=test, bevor sie buildApp() selbst aufrufen – das
// ist der einzige Fall, in dem hier kein automatischer Start passieren darf.
if (process.env.NODE_ENV !== 'test') {
  start();
}

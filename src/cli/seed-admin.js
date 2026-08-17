/**
 * CLI: Ersten Admin anlegen, falls die Datenbank leer ist.
 * Aufruf: node src/cli/seed-admin.js --username admin --display "T. Lehrer" [--password ...]
 */

import { getDb, DB_PATH } from '../db.js';
import { hashPassword } from '../auth.js';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) params[args[i].slice(2)] = args[i + 1] || '';
}

const username = String(params.username || '').trim();
const display_name = String(params.display_name || '').trim();
const password = params.password || (() => {
  const p = randomBytes(9).toString('base64url');
  console.log(`Zufälliges Passwort generiert: ${p}`);
  return p;
})();

if (!username) {
  console.error('Nutzung: node src/cli/seed-admin.js --username <name> [--display "Anzeigename"] [--password <pw>]');
  process.exit(1);
}

const db = getDb();
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount > 0) {
  console.error('Es existieren bereits Benutzer. Setup nicht nötig.');
  console.error('Über die Admin-UI weitere Admins anlegen.');
  process.exit(1);
}

try {
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role, active)
              VALUES (?, ?, ?, 'admin', 1)`)
    .run(username, display_name || username, hashPassword(password));
  console.log(`Admin '${username}' angelegt. DB: ${DB_PATH}`);
} catch (e) {
  console.error('Fehler:', e.message);
  process.exit(1);
}

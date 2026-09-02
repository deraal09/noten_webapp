/**
 * Sitzungsspeicher für @fastify/session in der bestehenden SQLite-Datenbank
 * (Tabelle `sessions`, siehe db.js) statt des mitgelieferten Default-Stores,
 * der nur im Arbeitsspeicher des Node-Prozesses lebt. Ohne diesen Store wäre
 * nach jedem Neustart (z. B. jedem Deploy auf Plesk: „Git Pull" + „App neu
 * starten") jede angemeldete Person ohne Vorwarnung ausgeloggt — mit diesem
 * Store übersteht eine Anmeldung Neustarts, solange die Session selbst noch
 * nicht abgelaufen ist (siehe `cookie.maxAge` bzw. der „Angemeldet
 * bleiben"-Haken beim Login, `src/routes/auth.js`).
 *
 * Implementiert die von @fastify/session erwartete Store-Schnittstelle
 * (`get`/`set`/`destroy`, Callback-Stil) — siehe deren `lib/store.js`
 * (Default-`MemoryStore`), die dieselbe Schnittstelle mit einer `Map` erfüllt.
 */
export class SqliteSessionStore {
  constructor(db) {
    this.db = db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (e) {
      callback(e);
    }
  }

  set(sid, session, callback) {
    try {
      // Fallback, falls eine Session (theoretisch) ohne cookie.expires
      // gespeichert wird: 12 h, statt dauerhaft in der DB zu bleiben.
      const expiresAt = session?.cookie?.expires
        ? new Date(session.cookie.expires).getTime()
        : Date.now() + 1000 * 60 * 60 * 12;
      this.db.prepare(`
        INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(session), expiresAt);
      // Nebenbei abgelaufene Sessions aufräumen -- kein separater
      // Cronjob/Timer nötig, die Tabelle bleibt dadurch klein.
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      callback();
    } catch (e) {
      callback(e);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback();
    } catch (e) {
      callback(e);
    }
  }
}

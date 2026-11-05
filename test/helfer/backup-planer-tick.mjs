// Ein Tick des Backup-Planers in einem eigenen Prozess (für test/backup-robustheit.test.js):
// wie starteBackupPlaner() -- fällig? dann sichern. Gibt das Ergebnis als JSON aus.
const { ladeEinstellungenMitPasswort, istFaellig, letzterLauf } = await import('../../src/backup/einstellungen.js');
const { fuehreBackupAus } = await import('../../src/backup/backup.js');
// Beide Prozesse sollen möglichst gleichzeitig prüfen: bis zum vereinbarten Startzeitpunkt warten.
const start = Number(process.env.START_UM || 0);
while (Date.now() < start) await new Promise((r) => setTimeout(r, 5));
const ergebnis = istFaellig(ladeEinstellungenMitPasswort(), letzterLauf())
  ? await fuehreBackupAus('geplant', { nurWennFaellig: true })
  : { ok: false, uebersprungen: true, meldung: 'nicht fällig' };
console.log(JSON.stringify(ergebnis));

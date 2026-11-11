# API für KI-Agenten (`/api/v1`)

Mit der API lesen, werten und tragen ein KI-Agent oder ein Programm Noten ein -- im Namen einer Lehrkraft und mit deren Rechten.
Die ausführliche, immer aktuelle Beschreibung steht in der laufenden App: **`/api/v1/docs`** (Seite) und **`/api/v1/openapi.json`**
(OpenAPI 3, z. B. für Tool-/Function-Calling). Quelle der Beschreibung ist `src/api-docs.js`, der Code `src/routes/api-v1.js`.

## API-Schlüssel

* Jede Lehrkraft mit **Schulkonto (LDAP)** legt ihre Schlüssel selbst an: Menü **🤖 API-Zugang** (`/konto/api`). Lokale Konten
  (auch der Admin) haben keinen API-Zugang; ein Schlüssel eines Kontos, das kein Schulkonto (mehr) ist, wird mit `403 nur_ldap` abgelehnt.
* Format `nk_…`. Der Klartext wird **nur einmal** angezeigt; in der Datenbank steht nur der SHA-256-Hash (Tabelle `api_keys`).
* Berechtigung je Schlüssel: **lesen** (Abfragen und Berechnungen) oder **schreiben** (zusätzlich Noten eintragen).
* Gültigkeit: 30 Tage, 90 Tage, 6 Monate oder 1 Jahr (höchstens ein Jahr); Widerruf wirkt sofort. Höchstens 20 aktive Schlüssel je Person.
  Früher unbegrenzte Schlüssel laufen ein Jahr nach dem Update auf 0.131.0 ab.
* Admin (`/admin/api`): sieht alle Schlüssel, kann sie **deaktivieren** (`401`, wieder aktivierbar) oder **löschen** und die API
  insgesamt **abschalten** (Vorgabe: an) -- dann antwortet jeder Aufruf mit `503 api_deaktiviert`; die Dokumentation bleibt erreichbar.
  „Alle laufenden Anmeldungen von LDAP-Konten beenden“ (LDAP-Einstellungen) widerruft auch alle Schlüssel der LDAP-Konten.
* Ein Schlüssel handelt als seine Besitzerin/sein Besitzer: dieselben Rechte und Prüfungen wie in der Oberfläche (nur eigene Klassen/Fächer
  und Halbjahre, nur Teilnehmende des Fachs, keine Eingabe bei Notenkonferenz-Sperre).

```bash
curl -H "Authorization: Bearer nk_DEIN_SCHLUESSEL" https://<server>/api/v1/me
```

## Endpunkte (Kurzfassung)

| Methode | Pfad | Schlüssel | Zweck |
|---|---|---|---|
| GET | `/me` | lesen | Konto und Berechtigung des Schlüssels |
| GET | `/klassen` | lesen | meine Klassen, Fächer (IDs), Kurse |
| GET | `/klassen/{id}/schueler` | lesen | Schüler:innen mit IDs |
| GET | `/faecher/{id}?halbjahr=` | lesen | Klausuren, Zusatzleistungen, Termine mit IDs |
| GET | `/faecher/{id}/noten?halbjahr=` | lesen | Notenübersicht aller Personen |
| GET | `/faecher/{id}/statistik?halbjahr=` | lesen | Durchschnitt, Verteilung, nicht bestanden |
| GET | `/notenschluessel` | lesen | Notenschlüssel IHK, BG, SPA |
| POST | `/berechnen/klausur` | lesen | Note aus Punkten berechnen (speichert nichts) |
| POST | `/klassen` | schreiben | Klasse anlegen (IHK/BG/SPA, Laufzeit; wiederholbar) |
| PUT | `/klassen/{id}/laufzeit` | schreiben | Laufzeit (Einschulung, Dauer) nachträglich ändern |
| POST | `/klassen/{id}/schueler` | schreiben | Schüler:innen anlegen (Doppelte werden übersprungen) |
| POST | `/klassen/{id}/faecher` | schreiben | Fach anlegen (Halbjahre wählbar; wiederholbar) |
| GET | `/papierkorb` | lesen | meine gelöschten Klassen mit Frist, `sofort_loeschbar` und `blockiert_durch_faecher` |
| DELETE | `/klassen/{id}` | schreiben | Klasse in den Papierkorb legen (wiederherstellbar) |
| POST | `/papierkorb/{id}/wiederherstellen` | schreiben | Klasse aus dem Papierkorb holen |
| DELETE | `/papierkorb/{id}` | schreiben | Klasse sofort endgültig löschen (nur wenn niemand sonst sie nutzt und keine fremden Noten enthält) |
| POST | `/kurse` | schreiben | Kurs anlegen (Standard BG; wiederholbar) |
| PUT | `/klassen/{id}/name` | schreiben | Klasse umbenennen (jede Lehrkraft der Klasse; gilt für alle) |
| PUT | `/faecher/{id}/name` | schreiben | Kurs umbenennen (jede Lehrkraft des Kurses; gilt für alle) |
| GET | `/faecher/{id}/teilnehmer` | lesen | Teilnehmerliste mit IDs |
| POST | `/faecher/{id}/teilnehmer` | schreiben | Personen aufnehmen (Nachname, Vorname, Klasse; wie CSV-Import) |
| POST | `/faecher/{id}/klausuren` | schreiben | Klausur anlegen |
| PUT | `/klausuren/{id}/ergebnisse` | schreiben | Klausurpunkte (mehrere Personen) |
| POST | `/faecher/{id}/unterrichtsleistungen` | schreiben | Zusatzleistung anlegen |
| PUT | `/unterrichtsleistungen/{id}/ergebnisse` | schreiben | Punkte der Zusatzleistung |
| POST | `/faecher/{id}/termine` | schreiben | Termin der Datumstabelle anlegen |
| PUT | `/termine/{id}/noten` | schreiben | Noten je Termin (auch `"n.a."`) |
| PUT | `/faecher/{id}/endnoten` | schreiben | Endnoten / `"ntg"` |
| POST | `/faecher/{id}/sync` | schreiben | mit der Klassenleitung synchronisieren („Jetzt synchronisieren“) |
| PUT | `/faecher/{id}/auto-sync` | schreiben | automatischen Sync ein-/ausschalten |

## Verhalten für Agenten

* **Alles oder nichts:** Ist bei einem Aufruf mit mehreren Personen ein Eintrag ungültig, wird nichts gespeichert (`422`, Liste unter `details`).
* **Probelauf:** `?dry_run=true` prüft und zeigt die berechneten Noten, ohne zu speichern -- vor dem Eintragen immer nutzen.
* **Idempotent:** Wiederholen schadet nicht. **Gelöscht wird nur über den Papierkorb für Klassen:** `DELETE /klassen/{id}` legt eine Klasse in den Papierkorb (wiederherstellbar), `DELETE /papierkorb/{id}` löscht sie sofort endgültig – aber nur, wenn keine weitere Lehrkraft mehr mit der Klasse verbunden ist (`409 noch_verbunden` sonst) und kein Fach Noten enthält, dem keine Lehrkraft (mehr) zugeordnet ist (`409 fremde_noten`, `details.faecher`; solche Klassen löscht nur der Admin in der App, auch der automatische Ablauf der Frist überspringt sie). Sonst lässt sich nichts löschen (leeren geht mit `null`).
* **Lernfelder, Komponenten, Unterfächer:** Ein Fach, das zu einem Lernfeld (SPA) bzw. zu einem übergeordneten Fach gehört, steht mit `art` und `uebergeordnet` in
  `GET /klassen` und `GET /faecher/{id}`. Eingetragen wird **im Unterfach bzw. in der Komponente selbst** (eigene ID, dort wo die Lehrkraft zugeordnet ist); das
  Lernfeld bzw. Fach mit Unterfächern lässt sich lesen (auch von Lehrkräften, die nur einem Unterfach zugeordnet sind), aber nicht beschreiben (`409`, `details`
  nennt die Unterfach-IDs). In SPA-Fächern kommen `leistungspunkte` und `tendenz` dazu; Endnoten sind dort Gesamtpunkte 0–15.
* **Personen anlegen:** Die Teilnehmerliste eines Fachs oder Kurses füllt `POST /faecher/{id}/teilnehmer` (Nachname, Vorname, Klasse je Person; legt
  fehlende Personen und Klassen an, überspringt Doppelte). Eine **Klasse** legt `POST /klassen` an (leer, bei SPA mit der Fächervorgabe); die Schüler:innen einer Klasse legt `POST /klassen/{id}/schueler` an (Nachname, Vorname je Person; Doppelte werden übersprungen), Fächer einer Klasse `POST /klassen/{id}/faecher`.
* **Grenzen:** 120 Anfragen pro Minute und Schlüssel, 500 Einträge je Aufruf, 40 Aufgaben je Klausur.
* **Datenschutz:** Namen und Noten verlassen das System. Der Einsatz eines externen KI-Dienstes muss datenschutzrechtlich zulässig sein.
* Fehlerformat: `{ "error": "code", "message": "…", "details": [ … ] }`.

## Synchronisation mit der Klassenleitung

Die Klassenleitung sieht nie die Live-Noten eines Fachs, nur den zuletzt **synchronisierten** Stand. Über die API geht beides wie in der App:

* `PUT /faecher/{id}/auto-sync` mit `{"aktiv": true}` schaltet den Haken „automatisch synchronisieren“ ein (je Lehrkraft und Fach). Danach löst **jede
  Eintragung über die API** den Sync von selbst aus; beim Einschalten wird sofort einmal synchronisiert.
* `POST /faecher/{id}/sync` synchronisiert auf Knopfdruck (z. B. am Ende einer Eintragung ohne Auto-Sync).
* `GET /faecher/{id}` zeigt unter `sync`, ob der Auto-Sync an ist und wann zuletzt (und von wem) synchronisiert wurde.

## Beispiel: Klausurpunkte eintragen

```bash
# 1. IDs holen
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/klassen"
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/faecher/41?halbjahr=5"

# 2. Probelauf
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"ergebnisse":[{"schueler_id":301,"punkte":[12,11,6]},{"schueler_id":302,"punkte":[9,null,null]}]}' \
  "$BASE/api/v1/klausuren/7/ergebnisse?dry_run=true"

# 3. Speichern (ohne dry_run) und kontrollieren
curl -X PUT ... "$BASE/api/v1/klausuren/7/ergebnisse"
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/faecher/41/noten?halbjahr=5"
```

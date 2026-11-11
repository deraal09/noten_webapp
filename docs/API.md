# API für KI-Agenten (`/api/v1`)

Mit der API lesen, werten und tragen ein KI-Agent oder ein Programm Noten ein -- im Namen einer Lehrkraft und mit deren Rechten.
Die ausführliche, immer aktuelle Beschreibung steht in der laufenden App: **`/api/v1/docs`** (Seite) und **`/api/v1/openapi.json`**
(OpenAPI 3, z. B. für Tool-/Function-Calling). Quelle der Beschreibung ist `src/api-docs.js`, der Code `src/routes/api-v1.js`.

## API-Schlüssel

* Jede angemeldete Person legt ihre Schlüssel selbst an: Menü **🤖 API-Zugang** (`/konto/api`).
* Format `nk_…`. Der Klartext wird **nur einmal** angezeigt; in der Datenbank steht nur der SHA-256-Hash (Tabelle `api_keys`).
* Berechtigung je Schlüssel: **lesen** (Abfragen und Berechnungen) oder **schreiben** (zusätzlich Noten eintragen).
* Gültigkeit: 30 Tage, 90 Tage, 1 Jahr oder unbegrenzt; Widerruf wirkt sofort. Höchstens 20 aktive Schlüssel je Person.
* Ein Schlüssel handelt als seine Besitzerin/sein Besitzer: dieselben Rechte und Prüfungen wie in der Oberfläche (nur eigene Klassen/Fächer
  und Halbjahre, nur Teilnehmende des Fachs, keine Eingabe bei Notenkonferenz-Sperre). Ein Admin-Schlüssel hat die Rechte des Admins.

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
* **Idempotent:** Wiederholen schadet nicht. **Gelöscht wird über die API nichts** (leeren geht mit `null`).
* **Nicht über die API beschreibbar:** SPA-Fächer und Fächer, die sich im Halbjahr aus Unterfächern zusammensetzen (`409`); lesen geht.
* **Personen anlegen:** Schüler:innen und Teilnehmerlisten legt die API nicht an (App: Klasse -- Einzeln/Mehrere auf einmal/CSV-Import; Kurs -- Suche,
  „Manuell anlegen“ oder CSV-Import `Nachname;Vorname;Klasse`). Danach stehen sie mit IDs in der API.
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

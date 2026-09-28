# Changelog

Versionsnummer (`package.json`: `version`) und Release-Datum
(`package.json`: `releaseDate`) werden von Hand gepflegt, siehe
[README.md → Versionsnummer](README.md#versionsnummer). Diese Datei wird ab
`0.36.0` laufend bei jedem Versionssprung um einen Eintrag ergänzt -- ältere
Versionen sind hier nicht rückwirkend erfasst.

## 0.37.0 - 2026-09-28

- Fix: rein historische Fächer (z. B. für ein vergangenes Schuljahr mit
  anderem Fächerkanon angelegt) konnten in der Halbjahresübersicht der
  Klassenleitung fälschlich als aktuelles Fach ohne Teilnehmer/innen
  auftauchen, u. a. nach einem Server-Neustart. Behoben an der Quelle
  (`ladeFaecherFuerKlassenleitung`, `fuelleFachTeilnehmerAuf`) plus
  einmalige Bereinigung bereits betroffener Bestandsdaten.
- Klassenleitungsübersicht: Fächer ohne zugewiesene Lehrkraft können jetzt
  von der Klassenleitung gelöscht werden (Aufräumen versehentlich oder
  falsch angelegter Fächer) -- gesperrt, solange noch eine Lehrkraft
  zugewiesen ist.
- Klassenleitungsübersicht: neue Schuljahr-Auswahl in der
  Halbjahresübersicht (Standard: aktuelles Schuljahr); bei Auswahl eines
  vergangenen Schuljahres werden dessen historische Fächer/Noten
  angezeigt statt des laufenden Sync-Standes.

## 0.36.0 - 2026-09-28

- Klassenleitung: Lehrkräfte können den Fächern vergangener Halbjahre
  zugeordnet werden und bekommen dadurch Zugriff auf die Notentafel/Historie.
- Vergangenes Schuljahr hinzufügen: nur noch die im Formular genannten
  Fächer/Lernfelder werden angelegt, nicht mehr automatisch die aktuellen
  Fächer der Klasse (die können in einem vergangenen Schuljahr andere
  gewesen sein).
- Historische Noten über mehrere Fächer/Lernfelder auf einen Schlag per Text
  einfügen oder CSV-Upload importieren, statt Fach für Fach und Schüler für
  Schüler von Hand.
- Vergangene, von einer Fachlehrkraft selbst angelegte historische Halbjahre
  werden der Klassenleitung synchronisiert angezeigt (nur lesend, nicht mehr
  überschreibbar).
- Noteneingabe (Dashboard): rein historische Fächer erscheinen nicht mehr im
  aktuellen Schuljahr, sondern nur noch nach expliziter Auswahl des
  jeweiligen vergangenen Schuljahres über eine neue Schuljahr-Auswahl.

# Changelog

Versionsnummer (`package.json`: `version`) und Release-Datum
(`package.json`: `releaseDate`) werden von Hand gepflegt, siehe
[README.md → Versionsnummer](README.md#versionsnummer). Diese Datei wird ab
`0.36.0` laufend bei jedem Versionssprung um einen Eintrag ergänzt -- ältere
Versionen sind hier nicht rückwirkend erfasst.

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

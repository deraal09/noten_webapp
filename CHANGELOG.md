# Changelog

Versionsnummer (`package.json`: `version`) und Release-Datum
(`package.json`: `releaseDate`) werden von Hand gepflegt, siehe
[README.md → Versionsnummer](README.md#versionsnummer). Diese Datei wird ab
`0.36.0` laufend bei jedem Versionssprung um einen Eintrag ergänzt -- ältere
Versionen sind hier nicht rückwirkend erfasst.

## 0.39.0 - 2026-09-29

- Abschluss-/Abgangsübersicht (Klassenleitungsübersicht-Reiter und eigene
  Seite): zeigt jetzt alle Fächer über die gesamte Schullaufbahn -- neben
  den aktuellen Fächern des laufenden Schuljahres auch alle rein
  historischen Fächer vergangener Schuljahre samt Fachabschlussnote, statt
  nur die aktuellen. Rein historische Fächer sind zusätzlich mit ihrem
  Schuljahr (bzw. der Schuljahr-Spanne, falls sie mehrere umfassen)
  beschriftet. Der "Ø Abschluss"-Notenschnitt mittelt entsprechend über
  alle abgeschlossenen Fächer, nicht mehr nur die aktuellen.

## 0.38.2 - 2026-09-29

- Fix: Noteneingabe zeigte bei einem rein historischen Fach weiterhin die
  Halbjahresumschaltung des laufenden Schuljahres an, obwohl die für dieses
  Fach keine Bedeutung hat -- sie ist jetzt ausgeblendet, stattdessen ist
  der Reiter "Historische Halbjahre" (mit Teilnehmer/innen und Noten) von
  vornherein aktiv statt der (für so ein Fach immer leeren) Notenübersicht.
- Fix: bei einem normalen Fach führte ein Wechsel der Halbjahresumschaltung
  dazu, dass Teilnehmer/innen und Noten scheinbar verschwanden, wenn zuvor
  über "⋮ Mehr" ein anderer Reiter gewählt war -- die Umschaltung springt
  jetzt gezielt zurück zur Notenübersicht.

## 0.38.1 - 2026-09-29

- Fix: Noteneingabe (Dashboard) zeigte bei Auswahl eines vergangenen
  Schuljahres zusätzlich weiterhin alle Fächer des aktuellen Schuljahres an
  -- diese werden jetzt nur noch unter "Aktuelles Schuljahr" angezeigt.
- Fix: die Kacheln der vergangenen Schuljahre führten auf die normale
  Notenübersicht eines Fachs, die für ein rein historisches Fach immer leer
  ist (keine Teilnehmer/innen, keine Klausuren) -- der Link führt jetzt
  direkt in den Reiter "Historische Halbjahre" mit den tatsächlichen
  Teilnehmer/innen und Noten.

## 0.38.0 - 2026-09-29

- Historische Noten: neues Kürzel <code>ntg</code> (nicht teilgenommen) kann
  jetzt statt einer Zahl eingetragen werden (manuell und per Text-/CSV-Import)
  -- zählt wie eine fehlende Note nicht in den Notenschnitt, wird aber
  explizit als "ntg" angezeigt statt als "–".
- Fach abschließen (Fachabschlussnote aus allen Halbjahren) ist jetzt auch
  für rein historische Fächer über die Klassenleitungs-Seite
  (/klassenlehrer/fach/:id/historie) verfügbar, nicht mehr nur über die
  normale Fach-Seite einer zugewiesenen Lehrkraft.
- Klassenleitungsübersicht: die Halbjahresübersicht eines vergangenen
  Schuljahres zeigt jetzt beide Halbjahre nebeneinander statt nur eines.

## 0.37.1 - 2026-09-29

- Fix: Bei einem rein historischen Fach zeigte die normale Fach-Seite
  (Noteneingabe) im Panel "Historische Halbjahre" nur den Fachnamen, aber
  keine Teilnehmer/innen oder Noten -- die Liste stützte sich fälschlich auf
  die (bei einem rein historischen Fach absichtlich leere) Teilnehmerliste
  der Live-Notentafel statt auf alle aktuellen Schüler/innen der Klasse, wie
  es die Speicher-Route und die Klassenleitungs-Seite bereits richtig
  machten.
- Fach löschen (Klassenleitung): Sprung zurück zum Fächer-Bereich statt an
  den Seitenanfang.

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

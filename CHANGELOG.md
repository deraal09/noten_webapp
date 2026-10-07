# Changelog

Versionsnummer (`package.json`: `version`) und Release-Datum
(`package.json`: `releaseDate`) werden von Hand gepflegt, siehe
[README.md → Versionsnummer](README.md#versionsnummer). Diese Datei wird ab
`0.36.0` laufend bei jedem Versionssprung um einen Eintrag ergänzt -- ältere
Versionen sind hier nicht rückwirkend erfasst.

## 0.77.0 - 2026-10-07

- **Fächer aus Vorlage importieren** trägt die importierende Lehrkraft nicht mehr
  automatisch ein: Alle importierten Fächer (und Unterfächer) starten **ohne
  Lehrkraft** und werden danach über die Klassenseite neu zugeordnet.

## 0.76.1 - 2026-10-07

- Fix: Hinter dem Klassennamen stand nach einer Änderung des Einschulungsjahres
  weiter das beim Anlegen gewählte Schuljahr. Jetzt zeigen die Überschriften
  (Klassenansicht, Klassenleitung, Sitzplan, Konferenz, Halbjahres-/Abschluss-
  übersicht, Zeugnis, Noteneingabe, Klassenlisten) die **Laufzeit der Klasse**,
  z. B. „2024/25–2026/27" (bei einem Jahr nur „2025/26"), und folgen damit
  Einschulungsjahr und Anzahl Jahre.

## 0.76.0 - 2026-10-07

- Klassenansicht („Meine Klassen"): In der obersten Zeile unter dem Titel steht
  für alle mit Zugriff auf die Klasse, **wer als Klassenleitung eingetragen
  ist** (alle Klassenlehrkräfte, alphabetisch) bzw. „noch niemand eingetragen".

## 0.75.0 - 2026-10-07

- Fächer aus Vorlage importieren: ab zwei Vorlagen gibt es oben im Dialog ein
  **Filterfeld**. Es durchsucht Vorlagenname, Fächer und Unterfächer (mehrere
  Suchbegriffe müssen alle passen) und blendet nicht passende Vorlagen aus; das
  Feld ist beim Öffnen sofort bedienbar.

## 0.74.0 - 2026-10-07

- **Mehrere Schüler/innen auf einmal:** Neben dem Komma sind jetzt auch
  **Semikolon, Tab und Leerzeichen** als Trenner zwischen Nach- und Vorname
  erlaubt (immer Nachname zuerst) -- z. B. aus einer Tabelle kopiert.
  Nach einem Komma/Semikolon/Tab ist alles Weitere der Vorname (auch mehrteilig).
- **Doppelnamen-Erkennung:** Zeilen nur mit Leerzeichen und mehr als zwei Wörtern
  (z. B. „Müller Schmidt Anna") sind nicht eindeutig. Sie werden nicht
  angelegt, sondern mit Hinweis angezeigt: bitte direkt nach dem Nachnamen ein
  Komma setzen („Müller Schmidt, Anna"). Die Zeilen stehen im Feld zur
  Korrektur bereit, alle übrigen Personen werden sofort angelegt.

## 0.73.1 - 2026-10-07

- Fix: Dieselbe Klasse konnte **doppelt** entstehen (zwei Klassen mit gleichem
  Namen und unterschiedlichen Fächern). Weil eine Klasse über mehrere
  Schuljahre läuft, prüfte die Doppelt-Sperre nur das gewählte Schuljahr. Jetzt
  wird beim Anlegen einer Klasse und beim manuellen Hinzufügen einer Person zu
  einem Fach (Feld „Klasse") eine bereits laufende Klasse gleichen Namens
  erkannt: man tritt ihr bei bzw. nutzt sie, statt eine zweite anzulegen. Nach
  Ende der Laufzeit bleibt derselbe Name für einen neuen Jahrgang möglich.

## 0.73.0 - 2026-10-07

- „Neue Klasse anlegen" → **„Vorhandene Klasse wählen"**: Es gibt nur noch die
  Auswahl bereits vorhandener Klassen (Name, Schuljahr, Notenschlüssel; ohne die
  eigenen). Schuljahr, Notenschlüssel, Einschulungsjahr und Anzahl der
  Schuljahre kommen von der gewählten Klasse und lassen sich dort nicht mehr
  einstellen; auch das Freigabe-Häkchen entfällt, da die Klasse schon freigegeben
  ist. Die Auswahl führt in den Beitritt zu dieser Klasse.
- Bei **„Neue Klasse anlegen"** ist der Haken „Automatisch für andere Lehrkräfte
  freigeben" jetzt standardmäßig gesetzt.

## 0.72.0 - 2026-10-07

- **Fächer-Vorlagen:** Neben „+ Neues Fach anlegen" gibt es auf der Klassenseite
  zwei weitere Buttons. **„💾 Fächer als Vorlage speichern"** sichert die
  gewählten Fächer samt Unterfächern, Halbjahren, Unterfach-Gewichten und
  Verrechnung unter einem Namen. **„📥 Fächer aus Vorlage importieren"** legt
  diese Fächer in jeder neuen Klasse mit demselben Notenschlüssel an
  (bestehende Fächer bleiben unberührt; Halbjahre jenseits der Laufzeit der
  Klasse entfallen). Die **Lehrkraftzuordnung ist nicht Teil der Vorlage** –
  beim Import wird nur die importierende Person zugeordnet, alle anderen
  ordnet die Klassenleitung neu zu. Vorlagen gehören der speichernden Lehrkraft
  und lassen sich im Import-Dialog löschen.

## 0.71.0 - 2026-10-07

- **„Fach abschließen" entfällt** (Button, Reiter und Routen zum Abschließen und
  Wiederöffnen). Ob ein Fach abgeschlossen ist, ergibt sich jetzt aus seinen
  Halbjahren: Ist das letzte Halbjahr des Fachs vorbei, gilt es als
  abgeschlossen und zeigt seine **Fachabschlussnote** (Mittelwert aus allen
  Halbjahren, live berechnet statt eingefroren). Das gilt in der Notenübersicht,
  der Abschluss-/Abgangsübersicht, im Abgangszeugnis und im SPA-Zeugnis.
  Fächer, die noch laufen, zeigen „läuft" bzw. den aktuellen Stand. Früher von
  Hand gesetzte Abschlüsse spielen keine Rolle mehr.

## 0.70.0 - 2026-10-07

- Der Reiter **„Teilnehmer/innen"** ist aus der Noteneingabe entfernt. Die
  Verwaltung (Personen entfernen, per Suche oder manuell hinzufügen) liegt jetzt
  bei „Meine Klassen": Button 👥 an jedem Fach der Klassenseite, bei Kursen in
  der Kursliste (eigene Seite je Fach).
- **Berechtigung:** Solange sich niemand als Klassenleitung der Klasse
  eingetragen hat, darf jede Lehrkraft mit Zugriff auf die Klasse die Teilnehmer
  verwalten; danach nur noch die Klassenleitung (und der Admin). Kurse:
  die ihnen zugeordneten Lehrkräfte.

## 0.69.0 - 2026-10-07

- **Manuelle Noten entfernt:** Der Reiter „Manuelle Noten", die Spalten
  „Mündliche Noten"/„Schriftliche Noten" in der Notenübersicht, der Abschnitt in
  der Notenbesprechung, die beiden Routen und die CSV-Spalten „Mündlich
  (manuell)"/„Schriftlich (manuell)" entfallen -- das übernimmt die direkte
  Noteneingabe. Die Spalten „Mündliche/Schriftliche Note" (berechnet) werden nun
  immer angezeigt. Alte Einträge bleiben nur in der Datenbank liegen und
  blockieren keine Halbjahres-Änderungen mehr.

## 0.68.0 - 2026-10-07

- Fächer lassen sich **nachträglich bearbeiten**: Ein Klick auf den Fachnamen
  (Klassenleitung) öffnet einen Dialog mit „Bearbeiten" und „Zur Noteneingabe".
  „Bearbeiten" ändert Name, Halbjahre und die **Verrechnung** des Fachs
  (Unterfächer: Name und Halbjahre; Unterfächer ziehen den neuen Namen des Fachs
  mit). Vorgegebene SPA-Fächer und -Komponenten sind nicht umbenennbar.
- Beim **Anlegen eines Fachs** lässt sich die Verrechnung gleich mit einstellen
  (nur Klassenleitung; vorbelegt mit der Klassen-Vorgabe).
- Fächer sind zusätzlich **nach Halbjahren sortiert**: Teilbereiche aufsteigend
  (früheste zuerst), Fächer in allen Halbjahren ganz unten; lückenhafte Angaben
  (z. B. 1. und 3. Halbjahr) zählen wie „alle Halbjahre". Innerhalb einer Gruppe
  alphabetisch. Gilt auf der Klassenseite, in der Noteneingabe-Übersicht und in
  den Klassenleitungs-Übersichten.

## 0.67.0 - 2026-10-07

- Klassenseite: Bei den Halbjahres-Einstellungen von Fächern, Unterfächern und
  Lehrkräften gibt es nur noch den **Stift** (✎) ohne kleines Dreieck; die
  Halbjahre des Fachs stehen als Text daneben.
- **Touch-Optimierung:** Buttons, Symbol-Buttons, Menüeinträge, Eingabefelder,
  Auswahllisten und Halbjahres-Checkboxen sind größer (mind. ca. 44 px), die
  Grundschrift ist etwas größer (15 → 17 px).

## 0.66.0 - 2026-10-07

- Noteneingabe: Oben gibt es einen **Klassenfilter** (Auswahl „Alle Klassen",
  einzelne Klasse oder „Kurse"), sobald Fächer in mehr als einer Klasse bzw.
  in Klassen und Kursen liegen. Die Auswahl wird im Browser gemerkt.

## 0.65.0 - 2026-10-07

- Fächer werden **alphabetisch** sortiert (deutsche Sortierung: Groß-/Klein-
  schreibung egal, Umlaute wie A/O/U, Zahlen numerisch: „LF2" vor „LF10"):
  Klassenseite (samt Unterfächern), Noteneingabe-Übersicht, Klassenleitungs-
  Übersichten, Abschluss/Zeugnis und CSV-Export.

## 0.64.1 - 2026-10-07

- SPA: Die Spalte **„Altnote (importiert)"** entfällt in der Eingabemaske; ihre
  Aufgabe übernimmt der **Vorwert**. Bereits gespeicherte Altnoten werden bei der
  Berechnung nicht mehr berücksichtigt, das Feld wird nicht mehr angenommen.

## 0.64.0 - 2026-10-07

- **Verrechnung der Halbjahre auch für SPA-Fächer**, je Fach einzeln auf der
  Fachseite (Noteneingabe): einklappbarer Abschnitt „Verrechnung der Halbjahre"
  (ändern nur Klassenleitung). Zu den eingestellten Prozent fließen die
  Leistungspunkte des Vorhalbjahres in die des Halbjahres ein; sie speisen wie
  bisher Direktwert bzw. Komponente und damit die Endpunkte. SPA-Fächer erben
  keine Klassen-Vorgabe (Standard: keine Verrechnung).

## 0.63.0 - 2026-10-07

- Die Abschnitte **„Laufzeit der Klasse"** und **„Verrechnung der Halbjahre"**
  sind aus dem Klassenleitungs-Bereich verschwunden. Die Laufzeit stellt die
  Klassenleitung im Menü „Einschulungsjahr festlegen" auf der Klassenseite ein
  (Meine Klassen).
- Die **Verrechnung der Halbjahre** gilt jetzt **je Fach** (nicht für
  Unterfächer und SPA-Fächer): auf der Klassenseite gibt es oberhalb der Fächer
  einen einklappbaren Abschnitt „Verrechnung der Halbjahre" (nur Klassenleitung)
  mit einem Dialog je Fach (⚖️) und der Option „Für alle Fächer der Klasse
  übernehmen". Bisherige Klassen-Einstellungen gelten weiter für Fächer ohne
  eigene Einstellung.
- Fix: Unterfächer wurden bisher zusätzlich selbst verrechnet, obwohl das Fach
  die gewichteten Unterfach-Noten schon verrechnet (doppelte Verrechnung).

## 0.62.1 - 2026-10-07

- SPA: Die Komponenten-Unterfächer (Rest-Anteil-Komponenten, z. B. Kunst/Spiel/
  Musik/Bewegung) lassen sich jetzt **komplett abwählen**: im Halbjahres-Menü
  einfach kein Halbjahr ankreuzen. Sind in einem Halbjahr alle Rest-Komponenten
  abgewählt, werden die festen Gewichte auf 100 % hochgerechnet (sonst bliebe
  ein Restbudget ungenutzt). Feste Komponenten (z. B. Pädagogik) bleiben
  weiterhin immer aktiv.

## 0.62.0 - 2026-10-07

- Klassenseite: Das Formular zum Anlegen neuer Fächer oberhalb der Fächerliste
  entfällt. Stattdessen steht unter allen Fächern der Button **„+ Neues Fach
  anlegen"**, der einen Dialog (Name und Halbjahre) öffnet.

## 0.61.1 - 2026-10-07

- Fix: Rote Buttons (🗑 Löschen im Aktionsmenü, ✕ bei Lehrkräften und Fächern)
  hatten roten Text auf rotem Grund und waren unleserlich. Jetzt roter Text/Rand
  auf transparentem Grund, beim Überfahren weiße Schrift auf Rot.

## 0.61.0 - 2026-10-07

- SPA: Die **Zusammensetzung der Fächer** (Komponenten der Lernfelder, z. B. LF3:
  Kunst/Spiel/Musik/Bewegung) steht jetzt auf der Klassenseite im Abschnitt
  „Fächer und Lehrkräftezuordnung" und erscheint als **vorgegebene Unterfächer**
  unter dem Lernfeld. Rest-Anteil-Komponenten lassen sich dort je Halbjahr
  abschalten (nur Klassenleitung), feste Komponenten (z. B. Pädagogik) sind
  markiert. Der alte Schalter auf der Fachseite und die Route
  `/fach/:id/spa/komponente` entfallen.
- Komponenten-Unterfächer können wie alle Unterfächer Lehrkräfte je Halbjahr
  haben. Deren Klausuren/Unterrichtsleistung (in Punkten) füttern die
  Komponente des Lernfelds; ein von Hand eingetragener Komponentenwert hat
  Vorrang. Vorgegebene Komponenten lassen sich nicht löschen, SPA-Lernfelder
  bekommen keine freien Unterfächer.

## 0.60.0 - 2026-10-07

- Lehrkräfte arbeiten **strikt je Halbjahr**: Ist eine Zuordnung auf bestimmte
  Halbjahre begrenzt, sieht die Lehrkraft nur dort die Fachseite (Reiter nur
  für ihre Halbjahre; ein nicht erlaubtes Halbjahr führt auf das nächstliegende
  erlaubte) und kann nur dort Klausuren, Unterrichtsleistung, Noten, Endnoten,
  Notizen u. a. bearbeiten. Das Dashboard zeigt bei begrenzter Zuordnung die
  Halbjahre an. Zuordnungen ohne Einschränkung und Admins sind unverändert.

## 0.59.0 - 2026-10-07

- Klassenseite: Fächeranlage und Lehrkraftzuordnung stehen jetzt in einem
  gemeinsamen Abschnitt **„Fächer und Lehrkräftezuordnung"**. Die Fächer sind
  als Liste aufgeführt; die frühere Fächer-Tabelle und die Abschnitte
  „Lehrkräfte zuordnen" samt „Lehrkräfte entfernen" entfallen.
- Je Fach zwei Buttons: **🎓 Lehrkraft zuordnen** (nur in Halbjahren ohne
  Unterfächer) und **📖 Unterfach hinzufügen**. Zugeordnete Lehrkräfte stehen
  eingerückt unter dem Fach/Unterfach (mit ihren Halbjahren) und lassen sich
  dort ändern (✎) bzw. entfernen (✕); mehrere Lehrkräfte je Fach/Unterfach sind
  möglich. So bleibt über alle Halbjahre ersichtlich, wer wann unterrichtet.
- **Unterfächer** (für alle Notenschlüssel): eigene Klausuren, Unterrichts-
  leistung und Noteneingabe; die Fachnote des Halbjahres ergibt sich gewichtet
  aus den Unterfächern (Gewichte auf der Zusammensetzungs-Seite des Fachs, leer
  = gleiches Gewicht; noch unbenotete Unterfächer zählen nicht mit). Die
  Halbjahreszuordnung bleibt am Fach, Unterfächer und Lehrkraftzuordnung lassen
  sich je Halbjahr ändern. Klassenleitungs-Übersichten, Export und Zeugnis
  zeigen weiterhin nur das Fach; der Sync eines Unterfachs aktualisiert auch
  den Stand des Fachs.

## 0.58.0 - 2026-10-07

- Klassenansicht: Die Aktionen je Person (und bei ehemaligen Schüler/innen)
  stehen hinter einem Menü mit drei Balken. Darin: Versetzen, Abgang, Abgang +
  Abgangszeugnis und Löschen (bzw. Abgangszeugnis, Reaktivieren, Löschen).
  "Versetzen" öffnet einen Dialog, in dem die Zielklasse ausgewählt wird.

## 0.57.0 - 2026-10-07

- "Klasse ins nächste Schuljahr übertragen" heißt jetzt "Einschulungsjahr
  festlegen" (Klassenseite): Einschulungsjahr wählen und die **Anzahl Jahre**
  an der Schule einstellen (1 bis 6, z. B. 2 oder 3; leer = Standard, SPA 2,
  BG/IHK 3). Dieselbe Einstellung gibt es beim Anlegen einer Klasse und im
  Klassenleitungsbereich unter "Laufzeit der Klasse" (dort statt des
  Abschlussschuljahres). Das Kopieren einer Klasse in ein anderes Schuljahr
  entfällt, da eine Klasse über ihre ganze Laufzeit in derselben Klasse bleibt.

## 0.56.1 - 2026-10-07

- "Meine Klassen": Button "Zur Noteneingabe" oben, je Klasse ein Link
  "Noteneingabe" und auf der Klassenseite der Button "Noteneingabe". Sie führen
  zur Noteneingabe und springen dort direkt zur jeweiligen Klasse.

## 0.56.0 - 2026-10-07

- SPA: Die Noteneingabe ist jetzt wie bei IHK/BG die Fachseite mit
  Notenübersicht, Datumstabelle, Klausuren und Zusatzleistungen
  (mündlich/schriftlich, Bewertung in Punkten 0-15). Die Halbjahrespunkte
  fließen in die Endnotentabelle des Fachs ein; die Übersicht zeigt dafür die
  neue Spalte "Endpunkte (Endnotentabelle)" samt Tendenz.
- Die bisherige SPA-Tabelle (Komponenten, Zusammensetzung z. B. von
  Lernfeld 3, Vorwert, Tendenz) ist die "Direkte Endnoteneingabe": Button auf
  der Fachseite bzw. `?ansicht=endnoten`. Handeingaben dort haben wie bisher
  Vorrang vor den berechneten Leistungspunkten; ein Link führt zurück zur
  Noteneingabe.

## 0.55.0 - 2026-10-07

- Die historischen Halbjahre sind entfernt: Reiter "Historische Halbjahre"
  auf der Fachseite, "Vergangene Schuljahre hinzufügen", der
  Notenimport (Text/CSV) und die Klassenleitungs-Seite je Fach entfallen,
  ebenso die Auswahl vergangener Schuljahre im Dashboard und in der
  Halbjahresübersicht. Bestehende historische Noten und rein historische Fächer
  werden beim Start der Datenbank gelöscht.
- Ersatz: Halbjahre über die Laufzeit der Klasse, Fächer je Halbjahr und die
  direkte Endnoteneingabe (Fachseite und Klassenleitung). Abschluss-/
  Abgangsübersicht, Abgangs-/Abschlusszeugnis und die SPA-Zeugnisquellen
  nutzen jetzt alle Halbjahre der Fächer (berechnet oder als Endnote
  eingetragen); Fächer, die nur in einzelnen Halbjahren gelten, tragen
  Halbjahre und Schuljahr in der Überschrift.

## 0.54.0 - 2026-10-07

- Verrechnung der Halbjahresnoten: Im Klassenleitungsbereich (Reiter "Weitere
  Klassenlehrkräfte", Abschnitt "Verrechnung der Halbjahre") lässt sich je
  Übergang einstellen, zu wie viel Prozent die Note eines Halbjahres in das
  nächste einfließt, z. B. 1. → 2. Halbjahr 50 %, 3. → 4. Halbjahr 0 %. Das
  Halbjahr besteht dann aus (100 − p) % eigenen Leistungen und p % der
  endgültigen Note des Vorhalbjahres (samt dessen Endnote bzw. eigener
  Verrechnung). Ohne eigene Note im Halbjahr entsteht keine Note.
- Fachseite: bei aktiver Verrechnung zeigt die Notenübersicht die Spalte
  "Vorhalbjahr"; die Tabelle der direkten Endnoteneingabe zeigt die
  verrechnete Note als "Berechnet". Die Synchronisation mit der Klassenleitung
  aktualisiert ein bereits synchronisiertes Folgehalbjahr mit.

## 0.53.0 - 2026-10-07

- Direkte Endnoteneingabe: Bei allen Fächern (außer SPA) gibt es auf der
  Fachseite neben der Notenübersicht den Button "Direkte Endnoteneingabe". Die
  Tabelle zeigt je Person die berechnete Halbjahresnote und ein Feld für die
  Endnote des gewählten Halbjahres (Zahl, "ntg" = nicht teilgenommen, leer =
  berechnete Note). Die direkte Endnote ersetzt die berechnete Note in der
  Übersicht, im Sync mit der Klassenleitung und in Abschluss/Zeugnis.
- Klassenleitungsbereich: neuer Reiter "Endnoten (Direkteingabe)" -- die
  Klassenleitung trägt für vergangene Halbjahre die Endnoten aller Fächer in
  einem Raster ein. Ist eine Person durch die Notenkonferenz gesperrt, muss
  sie zuerst entsperrt werden (gilt auch für die Fachseite).
- Fächer je Halbjahr: Beim Anlegen eines Fachs werden die Halbjahre
  angekreuzt, in denen es gilt (Vorbelegung: beide Halbjahre des aktuellen
  Schuljahres). In der Fächerliste lassen sie sich ändern (nicht, solange im
  wegfallenden Halbjahr Leistungen oder Endnoten stehen). Das Fach erscheint
  nur in diesen Halbjahren (Reiter, Halbjahresübersicht, Konferenzmodus,
  Raster); bestehende Fächer gelten in allen Halbjahren.

## 0.52.0 - 2026-10-07

- Klassen laufen über mehrere Schuljahre: jede Klasse hat ein
  Einschulungs- und ein Abschlussschuljahr (beim Anlegen optional, später im
  Klassenleitungsbereich unter "Laufzeit der Klasse" änderbar). Bestehende
  Klassen starten im Schuljahr, in dem sie angelegt wurden; ohne Abschlussjahr
  gilt die Standarddauer: BG/IHK drei Jahre (6 Halbjahre), SPA zwei Jahre
  (4 Halbjahre).
- Die Halbjahre werden über die Laufzeit durchgezählt (1. bis N. Halbjahr, im
  Reiter mit dem Schuljahr als Tooltip). Fachseiten, Klassenleitungsübersicht,
  Konferenzmodus, Notenbesprechung, Export und Abschluss-/Abgangsauswertung
  kennen alle Halbjahre der Klasse; ohne Angabe öffnet sich das aktuelle
  Halbjahr nach Datum. Der Mündlich-Anteil richtet sich nach dem Schuljahr des
  jeweiligen Halbjahres.
- Eine Klasse erscheint in "Meine Klassen" im Reiter jedes Schuljahres ihrer
  Laufzeit. Die Laufzeit lässt sich nicht so kürzen, dass Halbjahre mit
  bereits eingetragenen Leistungen wegfallen.

## 0.51.2 - 2026-10-06

- SPA-Eingabemaske: Die Felder für die Notenpunkte haben keine Pfeile mehr,
  die Punkte werden direkt getippt.
- SPA: Beim Ein-/Ausschalten einer Komponente der Zusammensetzung (z. B.
  Lernfeld 3) bleiben Scroll-Position und der angeklickte Umschalter erhalten,
  die Seite springt nicht mehr nach oben.

## 0.51.1 - 2026-10-06

- SPA: Die Zusammensetzung eines Lernfelds (z. B. Lernfeld 3: Komponenten
  ein-/ausschalten) lässt sich wieder auswählen. Der Klick zeigte bisher den
  JSON-Quelltext der Antwort statt die Seite; jetzt geht es zurück zur
  Fachseite des Halbjahrs.

## 0.51.0 - 2026-10-02

- Datumstabelle: Anwesenheit mit "n.a." (nicht anwesend). Die Felder nehmen nur
  noch Noten (auch mit Komma) oder n.a. an; jede andere Eingabe -- auch eine
  Zahl außerhalb des Notenbereichs -- wird automatisch zu n.a. Einträge mit
  n.a. zählen nicht in den Durchschnitt, werden aber je Person gezählt.
- Die Summe der n.a.-Einträge steht in der Datumstabelle (Spalte "n.a."), in
  der Notenübersicht (sobald Termine vorhanden sind) und in der
  Notenbesprechung (dort auch die einzelnen Termine mit n.a.).

## 0.50.0 - 2026-10-02

- Datumstabelle: Neben jeder Person gibt es einen kleinen Notizzettel (📝).
  Ein Klick öffnet ein Popup mit dem Verlauf der Notizen zur
  Unterrichtsleistung (je Person, Fach und Halbjahr) und einem Feld für eine
  neue Notiz (Strg+Enter speichert). Das Symbol ist gelb hinterlegt und zeigt
  die Anzahl, sobald Notizen vorhanden sind. Verfasser/in und Admins können
  eigene Notizen löschen.
- Die Notizen erscheinen in der Notenbesprechung (eigener Kasten bei der
  Datumstabelle und in der Notizenliste, Art "Unterricht (Datumstabelle)")
  sowie in den Notizlisten der Klassenübersicht und des Konferenzmodus. In der
  Notenbesprechung kann diese Art auch direkt angelegt werden.

## 0.49.2 - 2026-10-01

- Klausuren/Unterrichtsleistungen: Die Zeile "Max. Punkte" in der Tabelle ist
  farblich deutlich abgesetzt (getönter Hintergrund, Akzentlinien oben und
  unten, hervorgehobene Beschriftung "▼ Max. Punkte"), im hellen wie im
  dunklen Design.

## 0.49.1 - 2026-10-01

- Klausuren: Gewichtung, Datum und Anzahl Teile stehen in einer Reihe und
  rutschen auf schmalen Bildschirmen (Smartphone) automatisch in die nächste
  Zeile; die Erklärung zur Anzahl Teile steht darunter. Bei den
  Unterrichtsleistungen gilt das für Gewichtung und Datum.

## 0.49.0 - 2026-10-01

- Klausuren und Unterrichtsleistungen: Die maximal erreichbaren Punkte je
  Aufgabe stehen jetzt als eigene Zeile "Max. Punkte" direkt über den Spalten
  der Schülertabelle (statt in einer Liste darüber) und lassen sich dort
  bearbeiten -- so sind sie der jeweiligen Aufgabe sofort zuzuordnen. Die
  Summe steht über der Spalte "Punkte gesamt".

## 0.48.0 - 2026-10-01

- Klausuren neu gegliedert: Beim Anlegen werden nur noch Name und Datum
  eingegeben. In der Klausur gibt es dann "Anzahl Teile" (Standard 1).
  - 1 Teil: normale Klausur mit "Anzahl Aufgaben" und Max-Punkten je Aufgabe.
  - Mehr Teile: eine Tabelle mit Name, Aufgaben und Gewichtung je Teil, dazu
    die Auswahl, welcher Teil die beste Note begrenzt (nur bei mehreren
    Teilen sichtbar). Die Aufgabenzahl ergibt sich aus den Teilen, die
    Max-Punkte sind nach Teilen gruppiert.
  - Ändern der Teilezahl verteilt die Aufgaben bzw. ergänzt/entfernt Teile von
    hinten; Eingaben in der Teile-Tabelle werden beim Verlassen des Feldes
    automatisch gespeichert (Fokus und Scroll-Position bleiben erhalten).
- Der Bereich "Klausur aus mehreren Teilen (optional)" mit "Teile speichern"
  und "Wieder einteilig machen" entfällt.

## 0.47.1 - 2026-10-01

- Klausuren: Der Cursor springt beim Eintippen von Punkten nicht mehr an den
  Anfang des Feldes, langsam getippte Ziffern landen in der richtigen
  Reihenfolge (Auto-Speichern wartet zudem 0,8 s).
- "Anzahl Aufgaben" wird jetzt beim Verlassen des Feldes bzw. mit Enter
  übernommen statt nach jeder Ziffer: Zwischenstände wie "1" auf dem Weg zu
  "12" haben die Teile einer mehrteiligen Klausur vorher durcheinandergebracht.
  Die Teile (Aufgaben je Teil) passen sich der neuen Anzahl an.

## 0.47.0 - 2026-10-01

- Klausuren und Unterrichtsleistungen: Zahlenfelder (Aufgabenzahl, Max-Punkte,
  Gewichtung, Teile) haben keine Pfeile mehr, die Werte werden direkt getippt.
- Beim Eintragen springt die Seite nicht mehr nach oben: Scroll-Position und
  das fokussierte Feld bleiben nach dem automatischen Speichern erhalten
  (Max-Punkte, Anzahl Aufgaben, Teile, Gewichtung).
- "Anzahl Aufgaben" ist auch bei mehrteiligen Klausuren änderbar; die Teile
  passen sich an: zusätzliche Aufgaben kommen zum letzten Teil, fehlende
  werden von hinten abgezogen (bleibt nur ein Teil übrig, ist die Klausur
  wieder einteilig).

## 0.46.1 - 2026-10-01

- SPA: Klausuren und Unterrichtsleistung werden jetzt direkt in Punkten
  (0-15) bewertet statt über eine Schulnote 1-6: der Punkteschlüssel der
  Klasse (wie der BG-Schlüssel) übersetzt den Prozentwert in Punkte, die
  Tendenznote (1+ ... 6) wird daraus mit der SPA-Skala berechnet. Die
  Leistungspunkte ersetzen wie bisher den Punktwert des Halbjahres bzw.
  füttern die gewählte Komponente (Handeingaben haben Vorrang). In der
  Ansicht heißen die Spalten "Punkte"/"Gesamtpunkte" und eine neue Spalte
  zeigt die Tendenz. Die mehrteilige Klausur mit "beste Note bestimmt"
  deckelt entsprechend nach oben (mehr Punkte = besser).

## 0.46.0 - 2026-10-01

- SPA: Klausuren und Unterrichtsleistung (Datumstabelle, Zusatzleistungen,
  mehrteilige Klausuren) werden wie bei IHK abgehandelt -- auf der
  SPA-Fachseite führt der neue Button "📝 Klausuren & Unterrichtsleistung" zur
  gewohnten Ansicht mit allen vier Halbjahren. Die daraus berechnete
  Leistungsnote (Note 1-6, Gewichtung schriftlich/mündlich wie im Schuljahr
  eingestellt) wird in SPA-Punkte umgerechnet (1 = 14, 2 = 11, 3 = 8, 4 = 5,
  5 = 2, 6 = 0) und ersetzt den Punktwert des Halbjahres; ein von Hand
  eingetragener Wert behält Vorrang und die Eingabemaske zeigt die
  Leistungsnote als Platzhalter. Bei Fächern mit Komponenten (z. B. LF2/LF3)
  wird pro Fach und Halbjahr gewählt, in welche Komponente die Leistungsnote
  einfließt. Nur die Zeugnisnoten folgen weiter dem eigenen SPA-
  Bewertungssystem.

## 0.45.0 - 2026-10-01

- Klausuren können aus mehreren Teilen bestehen (alle Notenschlüssel mit
  Klausuren, also IHK und BG): im Klausur-Reiter unter "Klausur aus mehreren
  Teilen" werden Teile mit Name, Aufgabenzahl und prozentualer Gewichtung
  angelegt. Jeder Teil bekommt aus seinen Aufgaben eine eigene Note (in der
  Tabelle je Teil eine Note-Spalte), die Gesamtnote der Klausur wird
  prozentual aus den Teilnoten berechnet. Optional bestimmt EIN Teil die
  beste erreichbare Note: die anderen Teile können die Gesamtnote dann nicht
  weiter aufwerten, sie aber immer abwerten (bei IHK ist kleiner besser, bei
  BG größer -- die Richtung wird aus dem Notenschlüssel erkannt). Eine
  Gesamtnote gibt es erst, wenn alle Teile vollständig bepunktet sind. Die
  Klausur lässt sich jederzeit wieder einteilig machen, eingetragene Punkte
  bleiben erhalten. Wirkt auch in Notenübersicht, Halbjahresübersicht,
  Synchronisation und CSV-Export.

## 0.44.0 - 2026-09-30

- SPA-Abschlusszeugnis: pro Person lässt sich jede Zeugnisposition
  (Lernfeld/Fach) aus beliebigen Fächern der Person zusammenstellen -- auch
  aus Fächern früherer Klassen und rein historischen Fächern vergangener
  Schuljahre, nicht mehr nur aus den Fächern der aktuellen Klasse. Neuer Link
  "🎛 Fächer wählen" je Person im Abschlusszeugnis (4. Halbjahr der
  Zeugnisübersicht); mehrere gewählte Fächer werden gemittelt (Schulnoten
  1-6 werden dafür in Punkte umgerechnet). Ohne Auswahl bleibt alles beim
  Standard, angepasste Positionen sind mit ✎ markiert; die Auswahl lässt sich
  auf den Standard zurücksetzen.

## 0.43.0 - 2026-09-30

- Abgangs-/Abschlusszeugnis zeigt jetzt ALLE Fächer/Lernfelder über ALLE
  Schuljahre. Bisher fehlten die rein historischen Fächer vergangener
  Schuljahre (und damit deren Noten), es war nur das aktuelle Schuljahr
  enthalten. Je Fach gibt es die Einzelnoten (chronologisch, auch SPA-
  Halbjahre) und den aktuellen Stand; die Fächer müssen nicht abgeschlossen
  sein. Ein bereits abgeschlossenes Lernfeld zählt nur mit seiner
  Gesamtnote (Abschlussnote).
- Abgang: neben "🚪 Abgang" gibt es "🚪🎓 Abgang + Abgangszeugnis" -- trägt
  den Abgang ein und öffnet direkt das Zeugnis mit allen Noten bis zu diesem
  Schuljahr. Die Zeugnisseite heißt bei Abgang "Abgangszeugnis", sonst
  "Abschlusszeugnis"; der Link in der Abschluss-/Abgangsübersicht heißt
  entsprechend "Abgangs-/Abschlusszeugnis".

## 0.42.1 - 2026-09-30

- Fix: SPA-Klassen bekommen jetzt ebenfalls Zugriff auf die Personen in der
  Sammelklasse "Ohne Klasse" (Reiter "Aus „Ohne Klasse“ übernehmen") und
  können Personen dorthin versetzen. Zwischen echten SPA-Klassen ist das
  Versetzen bei gleichem Bildungsgang möglich; SPA <-> IHK/BG bleibt
  ausgeschlossen.

## 0.42.0 - 2026-09-30

- Sammelklasse "Ohne Klasse": ist jetzt für jede Lehrkraft einsehbar (in
  "Meine Klassen" und als Klassenseite) und erlaubt jeder Lehrkraft das
  Versetzen der enthaltenen Personen in eine Klasse. Löschen der Sammelklasse
  sowie Abgang/Löschen einzelner Personen bleiben Klassenleitung/Ersteller/in/
  Admin vorbehalten.
- Klassenseite: neuer Reiter "Aus „Ohne Klasse“ übernehmen" neben
  Einzeln/Mehrere/CSV -- Personen aus der Sammelklasse per Suche und
  Mehrfachauswahl direkt in die eigene Klasse übernehmen (Noten bleiben
  erhalten), wie bei den Kursen.

## 0.41.0 - 2026-09-30

- Schüler/innen versetzen: auf der Klassenseite lässt sich eine Person über
  "↔ Versetzen nach …" in eine andere Klasse (auch eines anderen Schuljahres,
  gleicher Notenschlüssel) oder in die Sammelklasse "Ohne Klasse" verschieben
  -- z. B. beim Wiederholen/Überspringen einer Stufe. Alle Noten bleiben
  erhalten (sie hängen an der Person), die Teilnahme an den Fächern der
  bisherigen Klasse bleibt bestehen und die Person wird Teilnehmer/in der
  Fächer der neuen Klasse. SPA-Klassen sind ausgenommen.
- Klasse löschen: die Schüler/innen (nur die Person, nicht die Noten der
  gelöschten Fächer) werden jetzt nicht mehr mitgelöscht, sondern in die
  Sammelklasse "Ohne Klasse" des Schuljahres übernommen und können von dort
  in andere Klassen versetzt werden. Gilt auch für das Löschen im Admin-
  Bereich. Wer eine Klasse löscht, wird Klassenleitung der Sammelklasse.
- Die Halbjahresübersicht/Abschlussübersicht einer Klasse zeigt Fächer einer
  fremden Klasse nur noch im selben Schuljahr, damit die alten Fächer einer
  versetzten Person nicht als Spalten in der neuen Klasse auftauchen.

## 0.40.1 - 2026-09-30

- Fix: "Klasse löschen" durfte bisher nur die erstellende Lehrkraft oder der
  Admin -- jetzt darf das auch jede eingetragene (Co-)Klassenleitung, die
  die Klasse nicht selbst angelegt hat (dieselbe Regel wie überall sonst
  beim Verwalten einer Klasse).

## 0.40.0 - 2026-09-29

- Externe Lehrkräfte einladen (Klassenleitung + Admin): die App verschickt
  weiterhin keine E-Mails selbst, aber neben dem "Link kopieren"-Button
  gibt es jetzt einen ✉️-Button, der das eigene E-Mail-Programm mit
  vorausgefülltem Betreff und Text (Anrede, Einladungslink, Gültigkeit)
  öffnet -- Empfänger ist automatisch die beim Erstellen der Einladung
  angegebene E-Mail-Adresse, falls vorhanden.

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

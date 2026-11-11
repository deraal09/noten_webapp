/**
 * Hilfe der App: Artikel mit Screenshots (static/hilfe/*.jpg, erzeugt von scripts/hilfe-screenshots.mjs), Suche und geführter Rundgang.
 * Inhalte stehen hier als Daten; Auszeichnung in Texten: **fett** und `Code`, alles andere wird maskiert (siehe formatiere()).
 */

export const KATEGORIEN = [
  { id: 'start', titel: 'Erste Schritte', icon: '🚀' },
  { id: 'klassen', titel: 'Klassen und Kurse', icon: '🏫' },
  { id: 'noten', titel: 'Noten eintragen', icon: '📝' },
  { id: 'auswerten', titel: 'Auswerten und Zusammenarbeit', icon: '🤝' },
  { id: 'mehr', titel: 'Weitere Funktionen', icon: '🧰' },
];

/**
 * @typedef {{ titel?: string, absaetze?: string[], schritte?: string[], hinweis?: string }} Abschnitt
 * @type {Array<{ slug: string, kategorie: string, titel: string, kurz: string, schlagworte: string[], bilder?: Array<{ datei: string, text: string }>, abschnitte: Abschnitt[], links?: Array<{ text: string, href: string }>, verwandt?: string[] }>}
 */
export const ARTIKEL = [
  // ---------------------------------------------------------------- Erste Schritte
  {
    slug: 'anmelden', kategorie: 'start', titel: 'Anmelden und Menü',
    kurz: 'Anmeldung mit dem Schulkonto, die Startseite und das Menü.',
    schlagworte: ['login', 'anmeldung', 'passwort', 'ldap', 'schulkonto', 'abmelden', 'menü', 'startseite', 'angemeldet bleiben', 'einladung', 'extern'],
    bilder: [{ datei: 'login', text: 'Anmeldeseite' }, { datei: 'start', text: 'Startseite mit den vier Bereichen' }],
    abschnitte: [
      { titel: 'Anmelden', schritte: [
        'Die Adresse der Notenverwaltung im Browser öffnen (am Handy und Tablet funktioniert sie genauso).',
        'Benutzernamen und Passwort deines **Schulkontos** eingeben und auf **Anmelden** klicken.',
        'Mit dem Haken **Angemeldet bleiben** bleibst du auf diesem Gerät länger angemeldet. Auf fremden Geräten besser nicht setzen.',
      ] },
      { titel: 'Externe Lehrkräfte', absaetze: [
        'Wer kein Schulkonto hat, bekommt von der Klassenleitung oder der Administration einen **Einladungslink** und legt damit ein eigenes Konto mit Passwort an. Das Passwort lässt sich unter **🔑 Passwort ändern** (oben rechts im Menü) ändern.',
      ] },
      { titel: 'Die Startseite', absaetze: [
        'Nach der Anmeldung siehst du vier Kacheln: **Noteneingabe** (hier trägst du Noten ein), **Meine Klassen** (Klassen und Kurse verwalten), **Sitzpläne** und **Klassenleitung** (Übersicht, Konferenz, Zeugnisse).',
        'Das Menü **☰** oben rechts bringt dich überall hin, auch zu **❓ Hilfe**, **🤖 API-Zugang** und **Abmelden**. Mit den Symbolen daneben stellst du das Farbschema auf Hell, Dunkel oder System.',
      ], hinweis: 'Die App lässt sich auf dem Handy als **App installieren**: im Menü auf „📲 App installieren“ tippen (iPhone: Teilen → „Zum Home-Bildschirm“).' },
    ],
    links: [{ text: 'Zur Startseite', href: '/start' }], verwandt: ['noteneingabe-ueberblick', 'klasse-anlegen'],
  },

  // ---------------------------------------------------------------- Klassen und Kurse
  {
    slug: 'klasse-anlegen', kategorie: 'klassen', titel: 'Klasse anlegen, umbenennen und löschen',
    kurz: 'Eine neue Klasse mit Schuljahr und Notenschlüssel anlegen; Klasse umbenennen; was „Klasse löschen“ bedeutet.',
    schlagworte: ['klasse', 'neue klasse', 'anlegen', 'schuljahr', 'notenschlüssel', 'ihk', 'bg', 'spa', 'einschulung', 'laufzeit', 'umbenennen', 'name ändern', 'löschen', 'beitreten', 'vorhandene klasse'],
    bilder: [{ datei: 'klassen-liste', text: 'Meine Klassen' }, { datei: 'klasse-anlegen', text: 'Neue Klasse anlegen' }, { datei: 'klasse-detail', text: 'Klassenseite mit „Klasse umbenennen“' }],
    abschnitte: [
      { titel: 'Neue Klasse anlegen', schritte: [
        'Im Menü **Meine Klassen** öffnen und oben auf **+ Neue Klasse anlegen** klicken.',
        'Existiert die Klasse schon im System, wählst du unter **Vorhandene Klasse wählen** die richtige aus und trittst ihr bei. So entstehen keine doppelten Klassen.',
        'Sonst im Reiter **Neue Klasse anlegen** das **Schuljahr** (das aktuelle ist vorausgewählt und mit „(aktuell)“ gekennzeichnet), den **Klassennamen**, den **Notenschlüssel** (IHK 1–6, BG 0–15 Punkte oder SPA) und das **Einschulungsjahr** angeben und speichern.',
      ], hinweis: 'Klassen anlegen dürfen Lehrkräfte mit Schulkonto. Externe Lehrkräfte werden von der Klassenleitung einem Fach zugeordnet.' },
      { titel: 'Klasse umbenennen', absaetze: [
        'Auf der Klassenseite gibt es unter der Überschrift **✏️ Klasse umbenennen**. Das darf **jede Lehrkraft, die der Klasse angehört**. Der neue Name gilt sofort für alle, die in der Klasse eingetragen sind. Im Schuljahr darf es keine zwei Klassen mit gleichem Namen geben.',
      ] },
      { titel: 'Klasse löschen und Papierkorb', absaetze: [
        '**🗑 Klasse löschen** blendet die Klasse nur **für dich** aus und legt sie in deinen Papierkorb. Die anderen Lehrkräfte sehen sie weiter. Mehr dazu im Artikel „Papierkorb“.',
      ] },
    ],
    links: [{ text: 'Meine Klassen öffnen', href: '/teacher/klassen' }], verwandt: ['schueler-eintragen', 'faecher-lehrkraefte', 'papierkorb'],
  },
  {
    slug: 'schueler-eintragen', kategorie: 'klassen', titel: 'Schüler:innen eintragen (einzeln, mehrere, CSV)',
    kurz: 'Personen einer Klasse hinzufügen: einzeln, als Liste oder per CSV-Datei; Abgang und Versetzen.',
    schlagworte: ['schüler', 'schülerinnen', 'personen', 'hinzufügen', 'import', 'csv', 'untis', 'excel', 'liste', 'mehrere auf einmal', 'abgang', 'versetzen', 'ohne klasse', 'sammelklasse', 'trennzeichen', 'semikolon'],
    bilder: [{ datei: 'klasse-detail', text: 'Schüler:innen: Einzeln, Mehrere auf einmal, CSV-Import' }, { datei: 'schueler-csv', text: 'CSV-Import in der Klasse' }],
    abschnitte: [
      { titel: 'Drei Wege', schritte: [
        '**Einzeln:** Nachname und Vorname eintragen und auf **+ Hinzufügen** klicken.',
        '**Mehrere auf einmal:** Eine Person pro Zeile einfügen, z. B. aus einer Tabelle (`Müller, Anna` oder `Müller;Anna`). Bei Doppelnamen ohne Komma fragt die App nach, was Nach- und Vorname ist.',
        '**CSV-Import:** Eine CSV-Datei mit den Spalten Nachname und Vorname hochladen. Eine Kopfzeile und das Trennzeichen (Semikolon, Komma, Tab) erkennt die App selbst, z. B. bei Listen aus Excel oder Untis.',
      ], hinweis: 'Wer schon in der Klasse ist, wird nicht doppelt angelegt; die Meldung nennt, wie viele übersprungen wurden.' },
      { titel: 'Abgang, Versetzen, Löschen', absaetze: [
        'Hinter jeder Person öffnet **☰** die Aktionen: **Versetzen** in eine andere Klasse (alle Noten bleiben erhalten), **Abgang** (Person verlässt die Klasse, Noten bleiben, ein Abgangszeugnis ist möglich) oder **Löschen** (entfernt die Person samt Noten unwiderruflich – nur, solange keine Noten anderer Lehrkräfte daran hängen).',
        'Wird eine Klasse endgültig gelöscht, landen ihre Personen (nur der Name) in der Sammelklasse **„Ohne Klasse“**. Von dort lassen sie sich über **Aus Ohne Klasse übernehmen** in eine eigene Klasse holen.',
      ] },
    ],
    links: [{ text: 'Meine Klassen', href: '/teacher/klassen' }], verwandt: ['klasse-anlegen', 'kurse'],
  },
  {
    slug: 'faecher-lehrkraefte', kategorie: 'klassen', titel: 'Fächer anlegen und Lehrkräfte zuordnen',
    kurz: 'Fächer in der Klasse anlegen, Halbjahre festlegen, Lehrkräfte zuordnen, sich als Klassenleitung eintragen.',
    schlagworte: ['fach', 'fächer', 'anlegen', 'lehrkraft', 'zuordnen', 'zuweisung', 'klassenleitung', 'eintragen', 'halbjahre', 'verrechnung', 'unterfächer', 'selbst eintragen', 'frei', 'vorlage'],
    bilder: [{ datei: 'faecher-lehrkraefte', text: 'Fächer und Lehrkräftezuordnung auf der Klassenseite' }],
    abschnitte: [
      { titel: 'Fach anlegen', schritte: [
        'Auf der Klassenseite zu **Fächer** gehen und den Namen des Fachs eintragen (z. B. „Englisch“). Mit Vorlagen lassen sich Fächer aus anderen Klassen übernehmen.',
        'Über das **⚙ Zahnrad** am Fach stellst du den Namen, die **Halbjahre**, in denen das Fach gilt, **Unterfächer** und die **Verrechnung** der Halbjahre ein.',
      ] },
      { titel: 'Lehrkräfte zuordnen', absaetze: [
        'Jedes Fach hat eine oder mehrere zugeordnete Lehrkräfte; nur sie tragen dort Noten ein. Du kannst dich **selbst für ein freies Fach eintragen**; die Klassenleitung ordnet auch andere Lehrkräfte zu und kann die Zuordnung auf einzelne Halbjahre begrenzen.',
      ] },
      { titel: 'Klassenleitung', absaetze: [
        'Mit **Als Klassenleitung eintragen** übernimmst du die Verwaltung der Klasse (sobald niemand eingetragen ist und du ein eigenes Fach in der Klasse hast). Die Klassenleitung sieht die **synchronisierten** Noten aller Fächer, führt die Notenkonferenz und erstellt Zeugnisse. Weitere Klassenlehrkräfte lassen sich eintragen.',
      ] },
    ],
    links: [{ text: 'Meine Klassen', href: '/teacher/klassen' }], verwandt: ['sync', 'klassenleitung', 'verrechnung-endnoten'],
  },
  {
    slug: 'kurse', kategorie: 'klassen', titel: 'Kurse anlegen und Teilnehmerliste füllen',
    kurz: 'Kurse über mehrere Klassen, Teilnehmer per Suche, manuell oder als CSV (Nachname;Vorname;Klasse).',
    schlagworte: ['kurs', 'kurse', 'ag', 'wahlpflicht', 'teilnehmer', 'teilnehmerliste', 'csv', 'import', 'klassenübergreifend', 'umbenennen', 'notenschlüssel bg', 'manuell'],
    bilder: [{ datei: 'kurs-teilnehmer', text: 'Teilnehmerliste eines Kurses mit CSV-Import' }],
    abschnitte: [
      { titel: 'Kurs anlegen', schritte: [
        'In **Meine Klassen** auf **+ Neuen Kurs anlegen** klicken, **Kursname** und **Schuljahr** wählen. Der Notenschlüssel ist **BG (0–15 Punkte)** voreingestellt; IHK ist wählbar.',
        'Danach landest du in der **Teilnehmerliste** des Kurses.',
      ] },
      { titel: 'Teilnehmer aufnehmen', absaetze: [
        '**Suche:** Name oder Klasse eintippen und Personen aus bestehenden Klassen desselben Schuljahres anklicken (der Notenschlüssel muss passen).',
        '**Manuell anlegen:** Nachname, Vorname und Klasse eintragen. Gibt es die Klasse noch nicht, wird sie als leere Klasse angelegt.',
        '**Liste per CSV importieren:** Eine Datei mit den Spalten **Nachname;Vorname;Klasse** hochladen. Kopfzeile und Trennzeichen werden erkannt, Doppelte übersprungen. Die Meldung nennt „x hinzugefügt, y übersprungen“ und listet nicht übernommene Zeilen (z. B. falscher Notenschlüssel der Klasse).',
      ] },
      { titel: 'Umbenennen', absaetze: [
        'Auf der Fachseite des Kurses gibt es **✏️ Kurs umbenennen**. Das darf jede Lehrkraft, die dem Kurs zugeordnet ist; der Name gilt für alle.',
      ] },
    ],
    links: [{ text: 'Meine Klassen und Kurse', href: '/teacher/klassen' }], verwandt: ['schueler-eintragen', 'api'],
  },
  {
    slug: 'papierkorb', kategorie: 'klassen', titel: 'Papierkorb: Klassen löschen und wiederherstellen',
    kurz: 'Jede Lehrkraft blendet Klassen für sich aus; endgültig gelöscht wird erst, wenn alle gelöscht haben, nach 30 Tagen.',
    schlagworte: ['papierkorb', 'löschen', 'wiederherstellen', 'ausblenden', '30 tage', 'ablaufzeit', 'endgültig', 'klasse löschen'],
    bilder: [{ datei: 'papierkorb', text: 'Papierkorb mit gelöschter Klasse' }],
    abschnitte: [
      { titel: 'So funktioniert es', absaetze: [
        '**Klasse löschen** blendet die Klasse nur für dich aus (Meine Klassen, Noteneingabe, Klassenleitung). Die anderen Lehrkräfte der Klasse sehen sie weiter.',
        'Im **🗑 Papierkorb** (in „Meine Klassen“) liegen deine gelöschten Klassen. Mit **↩ Wiederherstellen** holst du eine Klasse für dich zurück.',
        'Solange noch Lehrkräfte die Klasse nutzen, steht dort **„noch keine Ablaufzeit“**. Haben **alle** Lehrkräfte der Klasse sie gelöscht, läuft eine Frist von **30 Tagen** (das Datum steht im Papierkorb). Danach werden Fächer, Klausuren und Noten **unwiderruflich** gelöscht. Wer in der Frist wiederherstellt, stoppt sie.',
      ], hinweis: 'Die Personen (nur Name) bleiben nach dem endgültigen Löschen in der Sammelklasse „Ohne Klasse“.' },
    ],
    links: [{ text: 'Papierkorb öffnen', href: '/teacher/papierkorb' }], verwandt: ['klasse-anlegen'],
  },

  // ---------------------------------------------------------------- Noten eintragen
  {
    slug: 'noteneingabe-ueberblick', kategorie: 'noten', titel: 'Noteneingabe: Überblick, Schuljahr und Halbjahre',
    kurz: 'Deine Fächer als Kacheln, Schuljahr-Auswahl, Halbjahre und die Notenübersicht eines Fachs.',
    schlagworte: ['noteneingabe', 'fach', 'kacheln', 'schuljahr', 'filter', 'aktuell', 'halbjahr', 'notenübersicht', 'zukunft', 'ganze note', 'runden', 'gesamtnote', 'endnote direkt'],
    bilder: [{ datei: 'noteneingabe', text: 'Noteneingabe mit Schuljahr-Auswahl' }, { datei: 'fach-uebersicht', text: 'Notenübersicht mit Halbjahren und „ganze Note“' }],
    abschnitte: [
      { titel: 'Die Übersicht', absaetze: [
        'Unter **Noteneingabe** siehst du deine Fächer, nach Klassen gruppiert, und die Kurse. Mit der **Schuljahr-Auswahl** blendest du ein Schuljahr ein; das laufende ist mit **(aktuell)** gekennzeichnet. Schuljahre, die erst noch beginnen, werden ausgeblendet (neues Schuljahr: 1. August).',
      ] },
      { titel: 'Ein Fach öffnen', absaetze: [
        'Ein Klick auf ein Fach öffnet die **Notenübersicht** des aktuellen Halbjahres. Oben wechselst du das **Halbjahr**. Unter **⋮ Mehr** erreichst du **Unterrichtsleistung** und **Klausuren**.',
        'Die Tabelle zeigt je Person die Note der Unterrichtsleistung, die schriftliche Note (Klausuren) und die **Gesamtnote**. Mit dem Haken **ganze Note** unter einer Spaltenüberschrift rundest du die Anzeige dieser Spalte auf ganze Noten (nur die Anzeige; gespeichert wird genau).',
      ] },
      { titel: 'Direkte Endnoteneingabe', absaetze: [
        'Über **✏️ Direkte Endnoteneingabe** trägst du eine feste Endnote ein, die die berechnete ersetzt (`ntg` = nicht teilgenommen).',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['klausuren', 'unterrichtsleistung', 'verrechnung-endnoten', 'notenschluessel'],
  },
  {
    slug: 'klausuren', kategorie: 'noten', titel: 'Klausuren eintragen',
    kurz: 'Klausur anlegen, Punkte je Aufgabe, Extrapunkte, Gewichtung, Notizen.',
    schlagworte: ['klausur', 'klassenarbeit', 'punkte', 'aufgaben', 'maximale punkte', 'extrapunkte', 'gewichtung', 'datum', 'notiz', 'note berechnen', 'eintragen'],
    bilder: [{ datei: 'klausur-eintragen', text: 'Klausur mit Punkten je Aufgabe' }],
    abschnitte: [
      { titel: 'Klausur anlegen', schritte: [
        'In der Fachseite **⋮ Mehr → Klausuren** öffnen und mit **+** eine Klausur anlegen (Name, optional Datum).',
        'Bei **Anzahl Aufgaben** die Zahl der Aufgaben eintragen und in der Zeile **Max. Punkte** die erreichbaren Punkte je Aufgabe.',
        'In der Tabelle je Person die **erreichten Punkte** je Aufgabe eintragen. Die Note erscheint sofort nach dem Notenschlüssel der Klasse; alles wird automatisch gespeichert.',
      ] },
      { titel: 'Gewichtung, Extrapunkte, Notizen', absaetze: [
        '**Gewichtung:** Wie stark die Klausur in die schriftliche Note eingeht (verteilt sich automatisch, lässt sich ändern).',
        '**Extrapunkte** (optional, bei einteiligen Klausuren): Zusatzaufgaben, die nicht zur Gesamtpunktzahl zählen, aber zu den erreichten Punkten addiert werden; so sind Noten über 100 % möglich. Die Höchstzahl legst du in der Spalte „Extra“ fest.',
        'Unter der Tabelle steht ein **Notizfeld** zur Klausur.',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['klausur-teile', 'notenschluessel'],
  },
  {
    slug: 'klausur-teile', kategorie: 'noten', titel: 'Mehrteilige Klausuren: Hörverstehen und Inhalt & Sprache',
    kurz: 'Klausuren aus mehreren Teilen, Hörverstehen mit Verrechnungstabelle, Mediation/Textaufgabe mit Inhalt und Sprache.',
    schlagworte: ['teile', 'mehrteilig', 'hörverstehen', 'verrechnungspunkte', 'verrechnungstabelle', 'mediation', 'textaufgabe', 'inhalt', 'sprache', '50:50', 'gewichtung', 'fremdsprache', 'englisch', 'bestimmt beste note'],
    bilder: [{ datei: 'klausur-teile', text: 'Teile-Tabelle mit Art, Aufgaben und Gewichtung' }],
    abschnitte: [
      { titel: 'Teile einrichten', schritte: [
        'In der Klausur bei **Anzahl Teile** z. B. `2` eintragen. Darunter erscheint die Teile-Tabelle.',
        'Je Teil Name, **Art** und **Gewichtung %** festlegen (z. B. Hörverstehen 40 %, Textaufgabe 60 %). Die Gesamtnote ist der gewichtete Mittelwert der Teilnoten.',
      ] },
      { titel: 'Art des Teils', absaetze: [
        '**Standard:** Die Punkte der Aufgaben ergeben prozentual die Teilnote.',
        '**Hörverstehen (Verrechnungstabelle):** Eine Aufgabe mit den **Verrechnungspunkten** (meist 15, auch 20 oder 25). Die Note folgt der Verrechnungstabelle, ohne zu runden: bei 15 Punkten gibt es die 2 erst ab **4,05** Punkten. Die Tabelle lässt sich unter der Teile-Tabelle aufklappen.',
        '**Inhalt & Sprache** (Mediation, Textaufgabe): Zwei Spalten, in die du **direkt Noten bzw. Notenpunkte** einträgst (BG 0–15). Die Teilnote ist das Mittel im Verhältnis **Inhalt : Sprache** (meist 50:50). Beispiel: Inhalt 4 und Sprache 3 ergeben 3,5.',
      ] },
      { titel: 'Bestimmt beste Note', absaetze: [
        'Mit dieser Option legt ein Teil die beste erreichbare Gesamtnote fest: Die anderen Teile können sie dann nicht verbessern, nur verschlechtern.',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['klausuren', 'notenschluessel'],
  },
  {
    slug: 'unterrichtsleistung', kategorie: 'noten', titel: 'Unterrichtsleistung: Datumstabelle und Zusatzleistungen',
    kurz: 'Noten je Unterrichtstermin, n.a. für Abwesende, Unterrichtsinhalt; Zusatzleistungen wie Referate.',
    schlagworte: ['unterrichtsleistung', 'mündlich', 'datumstabelle', 'termin', 'datum', 'n.a.', 'nicht anwesend', 'unterrichtsinhalt', 'referat', 'zusatzleistung', 'durchschnitt', 'notiz', 'korrektur'],
    bilder: [{ datei: 'datumstabelle', text: 'Datumstabelle mit Terminen und Noten' }],
    abschnitte: [
      { titel: 'Datumstabelle', schritte: [
        'In der Fachseite **⋮ Mehr → Unterrichtsleistung** öffnen und ein Datum mit **+ Datum hinzufügen** anlegen.',
        'Je Person die Note für diesen Termin eintragen; **n.a.** steht für „nicht anwesend“ (zählt nicht mit). Am Handy erscheint beim Antippen eine Auswahl der Noten.',
        'Unter jedem Datum kannst du eine kurze Notiz zum **Unterrichtsinhalt** eintragen. Das Notizsymbol hinter dem Namen öffnet Notizen zur Person.',
      ] },
      { titel: 'Zusatzleistungen', absaetze: [
        'Mit **+** neben der Datumstabelle legst du Zusatzleistungen an (z. B. Referat). Wie bei Klausuren trägst du Punkte ein; die **Gewichtung** bestimmt den Anteil am Topf der Unterrichtsleistung. Der Rest geht in die Datumstabelle.',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['klausuren', 'verrechnung-endnoten'],
  },
  {
    slug: 'notenschluessel', kategorie: 'noten', titel: 'Notenschlüssel IHK, BG und SPA',
    kurz: 'Wie Prozent in Noten umgerechnet werden; Schlüssel ansehen; Änderungen durch die Administration.',
    schlagworte: ['notenschlüssel', 'ihk', 'bg', 'spa', 'prozent', 'note', 'punkte', 'tendenz', 'umrechnung', 'tabelle', 'schlüssel geändert', 'hinweis'],
    bilder: [{ datei: 'notenschluessel', text: 'Notenschlüssel ansehen (SPA aufgeklappt)' }, { datei: 'admin-notenschluessel', text: 'Administration: Schlüssel bearbeiten' }],
    abschnitte: [
      { titel: 'Die drei Schlüssel', absaetze: [
        '**IHK:** Prozent → Note 1–6 (kleiner ist besser). **BG:** Prozent → Notenpunkte 0–15 (größer ist besser). **SPA:** Prozent → Note 1–6; daraus werden **Leistungspunkte** (Punkte = 17 − 3 × Note) und die **Tendenznote** abgeleitet.',
        'Im Menü **Notenschlüssel** siehst du alle Tabellen; die SPA-Tabelle zeigt Prozent, Note, Punkte und Tendenz Schritt für Schritt. Die Abschnitte sind eingeklappt, ein Klick öffnet sie.',
      ] },
      { titel: 'Änderungen', absaetze: [
        'Die Zahlen pflegt die **Administration** zentral (Admin → Notenschlüssel); sie gelten für alle Klassen. Wird ein Schlüssel geändert, den du nutzt, erscheint oben eine Meldung mit Datum und Hinweis. **Verstanden** blendet sie aus; die Änderung gilt ab dem laufenden Halbjahr.',
      ] },
    ],
    links: [{ text: 'Notenschlüssel ansehen', href: '/notenschluessel' }], verwandt: ['klausur-teile', 'spa'],
  },
  {
    slug: 'verrechnung-endnoten', kategorie: 'noten', titel: 'Verrechnung der Halbjahre, Endnoten und Notenkorrektur',
    kurz: 'Anteil der Vorhalbjahresnote, direkte Endnoten, Gesamtnote korrigieren.',
    schlagworte: ['verrechnung', 'halbjahre', 'vorhalbjahr', 'prozent', 'endnote', 'direkt', 'ntg', 'gesamtnote', 'korrektur', 'korrigieren', 'zeugnis', 'abschlussnote'],
    bilder: [{ datei: 'fach-uebersicht', text: 'Notenübersicht eines Fachs' }],
    abschnitte: [
      { titel: 'Verrechnung', absaetze: [
        'In den Fach-Einstellungen (⚙ Zahnrad) legst du je Halbjahr fest, zu wie viel Prozent die Note des **Vorhalbjahres** in das nächste einfließt (0 % = gar nicht). In der Notenübersicht erscheint dann eine Spalte **Vorhalbjahr**.',
      ] },
      { titel: 'Endnoten', absaetze: [
        'Eine **direkt eingetragene Endnote** ersetzt die berechnete Halbjahresnote (Fachlehrkraft über **Direkte Endnoteneingabe**, Klassenleitung im Reiter **Endnoten** der Klassenleitung). Vergangene Halbjahre trägt die Klassenleitung ein, auch für Fächer ohne Lehrkraft.',
        'In der **Notenbesprechung** lässt sich die Gesamtnote korrigieren; der Korrekturwert erscheint mit Datum in der Datumstabelle.',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['notenbesprechung', 'klassenleitung'],
  },
  {
    slug: 'notenbesprechung', kategorie: 'noten', titel: 'Notenbesprechung mit Würfel',
    kurz: 'Personen nacheinander besprechen, zufällige Reihenfolge, mehrere Fächer, Gesamtnote korrigieren.',
    schlagworte: ['notenbesprechung', 'würfeln', 'zufällig', 'reihenfolge', 'besprechen', 'mehrere fächer', 'notiz', 'korrektur', 'gesamtnote'],
    bilder: [{ datei: 'besprechung', text: 'Notenbesprechung einer Person' }],
    abschnitte: [
      { titel: 'Besprechung starten', schritte: [
        'In der Fachseite auf **🗣 Notenbesprechung starten** klicken: Du siehst eine Person nach der anderen mit allen Noten.',
        'Mit **🎲 Zufällig starten** (oder dem Würfelknopf in der Besprechung) kommt die nächste Person **zufällig** dran; jede nur einmal. Die Zählung läuft weiter, so siehst du, wie viele noch kommen.',
        'Sind dir mehrere Fächer der Klasse zugeordnet, schaltest du oben zwischen den **Fächern** um.',
      ] },
      { titel: 'Korrigieren und Notizen', absaetze: [
        'Die **Gesamtnote** kannst du hier korrigieren; sie wird als Korrekturwert mit Datum in die Datumstabelle eingetragen. Notizen zur Person bleiben als Verlauf erhalten.',
      ] },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['verrechnung-endnoten'],
  },
  {
    slug: 'spa', kategorie: 'noten', titel: 'SPA: Lernfelder und Komponenten',
    kurz: 'Fächer, die zu einem Lernfeld gehören (z. B. DV-Unterricht als Teil von LF4), Leistungspunkte und Tendenz.',
    schlagworte: ['spa', 'lernfeld', 'lf4', 'komponente', 'unterfach', 'dv-unterricht', 'fachschule', 'leistungspunkte', 'tendenz', 'zeugnis', 'gesamtpunkte', 'endpunkte'],
    abschnitte: [
      { titel: 'Lernfelder und Komponenten', absaetze: [
        'In SPA-Klassen sind die Fächer **Lernfelder** (LF1, LF2, …). Ein Lernfeld kann aus **Komponenten** bestehen (Unterfächern, z. B. „DV-Unterricht“ als Teil von LF4). Lehrkräfte werden den Komponenten zugeordnet und tragen **dort** Klausuren, Unterrichtsleistung und Noten ein; das Lernfeld setzt sich daraus zusammen.',
        'Klausuren und Unterrichtsleistung werden nach dem **SPA-Schlüssel** (Noten 1–6) bewertet. Die App leitet daraus **Leistungspunkte** (0–15) und die **Tendenznote** ab (in der Notenübersicht eigene Spalten). Direkt eingetragene Gesamtpunkte (0–15) haben Vorrang.',
      ], hinweis: 'Die Zeugnisübersicht für SPA-Klassen findest du auf der Klassenseite unter **📋 Zeugnisübersicht**.' },
    ],
    links: [{ text: 'Meine Klassen', href: '/teacher/klassen' }], verwandt: ['notenschluessel', 'api'],
  },

  // ---------------------------------------------------------------- Auswerten und Zusammenarbeit
  {
    slug: 'sync', kategorie: 'auswerten', titel: 'Synchronisation mit der Klassenleitung',
    kurz: 'Die Klassenleitung sieht nur den synchronisierten Notenstand: per Knopf oder automatisch.',
    schlagworte: ['sync', 'synchronisieren', 'synchronisation', 'klassenleitung', 'auto', 'automatisch', 'halbjahresübersicht', 'stand'],
    bilder: [{ datei: 'fach-uebersicht', text: 'Fachseite (Sync-Funktionen unter „⋮ Mehr“)' }],
    abschnitte: [
      { titel: 'Warum Sync?', absaetze: [
        'Die Klassenleitung sieht **nie** die Live-Noten deiner Fächer, nur den Stand, den du **synchronisiert** hast. So behältst du die Kontrolle, bis du die Noten freigeben möchtest.',
      ] },
      { titel: 'So geht es', schritte: [
        '**Jetzt synchronisieren:** überträgt den aktuellen Notenstand des Fachs und Halbjahres an die Klassenleitung.',
        '**Automatisch mit Klassenleitung synchronisieren** (Haken): Danach löst jede Notenänderung in diesem Fach sofort einen Sync aus. Beim Einschalten wird einmal sofort synchronisiert.',
      ], hinweis: 'Auch Eintragungen über die API lösen den Sync aus, wenn der automatische Sync eingeschaltet ist.' },
    ],
    links: [{ text: 'Zur Noteneingabe', href: '/teacher' }], verwandt: ['klassenleitung', 'api'],
  },
  {
    slug: 'klassenleitung', kategorie: 'auswerten', titel: 'Klassenleitung: Übersicht, Konferenz und Zeugnisse',
    kurz: 'Halbjahresübersicht, Endnoten, Fehlzeiten, Notenkonferenz mit Sperre, Abschluss- und Abgangsübersicht.',
    schlagworte: ['klassenleitung', 'halbjahresübersicht', 'konferenz', 'sperre', 'entsperren', 'fehlzeiten', 'abschluss', 'abgang', 'zeugnis', 'endnoten', 'export', 'csv'],
    bilder: [{ datei: 'klassenleitung', text: 'Bereich Klassenleitung' }],
    abschnitte: [
      { titel: 'Reiter', absaetze: [
        '**Übersicht / Halbjahresübersicht:** die zuletzt synchronisierten Noten aller Fächer. **Endnoten (Direkteingabe):** Endnoten vergangener Halbjahre oder von Fächern ohne Lehrkraft. **Fehlzeiten:** Stunden je Person. **Abschluss-/Abgangsübersicht:** Noten über alle Halbjahre für Zeugnis und Abgang. **Weitere Klassenlehrkräfte:** Co-Klassenleitung eintragen.',
      ] },
      { titel: 'Notenkonferenz', absaetze: [
        'In der Notenkonferenz lassen sich Personen **sperren**: Dann kann in diesem Halbjahr niemand mehr Noten für sie ändern. Fachlehrkräfte können eine **Entsperrung anfragen**, die Klassenleitung entsperrt. Der **CSV-Export** der Klasse steht auf der Klassenseite.',
      ] },
    ],
    links: [{ text: 'Zur Klassenleitung', href: '/klassenlehrer' }], verwandt: ['sync', 'faecher-lehrkraefte'],
  },

  // ---------------------------------------------------------------- Weitere Funktionen
  {
    slug: 'api', kategorie: 'mehr', titel: 'API-Zugang für KI-Agenten',
    kurz: 'Persönliche API-Schlüssel, damit ein KI-Agent Noten auslesen, auswerten und eintragen kann.',
    schlagworte: ['api', 'schlüssel', 'token', 'ki', 'agent', 'claude', 'automatisierung', 'openapi', 'dokumentation', 'dry run', 'probelauf', 'schreiben', 'lesen'],
    bilder: [{ datei: 'api-zugang', text: 'API-Zugang: Schlüssel anlegen' }, { datei: 'api-docs', text: 'API-Dokumentation' }],
    abschnitte: [
      { titel: 'Schlüssel anlegen', schritte: [
        'Im Menü **🤖 API-Zugang** einen **Namen** (wofür?), die **Berechtigung** („nur lesen“ oder „lesen und Noten eintragen“) und die **Gültigkeit** wählen.',
        '**Schlüssel erzeugen** und den angezeigten Schlüssel (`nk_…`) **sofort kopieren**: Er wird nur dieses eine Mal gezeigt.',
        'Den Schlüssel dem Programm geben, das ihn als `Authorization: Bearer nk_…` mitsendet. Widerrufen wirkt sofort.',
      ], hinweis: 'Ein Schlüssel hat genau deine Rechte. Über die API wird nichts gelöscht; Eintragungen lassen sich mit `?dry_run=true` vorab prüfen.' },
      { titel: 'Dokumentation', absaetze: [
        'Die vollständige Beschreibung mit Beispielen und einem Vorschlag für den System-Prompt eines Agenten steht unter **/api/v1/docs**, maschinenlesbar als **OpenAPI** unter `/api/v1/openapi.json`. Die API kann u. a. Kurse und Klassen umbenennen, Kurse anlegen, Teilnehmer aufnehmen, Klausuren und Noten eintragen und mit der Klassenleitung synchronisieren.',
      ] },
    ],
    links: [{ text: 'API-Zugang öffnen', href: '/konto/api' }, { text: 'API-Dokumentation', href: '/api/v1/docs' }], verwandt: ['sync', 'kurse'],
  },
  {
    slug: 'administration', kategorie: 'mehr', titel: 'Administration (für Admins)',
    kurz: 'Schuljahre, Lehrkräfte, Notenschlüssel, LDAP, Datensicherung, Rechtliches.',
    schlagworte: ['admin', 'administration', 'schuljahr', 'lehrkräfte', 'ldap', 'datensicherung', 'backup', 'rechtliches', 'impressum', 'datenschutz', 'notenschlüssel', 'einladungen', 'zuweisungen'],
    bilder: [{ datei: 'admin', text: 'Administration: Dashboard' }],
    abschnitte: [
      { titel: 'Was die Administration pflegt', absaetze: [
        '**Schuljahre** legen sich zum 1. August automatisch an (manuell geht auch). **Lehrkräfte** und **Einladungen** (für externe Konten), **Zuweisungen** von Lehrkräften zu Fächern, **LDAP-Einstellungen** (Schulkonto, Gruppe), **LDAP-Import**.',
        '**Notenschlüssel** (IHK, BG, SPA) werden zentral gepflegt; **Datensicherung** (zeitgesteuerte, verschlüsselte Sicherungen, Wiederherstellung) und **Rechtliches** (Angaben für Datenschutzerklärung und Impressum) gibt es als eigene Menüpunkte.',
      ] },
    ],
    links: [{ text: 'Administration', href: '/admin' }], verwandt: ['notenschluessel', 'anmelden'],
  },
];

/** Geführter Rundgang: Schritt für Schritt durch die wichtigsten Funktionen. `artikel` verweist auf die Hilfe, `href` auf die Seite zum Ausprobieren. */
export const RUNDGANG = [
  { titel: 'Willkommen', bild: 'start', text: 'Dieser Rundgang führt dich in etwa 10 Minuten durch die wichtigsten Funktionen. Zu jedem Schritt gibt es einen Knopf, der die passende Seite öffnet. Auf der **Startseite** findest du die vier Bereiche: Noteneingabe, Meine Klassen, Sitzpläne und Klassenleitung. Das Menü **☰** bringt dich überall hin.', artikel: 'anmelden', href: '/start', linkText: 'Startseite öffnen' },
  { titel: 'Klasse anlegen', bild: 'klasse-anlegen', text: 'Unter **Meine Klassen** legst du mit **+ Neue Klasse anlegen** eine Klasse an: Schuljahr (das aktuelle ist vorausgewählt), Name, Notenschlüssel und Einschulungsjahr. Gibt es die Klasse schon, trittst du ihr einfach bei.', artikel: 'klasse-anlegen', href: '/teacher/klassen', linkText: 'Meine Klassen öffnen' },
  { titel: 'Schüler:innen eintragen', bild: 'schueler-csv', text: 'Auf der Klassenseite trägst du Personen **einzeln**, als **Liste** oder per **CSV-Datei** ein. Kopfzeile und Trennzeichen erkennt die App selbst.', artikel: 'schueler-eintragen', href: '/teacher/klassen', linkText: 'Zu den Klassen' },
  { titel: 'Fächer und Lehrkräfte', bild: 'faecher-lehrkraefte', text: 'Lege die **Fächer** der Klasse an und ordne **Lehrkräfte** zu. Du kannst dich auch selbst für ein freies Fach eintragen oder dich als **Klassenleitung** eintragen.', artikel: 'faecher-lehrkraefte', href: '/teacher/klassen', linkText: 'Zu den Klassen' },
  { titel: 'Noteneingabe', bild: 'noteneingabe', text: 'In der **Noteneingabe** siehst du deine Fächer. Die **Schuljahr-Auswahl** zeigt das aktuelle Schuljahr mit „(aktuell)“, künftige Schuljahre sind ausgeblendet. Ein Klick auf ein Fach öffnet die Notenübersicht.', artikel: 'noteneingabe-ueberblick', href: '/teacher', linkText: 'Noteneingabe öffnen' },
  { titel: 'Notenübersicht', bild: 'fach-uebersicht', text: 'Oben wechselst du das **Halbjahr**. Die Tabelle zeigt Unterrichtsleistung, schriftliche Note und **Gesamtnote**. Mit dem Haken **ganze Note** rundest du die Anzeige einer Spalte. Weitere Reiter findest du unter **⋮ Mehr**.', artikel: 'noteneingabe-ueberblick', href: '/teacher', linkText: 'Ein Fach öffnen' },
  { titel: 'Klausuren', bild: 'klausur-eintragen', text: 'Unter **⋮ Mehr → Klausuren** legst du Klausuren an: Aufgaben, **Max. Punkte** je Aufgabe und die erreichten Punkte je Person. Die Note erscheint sofort nach dem Notenschlüssel; alles wird automatisch gespeichert.', artikel: 'klausuren', href: '/teacher', linkText: 'Zur Noteneingabe' },
  { titel: 'Mehrteilige Klausuren', bild: 'klausur-teile', text: 'Klausuren können aus **Teilen** bestehen: **Hörverstehen** (Verrechnungspunkte, Tabelle ohne Rundung) und **Inhalt & Sprache** (zwei direkt eingetragene Noten, meist 50:50). Die Teilnoten gehen gewichtet in die Gesamtnote ein.', artikel: 'klausur-teile', href: '/teacher', linkText: 'Zur Noteneingabe' },
  { titel: 'Unterrichtsleistung', bild: 'datumstabelle', text: 'In der **Datumstabelle** trägst du je Unterrichtstermin eine Note ein (**n.a.** = nicht anwesend) und kannst den Unterrichtsinhalt notieren. Zusatzleistungen wie Referate legst du daneben an.', artikel: 'unterrichtsleistung', href: '/teacher', linkText: 'Zur Noteneingabe' },
  { titel: 'Notenschlüssel', bild: 'notenschluessel', text: 'Unter **Notenschlüssel** siehst du, wie Prozent in Noten umgerechnet werden (IHK, BG, SPA). Ändert die Administration einen Schlüssel, bekommst du einen Hinweis.', artikel: 'notenschluessel', href: '/notenschluessel', linkText: 'Notenschlüssel ansehen' },
  { titel: 'Notenbesprechung', bild: 'besprechung', text: 'Mit **🗣 Notenbesprechung starten** gehst du Person für Person durch; der **Würfel** wählt zufällig die nächste Person, jede nur einmal. Die Gesamtnote lässt sich korrigieren.', artikel: 'notenbesprechung', href: '/teacher', linkText: 'Zur Noteneingabe' },
  { titel: 'Sync mit der Klassenleitung', bild: 'klassenleitung', text: 'Die Klassenleitung sieht nur den **synchronisierten** Stand. Mit **Jetzt synchronisieren** oder dem Haken **automatisch synchronisieren** gibst du deine Noten frei.', artikel: 'sync', href: '/klassenlehrer', linkText: 'Klassenleitung öffnen' },
  { titel: 'Kurse', bild: 'kurs-teilnehmer', text: 'Für Kurse über mehrere Klassen legst du unter **+ Neuen Kurs anlegen** einen Kurs an (Standard-Schlüssel BG) und füllst die **Teilnehmerliste** per Suche, manuell oder per **CSV** (`Nachname;Vorname;Klasse`).', artikel: 'kurse', href: '/teacher/klassen', linkText: 'Meine Klassen und Kurse' },
  { titel: 'Papierkorb', bild: 'papierkorb', text: '**Klasse löschen** blendet sie nur für dich aus. Im **Papierkorb** holst du sie zurück. Endgültig gelöscht wird erst, wenn alle Lehrkräfte gelöscht haben und 30 Tage vergangen sind.', artikel: 'papierkorb', href: '/teacher/papierkorb', linkText: 'Papierkorb öffnen' },
  { titel: 'API für KI-Agenten', bild: 'api-zugang', text: 'Unter **🤖 API-Zugang** erzeugst du persönliche Schlüssel, mit denen ein KI-Agent Noten auslesen, auswerten und eintragen kann – mit deinen Rechten und nur, wenn du es erlaubst.', artikel: 'api', href: '/konto/api', linkText: 'API-Zugang öffnen' },
  { titel: 'Geschafft – und Hilfe', bild: 'hilfe', text: 'Das waren die wichtigsten Funktionen. In der **Hilfe** findest du zu jedem Thema einen Artikel mit Bildern; die **Suche** hilft bei konkreten Fragen. Viel Erfolg!', artikel: null, href: '/hilfe', linkText: 'Zur Hilfe' },
];

// ---------------------------------------------------------------- Formatierung

const MASKE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const maskiere = (s) => String(s).replace(/[&<>"']/g, (c) => MASKE[c]);

/** Maskiert Text und setzt **fett** sowie `code`. Nur für Inhalte aus diesem Modul gedacht. */
export function formatiere(text) {
  return maskiere(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

export const artikelNachSlug = (slug) => ARTIKEL.find((a) => a.slug === slug) || null;

// ---------------------------------------------------------------- Suche

/** Vergleichsform: klein, Umlaute und „ae/oe/ue“ vereinheitlicht („Hörverstehen“ = „Hoerverstehen“), ß = ss, ohne Markup. */
export function normalisiere(s) {
  return String(s)
    .toLowerCase()
    .replace(/\*\*|`/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ä|ae/g, 'a')
    .replace(/ö|oe/g, 'o')
    .replace(/ü|ue/g, 'u')
    .replace(/[^a-z0-9: .-]+/g, ' ');
}

const alsText = (a) => a.abschnitte.flatMap((ab) => [ab.titel, ...(ab.absaetze || []), ...(ab.schritte || []), ab.hinweis]).filter(Boolean).join(' ');

const INDEX = ARTIKEL.map((a) => ({
  artikel: a,
  titel: normalisiere(a.titel),
  schlag: normalisiere(a.schlagworte.join(' ')),
  kurz: normalisiere(a.kurz),
  text: normalisiere(alsText(a)),
  rohText: alsText(a).replace(/\*\*|`/g, ''),
}));

function zaehle(haystack, token) {
  let n = 0;
  for (let i = haystack.indexOf(token); i !== -1 && n < 5; i = haystack.indexOf(token, i + token.length)) n += 1;
  return n;
}

/** Ausschnitt: der erste Satz des Rohtexts, in dem das Suchwort vorkommt (sonst der Anfang), höchstens ca. 200 Zeichen. */
function ausschnitt(roh, token) {
  const saetze = roh.split(/(?<=[.!?:])\s+/);
  const satz = saetze.find((s) => normalisiere(s).includes(token)) || saetze[0] || '';
  return satz.length > 200 ? `${satz.slice(0, 200).trim()}…` : satz;
}

/**
 * Sucht in der Hilfe. Alle Wörter der Anfrage müssen vorkommen (Titel, Schlagworte, Kurztext oder Text); Titel und Schlagworte zählen
 * stärker. @returns {Array<{slug: string, titel: string, kategorie: string, kurz: string, snippet: string, punkte: number}>}
 */
export function sucheHilfe(anfrage, max = 8) {
  const tokens = normalisiere(anfrage).split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const treffer = [];
  for (const e of INDEX) {
    let punkte = 0;
    let alle = true;
    for (const t of tokens) {
      const imTitel = e.titel.includes(t);
      const inSchlag = e.schlag.includes(t);
      const inKurz = e.kurz.includes(t);
      const inText = zaehle(e.text, t);
      if (!imTitel && !inSchlag && !inKurz && !inText) { alle = false; break; }
      punkte += (imTitel ? (e.titel.startsWith(t) ? 14 : 10) : 0) + (inSchlag ? 6 : 0) + (inKurz ? 4 : 0) + inText;
    }
    if (!alle) continue;
    treffer.push({
      slug: e.artikel.slug, titel: e.artikel.titel, kategorie: e.artikel.kategorie, kurz: e.artikel.kurz, punkte,
      snippet: ausschnitt(e.rohText, tokens.find((t) => e.text.includes(t)) || tokens[0]),
    });
  }
  return treffer.sort((a, b) => b.punkte - a.punkte || a.titel.localeCompare(b.titel, 'de')).slice(0, max);
}

/*
 * Notenauswahl per Touch.
 *
 * Felder mit data-note-picker="IHK|BG" öffnen auf Touch-Geräten (primärer Zeiger "coarse", also Handy/Tablet) beim
 * Antippen eine Auswahl am unteren Bildschirmrand statt der Bildschirmtastatur: ganz vorne "n.a." (Datumstabelle:
 * data-picker-na) bzw. "ntg" (Endnoten: data-picker-ntg), danach die Noten des Notenschlüssels (IHK 1-6, BG 0-15).
 * Mit PC und Maus bleibt alles wie bisher: Note direkt über die Tastatur eintippen. Auf Touch-Geräten schaltet
 * "Tastatur" in der Auswahl bei Bedarf auf die normale Eingabe um (z. B. für 2,5).
 *
 * Gewählt wird, indem der Wert ins Feld geschrieben und das "change"-Ereignis ausgelöst wird -- das Speichern
 * übernimmt dieselbe Logik wie bei der Tastatureingabe. Danach springt die Auswahl zur nächsten Person derselben
 * Spalte; "Fertig" oder ein Tipp neben die Tabelle schließt sie.
 */
(function () {
  'use strict';
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
  var felder = Array.prototype.slice.call(document.querySelectorAll('input[data-note-picker]'));
  if (!felder.length) return;

  var sheet = null;
  var aktiv = null;
  var zwischen = false;
  var tastaturFeld = null;

  function el(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function knopf(text, klasse, onClick, label) {
    var b = el('button', klasse, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }
  function noteText(n) { return String(n).replace('.', ','); }

  function werte(schluessel) {
    var liste = [];
    if (schluessel === 'BG') {
      for (var i = 0; i <= 15; i++) liste.push(String(i));
      return liste;
    }
    for (var n = 1; n <= 6; n++) {
      liste.push(String(n));
      if (zwischen && n < 6) { liste.push(noteText(n + 0.3)); liste.push(noteText(n + 0.7)); }
    }
    return liste;
  }

  function spalte(inp) {
    var tabelle = inp.closest('table');
    if (!tabelle) return [inp];
    return Array.prototype.slice.call(tabelle.querySelectorAll('input[data-note-picker]')).filter(function (f) {
      return f.dataset.termin === inp.dataset.termin && f.dataset.fach === inp.dataset.fach;
    });
  }
  function nachbar(inp, richtung) {
    var s = spalte(inp);
    for (var i = s.indexOf(inp) + richtung; i >= 0 && i < s.length; i += richtung) {
      if (!s[i].disabled) return s[i];
    }
    return null;
  }
  function personName(inp) {
    var td = inp.closest('tr') && inp.closest('tr').querySelector('td.name');
    if (!td) return '';
    var kopie = td.cloneNode(true);
    Array.prototype.forEach.call(kopie.querySelectorAll('button, small'), function (b) { b.remove(); });
    return kopie.textContent.replace(/\s+/g, ' ').trim();
  }

  function bauen() {
    sheet = el('div', 'note-picker');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Note wählen');
    sheet.hidden = true;
    var kopf = el('div', 'note-picker-kopf');
    kopf.appendChild(knopf('◀', 'note-picker-nav', function () { wechsle(-1); }, 'Vorherige Person'));
    var titel = el('div', 'note-picker-titel');
    titel.appendChild(el('strong', 'note-picker-name'));
    titel.appendChild(el('small', 'note-picker-pos'));
    kopf.appendChild(titel);
    kopf.appendChild(knopf('▶', 'note-picker-nav', function () { wechsle(1); }, 'Nächste Person'));
    kopf.appendChild(knopf('Fertig', 'note-picker-fertig', schliessen));
    sheet.appendChild(kopf);
    sheet.appendChild(el('div', 'note-picker-raster'));
    var fuss = el('div', 'note-picker-fuss');
    fuss.appendChild(knopf('Zwischennoten', 'note-picker-zwischen', function () { zwischen = !zwischen; zeichne(); }));
    fuss.appendChild(knopf('Leeren', 'note-picker-leeren', function () { setze(''); }));
    fuss.appendChild(knopf('⌨ Tastatur', 'note-picker-tastatur', tastatur));
    sheet.appendChild(fuss);
    document.body.appendChild(sheet);
  }

  function zeichne() {
    if (!aktiv) return;
    var raster = sheet.querySelector('.note-picker-raster');
    raster.textContent = '';
    var aktuell = aktiv.value.trim().toLowerCase();
    var optionen = [];
    if (aktiv.dataset.pickerNa) optionen.push({ text: 'n.a.', wert: 'n.a.', klasse: 'note-picker-na' });
    if (aktiv.dataset.pickerNtg) optionen.push({ text: 'ntg', wert: 'ntg', klasse: 'note-picker-na' });
    werte(aktiv.dataset.notePicker).forEach(function (w) { optionen.push({ text: w, wert: w, klasse: '' }); });
    optionen.forEach(function (o) {
      var b = knopf(o.text, 'note-picker-wert ' + o.klasse, function () { setze(o.wert); });
      var gleich = aktuell === o.wert.toLowerCase() || (o.wert === 'n.a.' && aktuell === 'na');
      b.setAttribute('aria-pressed', gleich ? 'true' : 'false');
      raster.appendChild(b);
    });
    var zw = sheet.querySelector('.note-picker-zwischen');
    zw.hidden = aktiv.dataset.notePicker === 'BG';
    zw.setAttribute('aria-pressed', zwischen ? 'true' : 'false');
    sheet.querySelector('.note-picker-name').textContent = personName(aktiv) || 'Note wählen';
    var s = spalte(aktiv);
    sheet.querySelector('.note-picker-pos').textContent = s.length > 1 ? ' ' + (s.indexOf(aktiv) + 1) + '/' + s.length : '';
  }

  function sichtbar() {
    if (!aktiv) return;
    window.requestAnimationFrame(function () {
      var hoehe = sheet.offsetHeight;
      document.body.style.paddingBottom = hoehe + 'px';
      var r = aktiv.getBoundingClientRect();
      var frei = window.innerHeight - hoehe;
      if (r.bottom > frei - 8) window.scrollBy(0, r.bottom - frei + 80);
      else if (r.top < 60) window.scrollBy(0, r.top - 120);
    });
  }

  function oeffne(inp) {
    if (inp.disabled) return;
    if (!sheet) bauen();
    if (aktiv && aktiv !== inp) aktiv.classList.remove('note-picker-aktiv');
    aktiv = inp;
    inp.classList.add('note-picker-aktiv');
    sheet.hidden = false;
    document.body.classList.add('note-picker-offen');
    zeichne();
    sichtbar();
  }

  function schliessen() {
    if (aktiv) aktiv.classList.remove('note-picker-aktiv');
    aktiv = null;
    if (sheet) sheet.hidden = true;
    document.body.classList.remove('note-picker-offen');
    document.body.style.paddingBottom = '';
  }

  function setze(wert) {
    var inp = aktiv;
    if (!inp) return;
    inp.value = wert;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    var weiter = nachbar(inp, 1);
    if (weiter) oeffne(weiter); else schliessen();
  }

  function wechsle(richtung) {
    var n = aktiv && nachbar(aktiv, richtung);
    if (n) oeffne(n);
  }

  function tastatur() {
    var inp = aktiv;
    if (!inp) return;
    schliessen();
    tastaturFeld = inp;
    inp.readOnly = false;
    inp.setAttribute('inputmode', 'decimal');
    inp.focus();
    inp.select();
  }

  felder.forEach(function (inp) {
    // Ohne Bildschirmtastatur: das Feld ist nur zum Antippen da, bis "Tastatur" gewählt wird.
    inp.readOnly = true;
    inp.setAttribute('inputmode', 'none');
    inp.addEventListener('click', function () {
      if (tastaturFeld === inp) return;
      oeffne(inp);
    });
    inp.addEventListener('keydown', function (e) {
      if (tastaturFeld !== inp && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); oeffne(inp); }
    });
    inp.addEventListener('blur', function () {
      if (tastaturFeld !== inp) return;
      tastaturFeld = null;
      inp.readOnly = true;
      inp.setAttribute('inputmode', 'none');
    });
  });

  document.addEventListener('click', function (e) {
    if (!aktiv) return;
    // Der angetippte Knopf kann beim Neuzeichnen schon aus dem DOM entfernt sein -- darum der Ereignispfad.
    if (e.composedPath().indexOf(sheet) !== -1 || (e.target.closest && e.target.closest('input[data-note-picker]'))) return;
    schliessen();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') schliessen(); });
})();

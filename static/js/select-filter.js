/**
 * Such-/Auswahlfeld für lange Listen: <select data-filter> wird zur Combobox (Eingabefeld mit Trefferliste), die beim Tippen
 * unscharf filtert (Groß-/Kleinschreibung, Umlaute und ä/ae, ö/oe, ü/ue, ß/ss sind egal; mehrere Wörter müssen alle passen;
 * auch verstreute Buchstaben und ein Tippfehler bei längeren Wörtern werden verziehen) und die besten Treffer nach oben sortiert.
 * Passt genau ein Eintrag, wird er gleich ausgewählt. Ohne JavaScript bleibt die normale Auswahlliste.
 */
(function () {
  'use strict';

  /** Kleinbuchstaben ohne Akzente; ä/ae -> a, ö/oe -> o, ü/ue -> u, ß/ss -> ss (so passen beide Schreibweisen zueinander). */
  function normalisiere(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/ß/g, 'ss').replace(/ä|ae/g, 'a').replace(/ö|oe/g, 'o').replace(/ü|ue/g, 'u')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  /** Abstand zweier Wörter (Einfügen, Löschen, Ersetzen, Vertauschen je 1). */
  function abstand(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 1; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var kosten = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + kosten);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[m][n];
  }

  function istTeilfolge(token, text) {
    var pos = 0;
    for (var i = 0; i < token.length; i++) {
      pos = text.indexOf(token.charAt(i), pos);
      if (pos === -1) return false;
      pos += 1;
    }
    return true;
  }

  /** Wie gut passt ein Suchwort auf den Text? 0 = gar nicht; höher ist besser. */
  function bewerte(token, text, woerter) {
    var idx = text.indexOf(token);
    if (idx !== -1) {
      var wortanfang = idx === 0 || /[\s\-·(,]/.test(text.charAt(idx - 1));
      return 100 + (wortanfang ? 30 : 0) - Math.min(idx, 40) / 2;
    }
    if (token.length >= 4) { // ein Tippfehler (bei langen Wörtern zwei) wird verziehen
      var erlaubt = token.length >= 8 ? 2 : 1;
      for (var i = 0; i < woerter.length; i++) {
        var w = woerter[i];
        if (abstand(token, w) <= erlaubt || (w.length > token.length && abstand(token, w.slice(0, token.length)) <= erlaubt)) return 60;
      }
    }
    if (token.length >= 2 && istTeilfolge(token, text)) return 30; // verstreute Buchstaben, z. B. „mstr“ für „Muster“
    return 0;
  }

  function bewerteText(tokens, text) {
    var woerter = text.split(/[^a-z0-9]+/).filter(Boolean);
    var summe = 0;
    for (var i = 0; i < tokens.length; i++) {
      var p = bewerte(tokens[i], text, woerter);
      if (!p) return 0;
      summe += p;
    }
    return summe;
  }

  var zaehler = 0;

  /**
   * Aus <select data-filter> wird eine Combobox: ein Eingabefeld mit Trefferliste darunter (die Auswahlliste selbst bleibt unsichtbar im
   * Formular und liefert den Wert). Tippen filtert unscharf, Pfeiltasten wählen, Enter übernimmt, Escape schließt.
   */
  function verbessere(select) {
    if (select.dataset.filterBereit) return;
    select.dataset.filterBereit = '1';
    var eintraege = Array.prototype.map.call(select.options, function (o, i) {
      return { option: o, index: i, wert: o.value, text: o.textContent.replace(/\s+/g, ' ').trim(), norm: normalisiere(o.textContent + ' ' + (o.dataset.suche || '')) };
    }).filter(function (e) { return e.wert !== ''; });
    var id = 'sf-' + (++zaehler);

    var huelle = document.createElement('div');
    huelle.className = 'sf-combobox';
    var eingabe = document.createElement('input');
    eingabe.type = 'text';
    eingabe.className = 'select-filter';
    eingabe.placeholder = '🔍 Suchen oder auswählen …';
    eingabe.autocomplete = 'off';
    eingabe.setAttribute('role', 'combobox');
    eingabe.setAttribute('aria-autocomplete', 'list');
    eingabe.setAttribute('aria-expanded', 'false');
    eingabe.setAttribute('aria-controls', id + '-liste');
    eingabe.setAttribute('aria-label', select.getAttribute('aria-label') || 'Auswahl');
    var liste = document.createElement('ul');
    liste.className = 'sf-liste';
    liste.id = id + '-liste';
    liste.setAttribute('role', 'listbox');
    liste.hidden = true;
    var info = document.createElement('small');
    info.className = 'select-filter-info hint';
    info.setAttribute('aria-live', 'polite');
    info.hidden = true;
    huelle.appendChild(eingabe);
    huelle.appendChild(liste);
    huelle.appendChild(info);
    select.parentNode.insertBefore(huelle, select);
    select.classList.add('sf-versteckt'); // bleibt im Formular (Wert, Pflichtfeld), ist aber nicht mehr zu sehen

    var treffer = [];
    var aktiv = -1;

    function beschriftung(wert) {
      var e = eintraege.filter(function (x) { return x.wert === wert; })[0];
      return e ? e.text : '';
    }
    function setzeAuswahl(wert) {
      select.value = wert;
      eingabe.value = wert ? beschriftung(wert) : eingabe.value;
      eingabe.classList.remove('ohne-treffer');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function berechne(query) {
      var tokens = normalisiere(query).split(' ').filter(Boolean);
      var r = eintraege.map(function (e) { return { e: e, punkte: tokens.length ? bewerteText(tokens, e.norm) : 1 }; }).filter(function (t) { return t.punkte > 0; });
      r.sort(function (a, b) { return tokens.length ? ((b.punkte - a.punkte) || (a.e.index - b.e.index)) : (a.e.index - b.e.index); });
      return r.map(function (t) { return t.e; });
    }
    function markiere(neu) {
      var knoten = liste.children;
      if (!knoten.length) { aktiv = -1; eingabe.removeAttribute('aria-activedescendant'); return; }
      aktiv = (neu + knoten.length) % knoten.length;
      for (var i = 0; i < knoten.length; i++) knoten[i].setAttribute('aria-selected', i === aktiv ? 'true' : 'false');
      eingabe.setAttribute('aria-activedescendant', knoten[aktiv].id);
      knoten[aktiv].scrollIntoView({ block: 'nearest' });
    }
    function oeffne() {
      var query = eingabe.dataset.gewaehlt && eingabe.value === beschriftung(select.value) ? '' : eingabe.value;
      treffer = berechne(query);
      liste.textContent = '';
      treffer.slice(0, 60).forEach(function (e, i) {
        var li = document.createElement('li');
        li.id = id + '-opt-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.textContent = e.text;
        li.addEventListener('mousedown', function (ev) { ev.preventDefault(); waehle(e); });
        liste.appendChild(li);
      });
      info.hidden = !query.trim();
      info.textContent = treffer.length === 0 ? 'Kein Treffer' : (treffer.length === 1 ? '1 Treffer' : treffer.length + ' Treffer' + (treffer.length > 60 ? ' (die ersten 60 – bitte weiter eingrenzen)' : ''));
      eingabe.classList.toggle('ohne-treffer', Boolean(query.trim()) && treffer.length === 0);
      liste.hidden = treffer.length === 0;
      eingabe.setAttribute('aria-expanded', String(!liste.hidden));
      markiere(0);
    }
    function schliesse() {
      liste.hidden = true;
      eingabe.setAttribute('aria-expanded', 'false');
      eingabe.removeAttribute('aria-activedescendant');
    }
    function waehle(e) {
      eingabe.dataset.gewaehlt = '1';
      setzeAuswahl(e.wert);
      info.hidden = true;
      schliesse();
    }

    // Vorbelegung (selected-Attribut): gewählten Eintrag anzeigen
    if (select.value) { eingabe.value = beschriftung(select.value); eingabe.dataset.gewaehlt = '1'; }

    eingabe.addEventListener('input', function () {
      // Wer tippt, hat die bisherige Auswahl verworfen, bis aus der Liste neu gewählt wird.
      if (select.value) { select.value = ''; delete eingabe.dataset.gewaehlt; }
      oeffne();
    });
    eingabe.addEventListener('focus', function () { eingabe.select(); oeffne(); });
    eingabe.addEventListener('click', function () { if (liste.hidden) oeffne(); });
    eingabe.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (liste.hidden) oeffne(); else markiere(aktiv + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!liste.hidden) markiere(aktiv - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault(); // Enter schickt das Formular nicht ab, sondern übernimmt den markierten Treffer
        if (!liste.hidden && treffer[aktiv]) waehle(treffer[aktiv]);
      } else if (e.key === 'Escape') {
        if (!liste.hidden) { e.preventDefault(); schliesse(); }
      } else if (e.key === 'Tab') schliesse();
    });
    eingabe.addEventListener('blur', function () {
      // Genau ein Treffer und nichts gewählt: übernehmen (so reicht „schmid“ und Weiter).
      if (!select.value && eingabe.value.trim()) {
        var t = berechne(eingabe.value);
        if (t.length === 1) { eingabe.dataset.gewaehlt = '1'; setzeAuswahl(t[0].wert); }
      }
      schliesse();
      info.hidden = true;
    });
    // Pflichtfeld ohne Auswahl: Hinweis am sichtbaren Feld statt an der unsichtbaren Liste
    select.addEventListener('invalid', function (e) {
      e.preventDefault();
      eingabe.classList.add('ohne-treffer');
      info.hidden = false;
      info.textContent = 'Bitte einen Eintrag aus der Liste wählen.';
      eingabe.focus();
    });
    var formular = select.form;
    if (formular) formular.addEventListener('reset', function () { setTimeout(function () { eingabe.value = ''; delete eingabe.dataset.gewaehlt; select.value = ''; schliesse(); info.hidden = true; }, 0); });
  }

  function start() { document.querySelectorAll('select[data-filter]').forEach(verbessere); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.selectFilter = { normalisiere: normalisiere, bewerteText: bewerteText, abstand: abstand };
})();

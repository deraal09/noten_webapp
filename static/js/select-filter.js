/**
 * Such-/Filterfeld über langen Auswahllisten: <select data-filter> bekommt ein kleines Suchfeld, das die Einträge beim Tippen
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

  function verbessere(select) {
    if (select.dataset.filterBereit) return;
    select.dataset.filterBereit = '1';
    var alle = Array.prototype.map.call(select.options, function (o, i) {
      return { option: o, index: i, platzhalter: o.value === '', text: normalisiere(o.textContent + ' ' + (o.dataset.suche || '')) };
    });
    var eingabe = document.createElement('input');
    eingabe.type = 'search';
    eingabe.className = 'select-filter';
    eingabe.placeholder = '🔍 Suchen …';
    eingabe.autocomplete = 'off';
    eingabe.setAttribute('aria-label', (select.getAttribute('aria-label') || 'Auswahl') + ' durchsuchen');
    var info = document.createElement('small');
    info.className = 'select-filter-info hint';
    info.hidden = true;
    info.setAttribute('aria-live', 'polite');
    select.parentNode.insertBefore(eingabe, select);
    select.parentNode.insertBefore(info, select);

    function zeige(query) {
      var tokens = normalisiere(query).split(' ').filter(Boolean);
      var gewaehlt = select.value;
      var treffer = alle.filter(function (e) { return !e.platzhalter; }).map(function (e) {
        return { e: e, punkte: tokens.length ? bewerteText(tokens, e.text) : 1 };
      }).filter(function (t) { return t.punkte > 0; });
      if (tokens.length) treffer.sort(function (a, b) { return (b.punkte - a.punkte) || (a.e.index - b.e.index); });
      else treffer.sort(function (a, b) { return a.e.index - b.e.index; });
      while (select.options.length) select.remove(0);
      alle.filter(function (e) { return e.platzhalter; }).forEach(function (e) { select.add(e.option); });
      treffer.forEach(function (t) { select.add(t.e.option); });
      if (tokens.length && treffer.length === 1) select.value = treffer[0].e.option.value; // genau ein Treffer: gleich gewählt
      else if (gewaehlt && Array.prototype.some.call(select.options, function (o) { return o.value === gewaehlt; })) select.value = gewaehlt;
      else if (!tokens.length) select.selectedIndex = 0;
      else select.value = '';
      info.hidden = !tokens.length;
      info.textContent = treffer.length === 0 ? 'Kein Treffer' : (treffer.length === 1 ? '1 Treffer' : treffer.length + ' Treffer');
      eingabe.classList.toggle('ohne-treffer', Boolean(tokens.length) && treffer.length === 0);
    }

    eingabe.addEventListener('input', function () { zeige(eingabe.value); });
    eingabe.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { // Enter wählt den besten Treffer, schickt das Formular aber nicht ab
        e.preventDefault();
        if (select.options.length > 1 && !select.value) select.selectedIndex = 1;
        select.focus();
      } else if (e.key === 'ArrowDown') { e.preventDefault(); select.focus(); }
      else if (e.key === 'Escape') { eingabe.value = ''; zeige(''); }
    });
    var formular = select.form;
    if (formular) formular.addEventListener('reset', function () { setTimeout(function () { eingabe.value = ''; zeige(''); }, 0); });
  }

  function start() { document.querySelectorAll('select[data-filter]').forEach(verbessere); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.selectFilter = { normalisiere: normalisiere, bewerteText: bewerteText, abstand: abstand };
})();

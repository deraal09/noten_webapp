/**
 * Suche „Was möchtest du tun?“: Knopf 🔍 in der Kopfzeile oder Strg/⌘+K (bzw. „/“ außerhalb von Eingabefeldern) öffnet einen Dialog.
 * Beim Tippen liefert der Server (GET /suche?q=) Seiten/Aktionen und Hilfe-Artikel; ausgeschaltete Funktionen werden mit
 * „einschalten und öffnen“ angeboten. Bedienung per Tastatur: ↑ ↓ wählen, Enter öffnet, Esc schließt.
 */
(function () {
  'use strict';
  var knopf = document.getElementById('suche-oeffnen');
  var dialog = document.getElementById('suche-dialog');
  if (!knopf || !dialog || typeof dialog.showModal !== 'function') return;
  var eingabe = dialog.querySelector('input[type="search"]');
  var liste = dialog.querySelector('.suche-liste');
  var info = dialog.querySelector('.suche-info');
  var eintraege = [];
  var aktiv = -1;
  var timer = null;
  var laufend = 0;

  function el(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function markiere(neu) {
    var knoten = liste.querySelectorAll('[role="option"]');
    if (!knoten.length) { aktiv = -1; eingabe.removeAttribute('aria-activedescendant'); return; }
    aktiv = (neu + knoten.length) % knoten.length;
    knoten.forEach(function (k, i) { k.setAttribute('aria-selected', i === aktiv ? 'true' : 'false'); });
    eingabe.setAttribute('aria-activedescendant', knoten[aktiv].id);
    knoten[aktiv].scrollIntoView({ block: 'nearest' });
  }
  /** Öffnet das Ziel; bei einer ausgeschalteten Funktion erst einschalten (POST), dann weiter. */
  function oeffne(e) {
    if (e.aus && e.funktion) {
      var f = document.createElement('form');
      f.method = 'post'; f.action = '/konto/funktionen/einschalten';
      [['funktion', e.funktion], ['weiter', e.href]].forEach(function (p) {
        var i = document.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; f.appendChild(i);
      });
      document.body.appendChild(f);
      f.submit();
      return;
    }
    window.location.href = e.href;
  }
  function zeichne(daten, anfrage) {
    liste.textContent = '';
    eintraege = [];
    function abschnitt(titel) { liste.appendChild(el('li', 'suche-abschnitt', titel)); }
    function zeile(e, hauptText, nebenText, symbol, zusatz) {
      var li = el('li', 'suche-eintrag' + (e.aus ? ' suche-aus' : ''));
      li.id = 'suche-opt-' + eintraege.length;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.appendChild(el('span', 'suche-symbol', symbol || '•'));
      var t = el('span', 'suche-text');
      t.appendChild(el('strong', null, hauptText));
      if (zusatz) t.appendChild(el('span', 'suche-marke', zusatz));
      if (nebenText) t.appendChild(el('small', 'hint', nebenText));
      li.appendChild(t);
      var idx = eintraege.length;
      li.addEventListener('mousedown', function (ev) { ev.preventDefault(); oeffne(eintraege[idx]); });
      eintraege.push(e);
      liste.appendChild(li);
    }
    if (daten.aktionen && daten.aktionen.length) {
      abschnitt(anfrage ? 'Seiten und Aktionen' : 'Häufig gebraucht');
      daten.aktionen.forEach(function (a) {
        zeile(a, a.titel, a.aus ? a.text + ' – ausgeschaltet: Enter schaltet sie ein und öffnet sie' : a.text, a.symbol, a.aus ? 'ausgeschaltet' : '');
      });
    }
    if (daten.hilfe && daten.hilfe.length) {
      abschnitt('Hilfe');
      daten.hilfe.forEach(function (h) { zeile({ href: h.href }, h.titel, h.kurz, '❓'); });
    }
    info.textContent = eintraege.length ? '' : (anfrage ? 'Nichts gefunden. Versuche ein anderes Wort, z. B. „Klausur“, „Zeugnis“ oder „Sitzplan“.' : '');
    markiere(0);
  }
  function lade() {
    var q = eingabe.value.trim();
    var nr = ++laufend;
    fetch('/suche?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { aktionen: [], hilfe: [] }; })
      .then(function (d) { if (nr === laufend) zeichne(d, q); })
      .catch(function () { if (nr === laufend) { liste.textContent = ''; info.textContent = 'Die Suche ist gerade nicht erreichbar.'; } });
  }
  function auf() {
    if (!dialog.open) dialog.showModal();
    eingabe.focus();
    eingabe.select();
    lade();
  }
  knopf.addEventListener('click', auf);
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var tippt = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); auf(); }
    else if (e.key === '/' && !tippt && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); auf(); }
  });
  eingabe.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(lade, 150); });
  eingabe.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); markiere(aktiv + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); markiere(aktiv - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (eintraege[aktiv]) oeffne(eintraege[aktiv]); }
  });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); }); // Klick auf den Hintergrund
  dialog.querySelector('.suche-zu').addEventListener('click', function () { dialog.close(); });
})();

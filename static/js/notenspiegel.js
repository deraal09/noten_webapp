/**
 * Notenspiegel und Klassendurchschnitt zu einer Klausur (Fachseite, Reiter „Klausuren“, Schalter „📈 Notenspiegel“).
 *
 * Gerechnet wird im Browser aus den Notenzellen der Tabelle (.k-note), die Anzeige aktualisiert sich also beim Eintragen von selbst.
 * Gezählt werden nur Personen mit Note. Der Notenspiegel zählt IHK-Noten gerundet auf ganze Noten 1–6 (2,5 → 3, wie bei „ganze Note“),
 * BG-Notenpunkte 0–15 einzeln. Der Durchschnitt wird aus den genauen Noten gebildet. Die Wahl (an/aus) gehört zum Konto und liegt auf
 * dem Server (POST /konto/einstellung, Schlüssel notenspiegel_an); der Browser-Speicher ist nur Rückfall.
 */
(function () {
  'use strict';

  /** Notenzeile aus Zellentext lesen: „2,5“ bzw. „2,5 ▲ 1,0“ → 2.5; „–“ → null. */
  function liesNote(text) {
    var m = /^\s*(\d+(?:[.,]\d+)?)/.exec(String(text || ''));
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }

  function median(sortiert) {
    var n = sortiert.length;
    if (!n) return null;
    return n % 2 ? sortiert[(n - 1) / 2] : (sortiert[n / 2 - 1] + sortiert[n / 2]) / 2;
  }

  /**
   * @param {number[]} noten  Noten der Klasse (ohne Lücken)
   * @param {'IHK'|'BG'} typ  IHK: 1–6 (kleiner = besser), BG: 0–15 Punkte (größer = besser)
   * @returns {{ n: number, durchschnitt: number|null, median: number|null, beste: number|null, schlechteste: number|null,
   *             spiegel: {note: number, anzahl: number}[] }}  Spiegel von der besten zur schlechtesten Stufe
   */
  function berechne(noten, typ) {
    var bg = typ === 'BG';
    var min = bg ? 0 : 1;
    var max = bg ? 15 : 6;
    var gueltig = noten.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    var spiegel = [];
    for (var s = bg ? max : min; bg ? s >= min : s <= max; s += bg ? -1 : 1) spiegel.push({ note: s, anzahl: 0 });
    gueltig.forEach(function (x) {
      var stufe = Math.min(max, Math.max(min, Math.round(x)));
      spiegel.forEach(function (z) { if (z.note === stufe) z.anzahl += 1; });
    });
    var sortiert = gueltig.slice().sort(function (a, b) { return a - b; });
    var summe = gueltig.reduce(function (a, b) { return a + b; }, 0);
    return {
      n: gueltig.length,
      durchschnitt: gueltig.length ? Math.round(summe / gueltig.length * 100) / 100 : null,
      median: median(sortiert),
      beste: gueltig.length ? (bg ? sortiert[sortiert.length - 1] : sortiert[0]) : null,
      schlechteste: gueltig.length ? (bg ? sortiert[0] : sortiert[sortiert.length - 1]) : null,
      spiegel: spiegel,
    };
  }

  var api = { berechne: berechne, liesNote: liesNote };
  if (typeof window !== 'undefined') window.notenspiegel = api;
  if (typeof document === 'undefined' || !document.querySelectorAll) return;

  var SPEICHER = 'notenspiegel-an';
  function gemerkt() { try { return window.localStorage.getItem(SPEICHER) === '1'; } catch (e) { return false; } }
  function merke(an) { try { window.localStorage.setItem(SPEICHER, an ? '1' : '0'); } catch (e) { /* nur für diese Seite */ } }
  function speichereAufServer(an) {
    try {
      fetch('/konto/einstellung', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'schluessel=notenspiegel_an&wert=' + (an ? '1' : '0'), credentials: 'same-origin', keepalive: true });
    } catch (e) { /* bleibt im Browser-Speicher */ }
  }
  function dez(x, stellen) {
    if (x === null || x === undefined) return '–';
    var f = Math.pow(10, stellen);
    return (Math.round(x * f) / f).toFixed(stellen).replace('.', ',');
  }
  function el(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function zeichne(panel) {
    var kid = panel.dataset.klausur;
    var typ = panel.dataset.ns === 'BG' ? 'BG' : 'IHK';
    var zellen = document.querySelectorAll('td.k-note[data-kid="' + kid + '"]');
    var noten = [];
    Array.prototype.forEach.call(zellen, function (z) { var x = liesNote(z.textContent); if (x !== null) noten.push(x); });
    var e = berechne(noten, typ);
    var ziel = panel.querySelector('.notenspiegel-inhalt');
    ziel.textContent = '';
    if (!e.n) { ziel.appendChild(el('p', 'hint', 'Noch keine Noten – sobald Punkte eingetragen sind, erscheint hier der Notenspiegel.')); return; }
    var einheit = typ === 'BG' ? ' Punkte' : '';
    var stellen = 2;
    var kopf = el('p', 'notenspiegel-kopf');
    var ds = el('strong', null, 'Klassendurchschnitt: ' + dez(e.durchschnitt, stellen) + einheit);
    kopf.appendChild(ds);
    kopf.appendChild(document.createTextNode(' · Median ' + dez(e.median, typ === 'BG' ? 1 : 2) + ' · beste ' + dez(e.beste, typ === 'BG' ? 0 : 1)
      + ' · schlechteste ' + dez(e.schlechteste, typ === 'BG' ? 0 : 1) + ' · ' + e.n + (e.n === 1 ? ' Person' : ' Personen')));
    ziel.appendChild(kopf);
    var hoechst = e.spiegel.reduce(function (m, z) { return Math.max(m, z.anzahl); }, 0);
    var chart = el('div', 'notenspiegel-saeulen');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', 'Notenspiegel: ' + e.spiegel.map(function (z) { return z.anzahl + '× ' + (typ === 'BG' ? z.note + ' Punkte' : 'Note ' + z.note); }).join(', '));
    e.spiegel.forEach(function (z) {
      var spalte = el('div', 'notenspiegel-spalte' + (z.anzahl ? '' : ' leer'));
      spalte.appendChild(el('span', 'notenspiegel-anzahl', String(z.anzahl)));
      var balkenBox = el('span', 'notenspiegel-balkenbox');
      var balken = el('span', 'notenspiegel-balken');
      balken.style.height = (hoechst ? Math.round(z.anzahl / hoechst * 100) : 0) + '%';
      balkenBox.appendChild(balken);
      spalte.appendChild(balkenBox);
      spalte.appendChild(el('span', 'notenspiegel-note', String(z.note)));
      chart.appendChild(spalte);
    });
    ziel.appendChild(chart);
    ziel.appendChild(el('p', 'hint notenspiegel-hinweis', typ === 'BG'
      ? 'Anzahl der Personen je Notenpunkt (15 = beste, 0 = schlechteste Stufe).'
      : 'Anzahl der Personen je ganzer Note (auf ganze Noten gerundet; der Durchschnitt nutzt die genauen Noten).'));
  }

  function start() {
    var panels = document.querySelectorAll('[data-notenspiegel]');
    if (!panels.length) return;
    var schalter = document.querySelectorAll('input[data-notenspiegel-schalter]');
    var serverWert = panels[0].dataset.an;
    var an = serverWert === '1' || serverWert === '0' ? serverWert === '1' : gemerkt();
    if (serverWert !== '1' && serverWert !== '0' && an) speichereAufServer(true);
    var timer = null;
    function anwenden() {
      Array.prototype.forEach.call(schalter, function (s) { s.checked = an; });
      Array.prototype.forEach.call(panels, function (p) { p.hidden = !an; if (an) zeichne(p); });
    }
    function spaeter() {
      if (!an) return;
      clearTimeout(timer);
      timer = setTimeout(function () { Array.prototype.forEach.call(panels, zeichne); }, 200);
    }
    Array.prototype.forEach.call(schalter, function (s) {
      s.addEventListener('change', function () { an = s.checked; merke(an); speichereAufServer(an); anwenden(); });
    });
    // Die Notenzellen werden nach jeder Eingabe von der Seite neu beschriftet: darauf reagieren.
    if (window.MutationObserver) {
      var beobachter = new MutationObserver(spaeter);
      Array.prototype.forEach.call(document.querySelectorAll('td.k-note'), function (z) {
        beobachter.observe(z, { childList: true, characterData: true, subtree: true });
      });
    }
    window.addEventListener('pageshow', function (ev) { if (ev.persisted) anwenden(); });
    anwenden();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

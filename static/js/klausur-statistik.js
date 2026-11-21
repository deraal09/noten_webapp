/**
 * Aufgabenstatistik zu einer Klausur (Fachseite, Reiter „Klausuren“): zeigt je Aufgabe, wie schwer sie für die Klasse war
 * (Lösungsgrad = Ø Punkte / Höchstpunkte) und wie gut sie zwischen stärkeren und schwächeren Leistungen unterscheidet
 * (Trennschärfe = Korrelation der Aufgabe mit der Summe der übrigen Aufgaben, „Item-Rest-Korrelation“).
 *
 * Gerechnet wird im Browser aus den Eingabefeldern der Tabelle, die Anzeige aktualisiert sich also beim Eintragen von selbst.
 * Die Statistik ist ausgeschaltet, bis man sie über den Schalter „📊 Statistik“ aktiviert (die Wahl wird im Browser gemerkt).
 * Leere Felder zählen wie in der Punktesumme als 0; berücksichtigt werden nur Personen mit mindestens einem eingetragenen Wert.
 * Die Richtwerte sind Orientierung, kein Urteil über die Aufgabe (siehe CHANGELOG 0.144.0).
 */
(function () {
  'use strict';

  var RICHTWERTE = {
    zuSchwer: 0.30,        // Lösungsgrad unter 30 %: sehr schwer
    zuLeicht: 0.85,        // Lösungsgrad ab 85 %: sehr leicht
    trennschaerfeGut: 0.30,
    trennschaerfeGrenzwertig: 0.20,
    minPersonenTrennschaerfe: 10, // darunter wird keine Trennschärfe gezeigt
    kleineGruppe: 30,      // darunter: Hinweis „nur Orientierung“
  };

  function zahl(wert) {
    if (wert === null || wert === undefined || wert === '') return null;
    var z = Number(String(wert).replace(',', '.'));
    return isFinite(z) ? z : null;
  }
  function mittel(liste) {
    if (!liste.length) return null;
    var s = 0;
    for (var i = 0; i < liste.length; i++) s += liste[i];
    return s / liste.length;
  }
  function median(liste) {
    if (!liste.length) return null;
    var s = liste.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  /** Pearson-Korrelation; null, wenn eine der Reihen keine Streuung hat oder zu kurz ist. */
  function korrelation(x, y) {
    var n = x.length;
    if (n < 3 || y.length !== n) return null;
    var mx = mittel(x), my = mittel(y), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) * (x[i] - mx);
      syy += (y[i] - my) * (y[i] - my);
    }
    if (sxx < 1e-12 || syy < 1e-12) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  /**
   * @param {{max:number[], werte:(number|null)[][], ausgeschlossen?:number[]}} eingabe
   *   max: Höchstpunkte je Aufgabe; werte: je Person eine Zeile mit den Punkten je Aufgabe (null = leer);
   *   ausgeschlossen: Aufgaben-Indizes, die nicht ausgewertet werden (z. B. Noten statt Punkte).
   */
  function berechne(eingabe) {
    var max = eingabe.max || [];
    var skip = {};
    (eingabe.ausgeschlossen || []).forEach(function (i) { skip[i] = true; });
    var personen = (eingabe.werte || []).filter(function (zeile) {
      return zeile.some(function (w) { return w !== null && w !== undefined; });
    });
    var n = personen.length;
    var idx = [];
    for (var i = 0; i < max.length; i++) if (!skip[i] && max[i] > 0) idx.push(i);
    // Punkte je Person (leer = 0) und Summe über die ausgewerteten Aufgaben
    var punkte = personen.map(function (zeile) { return idx.map(function (i) { return zeile[i] === null || zeile[i] === undefined ? 0 : zeile[i]; }); });
    var summen = punkte.map(function (z) { return z.reduce(function (a, b) { return a + b; }, 0); });
    var maxSumme = idx.reduce(function (a, i) { return a + max[i]; }, 0);
    var gesamtMittel = mittel(summen);
    var gesamtGrad = n && maxSumme > 0 ? gesamtMittel / maxSumme : null;
    var aufgaben = idx.map(function (i, pos) {
      var werte = punkte.map(function (z) { return z[pos]; });
      var m = mittel(werte);
      var grad = n ? m / max[i] : null;
      var rest = summen.map(function (s, k) { return s - werte[k]; });
      var r = n >= RICHTWERTE.minPersonenTrennschaerfe && idx.length > 1 ? korrelation(werte, rest) : null;
      return {
        index: i,
        max: max[i],
        mittel: m,
        grad: grad,
        volle: n ? werte.filter(function (w) { return w >= max[i]; }).length / n : null,
        nullen: n ? werte.filter(function (w) { return w <= 0; }).length / n : null,
        abweichung: grad !== null && gesamtGrad !== null ? grad - gesamtGrad : null,
        trennschaerfe: r,
        schwierigkeit: grad === null ? null : (grad < RICHTWERTE.zuSchwer ? 'zu-schwer' : (grad >= RICHTWERTE.zuLeicht ? 'zu-leicht' : 'ausgewogen')),
        trennschaerfeStufe: r === null ? null : (r < 0 ? 'negativ' : (r < RICHTWERTE.trennschaerfeGrenzwertig ? 'schwach' : (r < RICHTWERTE.trennschaerfeGut ? 'grenzwertig' : 'gut'))),
      };
    });
    return {
      n: n,
      maxSumme: maxSumme,
      mittel: gesamtMittel,
      median: median(summen),
      grad: gesamtGrad,
      aufgaben: aufgaben,
      kleineGruppe: n < RICHTWERTE.kleineGruppe,
      trennschaerfeMoeglich: n >= RICHTWERTE.minPersonenTrennschaerfe,
    };
  }

  window.klausurStatistik = { berechne: berechne, korrelation: korrelation, median: median, RICHTWERTE: RICHTWERTE };

  // ---------- Anzeige (nur im Browser, auf der Fachseite) ----------
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  var SPEICHER = 'klausur-statistik-an';

  function gemerkt() { try { return window.localStorage.getItem(SPEICHER) === '1'; } catch (e) { return false; } }
  function merke(an) { try { window.localStorage.setItem(SPEICHER, an ? '1' : '0'); } catch (e) { /* ohne Speicher: nur für diese Seite */ } }
  function prozent(x) { return x === null ? '–' : Math.round(x * 100) + ' %'; }
  function dez(x) { return x === null ? '–' : (Math.round(x * 10) / 10).toString().replace('.', ','); }
  function el(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function lies(panel) {
    var kid = panel.dataset.klausur;
    var felder = document.querySelectorAll('input.punkt[data-kind="k"][data-kid="' + kid + '"]');
    var maxe = [], zeilen = {}, reihenfolge = [];
    Array.prototype.forEach.call(felder, function (f) {
      var i = parseInt(f.dataset.idx, 10);
      var m = zahl(f.getAttribute('max'));
      if (m !== null) maxe[i] = m;
      var sid = f.dataset.sid;
      if (!zeilen[sid]) { zeilen[sid] = []; reihenfolge.push(sid); }
      zeilen[sid][i] = zahl(f.value);
    });
    var ausgeschlossen = [];
    try { ausgeschlossen = JSON.parse(panel.dataset.ausschluss || '[]'); } catch (e) { /* keine */ }
    var labels = [];
    try { labels = JSON.parse(panel.dataset.labels || '[]'); } catch (e) { /* keine */ }
    var werte = reihenfolge.map(function (sid) {
      var z = zeilen[sid];
      var out = [];
      for (var i = 0; i < maxe.length; i++) out.push(z[i] === undefined ? null : z[i]);
      return out;
    });
    return { max: maxe.map(function (m) { return m === undefined ? 0 : m; }), werte: werte, ausgeschlossen: ausgeschlossen, labels: labels, sids: reihenfolge, kid: kid };
  }

  var SCHWIERIGKEIT = { 'zu-schwer': 'zu schwer', ausgewogen: 'ausgewogen', 'zu-leicht': 'zu leicht' };
  var STUFE = { negativ: '⚠ negativ', schwach: 'schwach', grenzwertig: 'grenzwertig', gut: 'gut' };

  function zeichne(panel) {
    var ziel = panel.querySelector('.statistik-inhalt');
    if (!ziel) return;
    var daten = lies(panel);
    var e = berechne(daten);
    ziel.textContent = '';
    if (!e.n) { ziel.appendChild(el('p', 'hint', 'Noch keine Punkte eingetragen.')); return; }
    ziel.appendChild(el('p', 'statistik-kopf', e.n + (e.n === 1 ? ' Person' : ' Personen') + ' · Ø ' + dez(e.mittel) + ' von ' + dez(e.maxSumme) + ' Punkten (' + prozent(e.grad) + ') · Median ' + dez(e.median)));

    var tabelle = el('table', 'data statistik-tabelle');
    var kopf = el('tr');
    ['Aufgabe', 'Ø Punkte', 'Lösungsgrad', 'Einschätzung', 'volle Punktzahl', '0 Punkte', 'Trennschärfe'].forEach(function (t) { kopf.appendChild(el('th', null, t)); });
    var thead = el('thead'); thead.appendChild(kopf); tabelle.appendChild(thead);
    var tbody = el('tbody');
    e.aufgaben.forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', null, daten.labels[a.index] || ('A' + (a.index + 1))));
      tr.appendChild(el('td', null, dez(a.mittel) + ' / ' + dez(a.max)));
      var grad = el('td', 'statistik-grad');
      var balken = el('span', 'statistik-balken'); var fuell = el('span', 'statistik-fuell ' + a.schwierigkeit);
      fuell.style.width = Math.max(0, Math.min(100, a.grad * 100)) + '%';
      balken.appendChild(fuell); grad.appendChild(balken); grad.appendChild(document.createTextNode(' ' + prozent(a.grad)));
      var abw = a.abweichung === null ? '' : ' (' + (a.abweichung >= 0 ? '+' : '−') + Math.abs(Math.round(a.abweichung * 100)) + ' zum Schnitt)';
      grad.title = 'Lösungsgrad = Ø Punkte / Höchstpunkte' + abw;
      tr.appendChild(grad);
      tr.appendChild(el('td', null, '')).appendChild(el('span', 'statistik-marke ' + a.schwierigkeit, SCHWIERIGKEIT[a.schwierigkeit]));
      tr.appendChild(el('td', null, prozent(a.volle)));
      tr.appendChild(el('td', null, prozent(a.nullen)));
      var ts = el('td');
      if (a.trennschaerfe === null) { ts.textContent = '–'; ts.title = e.trennschaerfeMoeglich ? 'Nicht berechenbar (alle erreichen gleich viele Punkte).' : 'Erst ab ' + RICHTWERTE.minPersonenTrennschaerfe + ' Personen.'; }
      else {
        ts.appendChild(document.createTextNode(a.trennschaerfe.toFixed(2).replace('.', ',').replace('-', '−') + ' '));
        ts.appendChild(el('span', 'statistik-marke t-' + a.trennschaerfeStufe, STUFE[a.trennschaerfeStufe]));
      }
      tr.appendChild(ts);
      tbody.appendChild(tr);
    });
    tabelle.appendChild(tbody);
    var huelle = el('div', 'tabelle-scroll'); huelle.appendChild(tabelle); ziel.appendChild(huelle);

    var hinweis = 'Lösungsgrad: unter ' + Math.round(RICHTWERTE.zuSchwer * 100) + ' % „zu schwer“, ab ' + Math.round(RICHTWERTE.zuLeicht * 100) + ' % „zu leicht“. '
      + 'Trennschärfe: wie gut die Aufgabe starke von schwächeren Leistungen unterscheidet (ab 0,3 gut, unter 0 auffällig – dann Aufgabenstellung oder Bewertung prüfen). '
      + 'Leere Felder zählen als 0 Punkte.';
    if (e.kleineGruppe) hinweis += ' Bei so wenigen Personen (' + e.n + ') ist das nur eine Orientierung, kein Urteil über die Aufgabe.';
    if (!e.trennschaerfeMoeglich) hinweis += ' Die Trennschärfe gibt es erst ab ' + RICHTWERTE.minPersonenTrennschaerfe + ' Personen.';
    ziel.appendChild(el('p', 'hint statistik-hinweis', hinweis));
  }

  function start() {
    var panels = document.querySelectorAll('[data-klausur-statistik]');
    if (!panels.length) return;
    var schalter = document.querySelectorAll('input[data-statistik-schalter]');
    var an = gemerkt();
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
      s.addEventListener('change', function () { an = s.checked; merke(an); anwenden(); });
    });
    document.addEventListener('input', function (ev) { if (ev.target && ev.target.classList && ev.target.classList.contains('punkt')) spaeter(); });
    document.addEventListener('change', function (ev) { if (ev.target && ev.target.classList && ev.target.classList.contains('punkt')) spaeter(); });
    anwenden();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

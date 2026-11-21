/**
 * Rechnen in den Punktefeldern (Klausur, Zusatzleistung, Extrapunkte): statt einer Zahl darf man eine Rechnung eintippen,
 * z. B. „2+1,5+3“ oder „(4+2)/2“ -- beim Verlassen des Feldes (oder mit Enter/Pfeiltasten) wird sie ausgerechnet, das Feld zeigt
 * die Summe, und die Summe wird als Punktzahl der Aufgabe gespeichert. Erlaubt sind Zahlen (Komma oder Punkt), + − * / × · ÷ :
 * und Klammern; es wird NICHT mit eval gerechnet, sondern mit einem kleinen eigenen Parser. Die Rechnung selbst wird nicht
 * gespeichert (nur das Ergebnis), steht aber bis zum Neuladen als Hinweis am Feld.
 */
(function () {
  'use strict';

  /** Text -> Zahl (Komma oder Punkt) oder null. */
  function rechne(text) {
    var roh = String(text == null ? '' : text);
    if (/[0-9.,]\s+[0-9.,]/.test(roh)) return null; // „2 3“ ist vermutlich ein Tippfehler, nicht 23
    var s = roh.replace(/\s+/g, '');
    if (s === '') return null;
    s = s.replace(/,/g, '.').replace(/[×·x*]/g, '*').replace(/[÷:\/]/g, '/').replace(/[−–—]/g, '-');
    if (!/^[0-9.+\-*\/()]+$/.test(s)) return null;
    var pos = 0;
    var fehler = false;
    function peek() { return s.charAt(pos); }
    function zahl() {
      var m = /^(\d+(\.\d*)?|\.\d+)/.exec(s.slice(pos));
      if (!m) { fehler = true; return 0; }
      pos += m[0].length;
      return parseFloat(m[0]);
    }
    function primaer() {
      if (peek() === '(') {
        pos++;
        var w = ausdruck();
        if (peek() !== ')') { fehler = true; return 0; }
        pos++;
        return w;
      }
      return zahl();
    }
    function unaer() {
      if (peek() === '-') { pos++; return -unaer(); }
      if (peek() === '+') { pos++; return unaer(); }
      return primaer();
    }
    function term() {
      var w = unaer();
      while (!fehler && (peek() === '*' || peek() === '/')) {
        var op = s.charAt(pos++);
        var r = unaer();
        if (op === '*') w *= r;
        else if (r === 0) { fehler = true; return 0; }
        else w /= r;
      }
      return w;
    }
    function ausdruck() {
      var w = term();
      while (!fehler && (peek() === '+' || peek() === '-')) {
        var op = s.charAt(pos++);
        var r = term();
        w = op === '+' ? w + r : w - r;
      }
      return w;
    }
    var ergebnis = ausdruck();
    if (fehler || pos !== s.length || !isFinite(ergebnis)) return null;
    return Math.round(ergebnis * 100) / 100; // Gleitkomma-Rauschen (0,1+0,2) und Zehntelstellen glätten
  }

  /** Ist es eine Rechnung (und nicht nur eine Zahl, auch mit Vorzeichen oder Komma)? */
  function istRechnung(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, '');
    return /[+*\/×·÷:()x]/.test(s) || /[0-9.,]-/.test(s) || /[−–—]/.test(s.replace(/^[−–—]/, ''));
  }

  /** Zahl -> Anzeige mit Komma, ohne überflüssige Nullen. */
  function formatiere(zahl) {
    return zahl === null || zahl === undefined || isNaN(zahl) ? '' : String(zahl).replace('.', ',');
  }

  window.punkteRechnen = { rechne: rechne, istRechnung: istRechnung, formatiere: formatiere };
})();

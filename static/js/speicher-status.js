/**
 * Rückmeldung beim (Auto-)Speichern: Alle Speicher-Anfragen der Seite (fetch mit POST/PUT/PATCH/DELETE an dieselbe Adresse, z. B. Punkte,
 * Endnoten, Notizen, Sitzplan) zeigen oben eine kleine Meldung: „Speichert …“, „Gespeichert ✓“ oder „⚠ Nicht gespeichert …“.
 * Fehler bleiben stehen, bis das nächste Speichern klappt; offline wird sofort gewarnt.
 */
(function () {
  'use strict';
  if (!window.fetch || window.speicherStatus) return;
  var original = window.fetch.bind(window);
  var offen = 0;
  var badge = null;
  var ausblenden = null;

  function element() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'speicher-status';
    badge.className = 'speicher-status';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.hidden = true;
    document.body.appendChild(badge);
    return badge;
  }
  function zeige(typ, text, dauer) {
    var b = element();
    clearTimeout(ausblenden);
    b.className = 'speicher-status speicher-' + typ;
    b.textContent = text;
    b.hidden = false;
    if (dauer) ausblenden = setTimeout(function () { if (typ === 'ok') b.hidden = true; }, dauer);
  }
  function uhrzeit() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function gleicheHerkunft(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }

  window.fetch = function (eingabe, optionen) {
    var methode = String((optionen && optionen.method) || (eingabe && eingabe.method) || 'GET').toUpperCase();
    var url = typeof eingabe === 'string' ? eingabe : (eingabe && eingabe.url) || '';
    if (methode === 'GET' || methode === 'HEAD' || methode === 'OPTIONS' || !gleicheHerkunft(url) || /\/suche(\?|$)/.test(url)) return original(eingabe, optionen);
    offen += 1;
    zeige('lade', 'Speichert …');
    return original(eingabe, optionen).then(function (antwort) {
      offen -= 1;
      var gut = antwort.ok;
      var meldung = '';
      if (gut && /json/.test(antwort.headers.get('content-type') || '')) {
        // Manche Adressen antworten 200 mit { ok: false, fehler: "…" }: auch das ist „nicht gespeichert“.
        return antwort.clone().json().then(function (d) {
          if (d && d.ok === false) { gut = false; meldung = d.fehler || d.error || d.message || ''; }
          fertig(gut, antwort.status, meldung);
          return antwort;
        }, function () { fertig(gut, antwort.status, ''); return antwort; });
      }
      fertig(gut, antwort.status, meldung);
      return antwort;
    }, function (fehler) {
      offen -= 1;
      zeige('fehler', '⚠ Nicht gespeichert – keine Verbindung. Bitte erneut versuchen.');
      throw fehler;
    });
  };

  function fertig(gut, status, meldung) {
    if (offen > 0) return; // weitere Anfragen laufen noch: erst danach das Ergebnis zeigen
    if (gut) zeige('ok', 'Gespeichert ✓ ' + uhrzeit(), 2500);
    else zeige('fehler', '⚠ Nicht gespeichert' + (meldung ? ': ' + meldung : status ? ' (Fehler ' + status + ')' : '') + '. Bitte prüfen und erneut versuchen.');
  }

  window.addEventListener('offline', function () { zeige('fehler', '⚠ Offline – Änderungen werden nicht gespeichert.'); });
  window.addEventListener('online', function () { zeige('ok', 'Wieder online ✓', 2500); });
  window.speicherStatus = { zeige: zeige };
})();

/**
 * Gemeinsames Verhalten für Menüs hinter den drei Balken (☰) und für Reiter-Leisten:
 *  - Menü (<details class="kopf-menue">) schließt per Klick daneben und Escape.
 *  - Einträge mit data-zeige="<id>" blenden einen verborgenen Bereich ein (data-menue-abschnitt), springen hin und setzen den Cursor;
 *    liegt der Bereich in einem Reiter (.reiter-panel), wird dieser Reiter erst aktiviert. data-merken hält den Bereich nach einem
 *    Neuladen offen, data-verberge="<id>" blendet ihn wieder aus.
 *  - Einträge mit data-klick-auf="<id>" lösen eine vorhandene (ggf. versteckte) Schaltfläche der Seite aus.
 *  - Eine Adresse mit #<id> aktiviert den Reiter, in dem das Ziel liegt.
 *  - Reiter-Leisten und Halbjahr-Tabs (.hj-tabs, .reiter-leiste) scrollen den aktiven Eintrag ins Sichtfeld.
 */
(function () {
  'use strict';

  function menues() { return document.querySelectorAll('.kopf-menue'); }
  document.addEventListener('click', function (e) {
    menues().forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menues().forEach(function (m) { if (m.open) { m.open = false; var s = m.querySelector('summary'); if (s) s.focus(); } });
  });

  function merke(el, offen) {
    var key = el.getAttribute('data-merken');
    if (!key) return;
    try { if (offen) sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch (e) { /* ohne Speicher egal */ }
  }

  /** Aktiviert die Reiter, in denen das Element liegt (von innen nach außen). */
  function aktiviereReiter(el) {
    var panel = el.closest('.reiter-panel');
    while (panel) {
      if (!panel.classList.contains('active') && panel.id) {
        var knopf = document.querySelector('.reiter > button[data-target="' + panel.id + '"]');
        if (knopf) knopf.click();
      }
      panel = panel.parentElement ? panel.parentElement.closest('.reiter-panel') : null;
    }
  }

  window.zeigeAbschnitt = function (id, springen) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    if (el.tagName === 'DETAILS') el.open = true;
    aktiviereReiter(el);
    merke(el, true);
    if (springen !== false) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var feld = el.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
      if (feld) setTimeout(function () { feld.focus({ preventScroll: true }); }, 250);
    }
  };

  function start() {
    document.querySelectorAll('[data-zeige]').forEach(function (knopf) {
      knopf.addEventListener('click', function () {
        var menue = knopf.closest('.kopf-menue');
        if (menue) menue.open = false;
        window.zeigeAbschnitt(knopf.getAttribute('data-zeige'));
      });
    });
    // Menü-Einträge, die eine vorhandene Schaltfläche der Seite auslösen (data-klick-auf="<id>")
    document.querySelectorAll('[data-klick-auf]').forEach(function (knopf) {
      knopf.addEventListener('click', function () {
        var menue = knopf.closest('.kopf-menue');
        if (menue) menue.open = false;
        var ziel = document.getElementById(knopf.getAttribute('data-klick-auf'));
        if (ziel) ziel.click();
      });
    });
    document.querySelectorAll('[data-verberge]').forEach(function (knopf) {
      knopf.addEventListener('click', function () {
        var el = document.getElementById(knopf.getAttribute('data-verberge'));
        if (el) { el.hidden = true; merke(el, false); }
      });
    });
    // Nach einem Absenden (Seite lädt neu) bleibt ein zuvor geöffneter Bereich offen; auch per Adresse (#…) erreichbar.
    var hash = location.hash ? location.hash.slice(1) : '';
    document.querySelectorAll('[data-menue-abschnitt]').forEach(function (el) {
      var key = el.getAttribute('data-merken'), offen = false;
      try { offen = Boolean(key && sessionStorage.getItem(key)); } catch (e) { /* egal */ }
      var perHash = hash && hash === el.id;
      if (offen || perHash) window.zeigeAbschnitt(el.id, Boolean(perHash));
    });
    if (hash) {
      var ziel = document.getElementById(hash);
      if (ziel && !ziel.hasAttribute('data-menue-abschnitt')) {
        aktiviereReiter(ziel);
        setTimeout(function () { ziel.scrollIntoView({ block: 'start' }); }, 0);
      }
    }
    // Aktiven Eintrag in scrollbaren Leisten sichtbar machen
    document.querySelectorAll('.hj-tabs, .reiter-leiste').forEach(function (leiste) {
      var aktiv = leiste.querySelector('.active');
      if (aktiv && leiste.scrollWidth > leiste.clientWidth) leiste.scrollLeft = Math.max(0, aktiv.offsetLeft - (leiste.clientWidth - aktiv.offsetWidth) / 2);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

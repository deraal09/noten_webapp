/**
 * Eigener Bestätigungsdialog statt des Browser-Fensters: Formulare (und Knöpfe) mit onsubmit="return confirm('…')" bzw.
 * onclick="return confirm('…')" fragen jetzt in einem Dialog nach – mit dem Text der Frage, einem klaren Knopf („Löschen“, „Entfernen“ …)
 * und „Abbrechen“ als Vorauswahl (Enter bricht ab). Ohne <dialog>-Unterstützung bleibt das normale Verhalten.
 */
(function () {
  'use strict';
  var test = document.createElement('dialog');
  if (typeof test.showModal !== 'function') return;

  var dialog = null;
  function baue() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'bestaetig-dialog';
    dialog.setAttribute('aria-labelledby', 'bestaetig-titel');
    dialog.innerHTML = '<form method="dialog"><h2 id="bestaetig-titel">Bist du sicher?</h2><p class="bestaetig-text"></p>'
      + '<div class="form-actions"><button type="submit" value="nein" class="bestaetig-nein" autofocus>Abbrechen</button>'
      + '<button type="submit" value="ja" class="bestaetig-ja"></button></div></form>';
    document.body.appendChild(dialog);
    return dialog;
  }

  /** Frage stellen; liefert ein Versprechen mit true (bestätigt) oder false. */
  function frage(text, gefaehrlich, ausloeser) {
    var d = baue();
    d.querySelector('.bestaetig-text').textContent = text;
    var ja = d.querySelector('.bestaetig-ja');
    ja.textContent = /lösch/i.test(text) ? 'Löschen' : /entfern/i.test(text) ? 'Entfernen' : /abschalt/i.test(text) ? 'Abschalten' : /widerruf/i.test(text) ? 'Widerrufen' : 'Bestätigen';
    ja.className = 'bestaetig-ja' + (gefaehrlich || /lösch|entfern|abschalt|widerruf|unwiderruf/i.test(text) ? ' danger' : '');
    return new Promise(function (aufloesen) {
      function fertig() {
        d.removeEventListener('close', fertig);
        aufloesen(d.returnValue === 'ja');
        if (ausloeser && ausloeser.focus && d.returnValue !== 'ja') { try { ausloeser.focus(); } catch (e) { /* egal */ } }
      }
      d.returnValue = 'nein';
      d.addEventListener('close', fertig);
      d.showModal();
      d.querySelector('.bestaetig-nein').focus();
    });
  }

  /** Ruft den Inline-Handler auf, fängt aber nur die Frage ab (confirm wird kurz ersetzt). Liefert den Fragetext oder null. */
  function fangeFrage(handler, ziel, ereignis) {
    if (typeof handler !== 'function') return null;
    var text = null;
    var original = window.confirm;
    window.confirm = function (t) { text = String(t); return false; };
    try { handler.call(ziel, ereignis); } catch (e) { text = null; } finally { window.confirm = original; }
    return text;
  }
  function mitJa(fn) {
    var original = window.confirm;
    window.confirm = function () { return true; };
    try { fn(); } finally { window.confirm = original; }
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM' || form.dataset.bestaetigt || !/confirm\(/.test(form.getAttribute('onsubmit') || '')) return;
    var text = fangeFrage(form.onsubmit, form, e);
    if (text === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var ausloeser = e.submitter || null;
    frage(text, ausloeser && ausloeser.classList.contains('danger'), ausloeser).then(function (ja) {
      if (!ja) return;
      form.dataset.bestaetigt = '1';
      mitJa(function () { if (form.requestSubmit) form.requestSubmit(ausloeser || undefined); else form.submit(); });
      delete form.dataset.bestaetigt;
    });
  }, true);

  document.addEventListener('click', function (e) {
    var knopf = e.target && e.target.closest ? e.target.closest('[onclick*="confirm("]') : null;
    if (!knopf || knopf.dataset.bestaetigt) return;
    var text = fangeFrage(knopf.onclick, knopf, e);
    if (text === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    frage(text, knopf.classList.contains('danger'), knopf).then(function (ja) {
      if (!ja) return;
      knopf.dataset.bestaetigt = '1';
      mitJa(function () { knopf.click(); });
      delete knopf.dataset.bestaetigt;
    });
  }, true);

  window.bestaetigen = frage;
})();

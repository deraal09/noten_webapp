/**
 * Weiterleitungsziele aus Formularen oder der Adresse (z. B. ?next=, weiter=) -- nur Pfade dieser Anwendung.
 *
 * Ein Ziel wie "/\evil.example" sieht wie ein Pfad aus, Browser machen daraus aber "//evil.example" und landen auf
 * einer fremden Seite (Open Redirect, z. B. für Phishing nach dem Login). Ebenso entfernen Browser Tabs und
 * Zeilenumbrüche aus Adressen ("/\t/evil.example"). Deshalb: muss mit genau einem "/" beginnen, kein Backslash, keine
 * Steuerzeichen.
 */
export function sicheresZiel(roh, standard = '/') {
  const ziel = String(roh ?? '');
  if (!ziel.startsWith('/') || ziel.startsWith('//')) return standard;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(ziel)) return standard;
  return ziel;
}

/**
 * Zufällige Namen aus dem Star-Trek-Universum als Etikett für Einladungen ohne eingegebenen Anzeigenamen: Personen, Raumschiffe,
 * Stationen, Waffen, Orte, Völker, Technik und mehr. Das Etikett dient nur dazu, eine Einladung beim Verschicken wiederzufinden;
 * es wird nie als Anrede oder als Name des neuen Kontos verwendet (siehe invitations.name_generiert).
 */

export const STARTREK_NAMEN = [
  // Personen
  'Jean-Luc Picard', 'James T. Kirk', 'Spock', 'Leonard McCoy', 'Montgomery Scott', 'Nyota Uhura', 'Hikaru Sulu', 'Pavel Chekov',
  'Christopher Pike', 'Benjamin Sisko', 'Kathryn Janeway', 'Jonathan Archer', 'Michael Burnham', 'William Riker', 'Data', 'Geordi La Forge',
  'Worf', 'Beverly Crusher', 'Deanna Troi', 'Wesley Crusher', 'Tasha Yar', 'Guinan', 'Miles O’Brien', 'Kira Nerys', 'Odo', 'Jadzia Dax',
  'Julian Bashir', 'Quark', 'Jake Sisko', 'Chakotay', 'Tuvok', 'Tom Paris', 'B’Elanna Torres', 'Harry Kim', 'Neelix', 'Kes', 'Seven of Nine',
  'T’Pol', 'Trip Tucker', 'Malcolm Reed', 'Hoshi Sato', 'Phlox', 'Saru', 'Paul Stamets', 'Hugh Culber', 'Sylvia Tilly', 'Philippa Georgiou',
  'Gabriel Lorca', 'Una Chin-Riley', 'Christine Chapel', 'Janice Rand', 'Sarek', 'Amanda Grayson', 'Khan Noonien Singh', 'Gowron', 'Martok',
  'Weyoun', 'Gul Dukat', 'Garak', 'Rom', 'Nog', 'Ezri Dax', 'Elim Garak', 'Q', 'Lwaxana Troi', 'Lore', 'Icheb', 'Naomi Wildman',
  'Lal', 'Alynna Nechayev', 'Ro Laren', 'Reginald Barclay', 'Katherine Pulaski', 'Natasha Yar', 'Thy’lek Shran', 'Soval', 'Leland', 'Zefram Cochrane',
  'Lursa', 'Be’Tor', 'Kor', 'Kang', 'Koloth', 'Duras', 'Kahless', 'Dal R’El', 'Gaila', 'Rhys', 'Adira', 'Book', 'Ni’Var',
  // Raumschiffe
  'USS Enterprise', 'USS Voyager', 'USS Defiant', 'USS Discovery', 'USS Cerritos', 'USS Titan', 'USS Reliant', 'USS Excelsior', 'USS Prometheus',
  'USS Stargazer', 'USS Equinox', 'USS Protostar', 'USS Franklin', 'USS Yamato', 'USS Pasteur', 'USS Rio Grande', 'USS Grissom', 'USS Bozeman',
  'USS Lakota', 'USS Sao Paulo', 'USS Saratoga', 'USS Shenzhou', 'USS Hood', 'USS Intrepid', 'USS Constellation', 'USS Valiant', 'USS Odyssey', 'USS Bonaventure',
  'IKS Bounty', 'IKS Rotarran', 'IKS Pagh', 'IKS Negh’Var', 'Klingonischer Bird-of-Prey', 'Romulanischer Warbird', 'Borg-Kubus', 'Borg-Sphäre',
  'Scimitar', 'Dominion-Jäger', 'Jem’Hadar-Kampfschiff', 'Cardassianische Galor-Klasse', 'Delta Flyer', 'Runabout Rio Grande', 'Runabout Orinoco',
  'Phoenix', 'Shuttle Galileo', 'Shuttle Columbus', 'SS Botany Bay', 'Narada', 'Kelvin',
  'ISS Charon', 'Hirogen-Jagdschiff', 'Spezies-8472-Bioschiff', 'Xindi-Aquatiker', 'Suliban-Zellschiff',
  // Stationen & Orte
  'Deep Space Nine', 'Raumstation Terok Nor', 'Spacedock', 'Starbase 1', 'Starbase 74', 'Utopia Planitia', 'Sternenflottenakademie', 'Memory Alpha',
  'Erde', 'Vulkan', 'Qo’noS', 'Romulus', 'Cardassia Prime', 'Bajor', 'Andoria', 'Tellar Prime', 'Betazed', 'Risa', 'Ferenginar', 'Trill',
  'Ocampa-Heimat', 'Talos IV', 'Genesis-Planet', 'Delta-Quadrant', 'Gamma-Quadrant', 'Wurmloch von Bajor', 'Badlands', 'Neutrale Zone', 'Nimbus III',
  'Altair IV', 'Cestus III', 'Organia', 'Vulkanische Akademie der Wissenschaften', 'Regula I', 'Station K-7', 'Archanis-Station',
  'Raumdock der Erde', 'Jupiter-Station', 'Mars-Werften', 'Orbitalwerft Utopia', 'Camp Khitomer', 'Kronos-Hochrat', 'Ba’ku-Planet', 'Sherman’s Planet',
  // Waffen
  'Phaser', 'Phaserpistole', 'Phaserkanone', 'Photonentorpedo', 'Quantentorpedo', 'Disruptor', 'Bat’leth', 'Mek’leth', 'D’k tahg', 'Tricorder-Scanner',
  'Polaron-Strahler', 'Antimaterie-Mine', 'Tetryon-Waffe', 'Plasmatorpedo', 'Thalaron-Strahler', 'Genesis-Gerät', 'Omega-Molekül', 'Phasenkanone',
  'Handphaser Typ 2', 'Jem’Hadar-Disruptor', 'Borg-Assimilationsröhrchen', 'Traktorstrahl', 
  'Pulsphaser', 'Tarnvorrichtung', 'Spiegeluniversum-Agonizer', 'Schmerzstab',
  // Technik & Gegenstände
  'Warpantrieb', 'Impulsantrieb', 'Holodeck', 'Replikator', 'Transporter', 'Universalübersetzer', 'Kommunikator', 'Deflektorschild', 
  'Warpkern', 'Dilithiumkristall', 'Positronisches Gehirn', 'Tricorder', 'Medizinischer Tricorder', 'Hypospray', 'Dermalregenerator', 'Holo-Emitter',
  'Kobayashi Maru', 'Spiegeluniversum', 'Zeitportal der Hüter', 'Orb der Propheten', 'Tesserakt', 'Kristallines Wesen', 'Sternenflotten-Kommunikator',
  'Gedankenverschmelzung', 'Vulkanischer Gruß', 'Pon Farr', 'Kolinahr', 'Oberste Direktive', 'Erstkontakt', 'Prime Directive', 'Borg-Kollektiv',
  'Dominion', 'Föderation', 'Sternenflotte', 'Klingonisches Reich', 'Romulanisches Sternenimperium', 'Cardassianische Union', 'Ferengi-Allianz',
  'Tal Shiar', 'Sektion 31', 'Maquis', 'Orioner-Syndikat', 'Gorn', 'Tholianer', 'Breen', 'Hirogen', 'Talaxianer', 'Ocampa', 'Kazon', 'Vidiianer',
  'Tribbles', 'Horta', 'Salzvampir', 'Mugato', 'Gorn-Kapitän', 'Metron', 'Organier', 'Nagus', 'Spot, die Katze', 'Porthos',
  'Sehlat I-Chaya', 'Targ', 'Ferengi-Erwerbsregeln', 'Dabo-Rad', 'Raktajino', 'Gagh', 'Romulanisches Ale', 'Synthehol', 'Earl Grey, heiß', 'Tranya',
  'Kanar', 'Rokeg-Blutwurst', 'Plomeek-Suppe', 'Viennese-Torte', 'Quarks Bar', 'Zehn Vorne', 'Ressikanische Flöte', 
];

const ROEMISCH = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Wählt zufällig einen Namen, der nicht in `belegt` steht (Vergleich ohne Groß-/Kleinschreibung). Sind alle vergeben, wird eine
 * Zahl in römischer Schreibweise angehängt („Worf III“), damit Etiketten eindeutig bleiben.
 * @param {Iterable<string>} belegt bereits vergebene Namen
 * @param {() => number} zufall Zufallsquelle in [0, 1) (für Tests austauschbar)
 */
export function zufaelligerStartrekName(belegt = [], zufall = Math.random) {
  const vergeben = new Set([...belegt].map((n) => String(n ?? '').trim().toLowerCase()));
  const frei = STARTREK_NAMEN.filter((n) => !vergeben.has(n.toLowerCase()));
  if (frei.length) return frei[Math.floor(zufall() * frei.length)];
  for (const r of ROEMISCH) {
    const mit = STARTREK_NAMEN.filter((n) => !vergeben.has(`${n} ${r}`.toLowerCase()));
    if (mit.length) return `${mit[Math.floor(zufall() * mit.length)]} ${r}`;
  }
  return `${STARTREK_NAMEN[Math.floor(zufall() * STARTREK_NAMEN.length)]} ${vergeben.size + 1}`;
}

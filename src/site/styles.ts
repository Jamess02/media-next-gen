/**
 * Feuille de style du site public.
 *
 * Aucune dependance, aucun framework : le site est du HTML statique servi tel
 * quel. Une seule feuille, inlinee a la generation.
 *
 * PARTI PRIS VISUEL — inspire de l0g.fr : noir sur blanc, densite elevee,
 * marqueurs de section `//`, entrees numerotees, badges d'etat.
 *
 * La ou l0g signale un risque de marche, nous signalons ce que le protocole
 * rend obligatoire : le NIVEAU DE PREUVE (§2), le TYPE de claim (§3) et le
 * TIER de source (§4). Le badge n'est pas decoratif, c'est la promesse du §0
 * rendue visible d'un coup d'oeil.
 */

/**
 * Theme sombre, applicable sous DEUX racines differentes.
 *
 * POURQUOI UNE FONCTION ET NON DEUX BLOCS COPIES. Le mode sombre doit
 * s'appliquer dans deux situations qui n'ont pas le meme selecteur :
 *
 *  - le systeme est en sombre et le lecteur n'a rien choisi
 *    (`:root:not([data-theme="light"])`, sous media query) ;
 *  - le lecteur a explicitement choisi sombre (`:root[data-theme="dark"]`),
 *    quel que soit son systeme.
 *
 * Deux blocs recopies divergeraient a la premiere couleur ajoutee — et le
 * defaut ne se verrait que dans l'un des deux cas, donc rarement, donc tard.
 *
 * `color-scheme` n'est pas decoratif : sans lui, barres de defilement et
 * controles de formulaire restent clairs sur une page entierement sombre.
 */
function themeSombre(racine: string): string {
  return `
${racine} {
  color-scheme: dark;
  --encre: #ececec;
  --papier: #101010;
  --gris: #9a9a9a;
  --gris-clair: #6f6f6f;
  --trait: #2b2b2b;
  --fond-doux: #191919;
  --accent: #7aa7ff;
  --fort: #6dd39a;
  --moyen: #e0a45c;
  --faible: #f08a80;
}
${racine} .badge.niveau-4, ${racine} .badge.niveau-3 { background: #14251b; border-color: #24402e; }
${racine} .badge.niveau-2 { background: #251d10; border-color: #40331c; }
${racine} .badge.niveau-1, ${racine} .badge.niveau-0 { background: #261615; border-color: #422523; }
${racine} .claim:target { background: #131a26; }
${racine} .relecture .note { color: #c9c9c9; }
${racine} .divulgation li { color: #d0d0d0; }
/* Le gris fonce des listes reste lisible sur papier blanc, pas sur fond
   sombre : sans cette reprise, les incertitudes declarees disparaissaient. */
${racine} .avertissement li { color: #c4c4c4; }
`;
}

export const STYLES = `
:root {
  color-scheme: light;
  --encre: #111;
  --papier: #fff;
  --gris: #666;
  --gris-clair: #949494;
  --trait: #e2e2e2;
  --fond-doux: #f7f7f5;
  --accent: #0b57d0;
  --fort: #157347;
  --moyen: #b4690e;
  --faible: #b42318;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --texte: "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--papier);
  color: var(--encre);
  font-family: var(--texte);
  font-size: 17px;
  line-height: 1.62;
  -webkit-text-size-adjust: 100%;
}

.enveloppe { max-width: 820px; margin: 0 auto; padding: 0 24px 96px; }

/* --- Entete ------------------------------------------------------------ */

header.site {
  border-bottom: 2px solid var(--encre);
  margin-bottom: 34px;
  padding: 30px 0 14px;
}
header.site .titre {
  font-family: var(--mono);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  text-decoration: none;
  color: var(--encre);
}
header.site .accroche {
  color: var(--gris);
  font-size: 14px;
  margin-top: 4px;
}
nav.site {
  display: flex;
  gap: 20px;
  margin-top: 16px;
  font-family: var(--mono);
  font-size: 12.5px;
  text-transform: lowercase;
}
nav.site a { color: var(--gris); text-decoration: none; }
nav.site a:hover, nav.site a.actif { color: var(--encre); }

/* --- Marqueurs de section ---------------------------------------------- */

.section {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--gris-clair);
  text-transform: lowercase;
  margin: 40px 0 14px;
}
.section::before { content: "// "; }

/* --- Liste d'articles --------------------------------------------------- */

ol.articles { list-style: none; margin: 0; padding: 0; }
ol.articles > li { border-top: 1px solid var(--trait); padding: 18px 0; }
ol.articles > li:last-child { border-bottom: 1px solid var(--trait); }

.entree-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--gris);
  margin-bottom: 6px;
}
.numero { color: var(--gris-clair); font-variant-numeric: tabular-nums; }
.entree-titre {
  display: block;
  font-size: 20px;
  line-height: 1.32;
  font-weight: 600;
  color: var(--encre);
  text-decoration: none;
  margin-bottom: 6px;
}
.entree-titre:hover { text-decoration: underline; text-underline-offset: 3px; }
.entree-resume { color: var(--gris); font-size: 15.5px; margin: 0 0 8px; }
.lire {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.lire::after { content: " \\2192"; }

/* --- Badges ------------------------------------------------------------- */

.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1;
  padding: 4px 7px;
  border: 1px solid var(--trait);
  border-radius: 3px;
  color: var(--gris);
  white-space: nowrap;
}
.badge.niveau-4, .badge.niveau-3 { color: var(--fort); border-color: #bfe0cc; background: #f2f9f5; }
.badge.niveau-2 { color: var(--moyen); border-color: #f0dcbd; background: #fdf8f0; }
.badge.niveau-1, .badge.niveau-0 { color: var(--faible); border-color: #f3c9c5; background: #fdf5f4; }
.badge.tier-1, .badge.tier-2 { color: var(--fort); }
.badge.tier-3, .badge.tier-4 { color: var(--moyen); }
.badge.type { text-transform: lowercase; }

/* --- Article ------------------------------------------------------------ */

article h1 {
  font-size: 33px;
  line-height: 1.2;
  letter-spacing: -0.015em;
  margin: 6px 0 12px;
}
article .dateline {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--gris);
  margin-bottom: 22px;
}
article .dateline .revise { color: var(--moyen); }

.avertissement {
  border-left: 3px solid var(--moyen);
  background: var(--fond-doux);
  padding: 14px 18px;
  margin: 22px 0;
  font-size: 15px;
}
.avertissement .section { margin: 0 0 8px; }
.avertissement ul { margin: 0; padding-left: 18px; }
.avertissement li { margin-bottom: 5px; color: #3d3d3d; }

/* §4 / EP-002 — divulgation d'interet. Placee AVANT les incertitudes et le
   corps : elle change la facon de lire ce qui suit, elle doit donc etre lue
   avant. Bordure rouge, la plus forte de la palette : ce n'est pas une reserve
   de methode parmi d'autres, c'est l'identite de qui parle. */
.divulgation {
  border-left: 3px solid var(--faible);
  background: var(--fond-doux);
  padding: 14px 18px;
  margin: 22px 0;
  font-size: 15px;
}
.divulgation .section { margin: 0 0 8px; color: var(--faible); }
.divulgation ul { margin: 0; padding-left: 18px; }
.divulgation li { margin-bottom: 5px; color: #3d3d3d; }

.corps p { margin: 0 0 18px; }
.corps a { color: var(--accent); }
.corps a.ref {
  font-family: var(--mono);
  font-size: 11.5px;
  text-decoration: none;
  border: 1px solid var(--trait);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--accent);
  vertical-align: 1px;
  white-space: nowrap;
}
.corps a.ref:hover { background: var(--fond-doux); }
.corps blockquote {
  margin: 0 0 18px;
  padding-left: 16px;
  border-left: 2px solid var(--trait);
  color: #333;
}
.corps code, code {
  font-family: var(--mono);
  font-size: 0.87em;
  background: var(--fond-doux);
  padding: 1px 4px;
  border-radius: 3px;
}

/* --- Preuves ------------------------------------------------------------ */

.claim {
  border: 1px solid var(--trait);
  border-radius: 4px;
  padding: 16px 18px;
  margin-bottom: 14px;
  scroll-margin-top: 20px;
}
.claim:target { border-color: var(--accent); background: #f6f9ff; }
.claim .entete {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.claim .cid { font-family: var(--mono); font-size: 12px; color: var(--gris-clair); }
.claim .texte { font-size: 16.5px; margin: 0 0 12px; }
.claim ul.sources { list-style: none; margin: 0; padding: 0; }
.claim ul.sources li {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--gris);
  padding: 5px 0;
  border-top: 1px dotted var(--trait);
  word-break: break-word;
}
.claim ul.sources a { color: var(--accent); }

/* --- Attestation de relecture -------------------------------------------
 * Encadre plutot que discret : c'est le nom d'une personne qui engage sa
 * responsabilite sur le texte. Le lecteur doit le voir, pas le chercher.
 * ---------------------------------------------------------------------- */

.relecture {
  border: 1px solid var(--trait);
  border-left: 3px solid var(--fort);
  border-radius: 4px;
  padding: 14px 18px;
  margin: 28px 0;
  background: var(--fond-doux);
  font-size: 15px;
}
.relecture .section { margin: 0 0 8px; }
.relecture p { margin: 0 0 8px; }
.relecture p:last-child { margin-bottom: 0; }
.relecture .note { font-style: italic; color: #3d3d3d; }
.relecture .empreinte {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--gris);
  line-height: 1.6;
}

/* Les reprises sombres sont toutes dans themeSombre(), en fin de feuille. */

/* --- Divers ------------------------------------------------------------- */

.ecartees li { color: var(--gris); font-size: 14.5px; margin-bottom: 6px; }

footer.site {
  border-top: 1px solid var(--trait);
  margin-top: 52px;
  padding-top: 18px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--gris-clair);
  line-height: 1.75;
}

.vide {
  border: 1px dashed var(--trait);
  border-radius: 4px;
  padding: 30px;
  text-align: center;
  color: var(--gris);
  font-size: 15px;
}

@media (max-width: 620px) {
  body { font-size: 16px; }
  article h1 { font-size: 26px; }
  .enveloppe { padding: 0 16px 64px; }
}

/* --- Tableau des chiffres traites ---------------------------------------- */
/*
   Le conteneur defile, pas la PAGE. Sept colonnes ne tiennent pas sur un
   telephone, et un debordement horizontal de la page casse la lecture du texte
   partout ailleurs.
*/
.tableau-enveloppe { overflow-x: auto; margin: 0 0 26px; }

table.chiffres {
  border-collapse: collapse;
  width: 100%;
  font-size: 14.5px;
}
table.chiffres caption {
  caption-side: top;
  text-align: left;
  color: var(--gris);
  font-size: 13px;
  line-height: 1.5;
  padding-bottom: 10px;
}
table.chiffres th, table.chiffres td {
  border-bottom: 1px solid var(--trait);
  padding: 8px 12px 8px 0;
  text-align: left;
  vertical-align: baseline;
  white-space: nowrap;
}
table.chiffres thead th {
  font-family: var(--mono);
  font-size: 11.5px;
  text-transform: lowercase;
  color: var(--gris);
  font-weight: 400;
  border-bottom: 1px solid var(--encre);
}
table.chiffres tbody th { font-weight: 600; white-space: normal; }
table.chiffres .rang { font-family: var(--mono); color: var(--gris-clair); }
/* Les valeurs sont alignees a droite et en chasse fixe : c'est ce qui permet de
   comparer des ordres de grandeur d'un coup d'oeil, ce qui est tout l'objet du
   tableau. */
table.chiffres .valeur {
  text-align: right;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 14px;
}
table.chiffres .periode { font-family: var(--mono); font-size: 12.5px; color: var(--gris); }
.badge.type {
  background: var(--fond-doux);
  border: 1px solid var(--trait);
  color: var(--gris);
}

/* --- Bascule de theme --------------------------------------------------- */

.theme-bascule {
  position: absolute;
  top: 30px;
  right: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  text-transform: lowercase;
  color: var(--gris);
  background: transparent;
  border: 1px solid var(--trait);
  border-radius: 3px;
  padding: 4px 9px;
  cursor: pointer;
  line-height: 1.4;
}
.theme-bascule:hover { color: var(--encre); border-color: var(--gris-clair); }
.theme-bascule:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
header.site { position: relative; }

/* --- Theme sombre -------------------------------------------------------- */
/*
   Deux applications, une seule definition (voir \`themeSombre\`).

   La media query est GARDEE par \`:not([data-theme="light"])\`. Sans cette
   garde, un lecteur sur machine sombre qui choisit « clair » n'obtiendrait
   rien : la media query continuerait de gagner, et la bascule paraitrait
   cassee alors qu'elle fonctionne.
*/
@media (prefers-color-scheme: dark) {
${themeSombre(':root:not([data-theme="light"])')}
}

/* Choix explicite du lecteur : l'emporte sur le reglage systeme, dans les
   deux sens. */
${themeSombre(':root[data-theme="dark"]')}
`;

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

export const STYLES = `
:root {
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

@media (prefers-color-scheme: dark) {
  :root {
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
  .badge.niveau-4, .badge.niveau-3 { background: #14251b; border-color: #24402e; }
  .badge.niveau-2 { background: #251d10; border-color: #40331c; }
  .badge.niveau-1, .badge.niveau-0 { background: #261615; border-color: #422523; }
  .claim:target { background: #131a26; }
}
`;

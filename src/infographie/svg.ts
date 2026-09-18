/**
 * INFOGRAPHIE — rendu en CASCADE d'un ecart deja calcule.
 *
 * Dependances : `escapeHtml` de `site/markdown.ts`. Aucune dependance npm —
 * pas de bibliotheque de graphiques, et ce n'est pas une economie : le site ne
 * charge AUCUN script, sa politique de securite du contenu n'autorisant que des
 * empreintes connues. Un SVG inline, lui, ne declenche aucune directive.
 *
 * L'echappement est IMPORTE plutot que reecrit : deux implementations
 * divergeraient, et celle qui n'est pas testee serait celle qui laisse passer.
 *
 * CE QUE CE MODULE NE FAIT PAS. Il ne calcule rien, ne verifie rien : il recoit
 * un `EcartCalcule`, donc un ecart dont chaque composante porte deja sa methode
 * et sa source. Separer les deux evite le defaut classique du graphique : une
 * mise en forme qui « arrange » un peu les chiffres pour que la figure tombe
 * juste.
 *
 * CHOIX DE LECTURE
 *
 *  - L'anticipe ET le realise sont montres. Un graphique qui n'afficherait que
 *    la valeur finale masquerait precisement ce dont l'article parle : l'ecart.
 *  - Le residu est TOUJOURS dessine, meme nul. C'est la barre qui dit « voila
 *    ce que nous n'expliquons pas ».
 *  - Une composante estimee porte la mention « estimee » dans le graphique
 *    lui-meme, pas seulement dans la legende : les legendes ne se lisent pas.
 *  - Aucune couleur en dur. Le site a trois etats de theme, et un graphique aux
 *    couleurs figees serait illisible dans l'un d'eux.
 *  - L'axe ne part pas de zero quand la base est eloignee de zero — sinon la
 *    cascade s'ecrase — et la TRONCATURE est alors ecrite sur le graphique.
 */

import { escapeHtml } from "../site/markdown.js";
import type { EcartCalcule } from "./ecart.js";

export interface CascadeRendue {
  /** Le graphique, pret a etre insere dans le corps de l'article. */
  svg: string;
  /** Description textuelle, pour qui ne voit pas l'image. */
  alt: string;
  /** Titre factuel : le constat, jamais son interpretation. */
  titre: string;
}

/** Une etape de la cascade, du niveau `depart` au niveau `arrivee`. */
interface Etape {
  libelle: string;
  valeur: number;
  depart: number;
  arrivee: number;
  /** `borne` : anticipe ou realise. `apport` : composante ou residu. */
  nature: "borne" | "apport";
  sens: "hausse" | "baisse" | "nul";
}

const LARGEUR = 720;
const HAUTEUR = 380;
const MARGE = { haut: 56, bas: 96, gauche: 16, droite: 16 };

/** Point decimal, comme dans les resumes de sources : « 2.47 », pas « 2,47 ». */
const nombre = (v: number): string => String(v);

const signe = (v: number): string => (v > 0 ? `+${nombre(v)}` : nombre(v));

/** Identifiant sur, derive de l'indicateur : il sert d'ancre d'accessibilite. */
function identifiant(indicateur: string): string {
  const net = indicateur.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return net.length > 0 ? net.slice(0, 48) : "ecart";
}

function etapes(e: EcartCalcule): Etape[] {
  const liste: Etape[] = [
    {
      libelle: "Anticipe",
      valeur: e.anticipe.value,
      depart: 0,
      arrivee: e.anticipe.value,
      nature: "borne",
      sens: "nul",
    },
  ];

  let niveau = e.anticipe.value;
  const apports = [
    ...e.composantes.map((c) => ({
      libelle: e.estimationsInternes.includes(c.name) ? `${c.name} (estimee)` : c.name,
      valeur: c.value,
    })),
    { libelle: "Residu non explique", valeur: e.residu },
  ];

  for (const apport of apports) {
    const depart = niveau;
    niveau = Math.round((niveau + apport.valeur) * 1e12) / 1e12;
    liste.push({
      libelle: apport.libelle,
      valeur: apport.valeur,
      depart,
      arrivee: niveau,
      nature: "apport",
      sens: apport.valeur > 0 ? "hausse" : apport.valeur < 0 ? "baisse" : "nul",
    });
  }

  liste.push({
    libelle: "Realise",
    valeur: e.realise.value,
    depart: 0,
    arrivee: e.realise.value,
    nature: "borne",
    sens: "nul",
  });

  return liste;
}

export function rendreCascade(e: EcartCalcule): CascadeRendue {
  const pas = etapes(e);
  const id = identifiant(e.indicateur);

  const titre =
    `${e.libelle} : ecart de ${signe(e.ecart)} ${e.unite} entre l'anticipation ` +
    `du ${e.anticipe.date} et le releve publie le ${e.realise.date}`;

  const detail = e.composantes
    .map((c) => `${c.name} ${signe(c.value)} (${c.method})`)
    .join(", ");

  const alt =
    `Cascade : la valeur anticipee de ${nombre(e.anticipe.value)} ${e.unite} ` +
    `conduit a la valeur realisee de ${nombre(e.realise.value)} ${e.unite}, ` +
    `soit un ecart de ${signe(e.ecart)}. ` +
    (detail.length > 0 ? `Composantes : ${detail}. ` : "Aucune composante n'a pu etre attribuee. ") +
    `Residu non explique : ${signe(e.residu)} ${e.unite}.`;

  // --- Echelle -------------------------------------------------------------
  //
  // La base n'est pas zero des que les valeurs en sont eloignees : une cascade
  // de 0,37 point tracee depuis zero se reduirait a un trait. La troncature est
  // alors ECRITE sur le graphique, jamais laissee a deviner.
  const niveaux = pas.flatMap((p) => (p.nature === "borne" ? [p.arrivee] : [p.depart, p.arrivee]));
  const min = Math.min(...niveaux);
  const max = Math.max(...niveaux);
  const amplitude = max - min;
  const marge = Math.max(amplitude * 0.25, Math.abs(max) * 0.02, 0.001);

  // On ne tronque que si tous les niveaux sont du meme cote de zero ET que
  // l'ecart est petit devant le niveau : c'est le cas ou un axe partant de zero
  // reduirait la cascade a un trait. Autrement, l'axe part de zero.
  const tronque = amplitude > 0 && min > 0 && amplitude < min / 2;
  const bas = tronque ? min - marge : Math.min(0, min - marge);
  const haut = max + marge;
  /** Base des barres pleines (anticipe, realise). */
  const socle = tronque ? bas : 0;

  const hauteurTrace = HAUTEUR - MARGE.haut - MARGE.bas;
  const y = (valeur: number): number =>
    MARGE.haut + hauteurTrace * (1 - (valeur - bas) / (haut - bas));

  const largeurUtile = LARGEUR - MARGE.gauche - MARGE.droite;
  const pasLarge = largeurUtile / pas.length;
  const barre = Math.min(pasLarge * 0.62, 90);

  const corps = pas
    .map((p, i) => {
      const centre = MARGE.gauche + pasLarge * (i + 0.5);
      const x = centre - barre / 2;
      const depart = p.nature === "borne" ? socle : p.depart;
      const hautBarre = Math.max(Math.abs(y(p.arrivee) - y(depart)), 2);
      const yBarre = Math.min(y(p.arrivee), y(depart));
      const couleur =
        p.nature === "borne"
          ? "currentColor"
          : p.sens === "hausse"
            ? "var(--faible)"
            : p.sens === "baisse"
              ? "var(--fort)"
              : "var(--gris-clair)";
      const valeurAffichee =
        p.nature === "borne" ? nombre(p.valeur) : signe(p.valeur);

      return (
        `<rect x="${x.toFixed(1)}" y="${yBarre.toFixed(1)}" width="${barre.toFixed(1)}" ` +
        `height="${hautBarre.toFixed(1)}" fill="${couleur}" fill-opacity="${p.nature === "borne" ? "0.85" : "0.7"}"/>` +
        `<text x="${centre.toFixed(1)}" y="${(yBarre - 8).toFixed(1)}" text-anchor="middle" ` +
        `font-size="13" fill="currentColor">${escapeHtml(valeurAffichee)}</text>` +
        `<text x="${centre.toFixed(1)}" y="${(HAUTEUR - MARGE.bas + 20).toFixed(1)}" text-anchor="middle" ` +
        `font-size="12" fill="var(--gris)">${escapeHtml(p.libelle)}</text>`
      );
    })
    .join("");

  const legende = [
    `Unite : ${e.unite}.`,
    `Anticipe : ${e.anticipe.source}, fige le ${e.anticipe.date}.`,
    `Realise : ${e.realise.source}, publie le ${e.realise.date}.`,
    e.estimationsInternes.length > 0
      ? `Estimations internes, non officielles : ${e.estimationsInternes.join(", ")}.`
      : "",
    tronque ? `Axe vertical tronque : il commence a ${nombre(Math.round(bas * 100) / 100)}.` : "",
  ].filter((l) => l.length > 0);

  const lignesLegende = legende
    .map(
      (l, i) =>
        `<text x="${MARGE.gauche}" y="${(HAUTEUR - MARGE.bas + 44 + i * 15).toFixed(1)}" ` +
        `font-size="11.5" fill="var(--gris)">${escapeHtml(l)}</text>`,
    )
    .join("");

  const svg =
    `<svg class="cascade" viewBox="0 0 ${LARGEUR} ${HAUTEUR}" width="100%" ` +
    `role="img" aria-labelledby="titre-${id} desc-${id}" xmlns="http://www.w3.org/2000/svg">` +
    `<title id="titre-${id}">${escapeHtml(titre)}</title>` +
    `<desc id="desc-${id}">${escapeHtml(alt)}</desc>` +
    `<text x="${MARGE.gauche}" y="26" font-size="15" fill="currentColor">${escapeHtml(titre)}</text>` +
    // La ligne suit le SOCLE, pas le bas du cadre. Quand l'axe n'est pas
    // tronque, le socle vaut zero : la ligne traverse alors le graphique, et
    // les barres negatives passent visiblement dessous. Tracee en bas du cadre,
    // elle se lirait comme l'axe tout en placant le zero sous des valeurs
    // negatives — un lecteur y verrait une hausse la ou la valeur baisse.
    `<line x1="${MARGE.gauche}" y1="${y(socle).toFixed(1)}" ` +
    `x2="${LARGEUR - MARGE.droite}" y2="${y(socle).toFixed(1)}" ` +
    `stroke="var(--gris-clair)" stroke-width="1"/>` +
    corps +
    lignesLegende +
    `</svg>`;

  return { svg, alt, titre };
}

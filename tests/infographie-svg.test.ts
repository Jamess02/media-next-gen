/**
 * INFOGRAPHIE — le rendu en cascade.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le graphique est l'element le plus autoritaire d'une page : aligne, chiffre,
 * colore, il a l'apparence d'une donnee verifiee. Ce qui s'y affiche doit donc
 * etre produit par du code teste, a partir d'un ecart DEJA valide — jamais
 * dessine ni decrit par un modele.
 *
 * Les exigences viennent du brief de l'editeur du 2026-09-18 :
 * anticipe ET realise sur le meme graphique, cascade de l'un vers l'autre,
 * titre factuel, unites, dates et sources en legende, axe non tronque ou
 * troncature signalee, et un texte alternatif qui decrit reellement le
 * graphique.
 */

import { describe, expect, it } from "vitest";

import { calculerEcart, type EntreeEcart } from "../src/infographie/ecart.js";
import { rendreCascade } from "../src/infographie/svg.js";

const ENTREE: EntreeEcart = {
  indicateur: "inflation_zone_euro_hicp",
  libelle: "Inflation annuelle, zone euro (IPCH)",
  unite: "points de %",
  anticipe: {
    value: 2.1,
    source: "Projections BCE de juin 2026",
    date: "2026-06-12",
  },
  realise: {
    value: 2.47,
    source: "Eurostat, prc_hicp_manr",
    date: "2026-07-13",
  },
  composantes: [
    { name: "energie", value: 0.25, method: "publiee", source: "Eurostat, contributions" },
    {
      name: "services",
      value: 0.08,
      method: "estimee",
      source: "calcul interne : contributions ponderees par les poids IPCH 2026",
    },
  ],
};

/** Ecart valide, produit par le calcul reel plutot qu'ecrit a la main. */
function ecartValide(entree: EntreeEcart = ENTREE) {
  const r = calculerEcart(entree);
  if (!r.ok) throw new Error(`entree de test invalide : ${r.motif}`);
  return r.ecart;
}

describe("cascade — ce que le graphique montre", () => {
  it("affiche l'anticipe ET le realise, jamais la seule valeur finale", () => {
    const { svg } = rendreCascade(ecartValide());
    expect(svg).toContain("2.1");
    expect(svg).toContain("2.47");
    expect(svg).toMatch(/anticip/i);
    expect(svg).toMatch(/realis/i);
  });

  it("dessine une etape par composante, plus le residu, entre les deux bornes", () => {
    const { svg } = rendreCascade(ecartValide());
    expect(svg).toMatch(/energie/);
    expect(svg).toMatch(/services/);
    expect(svg).toMatch(/residu/i);
    // Cinq barres : anticipe, energie, services, residu, realise.
    expect(svg.split("<rect").length - 1).toBeGreaterThanOrEqual(5);
  });

  it("AFFICHE le residu meme nul : ne jamais laisser croire a une explication complete", () => {
    const complet = ecartValide({
      ...ENTREE,
      composantes: [{ name: "energie", value: 0.37, method: "publiee", source: "Eurostat" }],
    });
    expect(complet.residu).toBe(0);
    expect(rendreCascade(complet).svg).toMatch(/residu/i);
  });

  it("ETIQUETTE les estimations internes dans le graphique lui-meme", () => {
    // Le brief l'exige dans le graphique ET dans le texte : une estimation
    // interne ne doit jamais passer pour un chiffre officiel.
    const { svg } = rendreCascade(ecartValide());
    expect(svg).toMatch(/services[^<]*estim/i);
  });
});

describe("cascade — ce que le graphique declare", () => {
  it("porte un titre FACTUEL : le constat, pas l'interpretation", () => {
    const { titre } = rendreCascade(ecartValide());
    expect(titre).toMatch(/Inflation annuelle, zone euro/);
    expect(titre).toMatch(/0\.37|0,37/);
    expect(titre).toMatch(/points de %/);
    for (const mot of ["surprise", "choc", "decevant", "inquietant", "rassurant", "spectaculaire"]) {
      expect(titre.toLowerCase(), mot).not.toContain(mot);
    }
  });

  it("met unites, dates et sources dans la legende", () => {
    const { svg } = rendreCascade(ecartValide());
    expect(svg).toContain("points de %");
    expect(svg).toContain("2026-06-12");
    expect(svg).toContain("2026-07-13");
    expect(svg).toContain("Projections BCE de juin 2026");
    expect(svg).toContain("Eurostat, prc_hicp_manr");
  });

  it("rend un texte alternatif qui DECRIT le graphique", () => {
    const { svg, alt } = rendreCascade(ecartValide());
    expect(alt).toMatch(/anticip/i);
    expect(alt).toMatch(/realis/i);
    expect(alt).toMatch(/0\.37|0,37/);
    expect(alt).toMatch(/residu/i);
    // Accessible : le SVG s'annonce comme image et porte sa description.
    expect(svg).toMatch(/role="img"/);
    expect(svg).toContain("<title");
    expect(svg).toContain("<desc");
  });

  it("SIGNALE un axe tronque, quand la base n'est pas zero", () => {
    const { svg } = rendreCascade(ecartValide());
    // Une cascade partant de 2,1 pour un ecart de 0,37 ne peut pas partir de
    // zero sans ecraser le graphique : la troncature est alors ANNONCEE.
    expect(svg).toMatch(/tronqu/i);
  });
});

describe("cascade — geometrie", () => {
  /** Les barres, telles qu'elles sont REELLEMENT dessinees. */
  function barres(svg: string) {
    return [
      ...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g),
    ].map((m) => {
      const [x, y, l, h] = m.slice(1, 5).map(Number) as [number, number, number, number];
      return { x, y, l, h, bas: y + h };
    });
  }

  function ligneDeBase(svg: string): number {
    const m = /<line [^>]*y1="([\d.-]+)"/.exec(svg);
    if (m === null) throw new Error("aucune ligne de base dans le graphique");
    return Number(m[1]);
  }

  function cadre(svg: string) {
    const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    if (m === null) throw new Error("aucun viewBox");
    return { largeur: Number(m[1]), hauteur: Number(m[2]) };
  }

  /** Un ecart autour de zero : l'axe ne peut pas etre tronque. */
  const AUTOUR_DE_ZERO: EntreeEcart = {
    ...ENTREE,
    anticipe: { value: 0.2, source: "Projections BCE de juin 2026", date: "2026-06-12" },
    realise: { value: -0.3, source: "Eurostat, prc_hicp_manr", date: "2026-07-13" },
    composantes: [{ name: "energie", value: -0.4, method: "publiee", source: "Eurostat" }],
  };

  it("dessine chaque barre DANS le cadre, avec des dimensions visibles", () => {
    for (const entree of [ENTREE, AUTOUR_DE_ZERO]) {
      const { svg } = rendreCascade(ecartValide(entree));
      const { largeur, hauteur } = cadre(svg);
      for (const b of barres(svg)) {
        expect(b.l, "largeur").toBeGreaterThan(0);
        expect(b.h, "hauteur").toBeGreaterThan(0);
        expect(b.x, "bord gauche").toBeGreaterThanOrEqual(0);
        expect(b.x + b.l, "bord droit").toBeLessThanOrEqual(largeur);
        expect(b.y, "bord haut").toBeGreaterThanOrEqual(0);
        expect(b.bas, "bord bas").toBeLessThanOrEqual(hauteur);
      }
    }
  });

  it("fait REPOSER les bornes sur la ligne de base, y compris autour de zero", () => {
    // Sinon la ligne se lit comme l'axe alors qu'elle n'est pas a son niveau :
    // elle placerait le zero sous des valeurs negatives. Un lecteur y verrait
    // une barre positive la ou la valeur est negative.
    for (const entree of [ENTREE, AUTOUR_DE_ZERO]) {
      const { svg } = rendreCascade(ecartValide(entree));
      const dessinees = barres(svg);
      const base = ligneDeBase(svg);
      for (const borne of [dessinees[0]!, dessinees[dessinees.length - 1]!]) {
        const repose = Math.abs(borne.y - base) < 0.5 || Math.abs(borne.bas - base) < 0.5;
        expect(repose, `borne a y=${borne.y}..${borne.bas} contre une base a ${base}`).toBe(true);
      }
    }
  });

  it("enchaine les apports : chaque etape repart du niveau atteint par la precedente", () => {
    const { svg } = rendreCascade(ecartValide());
    const dessinees = barres(svg);
    expect(dessinees, "anticipe, energie, services, residu, realise").toHaveLength(5);
    const [anticipe, energie, services, residu, realise] = dessinees;
    // Les composantes sont positives : chaque barre monte depuis le sommet de
    // la precedente, et la derniere atteint le sommet du realise.
    expect(energie!.bas).toBeCloseTo(anticipe!.y, 1);
    expect(services!.bas).toBeCloseTo(energie!.y, 1);
    expect(residu!.bas).toBeCloseTo(services!.y, 1);
    expect(realise!.y).toBeCloseTo(residu!.y, 1);
  });
});

describe("cascade — surete du rendu", () => {
  it("echappe tout texte hostile venu des donnees", () => {
    const { svg } = rendreCascade(
      ecartValide({
        ...ENTREE,
        libelle: "Inflation <script>alert(1)</script>",
        composantes: [
          { name: "<img src=x onerror=vol()>", value: 0.37, method: "publiee", source: "Eurostat" },
        ],
      }),
    );
    expect(svg).not.toMatch(/<script>alert/);
    expect(svg).not.toMatch(/<img src=x/);
    expect(svg).toMatch(/&lt;script&gt;/);
  });

  it("n'inscrit AUCUNE couleur en dur : le graphique suit le theme du lecteur", () => {
    // Le site a trois etats de theme. Un graphique en couleurs figees serait
    // illisible dans l'un d'eux — et le lecteur n'a pas a choisir entre lire
    // le texte et lire le graphique.
    const { svg } = rendreCascade(ecartValide());
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(svg).toMatch(/currentColor|var\(--/);
  });

  it("ne contient aucun script : la politique de contenu du site l'interdit", () => {
    const { svg } = rendreCascade(ecartValide());
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\son\w+=/i);
  });
});

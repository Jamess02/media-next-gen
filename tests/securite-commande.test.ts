/**
 * Une commande mal tapee ne doit JAMAIS lancer de vrais appels d'API.
 *
 * NE D'UN INCIDENT REEL, le 2026-09-11, pendant la verification des securites.
 * `npm run dev -- verify-journal` voulait verifier le journal d'audit. La vraie
 * commande est `journal` ; `verify-journal` est le nom INTERNE de cette
 * commande, pas son nom public. L'interface l'a pris pour un SUJET d'article et
 * a lance le pipeline : cinq appels reels au modele, consommes pour rien.
 *
 * Le fournisseur par defaut etant gratuit, l'erreur n'a coute que du quota.
 * Avec un fournisseur facture, une faute de frappe aurait coute de l'argent —
 * exactement ce que l'editeur a interdit.
 *
 * C'est aussi la menace n°7 de l'article « Why Your AI Developer Tools Might Be
 * Your Biggest Security Risk » sous une autre forme : un outil qui fait autre
 * chose que ce qu'on croit lui demander, et le fait sans prevenir.
 */

import { describe, expect, it } from "vitest";

import { drapeauRefuse, ressembleAUneCommande } from "../src/securite/commande.js";

describe("ce qui ressemble a une commande est refuse, avec la bonne suggestion", () => {
  it("le nom INTERNE d'une commande — l'incident reel", () => {
    expect(ressembleAUneCommande("verify-journal")).toBe("journal");
  });

  it("les autres noms internes", () => {
    expect(ressembleAUneCommande("build-site")).toBe("site");
    expect(ressembleAUneCommande("list-providers")).toBe("--providers");
  });

  it("une faute de frappe sur une commande publique", () => {
    expect(ressembleAUneCommande("jounral")).toBe("journal");
    expect(ressembleAUneCommande("stuido")).toBe("studio");
    expect(ressembleAUneCommande("valdier")).toBe("valider");
  });

  it("un mot compose qui contient un nom de commande", () => {
    expect(ressembleAUneCommande("verifier-journal")).not.toBeNull();
  });

  it("une faute de frappe sur la sonde des sources de marche", () => {
    // Sans cette entree, « marchse » lancerait un article sur « marchse ».
    expect(ressembleAUneCommande("marchse")).toBe("marches");
  });
});

describe("un vrai sujet passe, meme court", () => {
  const sujets = [
    "inflation annuelle en zone euro",
    "croissance du PIB",
    "inflation",
    "sanctions",
    "euro-dollar",
    "covid-19",
    "Reserve federale",
  ];
  for (const s of sujets) {
    it(`laisse passer « ${s} »`, () => {
      expect(ressembleAUneCommande(s)).toBeNull();
    });
  }
});

describe("--mode=live est refuse : il selectionnait Anthropic sans le dire", () => {
  /**
   * Decision de l'editeur, le 2026-09-11. Ce drapeau herite equivalait a
   * `--provider=anthropic` — le seul fournisseur FACTURE, que l'editeur a
   * interdit. Rien dans son nom ne l'annoncait : « live » evoque des sources
   * reelles, pas une facturation. Un seul argument suffisait a declencher la
   * depense.
   */
  it("refuse --mode=live avec un message", () => {
    const m = drapeauRefuse("--mode=live") ?? "";
    expect(m.length).toBeGreaterThan(0);
    // Le message doit dire POURQUOI et quoi faire a la place.
    expect(m).toMatch(/anthropic|factur/i);
    expect(m).toMatch(/--provider=/);
  });

  it("laisse passer --mode=mock, inoffensif", () => {
    expect(drapeauRefuse("--mode=mock")).toBeNull();
  });

  it("laisse passer les drapeaux ordinaires", () => {
    for (const d of ["--real-sources", "--enquete", "--prospectif", "--provider=gemini"]) {
      expect(drapeauRefuse(d), d).toBeNull();
    }
  });
});

/**
 * Dependances : une liste APPROUVEE, pas une liste qui grossit seule.
 *
 * Menace n°3 de l'article « Why Your AI Developer Tools Might Be Your Biggest
 * Security Risk » (The Hacker News, aout 2026) : l'HALLUCINATION DE PAQUETS.
 * Un assistant de code propose un nom de paquet qui n'existe pas ; un
 * attaquant, qui recense ces noms, l'enregistre sur npm avec un script
 * d'installation malveillant. L'etude citee : 43 % des noms hallucines
 * reviennent a chaque fois qu'on repose la question — assez regulierement pour
 * qu'on les exploite.
 *
 * Ce projet est developpe avec un outil d'IA. Le risque ne vise pas un
 * developpeur imaginaire : il vise la prochaine dependance que CET outil
 * ajouterait sans qu'on la remarque.
 *
 * LA REGLE. Toute dependance doit figurer dans la liste ci-dessous, et
 * l'ajouter a la liste est un acte delibere, visible en revue. Un paquet ajoute
 * a package.json sans passer par ici fait echouer la suite.
 *
 * Le projet tient depuis le debut a « zero dependance ajoutee » : deux
 * dependances d'execution, quatre de developpement. Cette liste en fait une
 * contrainte plutot qu'une habitude.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Approuvees une a une. Ajouter une ligne ici est une decision, pas un reflexe. */
const APPROUVEES_EXECUTION = ["@anthropic-ai/sdk", "zod"];
const APPROUVEES_DEVELOPPEMENT = ["@types/node", "tsx", "typescript", "vitest"];

/** Seul registre admis. Un paquet resolu ailleurs n'a pas ete verifie par npm. */
const REGISTRE = "registry.npmjs.org";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const verrou = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
};

describe("aucune dependance hors liste approuvee", () => {
  it("dependances d'execution : exactement la liste approuvee", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(
      [...APPROUVEES_EXECUTION].sort(),
    );
  });

  it("dependances de developpement : exactement la liste approuvee", () => {
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(
      [...APPROUVEES_DEVELOPPEMENT].sort(),
    );
  });
});

describe("chaque dependance directe est VERROUILLEE et VERIFIEE", () => {
  const directes = [...APPROUVEES_EXECUTION, ...APPROUVEES_DEVELOPPEMENT];

  for (const nom of directes) {
    it(`${nom} : presente au verrou, avec une empreinte d'integrite`, () => {
      // Sans empreinte, npm installerait ce que le registre sert AUJOURD'HUI,
      // y compris une version remplacee apres compromission.
      const e = verrou.packages?.[`node_modules/${nom}`];
      expect(e, `${nom} absent de package-lock.json`).toBeDefined();
      expect(e?.integrity ?? "", `${nom} sans empreinte`).toMatch(/^sha512-/);
    });

    it(`${nom} : resolue depuis le registre officiel`, () => {
      const e = verrou.packages?.[`node_modules/${nom}`];
      const hote = e?.resolved === undefined ? "" : new URL(e.resolved).host;
      expect(hote).toBe(REGISTRE);
    });
  }
});

describe("le verrou entier ne tire rien d'ailleurs", () => {
  it("toutes les dependances transitives viennent du registre officiel", () => {
    // Une dependance transitive resolue depuis un depot git ou un serveur
    // tiers echapperait a la liste approuvee sans y figurer.
    const etrangeres = Object.entries(verrou.packages ?? {})
      .filter(([chemin, e]) => chemin !== "" && e.resolved !== undefined)
      .filter(([, e]) => new URL(e.resolved as string).host !== REGISTRE)
      .map(([chemin]) => chemin);
    expect(etrangeres).toEqual([]);
  });
});

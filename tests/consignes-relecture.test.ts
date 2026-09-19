/**
 * Les NOTES DE RELECTURE reviennent dans la production.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Constat du 2026-09-19, verifie avant d'ecrire une ligne : la note qu'un
 * relecteur laisse en validant etait ecrite dans l'attestation, inscrite au
 * changelog public et affichee sur le site — mais AUCUN agent, aucun module du
 * pipeline ne la relisait. Elle etait archivee, pas prise en compte.
 *
 * La preuve tenait dans le depot lui-meme : la note du 2026-09-13 demandait de
 * traiter « les consequences des seismes dans les regions touchees et les
 * actions mises en place par les gouvernements ». Les articles suivants n'en
 * ont rien fait, et le manque a ete signale plus tard comme s'il venait de
 * nulle part.
 *
 * CE QU'UNE CONSIGNE PEUT, ET CE QU'ELLE NE PEUT PAS. Elle oriente l'ECRITURE :
 * un angle a couvrir, un manque a combler, une longueur. Elle ne leve aucune
 * regle du protocole, et c'est structurel plutot que promis — les regles sont
 * du code, le gate s'applique apres le modele. Un test s'en assure quand meme :
 * une regression qui ferait passer les consignes AVANT les controles doit se
 * voir.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import { INSTRUCTIONS_REDACTEUR } from "../src/agents/redacteur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { lireConsignes, MAX_CONSIGNES } from "../src/editorial/consignes.js";
import { ADAPTIVE_RESPONDERS } from "../src/fixtures/adaptive-responders.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import type { SourceAdapter } from "../src/sources/types.js";

let racine: string;

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), "consignes-"));
});
afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

/** Ecrit une attestation de relecture, avec sa note et sa date. */
async function attester(
  dossier: string,
  id: string,
  note: string | null,
  reviewedAt: string,
): Promise<void> {
  await mkdir(dossier, { recursive: true });
  await writeFile(
    join(dossier, `${id}.review.json`),
    JSON.stringify({
      article_id: id,
      article_title: `Titre ${id}`,
      reviewer: "jemunzu",
      reviewed_at: reviewedAt,
      content_sha256: "0".repeat(64),
      note,
    }),
    "utf8",
  );
}

/* -------------------------------------------------------------------------
 * 1. Lire les notes
 * ---------------------------------------------------------------------- */

describe("lecture des notes de relecture", () => {
  it("rend les notes, la PLUS RECENTE d'abord", async () => {
    const d = join(racine, "articles");
    await attester(d, "a1", "ancienne remarque", "2026-09-10T10:00:00Z");
    await attester(d, "a2", "remarque recente", "2026-09-18T10:00:00Z");

    const consignes = await lireConsignes(d);
    expect(consignes[0]).toContain("remarque recente");
    expect(consignes[1]).toContain("ancienne remarque");
  });

  it("IGNORE les attestations sans note", async () => {
    // Une relecture peut etre silencieuse : c'est le cas ordinaire, pas une
    // anomalie. Une consigne vide diluerait les vraies.
    const d = join(racine, "articles");
    await attester(d, "a1", null, "2026-09-18T10:00:00Z");
    await attester(d, "a2", "   ", "2026-09-17T10:00:00Z");
    await attester(d, "a3", "la seule vraie", "2026-09-16T10:00:00Z");

    const consignes = await lireConsignes(d);
    expect(consignes).toHaveLength(1);
    expect(consignes[0]).toContain("la seule vraie");
  });

  it("BORNE le nombre de consignes transmises", async () => {
    // Sans plafond, chaque relecture alourdirait le prompt de la suivante, et
    // la consigne la plus ancienne pesorait autant que la derniere.
    const d = join(racine, "articles");
    for (let i = 0; i < MAX_CONSIGNES + 4; i += 1) {
      await attester(d, `a${i}`, `remarque ${i}`, `2026-09-${String(10 + i).padStart(2, "0")}T10:00:00Z`);
    }
    expect(await lireConsignes(d)).toHaveLength(MAX_CONSIGNES);
  });

  it("TRONQUE une note demesuree plutot que de noyer le prompt", async () => {
    const d = join(racine, "articles");
    await attester(d, "a1", "x".repeat(5000), "2026-09-18T10:00:00Z");
    const consignes = await lireConsignes(d);
    expect(consignes[0]!.length).toBeLessThan(1000);
  });

  it("rend une liste vide quand rien n'a encore ete relu", async () => {
    expect(await lireConsignes(join(racine, "inexistant"))).toEqual([]);
  });

  it("IGNORE une attestation illisible sans faire tomber la collecte", async () => {
    // Un fichier tronque ne doit pas priver la production de toutes les autres
    // consignes : le suivi sert l'article, pas l'inverse.
    const d = join(racine, "articles");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "casse.review.json"), "{ pas du json", "utf8");
    await attester(d, "a1", "remarque valable", "2026-09-18T10:00:00Z");

    const consignes = await lireConsignes(d);
    expect(consignes).toHaveLength(1);
    expect(consignes[0]).toContain("remarque valable");
  });

  it("porte le NOM du relecteur : une consigne engage quelqu'un", async () => {
    const d = join(racine, "articles");
    await attester(d, "a1", "developper les consequences", "2026-09-18T10:00:00Z");
    expect((await lireConsignes(d))[0]).toContain("jemunzu");
  });
});

/* -------------------------------------------------------------------------
 * 2. Ce que le Redacteur en sait
 * ---------------------------------------------------------------------- */

describe("instructions du Redacteur", () => {
  const section = (): string => {
    const debut = INSTRUCTIONS_REDACTEUR.indexOf("OBSERVATIONS DES RELECTURES");
    return debut < 0 ? "" : INSTRUCTIONS_REDACTEUR.slice(debut);
  };

  it("explique d'ou viennent les consignes", () => {
    expect(section()).toMatch(/relect/i);
  });

  it("dit qu'une consigne ne LEVE aucune regle", () => {
    // Le point le plus important du cadrage : une remarque humaine oriente
    // l'ecriture, elle n'autorise rien. Sans cette phrase, une note maladroite
    // — « sois moins prudent sur les chiffres » — se lirait comme une
    // permission.
    expect(section()).toMatch(/ne (leve|dispense|remplace)|aucune regle|ne t'autorise/i);
  });

  it("dit qu'une consigne n'est pas une SOURCE", () => {
    // Une observation de relecteur ne fonde aucun fait : elle ne peut pas
    // devenir la source d'une affirmation.
    expect(section()).toMatch(/pas une source|ne fonde|jamais une source/i);
  });
});

/* -------------------------------------------------------------------------
 * 3. Bout en bout
 * ---------------------------------------------------------------------- */

const adaptateur: SourceAdapter = {
  id: "fred:test",
  describes: "Serie de test",
  async fetch() {
    return {
      requestedUrl: "https://fred.stlouisfed.org/series/TEST",
      raw: {},
      observations: [
        {
          source: "FRED",
          url: "https://fred.stlouisfed.org/series/TEST",
          date_observed: "2026-09-09T09:00:00Z",
          date_published: "2026-09-08T10:00:00Z",
          type: "donnee-macro",
          resume: "Le taux effectif s'etablit a 4,33 % au 1er juillet 2026.",
        },
      ],
    };
  },
};

describe("branchement — les surfaces de production lisent les relectures", () => {
  /**
   * Le repertoire est injecte, donc oubliable : sans lui, le pipeline sait lire
   * les consignes et personne ne le lui demande. C'est le piege deja rencontre
   * quatre fois ici — une regle absente du gate, une fonction de rendu jamais
   * appelee, un champ absent du format de reponse, un registre jamais passe.
   */
  const RACINE = fileURLToPath(new URL("..", import.meta.url));

  function instanciations(source: string): string[] {
    return source
      .split("new EditorialPipeline({")
      .slice(1)
      .map((bloc) => bloc.split(".run(")[0] ?? "");
  }

  for (const fichier of ["src/cli.ts", "src/studio/server.ts"]) {
    it(`${fichier} passe le repertoire des articles valides`, async () => {
      const source = await readFile(join(RACINE, fichier), "utf8");
      const blocs = instanciations(source);
      expect(blocs.length, `aucun pipeline dans ${fichier}`).toBeGreaterThan(0);
      for (const [i, bloc] of blocs.entries()) {
        expect(bloc, `${fichier} — pipeline n°${i + 1} sans publishedDir`).toMatch(
          /publishedDir/,
        );
      }
    });
  }
});

describe("bout en bout — la consigne atteint le Redacteur", () => {
  it("TRANSMET les notes de relecture au redacteur", async () => {
    const publies = join(racine, "articles");
    await attester(
      publies,
      "ancien",
      "parler des consequences dans les regions touchees et des actions des gouvernements",
      "2026-09-18T10:00:00Z",
    );

    let vuParLeRedacteur = "";
    const redacteur: MockResponder = (requete) => {
      vuParLeRedacteur = requete.user;
      return (ADAPTIVE_RESPONDERS["redacteur"] as MockResponder)(requete);
    };

    const audit = new AuditLog({ dir: join(racine, "audit") });
    const r = await new EditorialPipeline({
      ctx: {
        llm: new MockLlmClient({
          audit,
          responders: { ...ADAPTIVE_RESPONDERS, redacteur },
        }),
        audit,
      },
      adapters: [adaptateur],
      publishedDir: publies,
      editeur: new Editeur(
        join(racine, "output"),
        new EditorialChangelog(join(racine, "changelog-editorial.md")),
      ),
    }).run("taux directeur");

    expect(r.status, JSON.stringify(r)).toBe("published");
    expect(vuParLeRedacteur).toMatch(/consequences dans les regions touchees/);
  });

  it("publie NORMALEMENT quand aucune relecture n'a laisse de note", async () => {
    const audit = new AuditLog({ dir: join(racine, "audit") });
    const r = await new EditorialPipeline({
      ctx: { llm: new MockLlmClient({ audit, responders: ADAPTIVE_RESPONDERS }), audit },
      adapters: [adaptateur],
      publishedDir: join(racine, "vide"),
      editeur: new Editeur(
        join(racine, "output"),
        new EditorialChangelog(join(racine, "changelog-editorial.md")),
      ),
    }).run("taux directeur");

    expect(r.status, JSON.stringify(r)).toBe("published");
  });
});

/**
 * INFOGRAPHIE — le pipeline ENREGISTRE l'ecart, et remonte le signal.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Derniere piece du brief du 2026-09-18 : « Enregistre chaque indicateur dans
 * le stockage de suivi du projet », puis « si les ecarts vont dans le meme sens
 * sur 3 periodes consecutives ou plus, remonte-le au Redacteur en chef ».
 *
 * LE REGISTRE EST INJECTE, ET SANS LUI RIEN N'EST ECRIT. C'est la decision
 * centrale de ce fichier, et elle protege le depot : `SuiviIndicateurs` ecrit
 * par defaut dans `data/tracking/`, a la racine. La suite de tests instancie des
 * pipelines par dizaines ; une persistance implicite remplirait d'articles
 * fictifs un fichier dont toute la raison d'etre est qu'on n'y reecrit jamais.
 * Le CLI passera le registre explicitement ; un test qui l'oublie n'ecrit rien.
 *
 * UNE PANNE DU REGISTRE NE FAIT PAS ECHOUER UNE PUBLICATION DEJA ACQUISE.
 * L'article est ecrit sur disque avant cette etape. Laisser remonter une erreur
 * d'ecriture ferait perdre un article publie pour un probleme de suivi — le
 * suivi sert l'article, pas l'inverse.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { ADAPTIVE_RESPONDERS } from "../src/fixtures/adaptive-responders.js";
import { calculerEcart, type EntreeEcart } from "../src/infographie/ecart.js";
import { SuiviIndicateurs, periodeIso } from "../src/infographie/suivi.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import type { SourceAdapter } from "../src/sources/types.js";

const INDICATEUR = "taux_directeur_effectif";

/** Ecart +0.18, dont 0.12 attribue et 0.06 de residu. */
const INFOGRAPHIE = {
  indicateur: INDICATEUR,
  libelle: "Taux effectif des fonds federaux",
  unite: "points de %",
  anticipe: {
    value: 4.15,
    source: "Consensus Reuters de juin 2026",
    date: "2026-06-12",
  },
  realise: {
    value: 4.33,
    source: "FRED, serie TEST",
    date: "2026-07-01",
  },
  composantes: [
    {
      name: "prime de terme",
      value: 0.12,
      method: "publiee" as const,
      source: "https://fred.stlouisfed.org/series/TEST",
    },
  ],
};

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

function candidatesDe(request: { user: string }) {
  const p = JSON.parse(request.user) as {
    observations_retenues: Array<{
      url: string;
      tier: number;
      date_observed: string;
      date_published: string | null;
    }>;
  };
  const e = p.observations_retenues[0]!;
  return [
    {
      id: "claim-1",
      type: "fait",
      text: "Le taux effectif s'etablit a 4,33 % au 1er juillet 2026.",
      proposed_evidence_level: 2,
      rationale:
        "Reprise directe de la serie publiee, sans retraitement : la valeur et " +
        "sa date proviennent de l'emetteur.",
      sources: [
        {
          url: e.url,
          tier: e.tier,
          date_observed: e.date_observed,
          date_published: e.date_published,
        },
      ],
    },
  ];
}

const analysteAvecInfographie: MockResponder = (request) => ({
  candidates: candidatesDe(request),
  narrative_vs_data: "Aucune source secondaire retenue.",
  publication_caveats: ["Serie sujette a revision."],
  infographie: INFOGRAPHIE,
});

const analysteSansInfographie: MockResponder = (request) => ({
  candidates: candidatesDe(request),
  narrative_vs_data: "Aucune source secondaire retenue.",
  publication_caveats: ["Serie sujette a revision."],
});

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "media-suivi-pipeline-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function run(analyste: MockResponder, suivi?: SuiviIndicateurs) {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  return new EditorialPipeline({
    ctx: {
      llm: new MockLlmClient({
        audit,
        responders: { ...ADAPTIVE_RESPONDERS, analyste },
      }),
      audit,
    },
    adapters: [adaptateur],
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(join(workDir, "changelog-editorial.md")),
    ),
    ...(suivi === undefined ? {} : { suivi }),
  }).run("taux directeur");
}

/** Ecart deja calcule, pour pre-remplir le registre. */
function ecart(valeurRealisee: number) {
  const entree: EntreeEcart = {
    ...INFOGRAPHIE,
    realise: { ...INFOGRAPHIE.realise, value: valeurRealisee },
  };
  const r = calculerEcart(entree);
  if (!r.ok) throw new Error(`entree de test invalide : ${r.motif}`);
  return r.ecart;
}

/* -------------------------------------------------------------------------
 * 1. Rien n'est ecrit sans registre
 * ---------------------------------------------------------------------- */

describe("persistance — le registre est injecte", () => {
  it("n'ecrit RIEN quand aucun registre n'est fourni", async () => {
    // Sans cette garantie, chaque test du depot ecrirait dans data/tracking/.
    const r = await run(analysteAvecInfographie);
    expect(r.status, JSON.stringify(r)).toBe("published");
    if (r.status !== "published") return;

    await expect(readdir(join(workDir, "tracking"))).rejects.toThrow();
    // Et AUCUNE tentative : constater l'absence de fichier ne suffirait pas,
    // un code qui essaie puis echoue laisse lui aussi le disque intact. Sans
    // cette seconde assertion, retirer la garde `suivi !== undefined` passerait
    // inapercu — l'erreur serait simplement rattrapee plus loin.
    expect(r.warnings.find((w) => w.rule === "SUIVI_INDISPONIBLE")).toBeUndefined();
  });

  it("enregistre l'ecart quand un registre est fourni", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    const r = await run(analysteAvecInfographie, suivi);
    expect(r.status, JSON.stringify(r)).toBe("published");
    if (r.status !== "published") return;

    const enregistres = await suivi.lire();
    expect(enregistres).toHaveLength(1);
    const e = enregistres[0]!;
    expect(e.indicator).toBe(INDICATEUR);
    expect(e.gap).toBeCloseTo(0.18, 10);
    expect(e.residual).toBeCloseTo(0.06, 10);
    expect(e.article_id).toBe(r.article.id);
    // Le graphique est INLINE dans l'article : le fichier qui le porte est
    // l'article lui-meme. Un enregistrement qui ne renverrait a rien rendrait
    // la comparaison entre editions inverifiable.
    expect(e.chart_file).toBe(r.markdownPath);
    // L'article a franchi le gate — dont la regle qui refuse une composante
    // sans source — puis le redacteur en chef.
    expect(e.factchecked).toBe(true);
  });

  it("date l'enregistrement sur la SEMAINE ISO de publication", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    const r = await run(analysteAvecInfographie, suivi);
    if (r.status !== "published") throw new Error("attendu : publie");

    const attendue = periodeIso(new Date(r.article.published_at));
    expect((await suivi.lire())[0]!.period).toBe(attendue);
  });

  it("n'enregistre rien pour un article SANS infographie", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    const r = await run(analysteSansInfographie, suivi);
    expect(r.status).toBe("published");
    expect(await suivi.lire()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 2. Le signal au Redacteur en chef
 * ---------------------------------------------------------------------- */

describe("signal — trois periodes de meme sens", () => {
  it("REMONTE le signal a la troisieme periode consecutive", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    // Deux ecarts positifs anterieurs ; celui du pipeline fera le troisieme.
    for (const [periode, realise] of [
      ["2026-W30", 4.28],
      ["2026-W31", 4.31],
    ] as const) {
      await suivi.enregistrerEcart(ecart(realise), {
        period: periode,
        chart_file: "",
        article_id: "article-anterieur",
        factchecked: true,
      });
    }

    const r = await run(analysteAvecInfographie, suivi);
    if (r.status !== "published") throw new Error(`attendu : publie — ${JSON.stringify(r)}`);

    const signal = r.warnings.find((w) => w.rule === "ECARTS_DE_MEME_SENS");
    expect(signal, JSON.stringify(r.warnings)).toBeDefined();
    expect(signal!.severity).toBe("warning");
    expect(signal!.message).toMatch(/3 periodes|trois periodes/i);
    expect(signal!.message).toMatch(new RegExp(INDICATEUR));
  });

  it("ne remonte RIEN a la deuxieme periode : deux points ne font pas une tendance", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    await suivi.enregistrerEcart(ecart(4.28), {
      period: "2026-W30",
      chart_file: "",
      article_id: "article-anterieur",
      factchecked: true,
    });

    const r = await run(analysteAvecInfographie, suivi);
    if (r.status !== "published") throw new Error("attendu : publie");
    expect(r.warnings.find((w) => w.rule === "ECARTS_DE_MEME_SENS")).toBeUndefined();
  });

  it("ne remonte rien quand le sens change", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    // Deux ecarts NEGATIFS : l'ecart du pipeline est positif, la serie
    // courante retombe a un seul element.
    for (const [periode, realise] of [
      ["2026-W30", 4.05],
      ["2026-W31", 4.01],
    ] as const) {
      await suivi.enregistrerEcart(ecart(realise), {
        period: periode,
        chart_file: "",
        article_id: "article-anterieur",
        factchecked: true,
      });
    }

    const r = await run(analysteAvecInfographie, suivi);
    if (r.status !== "published") throw new Error("attendu : publie");
    expect(r.warnings.find((w) => w.rule === "ECARTS_DE_MEME_SENS")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------
 * 3. Le suivi sert l'article, jamais l'inverse
 * ---------------------------------------------------------------------- */

describe("branchement — les surfaces de production passent le registre", () => {
  /**
   * Un registre injecte est un registre OUBLIABLE.
   *
   * Tout ce qui precede prouve que le pipeline SAIT enregistrer ; rien ne
   * prouve que le CLI et le studio le lui demandent. C'est exactement le piege
   * rencontre deux fois dans cette fonctionnalite — une regle ecrite mais
   * absente de DOCUMENT_RULES, une fonction de rendu jamais appelee — et une
   * troisieme fois dans l'histoire du depot, avec le champ `figure` que le
   * format de reponse ne contenait pas. Tout marche, et rien ne se passe.
   *
   * Ce test lit les SOURCES. C'est inhabituel, et c'est assume : la seule autre
   * facon de le verifier serait de lancer le CLI, donc le reseau et un modele.
   */
  const RACINE = fileURLToPath(new URL("..", import.meta.url));

  /** Les blocs d'options de chaque `new EditorialPipeline({ ... })`. */
  function instanciations(source: string): string[] {
    return source
      .split("new EditorialPipeline({")
      .slice(1)
      .map((bloc) => bloc.split(".run(")[0] ?? "");
  }

  for (const fichier of ["src/cli.ts", "src/studio/server.ts"]) {
    it(`${fichier} passe le registre a CHAQUE pipeline`, async () => {
      const source = await readFile(join(RACINE, fichier), "utf8");
      const blocs = instanciations(source);

      expect(blocs.length, `aucun pipeline instancie dans ${fichier}`).toBeGreaterThan(0);
      for (const [i, bloc] of blocs.entries()) {
        expect(bloc, `${fichier} — pipeline n°${i + 1} sans registre`).toMatch(/suivi/);
      }
    });
  }
});

describe("robustesse", () => {
  it("PUBLIE malgre une panne du registre", async () => {
    // L'article est deja ecrit sur disque quand le suivi intervient. Laisser
    // remonter l'erreur ferait perdre un article publie pour un probleme de
    // journalisation.
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    suivi.enregistrerEcart = async () => {
      throw new Error("disque plein");
    };

    const r = await run(analysteAvecInfographie, suivi);
    expect(r.status, JSON.stringify(r)).toBe("published");
  });

  it("SIGNALE la panne plutot que de l'avaler en silence", async () => {
    const suivi = new SuiviIndicateurs({ dir: join(workDir, "tracking") });
    suivi.enregistrerEcart = async () => {
      throw new Error("disque plein");
    };

    const r = await run(analysteAvecInfographie, suivi);
    if (r.status !== "published") throw new Error("attendu : publie");

    const panne = r.warnings.find((w) => w.rule === "SUIVI_INDISPONIBLE");
    expect(panne, JSON.stringify(r.warnings)).toBeDefined();
    expect(panne!.message).toMatch(/disque plein/);
  });
});

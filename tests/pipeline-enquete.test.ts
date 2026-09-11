/**
 * L'Investigateur branche au pipeline (§5.3, format long).
 *
 * Ces tests portent sur les TROIS points ou le mode `enquete` doit se
 * comporter autrement que les autres, et ou une erreur ne se verrait pas :
 *
 *  1. LA CADENCE est verifiee AVANT toute redaction. Un quota controle apres
 *     coup ne limite rien : le texte est deja ecrit, et la tentation de le
 *     publier quand meme est entiere.
 *  2. LE ROUTAGE est verifie sur la matiere REELLEMENT collectee, pas sur
 *     l'intention de depart. Un sujet peut sembler meriter une enquete et ne
 *     ramener que deux documents d'un meme emetteur.
 *  3. LE REFUS de l'agent arrete le pipeline proprement, avec son motif. Une
 *     piste abandonnee n'est pas une panne.
 *
 * Ils ecrivent dans un repertoire temporaire : ni `output/`, ni `audit/`, ni
 * le changelog du projet ne sont touches.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { MOCK_RESPONDERS } from "../src/fixtures/mock-scenario.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline, type PipelineResult } from "../src/pipeline.js";
import type { Investigation } from "../src/planification/investigation.js";
import { MOCK_ADAPTERS } from "../src/sources/mock-sources.js";
import type { SourceAdapter } from "../src/sources/types.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "enquete-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Doublure des DEUX passes.
 *
 * Les deux agents portent le meme role `investigateur` : la doublure les
 * distingue par `schemaName`. Sans cela, elle rendrait un plan la ou un
 * chapitre est attendu, et le schema rejetterait la reponse — un echec qui
 * ressemblerait a un defaut du pipeline.
 */
const PLAN_PUBLIABLE = {
  publiable: true,
  motif_de_refus: null,
  title: "Une enquete conforme",
  resume_en_bref: "Le fait, sa portee, son incertitude.",
  chapitres: [
    { role: "etabli", titre: "Ce que les donnees etablissent", angle: "les chiffres" },
    { role: "contradictoire", titre: "Le versant rassurant", angle: "la lecture inverse" },
    { role: "echeances", titre: "Prochaines echeances a surveiller", angle: "la suite" },
  ],
  glossaire: [{ terme: "IPCH", definition: "indice harmonise" }],
  bibliographie: { primaires: ["Emetteur officiel"], secondaires: [], hypotheses: [] },
  uncertainty_flags: [],
};

/** Chapitre assez long pour que l ensemble franchisse le plancher de 1500. */
const CHAPITRE_ECRIT = {
  corps: Array.from({ length: 700 }, (_, i) => `mot${i % 83}`).join(" "),
};

const investigateurEnDeuxPasses: MockResponder = (req) =>
  req.schemaName === "PlanEnquete" ? PLAN_PUBLIABLE : CHAPITRE_ECRIT;

/**
 * Sources supplementaires, propres a ces tests.
 *
 * La fixture standard plafonne a trois observations, dont deux retenues — sous
 * le plancher de quatre exige pour une enquete. Ce n'est pas un defaut de la
 * fixture : c'est la regle qui fonctionne. Un scenario de breve NE DOIT PAS
 * pouvoir declencher une enquete, et abaisser le seuil pour faire passer un
 * test reviendrait a supprimer la regle qu'on teste.
 *
 * On fournit donc la matiere qu'un vrai sujet d'enquete apporterait.
 */
const SOURCES_SUPPLEMENTAIRES: SourceAdapter[] = [
  ["bce:communique", "https://www.ecb.europa.eu/press/zembla-2026", "BCE"],
  ["ins:bulletin", "https://institut-statistique.test/bulletin-2026", "Institut statistique"],
].map(([id, url, source]) => ({
  id: id as string,
  describes: `Source d'appoint ${id}`,
  fetch: async () => ({
    observations: [
      {
        source: source as string,
        url: url as string,
        date_observed: new Date().toISOString(),
        date_published: new Date(Date.now() - 86_400_000).toISOString(),
        type: "communique",
        resume: `Element documentaire complementaire publie par ${source}.`,
      },
    ],
    raw: {},
    requestedUrl: url as string,
  }),
}));

/** Selection retenant TOUTES les observations, pour atteindre le plancher. */
const VEILLEUR_LARGE: MockResponder = () => ({
  retained: [
    "https://fred.stlouisfed.org/series/ZEMBLAPOLRATE",
    "https://comtrade.un.org/data/ZMB/202607",
    "https://www.ecb.europa.eu/press/zembla-2026",
    "https://institut-statistique.test/bulletin-2026",
  ].map((url) => ({ url, selection_reason: "matiere d'enquete" })),
  set_aside: [
    {
      url: "https://gnews.io/articles/zembla-monetary-tightening",
      reason: "reprise de presse sans element propre",
    },
  ],
  freshness_assessment: "sources publiees dans la fenetre retenue",
  primary_source_available: true,
});

async function lancer(options: {
  responders?: Record<string, MockResponder>;
  investigations?: readonly Investigation[];
}): Promise<PipelineResult> {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  const pipeline = new EditorialPipeline({
    ctx: {
      llm: new MockLlmClient({
        audit,
        responders: {
          ...MOCK_RESPONDERS,
          veilleur: VEILLEUR_LARGE,
          investigateur: investigateurEnDeuxPasses,
          ...options.responders,
        },
      }),
      audit,
    },
    adapters: [...MOCK_ADAPTERS, ...SOURCES_SUPPLEMENTAIRES],
    mode: "enquete",
    investigations: options.investigations ?? [],
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(join(workDir, "changelog.md")),
    ),
  });
  return pipeline.run("ecart entre deux mesures officielles, mecanisme a demonter");
}

describe("mode enquete — cadence", () => {
  it("refuse d'ouvrir une enquete quand le quota est consomme", async () => {
    const r = await lancer({
      investigations: [
        {
          sujet: "precedente",
          ouverte_le: new Date(Date.now() - 86_400_000).toISOString(),
          statut: "publiee",
          article_id: "article-00000000-0000-4000-8000-000000000000",
        },
      ],
    });
    expect(r.status).toBe("halted");
    if (r.status !== "halted") return;
    expect(r.reason).toMatch(/quota|cadence/i);
  });

  it("verifie la cadence AVANT d'appeler l'Investigateur", async () => {
    // Le point entier du quota. S'il etait controle apres la redaction, le
    // texte existerait deja — et un texte ecrit finit par etre publie.
    let appele = false;
    const r = await lancer({
      responders: {
        investigateur: (req) => {
          appele = true;
          return investigateurEnDeuxPasses(req);
        },
      },
      investigations: [
        {
          sujet: "precedente",
          ouverte_le: new Date().toISOString(),
          statut: "en-cours",
          article_id: null,
        },
      ],
    });
    expect(r.status).toBe("halted");
    expect(appele, "l'Investigateur n'aurait pas du etre appele").toBe(false);
  });

  it("laisse passer quand aucune enquete recente ne consomme le quota", async () => {
    const r = await lancer({ investigations: [] });
    expect(r.status).toBe("published");
  });
});

describe("mode enquete — refus de l'agent", () => {
  it("arrete le pipeline avec le MOTIF, sans en faire une panne", async () => {
    const r = await lancer({
      responders: {
        investigateur: () => ({
          ...PLAN_PUBLIABLE,
          publiable: false,
          motif_de_refus: "emetteur unique : aucun recoupement possible",
          title: null,
          resume_en_bref: null,
          chapitres: [],
        }),
      },
    });
    expect(r.status).toBe("halted");
    if (r.status !== "halted") return;
    expect(r.stage).toBe("redaction");
    expect(r.reason).toMatch(/recoupement|piste|renonc/i);
    expect(r.details.join(" ")).toMatch(/emetteur unique/);
  });
});

describe("mode enquete — article produit", () => {
  it("porte le mode `enquete` dans le contrat §7", async () => {
    const r = await lancer({});
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(r.article.mode).toBe("enquete");
  });

  it("cree l'Investigateur parmi les agents auteurs, pas le Redacteur", async () => {
    const r = await lancer({});
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(r.article.authors_agents).toContain("investigateur");
    expect(r.article.authors_agents).not.toContain("redacteur");
  });

  it("franchit les regles de structure du format long", async () => {
    const r = await lancer({});
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    const noms = r.warnings.map((w) => w.rule);
    for (const regle of [
      "ENQUETE_TROP_COURTE",
      "ENQUETE_SANS_CONTRADICTOIRE",
      "ENQUETE_SANS_GLOSSAIRE",
      "ENQUETE_BIBLIO_NON_SEPAREE",
      "ENQUETE_SANS_ECHEANCES",
    ]) {
      expect(noms, regle).not.toContain(regle);
    }
  });
});

describe("les autres modes ne changent pas", () => {
  it("un constat continue de passer par le Redacteur", async () => {
    const audit = new AuditLog({ dir: join(workDir, "audit") });
    let investigateurAppele = false;
    const pipeline = new EditorialPipeline({
      ctx: {
        llm: new MockLlmClient({
          audit,
          responders: {
            ...MOCK_RESPONDERS,
            investigateur: (req) => {
              investigateurAppele = true;
              return investigateurEnDeuxPasses(req);
            },
          },
        }),
        audit,
      },
      adapters: MOCK_ADAPTERS,
      editeur: new Editeur(
        join(workDir, "output"),
        new EditorialChangelog(join(workDir, "changelog.md")),
      ),
    });
    const r = await pipeline.run("sujet ordinaire");
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(investigateurAppele).toBe(false);
    expect(r.article.authors_agents).toContain("redacteur");
  });
});

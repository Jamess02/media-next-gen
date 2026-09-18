/**
 * INFOGRAPHIE — le dernier maillon : l'Analyste la PRODUIT, le pipeline la
 * transporte.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le calcul, le rendu, le registre, le contrat et la page sont deja tenus par du
 * code teste. Il manque ce qui les alimente — et c'est exactement la ou le
 * projet s'est deja fait prendre. Le commentaire de `figure` dans
 * `AnalysteOutputSchema` le raconte :
 *
 *   « ABSENT DE CE SCHEMA, il etait inatteignable : le format de reponse envoye
 *   au modele ne le contenait pas, donc aucun modele ne pouvait le produire —
 *   et le champ est reste vide en execution reelle alors que tout le reste de
 *   la chaine etait pret. »
 *
 * C'est litteralement la situation presente. D'ou trois maillons verifies ici,
 * chacun capable de rompre la chaine SANS que rien n'echoue :
 *
 *  1. le schema de sortie de l'agent accepte le champ — sinon le modele ne peut
 *     pas le produire ;
 *  2. les instructions le decrivent — sinon le modele ignore qu'il existe ;
 *  3. le pipeline le transporte jusqu'a l'article — sinon il meurt a
 *     l'assemblage.
 *
 * Le test decisif est le quatrieme : de bout en bout, jusqu'a la page.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import {
  AnalysteOutputSchema,
  INSTRUCTIONS_ANALYSTE,
} from "../src/agents/analyste.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { ADAPTIVE_RESPONDERS } from "../src/fixtures/adaptive-responders.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline } from "../src/pipeline.js";
import { articlePage } from "../src/site/templates.js";
import type { SourceAdapter } from "../src/sources/types.js";

/**
 * Infographie coherente : ecart 4.33 - 4.15 = 0.18, dont 0.12 attribue et 0.06
 * de residu. Elle DOIT etre valide, sans quoi la regle du gate refuserait
 * l'article et le test echouerait pour une raison etrangere a son sujet.
 */
const INFOGRAPHIE = {
  indicateur: "taux_directeur_effectif",
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

/** Claims minimales et sourcees, communes aux deux analystes de ce fichier. */
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

/** Analyste qui produit une infographie en plus de ses claims. */
const analysteAvecInfographie: MockResponder = (request) => ({
  candidates: candidatesDe(request),
  narrative_vs_data: "Aucune source secondaire retenue.",
  publication_caveats: ["Serie sujette a revision."],
  infographie: INFOGRAPHIE,
});

/** Le meme, sans infographie : le cas NORMAL, qui doit rester publiable. */
const analysteSansInfographie: MockResponder = (request) => ({
  candidates: candidatesDe(request),
  narrative_vs_data: "Aucune source secondaire retenue.",
  publication_caveats: ["Serie sujette a revision."],
});

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "media-infographie-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function run(analyste: MockResponder) {
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
  }).run("taux directeur");
}

/* -------------------------------------------------------------------------
 * 1. Le format de reponse envoye au modele
 * ---------------------------------------------------------------------- */

describe("format de reponse de l'Analyste", () => {
  it("ACCEPTE une infographie : sans cela, aucun modele ne peut la produire", () => {
    const parsed = AnalysteOutputSchema.safeParse({
      candidates: [],
      narrative_vs_data: "",
      publication_caveats: [],
      infographie: INFOGRAPHIE,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("la laisse OPTIONNELLE : la plupart des sujets n'ont pas d'anticipation datee", () => {
    const parsed = AnalysteOutputSchema.safeParse({
      candidates: [],
      narrative_vs_data: "",
      publication_caveats: [],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REFUSE une infographie mal formee, des le format de reponse", () => {
    const parsed = AnalysteOutputSchema.safeParse({
      candidates: [],
      narrative_vs_data: "",
      publication_caveats: [],
      infographie: { ...INFOGRAPHIE, anticipe: { ...INFOGRAPHIE.anticipe, date: "" } },
    });
    expect(parsed.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 2. Ce que les instructions disent au modele
 * ---------------------------------------------------------------------- */

describe("instructions de l'Analyste", () => {
  /**
   * La section INFOGRAPHIE, ISOLEE du reste du prompt.
   *
   * Les assertions portent sur elle seule, et non sur les instructions
   * entieres. La raison a ete constatee par mutation : « n'invente » figure
   * deja dans la consigne sur les chiffres structures — « N'invente jamais une
   * valeur pour completer un tableau » — si bien que le test passait meme apres
   * suppression de l'interdiction portant sur la DECOMPOSITION. Les mots
   * « date » et « publiee » sont loges a la meme enseigne dans un prompt de
   * cette taille.
   *
   * Consequence voulue : si la section disparait, cette fonction rend une
   * chaine vide et TOUS les tests de ce bloc tombent.
   */
  const section = (): string => {
    const debut = INSTRUCTIONS_ANALYSTE.indexOf("INFOGRAPHIE —");
    if (debut < 0) return "";
    const fin = INSTRUCTIONS_ANALYSTE.indexOf("Contraintes :", debut);
    return INSTRUCTIONS_ANALYSTE.slice(debut, fin < 0 ? undefined : fin);
  };

  it("DECRIT l'infographie : un champ que le prompt ignore reste vide", () => {
    expect(section()).toMatch(/infographie/i);
  });

  it("pose la regle dure : sans anticipation datee et sourcee, aucun ecart", () => {
    expect(section()).toMatch(/sans anticipation datee et sourcee/i);
  });

  it("nomme les trois methodes, et le residu", () => {
    for (const methode of ["publiee", "estimee", "incertaine"]) {
      expect(section(), methode).toContain(methode);
    }
    expect(section()).toMatch(/residu/i);
  });

  it("INTERDIT de fabriquer une decomposition", () => {
    // Le brief est explicite : « Si les donnees ne permettent pas une
    // decomposition defendable, n'en fabrique pas. » L'interdiction doit porter
    // sur la DECOMPOSITION, d'ou les deux termes lies dans la meme phrase.
    expect(section()).toMatch(/n'invente[^.]*decomposition/i);
  });

  it("exige de SIGNALER les composantes correlees", () => {
    // Derniere exigence du brief encore absente de la chaine : « Ne presente
    // pas des composantes correlees comme independantes. »
    expect(section()).toMatch(/correlees/i);
  });
});

/* -------------------------------------------------------------------------
 * 3. De bout en bout
 * ---------------------------------------------------------------------- */

describe("bout en bout — de l'Analyste jusqu'a la page", () => {
  it("TRANSPORTE l'infographie jusqu'a l'article publie", async () => {
    const r = await run(analysteAvecInfographie);
    expect(r.status, JSON.stringify(r)).toBe("published");
    if (r.status !== "published") return;

    expect(r.article.infographie).toBeDefined();
    expect(r.article.infographie?.indicateur).toBe("taux_directeur_effectif");
  });

  it("rend le graphique sur la page de cet article", async () => {
    const r = await run(analysteAvecInfographie);
    if (r.status !== "published") throw new Error("attendu : publie");

    const html = articlePage(r.article);
    expect(html).toContain('<figure class="figure-ecart">');
    expect(html).toContain("Taux effectif des fonds federaux");
  });

  it("publie TOUJOURS un article sans infographie : c'est le cas normal", async () => {
    const r = await run(analysteSansInfographie);
    expect(r.status, JSON.stringify(r)).toBe("published");
    if (r.status !== "published") return;
    expect(r.article.infographie).toBeUndefined();
  });
});

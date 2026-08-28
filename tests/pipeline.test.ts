/**
 * Bout en bout : le pipeline complet (§5) sur le scenario simule.
 *
 * Ces tests ecrivent dans un repertoire temporaire : ils ne touchent ni
 * `output/`, ni `audit/`, ni `changelog-editorial.md` du projet.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Editeur } from "../src/agents/editeur.js";
import { AuditLog } from "../src/audit/audit-log.js";
import { EditorialChangelog } from "../src/editorial/changelog.js";
import { MOCK_RESPONDERS } from "../src/fixtures/mock-scenario.js";
import { MockLlmClient, type MockResponder } from "../src/llm/mock-client.js";
import { EditorialPipeline, type PipelineResult } from "../src/pipeline.js";
import { MOCK_ADAPTERS } from "../src/sources/mock-sources.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "media-next-gen-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runPipeline(
  overrides: Record<string, MockResponder> = {},
): Promise<{ result: PipelineResult; audit: AuditLog; changelogPath: string }> {
  const audit = new AuditLog({ dir: join(workDir, "audit") });
  const changelogPath = join(workDir, "changelog-editorial.md");
  const pipeline = new EditorialPipeline({
    ctx: {
      llm: new MockLlmClient({
        audit,
        responders: { ...MOCK_RESPONDERS, ...overrides },
      }),
      audit,
    },
    adapters: MOCK_ADAPTERS,
    editeur: new Editeur(
      join(workDir, "output"),
      new EditorialChangelog(changelogPath),
    ),
  });
  return { result: await pipeline.run("test"), audit, changelogPath };
}

describe("chaine de publication complete", () => {
  it("publie l'article du scenario simule", async () => {
    const { result } = await runPipeline();
    expect(result.status).toBe("published");
  });

  it("applique le clamp monotone malgre un fact-checker defaillant", async () => {
    // Le scenario simule contient un fact-checker qui tente de promouvoir
    // claim-3 (inference) en fait et de remonter son niveau de 3 a 4.
    const { result } = await runPipeline();
    if (result.status !== "published") throw new Error("attendu : publie");

    const claim3 = result.article.claims.find((c) => c.id === "claim-3");
    expect(claim3?.type).toBe("inférence");
    expect(claim3?.evidence_level).toBe(3);
    expect(result.adjustments.join(" ")).toMatch(/promotion .* refusee/);
    expect(result.adjustments.join(" ")).toMatch(/remontee de niveau/);
  });

  it("ne presente jamais une claim publiee comme ecartee (§7)", async () => {
    const { result } = await runPipeline();
    if (result.status !== "published") throw new Error("attendu : publie");

    // `excluded_claims` ne contient que des rejets. Une claim presente dans
    // l'article ne doit jamais y etre annoncee comme retiree.
    const publishedIds = result.article.claims.map((c) => c.id);
    for (const excluded of result.article.editorial_notes.excluded_claims) {
      for (const id of publishedIds) {
        expect(excluded.startsWith(`${id} :`)).toBe(false);
      }
    }
    // Les ajustements restent visibles, mais du bon cote.
    expect(result.article.editorial_notes.uncertainty_flags.join(" ")).toMatch(
      /Ajustement du fact-checker/,
    );
  });

  it("ecarte la reprise de presse au profit de la source primaire (EP-001)", async () => {
    const { result } = await runPipeline();
    if (result.status !== "published") throw new Error("attendu : publie");

    const urls = result.article.claims.flatMap((c) => c.sources.map((s) => s.url));
    expect(urls.some((u) => u.includes("gnews.io"))).toBe(false);
    expect(urls.some((u) => u.includes("fred.stlouisfed.org"))).toBe(true);
  });

  it("remonte la source indisponible dans les incertitudes (EP-003)", async () => {
    const { result } = await runPipeline();
    if (result.status !== "published") throw new Error("attendu : publie");
    expect(result.article.editorial_notes.uncertainty_flags.join(" ")).toMatch(
      /reliefweb/i,
    );
  });

  it("journalise chaque appel externe (§9.4)", async () => {
    const { result, audit } = await runPipeline();
    expect(result.status).toBe("published");

    const entries = audit.entries();
    // 4 adaptateurs de source (dont un en echec) + 5 agents LLM.
    expect(entries.filter((e) => e.kind === "source")).toHaveLength(4);
    expect(entries.filter((e) => e.kind === "llm")).toHaveLength(5);
    // L'echec est journalise, pas avale.
    expect(entries.some((e) => e.error !== undefined)).toBe(true);
    // Chaque enregistrement pointe vers une archive brute.
    expect(entries.every((e) => e.raw_sha256.length === 64)).toBe(true);
  });

  it("consigne la publication dans le changelog versionne (§6 / §9.6)", async () => {
    const { result, changelogPath } = await runPipeline();
    expect(result.status).toBe("published");

    const changelog = await readFile(changelogPath, "utf8");
    expect(changelog).toMatch(/Publication initiale/);
    expect(changelog).toMatch(/append-only/);
  });

  it("affiche type, niveau de preuve et sources dans le markdown publie", async () => {
    const { result } = await runPipeline();
    if (result.status !== "published") throw new Error("attendu : publie");

    const markdown = await readFile(result.markdownPath, "utf8");
    expect(markdown).toMatch(/\*\*Niveau de preuve\*\* : 3/);
    expect(markdown).toMatch(/\*\*Type\*\* : `inférence`/);
    expect(markdown).toMatch(/tier 1 \(Source primaire\)/);
    expect(markdown).toMatch(/ne constitue ni un conseil d'investissement/);
  });
});

describe("arrets du pipeline", () => {
  it("s'arrete si les claims restent sous le niveau 2 meme apres reformulation (§9.3)", async () => {
    const { result } = await runPipeline({
      "fact-checker": () => ({
        verdicts: ["claim-1", "claim-2", "claim-3"].map((id) => ({
          claim_id: id,
          verdict: "abaisse",
          adjusted_evidence_level: 1,
          adjusted_type: "inférence",
          justification: "La source ne soutient pas l'affirmation.",
          reformulated_text: null,
        })),
        conflicts_found: [],
      }),
    });

    expect(result.status).toBe("halted");
    if (result.status !== "halted") return;
    expect(result.stage).toBe("fact-checking");
    expect(result.reason).toMatch(/meme apres reformulation/);
    // Les motifs des deux passes sont remontes : 3 claims x 2 passes.
    expect(result.details).toHaveLength(6);
  });

  it("tente UNE seconde passe de reformulation avant d'abandonner (§9.3)", async () => {
    let call = 0;
    const { result } = await runPipeline({
      "fact-checker": () => {
        call += 1;
        // 1re passe : tout echoue. 2e passe : claim-1 est sauvee en scenario.
        if (call === 1) {
          return {
            verdicts: ["claim-1", "claim-2", "claim-3"].map((id) => ({
              claim_id: id,
              verdict: "abaisse",
              adjusted_evidence_level: 1,
              adjusted_type: "inférence",
              justification: "Affirmation trop forte pour les sources.",
              reformulated_text: null,
            })),
            conflicts_found: [],
          };
        }
        return {
          verdicts: [
            {
              claim_id: "claim-1",
              verdict: "reformule",
              adjusted_evidence_level: 2,
              adjusted_type: "scénario",
              justification: "Restituee en hypothese explicite.",
              reformulated_text:
                "[SIMULATION] Si le resserrement se poursuit, une pression sur le compte courant devient plausible.",
            },
            {
              claim_id: "claim-2",
              verdict: "rejete",
              adjusted_evidence_level: 0,
              adjusted_type: "estimation",
              justification: "Insoutenable meme reformulee.",
              reformulated_text: null,
            },
            {
              claim_id: "claim-3",
              verdict: "rejete",
              adjusted_evidence_level: 0,
              adjusted_type: "inférence",
              justification: "Insoutenable meme reformulee.",
              reformulated_text: null,
            },
          ],
          conflicts_found: [],
        };
      },
      // Le corps ne doit referencer que la claim survivante.
      redacteur: () => ({
        title: "[SIMULATION] Lecture prudente d'un resserrement monetaire",
        body: "Si le resserrement se poursuit, une pression sur le compte courant devient plausible [[claim-1]].",
        uncertainty_flags: [],
      }),
    });

    expect(call).toBe(2);
    expect(result.status).toBe("published");
    if (result.status !== "published") return;

    expect(result.article.claims).toHaveLength(1);
    expect(result.article.claims[0]?.type).toBe("scénario");
    // EP-003 : le lecteur doit savoir que l'article est un repli en hypotheses.
    expect(result.article.editorial_notes.uncertainty_flags.join(" ")).toMatch(
      /reecrit en hypotheses explicites/,
    );
  });

  it("ne boucle pas indefiniment : au plus deux passes de fact-checking", async () => {
    let call = 0;
    await runPipeline({
      "fact-checker": () => {
        call += 1;
        return {
          verdicts: ["claim-1", "claim-2", "claim-3"].map((id) => ({
            claim_id: id,
            verdict: "rejete",
            adjusted_evidence_level: 0,
            adjusted_type: "inférence",
            justification: "Rejet systematique.",
            reformulated_text: null,
          })),
          conflicts_found: [],
        };
      },
    });

    // Une boucle non bornee finirait par affaiblir le texte jusqu'a ce qu'il
    // passe, ce qui viderait le gate de son sens.
    expect(call).toBe(2);
  });

  it("s'arrete sur une recommandation implicite reperee par le redacteur en chef (EP-007)", async () => {
    const { result } = await runPipeline({
      "redacteur-en-chef": () => ({
        // Verdict contradictoire : le modele signale une recommandation ET
        // conclut "publier". Le pipeline tranche en faveur du signalement.
        verdict: "publier",
        justification: "RAS.",
        implicit_recommendations: [
          "Les fondamentaux de Zembla restent solides malgre les tensions.",
        ],
        angle_issues: [],
        suggested_split: [],
      }),
    });

    expect(result.status).toBe("halted");
    if (result.status !== "halted") return;
    expect(result.stage).toBe("validation");
    expect(result.details.join(" ")).toMatch(/EP-007/);
  });

  it("s'arrete si le veilleur ne retient aucune source", async () => {
    const { result } = await runPipeline({
      veilleur: () => ({
        retained: [],
        set_aside: [{ url: "https://gnews.io/x", reason: "tier 3 seul" }],
        freshness_assessment: "n/a",
        primary_source_available: false,
      }),
    });

    expect(result.status).toBe("halted");
    if (result.status !== "halted") return;
    expect(result.stage).toBe("selection");
  });
});

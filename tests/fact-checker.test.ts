/**
 * §9.3 — le clamp monotone du gate.
 *
 * Ces tests protegent la propriete de securite centrale du pipeline : le
 * fact-checker LLM ne dispose QUE du pouvoir de degrader. Si l'un d'eux tombe,
 * un modele defaillant ou manipule peut ouvrir le gate.
 */

import { describe, expect, it } from "vitest";

import type { AnalysteOutput } from "../src/agents/analyste.js";
import {
  applyVerdicts,
  reconcileTiers,
  type FactCheckerOutput,
} from "../src/agents/fact-checker.js";

type Candidate = AnalysteOutput["candidates"][number];
type Verdict = FactCheckerOutput["verdicts"][number];

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "claim-1",
    text: "Texte de la claim.",
    type: "inférence",
    proposed_evidence_level: 2,
    rationale: "Deduite de deux observations.",
    sources: [
      {
        url: "https://fred.stlouisfed.org/series/TEST",
        tier: 1,
        date_observed: "2026-08-27T09:00:00Z",
        date_published: null,
      },
    ],
    ...overrides,
  };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    claim_id: "claim-1",
    verdict: "accepte",
    adjusted_evidence_level: 2,
    adjusted_type: "inférence",
    justification: "Verifie.",
    reformulated_text: null,
    ...overrides,
  };
}

const output = (verdicts: Verdict[]): FactCheckerOutput => ({
  verdicts,
  conflicts_found: [],
});

describe("clamp du niveau de preuve", () => {
  it("ignore une tentative de remontee du niveau", () => {
    const result = applyVerdicts(
      [candidate({ proposed_evidence_level: 2 })],
      output([verdict({ adjusted_evidence_level: 4 })]),
    );
    expect(result.accepted[0]?.evidence_level).toBe(2);
    expect(result.adjustments.join(" ")).toMatch(/remontee de niveau/);
  });

  it("applique une degradation du niveau", () => {
    const result = applyVerdicts(
      [candidate({ proposed_evidence_level: 4 })],
      output([verdict({ adjusted_evidence_level: 2, verdict: "abaisse" })]),
    );
    expect(result.accepted[0]?.evidence_level).toBe(2);
  });

  it("exclut une claim degradee sous le niveau 2", () => {
    const result = applyVerdicts(
      [candidate({ proposed_evidence_level: 3 })],
      output([
        verdict({
          adjusted_evidence_level: 1,
          verdict: "abaisse",
          justification: "La source ne mentionne pas le chiffre.",
        }),
      ]),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.passed).toBe(false);
    expect(result.excluded[0]).toMatch(/niveau de preuve 1 < 2/);
  });
});

describe("clamp du type de claim (§3 / §8)", () => {
  it("refuse la promotion d'une inference en fait", () => {
    const result = applyVerdicts(
      [candidate({ type: "inférence" })],
      output([verdict({ adjusted_type: "fait" })]),
    );
    expect(result.accepted[0]?.type).toBe("inférence");
    expect(result.adjustments.join(" ")).toMatch(/promotion .* refusee/);
  });

  it("refuse la promotion d'un scenario en fait", () => {
    const result = applyVerdicts(
      [candidate({ type: "scénario" })],
      output([verdict({ adjusted_type: "fait" })]),
    );
    expect(result.accepted[0]?.type).toBe("scénario");
  });

  it("autorise la degradation d'un fait en inference", () => {
    const result = applyVerdicts(
      [candidate({ type: "fait" })],
      output([verdict({ adjusted_type: "inférence" })]),
    );
    expect(result.accepted[0]?.type).toBe("inférence");
  });

  it("laisse un fait rester fait", () => {
    const result = applyVerdicts(
      [candidate({ type: "fait" })],
      output([verdict({ adjusted_type: "fait" })]),
    );
    expect(result.accepted[0]?.type).toBe("fait");
  });
});

describe("verdicts manquants et rejets", () => {
  it("exclut une claim sans verdict : non verifiee = non publiable", () => {
    const result = applyVerdicts([candidate()], output([]));
    expect(result.accepted).toHaveLength(0);
    expect(result.excluded[0]).toMatch(/aucun verdict/);
  });

  it("exclut une claim rejetee", () => {
    const result = applyVerdicts(
      [candidate()],
      output([verdict({ verdict: "rejete", justification: "Source morte." })]),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.excluded[0]).toMatch(/Source morte/);
  });

  it("applique le texte reformule", () => {
    const result = applyVerdicts(
      [candidate()],
      output([
        verdict({
          verdict: "reformule",
          reformulated_text: "Si la tendance se maintient, alors...",
          adjusted_type: "scénario",
        }),
      ]),
    );
    expect(result.accepted[0]?.text).toBe("Si la tendance se maintient, alors...");
  });
});

describe("§4 — reconciliation des tiers", () => {
  it("corrige un tier surevalue par l'analyste", () => {
    const { candidates, corrections } = reconcileTiers([
      candidate({
        sources: [
          {
            url: "https://gnews.io/articles/x",
            tier: 1, // mensonge : gnews.io est tier 3
            date_observed: "2026-08-27T09:00:00Z",
            date_published: null,
          },
        ],
      }),
    ]);
    expect(candidates[0]?.sources[0]?.tier).toBe(3);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ declaredTier: 1, actualTier: 3 });
  });

  it("ne signale rien quand le tier est correct", () => {
    expect(reconcileTiers([candidate()]).corrections).toHaveLength(0);
  });
});

/**
 * Le gate editorial (§2, §3, §4, §6, §8).
 *
 * Chaque test nomme la clause qu'il protege. Si un test tombe, on sait quelle
 * phrase du protocole a cesse d'etre appliquee.
 */

import { describe, expect, it } from "vitest";

import { runEditorialGate, detectIllegalPromotions } from "../src/protocol/rules.js";
import { article, claim } from "./helpers.js";

const blocking = (a: Parameters<typeof runEditorialGate>[0]) =>
  runEditorialGate(a).violations.filter((v) => v.severity === "blocking");

describe("§2 — plancher de niveau de preuve", () => {
  it("bloque une claim sous le niveau 2", () => {
    const result = runEditorialGate(
      article({ claims: [claim({ evidence_level: 1 })] }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("EVIDENCE_FLOOR");
  });

  it("laisse passer une claim au niveau 2", () => {
    expect(
      runEditorialGate(article({ claims: [claim({ evidence_level: 2 })] })).passed,
    ).toBe(true);
  });

  it("bloque un niveau >= 2 annonce sans aucune source", () => {
    const rules = blocking(
      article({ claims: [claim({ evidence_level: 3, sources: [] })] }),
    ).map((v) => v.rule);
    expect(rules).toContain("EVIDENCE_LEVEL_UNBACKED");
  });
});

describe("§3 — plafond de claims structurantes", () => {
  it("bloque au-dela de 3 claims", () => {
    const claims = [1, 2, 3, 4].map((n) => claim({ id: `claim-${n}` }));
    const rules = blocking(article({ claims })).map((v) => v.rule);
    expect(rules).toContain("CLAIM_CEILING");
  });

  it("accepte exactement 3 claims", () => {
    const claims = [1, 2, 3].map((n) => claim({ id: `claim-${n}` }));
    expect(runEditorialGate(article({ claims })).passed).toBe(true);
  });
});

describe("§3 / EP-001 — un fait exige une source primaire", () => {
  it("bloque un `fait` adosse uniquement a de la presse (tier 3)", () => {
    const rules = blocking(
      article({
        claims: [
          claim({
            type: "fait",
            sources: [
              {
                url: "https://gnews.io/articles/x",
                tier: 3,
                date_observed: "2026-08-27T09:00:00Z",
                date_published: null,
              },
            ],
          }),
        ],
      }),
    ).map((v) => v.rule);
    expect(rules).toContain("FACT_NEEDS_PRIMARY_SOURCE");
  });

  it("accepte la meme source pour une `inférence`", () => {
    const rules = blocking(
      article({
        claims: [
          claim({
            type: "inférence",
            evidence_level: 2,
            sources: [
              {
                url: "https://gnews.io/articles/x",
                tier: 3,
                date_observed: "2026-08-27T09:00:00Z",
                date_published: null,
              },
            ],
          }),
        ],
      }),
    ).map((v) => v.rule);
    expect(rules).not.toContain("FACT_NEEDS_PRIMARY_SOURCE");
  });
});

describe("§4 — declaration des sources faibles", () => {
  const weakClaim = claim({
    type: "inférence",
    evidence_level: 2,
    sources: [
      {
        url: "https://acleddata.com/data/x",
        tier: 3,
        date_observed: "2026-08-27T09:00:00Z",
        date_published: null,
      },
    ],
  });

  it("bloque quand tout repose sur du tier 3 sans mention", () => {
    const rules = blocking(article({ claims: [weakClaim] })).map((v) => v.rule);
    expect(rules).toContain("WEAK_TIER_UNDISCLOSED");
  });

  it("passe quand la mention est presente", () => {
    expect(
      runEditorialGate(
        article({
          claims: [weakClaim],
          editorial_notes: {
            uncertainty_flags: [
              "Analyse basee sur des sources secondaires, a confirmer.",
            ],
            excluded_claims: [],
          },
        }),
      ).passed,
    ).toBe(true);
  });
});

describe("§7 — references du corps vers les claims", () => {
  it("bloque une reference vers une claim inexistante", () => {
    const rules = blocking(
      article({ body: "Texte avec [[claim-fantome]]." }),
    ).map((v) => v.rule);
    expect(rules).toContain("DANGLING_CLAIM_REFERENCE");
  });

  it("avertit sans bloquer sur une claim jamais referencee", () => {
    const result = runEditorialGate(article({ body: "Corps sans reference." }));
    expect(result.passed).toBe(true);
    expect(result.violations.map((v) => v.rule)).toContain("CLAIM_NOT_REFERENCED");
  });
});

describe("§6 / EP-004 — corrections", () => {
  it("bloque une revision anterieure a la publication", () => {
    const rules = blocking(
      article({
        published_at: "2026-08-28T10:00:00Z",
        revised_at: "2026-08-01T10:00:00Z",
        changelog: [
          {
            date: "2026-08-01T10:00:00Z",
            type: "factuelle",
            description: "x",
          },
        ],
      }),
    ).map((v) => v.rule);
    expect(rules).toContain("REVISION_BEFORE_PUBLICATION");
  });

  it("bloque une revision sans entree de changelog", () => {
    const rules = blocking(
      article({ revised_at: "2026-08-29T10:00:00Z", changelog: [] }),
    ).map((v) => v.rule);
    expect(rules).toContain("SILENT_REVISION");
  });
});

describe("EP-007 — absence de recommandation", () => {
  it("bloque une recommandation d'investissement explicite", () => {
    const rules = blocking(
      article({ body: "Les investisseurs devraient reduire leur exposition. [[claim-1]]" }),
    ).map((v) => v.rule);
    expect(rules).toContain("RECOMMENDATION_DETECTED");
  });

  it("bloque aussi depuis le titre", () => {
    const rules = blocking(
      article({ title: "Opportunite d'investissement a Zembla" }),
    ).map((v) => v.rule);
    expect(rules).toContain("RECOMMENDATION_DETECTED");
  });

  it("laisse passer une description neutre", () => {
    expect(
      runEditorialGate(
        article({ body: "Le taux directeur passe a 4,50 %. [[claim-1]]" }),
      ).passed,
    ).toBe(true);
  });
});

describe("§3 / §8 — interdiction de promotion", () => {
  it("detecte une inference devenue fait", () => {
    const violations = detectIllegalPromotions(
      [{ id: "claim-1", type: "inférence" }],
      [claim({ id: "claim-1", type: "fait" })],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("ILLEGAL_PROMOTION");
  });

  it("detecte un scenario devenu fait", () => {
    expect(
      detectIllegalPromotions(
        [{ id: "claim-1", type: "scénario" }],
        [claim({ id: "claim-1", type: "fait" })],
      ),
    ).toHaveLength(1);
  });

  it("autorise une estimation a rester estimation", () => {
    expect(
      detectIllegalPromotions(
        [{ id: "claim-1", type: "estimation" }],
        [claim({ id: "claim-1", type: "estimation", evidence_level: 2 })],
      ),
    ).toHaveLength(0);
  });

  it("autorise la degradation d'un fait en inference", () => {
    expect(
      detectIllegalPromotions(
        [{ id: "claim-1", type: "fait" }],
        [claim({ id: "claim-1", type: "inférence" })],
      ),
    ).toHaveLength(0);
  });
});

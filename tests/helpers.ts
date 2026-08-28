import type { Article, Claim } from "../src/protocol/schema.js";

export function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim-1",
    text: "Le taux directeur a ete releve de 25 points de base le 12 aout 2026.",
    type: "fait",
    evidence_level: 3,
    sources: [
      {
        url: "https://fred.stlouisfed.org/series/TEST",
        tier: 1,
        date_observed: "2026-08-27T09:00:00Z",
        date_published: "2026-08-12T14:00:00Z",
      },
    ],
    ...overrides,
  };
}

export function article(overrides: Partial<Article> = {}): Article {
  const claims = overrides.claims ?? [claim()];
  return {
    id: "article-test",
    title: "Titre de test",
    published_at: "2026-08-28T10:00:00Z",
    revised_at: null,
    authors_agents: ["analyste", "fact-checker"],
    claims,
    body: claims.map((c) => `Corps de test [[${c.id}]].`).join("\n"),
    editorial_notes: { uncertainty_flags: [], excluded_claims: [] },
    changelog: [],
    ...overrides,
  };
}

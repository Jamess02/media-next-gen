import { vi } from "vitest";

import type { Article, Claim } from "../src/protocol/schema.js";

/**
 * Remplace `fetch` par un bouchon. Les tests d'adaptateurs ne doivent pas
 * dependre du reseau : ils testeraient la disponibilite d'une API tierce
 * plutot que notre code, et echoueraient hors ligne.
 *
 * Le bouchon expose `text()` et non `json()` : c'est ce que `http.ts` appelle,
 * pour pouvoir citer le corps brut quand une API repond du HTML en HTTP 200.
 */
export function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number; asText?: string } = {},
): void {
  const text = init.asText ?? JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => text,
    })),
  );
}

/** Bouchon qui echoue au niveau reseau, avec un nom d'erreur donne. */
export function stubFetchFailure(name: string, message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const error = new Error(message);
      error.name = name;
      throw error;
    }),
  );
}

/** Derniere URL passee a `fetch`. Verifie ce qu'un adaptateur interroge vraiment. */
export function lastFetchedUrl(): string {
  const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  const call = mock.mock.calls.at(-1);
  return String(call?.[0]);
}

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
    // Format reel produit par le pipeline : `article-<uuid>`. La revision le
    // valide strictement (traversee de chemin), donc les tests l'utilisent.
    id: "article-00000000-0000-4000-8000-000000000000",
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

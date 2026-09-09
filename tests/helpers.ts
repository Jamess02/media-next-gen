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

/**
 * Corps par defaut : un texte REDIGE, pas un collage de claims.
 *
 * Depuis l'ajout de BODY_TOO_THIN et BODY_IS_CLAIM_PASTE (§5.3), un article
 * dont le corps se resume a ses references ne passe plus le gate. Le corps par
 * defaut du helper doit donc ressembler a ce que le protocole attend, sinon
 * chaque test devrait le contourner — et un helper qu'on contourne partout ne
 * sert plus a rien.
 *
 * Il ne reprend AUCUN texte de claim : c'est precisement ce que la regle
 * mesure.
 */
/**
 * Prose de remplissage, en francais, sans aucun texte de claim.
 *
 * Sert aux tests qui veulent eprouver UNE regle precise avec un corps sur
 * mesure : sans elle, chacun tomberait d'abord sur BODY_TOO_THIN et
 * testerait le plancher de redaction au lieu de ce qu'il vise.
 */
export const PROSE_MINIMALE = [
  "",
  "Cet article documente un etat de publication a une date donnee. Il ne " +
    "prolonge pas les donnees au-dela de ce qu'elles portent et distingue a " +
    "chaque etape ce qui releve de l'observation de ce qui n'en releve pas. " +
    "La date de collecte compte autant que la valeur relevee : une meme serie " +
    "consultee deux semaines plus tard peut porter un chiffre different sans " +
    "qu'aucun evenement economique ne se soit produit entre-temps.",
  "",
  "La methode de production compte autant que le resultat. Chaque valeur citee " +
    "provient d'un organisme identifie, couvre une periode nommee et porte une " +
    "date d'observation distincte de sa date de publication. Confondre ces deux " +
    "dates conduit a dater un fait du jour ou on l'a lu plutot que du jour ou " +
    "il s'est produit, ce qui suffit a rendre une comparaison trompeuse.",
  "",
  "Aucun rapprochement entre institutions differentes n'est effectue ici. Deux " +
    "series qui portent le meme nom peuvent reposer sur des perimetres, des " +
    "frequences et des methodes de revision distincts ; les additionner ou les " +
    "comparer sans exposer ces ecarts produirait un chiffre plus precis en " +
    "apparence et moins vrai en pratique.",
  "",
  "Ce qui reste ouvert : la prochaine publication de chaque source dira si les " +
    "valeurs retenues sont revisees, plusieurs des series citees etant sujettes " +
    "a revision apres leur premiere diffusion. Les elements absents du catalogue " +
    "de sources ne sont pas traites, et leur absence ne vaut pas absence de " +
    "fait — elle signale seulement les limites de ce que la collecte a pu " +
    "atteindre a cette date.",
].join("\n");

export function defaultBody(claims: readonly Claim[]): string {
  const paragraphes = claims.map(
    (c, i) =>
      `Le ${["premier", "deuxieme", "troisieme"][i] ?? `${i + 1}e`} element retenu ` +
      `pour cette lecture est adosse a ${c.sources.length} source(s) identifiee(s) ` +
      `et se lit dans la fiche de preuve jointe [[${c.id}]]. Son producteur, la ` +
      `periode couverte et la date d'observation y figurent, de sorte qu'un lecteur ` +
      `puisse remonter a l'emetteur sans dependre de ce texte. Ce que cet element ` +
      `ne dit pas merite d'etre nomme : il ne couvre pas les periodes anterieures ` +
      `a la fenetre de collecte retenue, et ne se prononce pas sur les grandeurs ` +
      `voisines que la meme institution publie separement.`,
  );

  return [
    "Cet article documente un etat de publication a une date donnee. Il ne " +
      "prolonge pas les donnees au-dela de ce qu'elles portent et distingue a " +
      "chaque etape ce qui releve de l'observation de ce qui n'en releve pas. " +
      "La date de collecte compte autant que la valeur relevee : une meme serie " +
      "consultee deux semaines plus tard peut porter un chiffre different sans " +
      "qu'aucun evenement economique ne se soit produit entre-temps.",
    "",
    ...paragraphes.flatMap((p) => [p, ""]),
    "Prises ensemble, ces affirmations decrivent un etat de publication et non " +
      "une dynamique. Aucune n'a fait l'objet d'un recoupement entre sources " +
      "independantes, et le rapprochement de series produites par des " +
      "institutions differentes n'est pas fait ici.",
    "",
    "Ce qui reste ouvert : la prochaine publication de chaque source dira si les " +
      "valeurs retenues sont revisees, plusieurs des series citees etant sujettes " +
      "a revision apres leur premiere diffusion. Les elements absents du catalogue " +
      "de sources ne sont pas traites, et leur absence ne vaut pas absence de " +
      "fait — elle signale seulement les limites de ce que la collecte a pu " +
      "atteindre a cette date.",
  ].join("\n");
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
    body: defaultBody(claims),
    editorial_notes: { uncertainty_flags: [], excluded_claims: [] },
    changelog: [],
    ...overrides,
  };
}

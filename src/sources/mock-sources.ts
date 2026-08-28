/**
 * Adaptateurs simules, pour faire tourner le pipeline hors ligne.
 *
 * Ils exposent EXACTEMENT le meme contrat que des adaptateurs reels : meme
 * interface, meme passage par la passerelle, meme journalisation. Brancher une
 * vraie source revient a remplacer un fichier, pas a modifier le pipeline.
 *
 * Les charges utiles portent sur une economie FICTIVE (la Republique de Zembla)
 * et sont prefixees "[SIMULATION]". Un scaffold ne doit jamais produire des
 * affirmations plausibles sur de vrais Etats : le jour ou la sortie fuite hors
 * de la console, elle doit etre immediatement reconnaissable comme fausse.
 *
 * Les domaines, eux, sont reels : c'est ce qui permet d'exercer reellement la
 * classification en tiers du §4.
 */

import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const SIM = "[SIMULATION]";

/** Tier 1 — serie de taux directeur, source primaire. */
export const fredMockAdapter: SourceAdapter = {
  id: "fred:policy-rate",
  describes: "Taux directeur, serie mensuelle (simulee)",
  async fetch(query: SourceQuery): Promise<FetchOutcome> {
    const requestedUrl =
      "https://fred.stlouisfed.org/graph/fredgraph.csv?id=ZEMBLAPOLRATE" +
      `&cosd=${query.since.slice(0, 10)}`;
    const raw = {
      __simulation: true,
      series_id: "ZEMBLAPOLRATE",
      observations: [
        { date: "2026-06-11", value: "4.25" },
        { date: "2026-07-16", value: "4.25" },
        { date: "2026-08-12", value: "4.50" },
      ],
    };
    return {
      requestedUrl,
      raw,
      observations: [
        {
          source: "FRED",
          url: "https://fred.stlouisfed.org/series/ZEMBLAPOLRATE",
          date_observed: "2026-08-27T09:00:00Z",
          date_published: "2026-08-12T14:00:00Z",
          type: "donnee-macro",
          resume:
            `${SIM} La banque centrale de Zembla a releve son taux directeur ` +
            `de 4,25 % a 4,50 % le 12 aout 2026, soit 25 points de base.`,
        },
      ],
    };
  },
};

/** Tier 1 — donnees douanieres, source primaire mais publiees avec retard. */
export const comtradeMockAdapter: SourceAdapter = {
  id: "comtrade:trade-balance",
  describes: "Flux commerciaux bilateraux mensuels (simules, publication differee)",
  async fetch(_query: SourceQuery): Promise<FetchOutcome> {
    const requestedUrl =
      "https://comtrade.un.org/api/get?r=ZMB&freq=M&ps=202607&type=C";
    const raw = {
      __simulation: true,
      note: "Donnees de juillet partielles : 3 partenaires sur 11 ont declare.",
      dataset: [
        { partner: "A", exports_musd: 1420, imports_musd: 1980 },
        { partner: "B", exports_musd: 310, imports_musd: 275 },
        { partner: "C", exports_musd: 96, imports_musd: 140 },
      ],
    };
    return {
      requestedUrl,
      raw,
      observations: [
        {
          source: "UN Comtrade",
          url: "https://comtrade.un.org/data/ZMB/202607",
          date_observed: "2026-08-27T09:05:00Z",
          date_published: "2026-08-20T00:00:00Z",
          type: "donnee-commerce",
          resume:
            `${SIM} Donnees douanieres de Zembla pour juillet 2026, PARTIELLES : ` +
            `3 partenaires declarants sur 11. Solde observe sur ce sous-ensemble : -569 MUSD.`,
        },
      ],
    };
  },
};

/** Tier 3 — presse. Reprend la donnee ci-dessus, donc eclipsee par EP-001. */
export const gnewsMockAdapter: SourceAdapter = {
  id: "gnews:coverage",
  describes: "Couverture de presse generaliste (simulee)",
  async fetch(query: SourceQuery): Promise<FetchOutcome> {
    const requestedUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query.topic)}`;
    const raw = {
      __simulation: true,
      totalArticles: 2,
      articles: [
        { title: "Zembla durcit sa politique monetaire", source: "Presse Simulee" },
        { title: "Vers une crise commerciale a Zembla ?", source: "Presse Simulee" },
      ],
    };
    return {
      requestedUrl,
      raw,
      observations: [
        {
          source: "GNews",
          url: "https://gnews.io/articles/zembla-monetary-tightening",
          date_observed: "2026-08-27T09:10:00Z",
          date_published: "2026-08-13T07:30:00Z",
          type: "presse",
          resume:
            `${SIM} La presse relaie la hausse de taux et evoque, sans chiffrage, ` +
            `un "risque de crise commerciale" a Zembla.`,
        },
      ],
    };
  },
};

/**
 * Adaptateur en echec permanent. Il est ici volontairement : le pipeline doit
 * se comporter correctement quand une source est muette, et une source muette
 * doit apparaitre dans le journal d'audit plutot que disparaitre.
 */
export const failingMockAdapter: SourceAdapter = {
  id: "reliefweb:humanitarian",
  describes: "Bulletins humanitaires ONU (simules, indisponible)",
  async fetch(): Promise<FetchOutcome> {
    throw new Error("HTTP 503 : service indisponible (simule)");
  },
};

export const MOCK_ADAPTERS: readonly SourceAdapter[] = [
  fredMockAdapter,
  comtradeMockAdapter,
  gnewsMockAdapter,
  failingMockAdapter,
];

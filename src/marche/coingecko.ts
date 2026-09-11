/**
 * Connecteur CoinGecko — agregat multi-plateformes, plan Demo.
 *
 * Dependances internes : `acces.ts`, `instruments.ts` et `types.ts` (types).
 * Aucune dependance npm.
 *
 * CE QUE COINGECKO EST POUR CE MEDIA
 *
 * La reference pour un chiffre du marche GLOBAL : un prix moyen pondere par
 * les volumes, calcule sur les plateformes que CoinGecko suit. Tier 2 — donnee
 * publique agregee et sourcee. Mais un agregat depend de qui le calcule : un
 * autre agregateur publie une autre valeur. D'ou « selon CoinGecko », exige
 * par une regle bloquante — et par les conditions du plan Demo, qui imposent
 * l'attribution a cote de la donnee.
 *
 * MESURES du 2026-09-11 :
 *  - clef en en-tete `x-cg-demo-api-key` (la documentation deconseille le
 *    parametre d'URL) ;
 *  - aucun en-tete de limite de debit : le plan Demo annonce 100 appels/min et
 *    10 000 credits/mois, chaque reponse HTTP 200 consommant un credit. Le
 *    debit est donc tenu par nous seuls, et le cache fait l'essentiel ;
 *  - `market_chart/range` rend des points de cinq minutes. Celui de 00:00:00Z
 *    vaut exactement l'instantane journalier de `history`, mais son horodatage
 *    est DANS la donnee, la ou `history` ne le donne que par documentation ;
 *  - l'URL se rejoue sans clef : le lecteur peut verifier.
 */

import { AccesMarche, schemaModifie, type Horloge, type PolitiqueDAcces } from "./acces.js";
import { INSTRUMENTS, type Instrument } from "./instruments.js";
import type { ConnecteurDeMarche, PointDeMarche, ReleveDeMarche } from "./types.js";

export const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/** Fenetre demandee de part et d'autre de minuit : deux points de cinq minutes. */
const DEMI_FENETRE_S = 600;

const chemin = (id: string): string => `/coins/${id}/market_chart/range`;

export function politiqueCoinGecko(apiKey: string): PolitiqueDAcces {
  return {
    id: "coingecko",
    nom: "CoinGecko",
    base: COINGECKO_BASE,
    // Liste blanche derivee de la table des instruments : on ne peut pas
    // interroger un actif que personne n'a declare.
    chemins: [
      "/ping",
      ...INSTRUMENTS.flatMap((i) => (i.coingecko === undefined ? [] : [chemin(i.coingecko.id)])),
    ],
    // Une requete par seconde au plus : 60 par minute, sous les 100 du plan.
    intervalleMinMs: 1_000,
    delaiMs: 10_000,
    essaisMax: 3,
    pause429Ms: 60_000,
    pause418Ms: 3_600_000,
    pause403Ms: 15 * 60_000,
    enTetes: { "x-cg-demo-api-key": apiKey },
  };
}

export interface OptionsCoinGecko {
  /** Clef du plan Demo, lue depuis .env par le catalogue. */
  apiKey: string;
  dossier?: string | null;
  horloge?: Horloge;
  /** Validite en cache d'un releve a minuit passe. Un jour par defaut. */
  ttlMs?: number;
}

type Serie = Array<[number, number | null]>;

function serie(corps: Record<string, unknown>, nom: string): Serie {
  const s = corps[nom];
  if (!Array.isArray(s) || s.length === 0) {
    throw schemaModifie(`la serie « ${nom} » est absente ou vide`);
  }
  for (const point of s) {
    if (
      !Array.isArray(point) ||
      typeof point[0] !== "number" ||
      (typeof point[1] !== "number" && point[1] !== null)
    ) {
      throw schemaModifie(`un point de « ${nom} » n'a plus la forme [horodatage, valeur]`);
    }
  }
  return s as Serie;
}

interface ReleveLu {
  horodatageMs: number;
  prix: number;
  capitalisation: number;
  volume: number;
}

/** Controle la forme et extrait les trois mesures au MEME instant : minuit. */
function lireSerie(corps: unknown, referenceMs: number): ReleveLu {
  if (typeof corps !== "object" || corps === null || Array.isArray(corps)) {
    throw schemaModifie("un objet {prices, market_caps, total_volumes} etait attendu");
  }
  const c = corps as Record<string, unknown>;
  const prix = serie(c, "prices");
  const caps = serie(c, "market_caps");
  const volumes = serie(c, "total_volumes");

  const a = (s: Serie, mesure: string): number => {
    const point = s.find(([t]) => t === referenceMs);
    if (point === undefined) {
      throw new Error(
        `donnee indisponible — aucun point de ${mesure} a minuit UTC ` +
          `(${new Date(referenceMs).toISOString()}) : on ne lui substitue pas un autre instant`,
      );
    }
    const v = point[1];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`valeur absente pour ${mesure} a minuit UTC : un trou n'est pas un zero`);
    }
    return v;
  };

  return {
    horodatageMs: referenceMs,
    prix: a(prix, "prix"),
    capitalisation: a(caps, "capitalisation"),
    volume: a(volumes, "volume"),
  };
}

export function connecteurCoinGecko(options: OptionsCoinGecko): ConnecteurDeMarche {
  const acces = new AccesMarche(
    politiqueCoinGecko(options.apiKey),
    options.dossier ?? null,
    options.horloge,
  );
  const ttlMs = options.ttlMs ?? 86_400_000;

  return {
    id: "coingecko",
    nom: "CoinGecko",

    couvre: (instrument: Instrument) => instrument.coingecko !== undefined,

    async releve(instrument: Instrument, reference: Date): Promise<ReleveDeMarche> {
      const cg = instrument.coingecko;
      if (cg === undefined) {
        throw new Error(`CoinGecko ne suit pas l'instrument « ${instrument.id} ».`);
      }
      const ref = reference.getTime();
      const secondes = Math.floor(ref / 1000);

      const r = await acces.obtenir(
        chemin(cg.id),
        { vs_currency: "usd", from: secondes - DEMI_FENETRE_S, to: secondes + DEMI_FENETRE_S },
        { ttlMs, valider: (corps) => void lireSerie(corps, ref) },
      );
      const lu = lireSerie(r.corps, ref);

      const commun = {
        // L'identifiant CoinGecko seul : le pont affiche deja le libelle, et
        // les repeter produisait « bitcoin (bitcoin (bitcoin)) ».
        instrument: cg.id,
        horodatageDonnee: new Date(lu.horodatageMs).toISOString(),
        horodatageRequete: r.horodatageRequete,
        source: "CoinGecko",
        url: r.url,
        fiabilite: "primaire" as const,
        perimetre: {
          type: "agrege" as const,
          methode:
            "moyenne ponderee par les volumes, calculee par CoinGecko sur les " +
            "plateformes qu'il suit",
        },
        usage: "citable" as const,
        reserves: [
          "Agregat calcule par CoinGecko selon sa propre methodologie : un autre " +
            "agregateur publie une valeur differente.",
          "Attribution exigee par les conditions du plan Demo : « selon CoinGecko », " +
            "a cote du chiffre.",
          // En lettres : un « 24 » dans le resume deviendrait une valeur source
          // pour le controle d'ancrage des chiffres (§2).
          "Le volume est un cumul glissant sur les vingt-quatre heures precedant le releve.",
        ],
      };

      const points: PointDeMarche[] = [
        { ...commun, mesure: "prix moyen a minuit UTC", nature: "prix", valeur: lu.prix, unite: "USD" },
        { ...commun, mesure: "capitalisation a minuit UTC", nature: "capitalisation", valeur: lu.capitalisation, unite: "USD" },
        { ...commun, mesure: "volume echange sur vingt-quatre heures, toutes plateformes suivies", nature: "volume", valeur: lu.volume, unite: "USD" },
      ];

      return { points, url: r.url, brut: r.corps, depuisLeCache: r.depuisLeCache };
    },

    async sante() {
      try {
        await acces.obtenir("/ping", {}, {
          ttlMs: 0,
          valider: (corps) => {
            const g = (corps as { gecko_says?: unknown } | null)?.gecko_says;
            if (typeof g !== "string") throw schemaModifie("le ping devait rendre « gecko_says »");
          },
        });
        return { ok: true, detail: "CoinGecko : le ping repond (plan Demo)." };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

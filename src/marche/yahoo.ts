/**
 * Connecteur Yahoo Finance — option (b) : TypeScript natif, sans yfinance.
 *
 * Dependances internes : `acces.ts`, `instruments.ts` et `types.ts` (types).
 * Aucune dependance npm, aucun processus Python.
 *
 * CHOIX VALIDE PAR L'EDITEUR le 2026-09-11, contre un microservice Python
 * adosse a yfinance. Les deux interrogent les MEMES endpoints non documentes :
 * la fragilite est identique. yfinance ajoutait douze dependances directes,
 * dont `curl_cffi`, qui imite l'empreinte TLS d'un navigateur pour dejouer la
 * detection de robots — un contournement que ce projet n'a pas autorise.
 * MESURE : l'endpoint repond HTTP 200 a notre agent declare, sans cookie ni
 * jeton. Le jour ou ce ne sera plus le cas, ce connecteur tombera, et le
 * pipeline continuera sans lui : Yahoo n'est jamais sur le chemin critique.
 *
 * UN SIGNAL, JAMAIS UNE PREUVE. Yahoo relaie les donnees d'autres emetteurs,
 * sans engagement de service. Ses chiffres servent a reperer et a
 * pre-verifier ; la source citee est l'emetteur d'origine, declare pour chaque
 * symbole dans `protocol/sources-de-marche.ts`. Le fact-checker retire le
 * signal des citations, le gate refuse qu'il en reste un.
 *
 * LE CONTRAT, C'EST LE SCHEMA. Il n'y a pas de version de bibliotheque a
 * epingler. Ce qui fait contrat est la forme de la reponse, decrite ci-dessous
 * et versionnee par `CONTRAT_YAHOO`. La modifier est une operation A RISQUE :
 * voir docs/sources-marche.md — nouvelle mesure de l'endpoint reel, mise a
 * jour des fixtures, et passage des tests de non-regression AVANT tout usage.
 *
 * LIMITES connues de la source : series ajustees retroactivement, couverture
 * inegale hors Etats-Unis, frequence de mise a jour variable. Elles voyagent
 * avec chaque point, dans ses reserves.
 */

import { AccesMarche, schemaModifie, type Horloge, type PolitiqueDAcces } from "./acces.js";
import { INSTRUMENTS, type Instrument } from "./instruments.js";
import type { ConnecteurDeMarche, PointDeMarche, ReleveDeMarche } from "./types.js";

export const YAHOO_BASE = "https://query1.finance.yahoo.com";

/**
 * Version du contrat de schema de l'endpoint `v8/finance/chart`, datee de la
 * mesure qui l'a etabli. Toute adaptation du code a une nouvelle forme change
 * cette valeur — c'est ce qui rend la modification visible en revue.
 *
 * Champs du contrat : chart.error (null) ; chart.result[0].meta.{symbol,
 * currency, exchangeTimezoneName, priceHint?} ; chart.result[0].timestamp[] ;
 * chart.result[0].indicators.quote[0].close[] (nombres ou null), aligne sur
 * timestamp.
 */
export const CONTRAT_YAHOO = "v8-chart/2026-09-11";

/** Fenetre demandee avant la reference : week-ends et jours feries compris. */
const FENETRE_JOURS = 10;

const chemin = (symbole: string): string => `/v8/finance/chart/${encodeURIComponent(symbole)}`;

export const POLITIQUE_YAHOO: PolitiqueDAcces = {
  id: "yahoo",
  nom: "Yahoo Finance",
  base: YAHOO_BASE,
  chemins: INSTRUMENTS.flatMap((i) => (i.yahoo === undefined ? [] : [chemin(i.yahoo.symbole)])),
  // Debit client AGRESSIVEMENT bas : une requete toutes les deux secondes au
  // plus, pour un service qui ne publie aucune limite et peut bloquer sans
  // prevenir. Le cache fait le reste.
  intervalleMinMs: 2_000,
  delaiMs: 10_000,
  essaisMax: 2,
  pause429Ms: 30 * 60_000,
  pause418Ms: 6 * 3_600_000,
  // Un 403 de Yahoo signale son anti-robot : on s'eloigne longtemps plutot
  // que d'insister, et JAMAIS on ne le contourne.
  pause403Ms: 60 * 60_000,
};

export interface OptionsYahoo {
  dossier?: string | null;
  horloge?: Horloge;
  /** Yahoo ajuste ses series : six heures de cache par defaut, pas davantage. */
  ttlMs?: number;
}

interface SeanceLue {
  horodatageS: number;
  cloture: number;
  fuseau: string;
  decimales: number;
}

const contrat = (detail: string): Error => schemaModifie(`${detail} (contrat ${CONTRAT_YAHOO})`);

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Controle le contrat et extrait la derniere seance CLOSE avant la reference. */
function lireChart(corps: unknown, symbole: string, devise: string, referenceS: number): SeanceLue {
  if (!objet(corps) || !objet(corps["chart"])) throw contrat("champ « chart » absent");
  const chart = corps["chart"];

  const erreur = chart["error"];
  if (erreur !== null && erreur !== undefined) {
    const description = objet(erreur) ? erreur["description"] : undefined;
    throw new Error(
      `donnee indisponible — Yahoo signale : ${typeof description === "string" ? description : JSON.stringify(erreur).slice(0, 120)}`,
    );
  }

  const result = chart["result"];
  if (!Array.isArray(result) || result.length === 0 || !objet(result[0])) {
    throw contrat("« chart.result » vide ou absent");
  }
  const r = result[0];
  const meta = r["meta"];
  if (
    !objet(meta) ||
    typeof meta["symbol"] !== "string" ||
    typeof meta["currency"] !== "string" ||
    typeof meta["exchangeTimezoneName"] !== "string"
  ) {
    throw contrat("« meta » incomplet (symbol, currency, exchangeTimezoneName)");
  }
  if (meta["symbol"] !== symbole) {
    throw new Error(`rupture de contrat — Yahoo rend le symbole ${meta["symbol"]} pour ${symbole}`);
  }
  if (meta["currency"] !== devise) {
    throw new Error(
      `rupture de contrat — devise ${meta["currency"]} au lieu de ${devise} pour ${symbole} : ` +
        `l'accepter changerait l'unite du chiffre sans que personne l'ait decide`,
    );
  }

  const horodatages = r["timestamp"];
  const indicators = r["indicators"];
  const quote = objet(indicators) && Array.isArray(indicators["quote"]) ? indicators["quote"][0] : undefined;
  const clotures = objet(quote) ? quote["close"] : undefined;
  if (!objet(indicators) || !Array.isArray(clotures)) {
    throw contrat("« indicators.quote[0].close » absent");
  }
  if (!Array.isArray(horodatages) || horodatages.some((t) => typeof t !== "number")) {
    throw contrat("« timestamp » absent ou non numerique");
  }
  if (clotures.length !== horodatages.length) {
    throw contrat("« close » et « timestamp » ne sont plus alignes");
  }

  // Derniere seance STRICTEMENT anterieure a la reference, cloture renseignee.
  // Une barre datee de minuit pile est la seance du jour, pas encore close ;
  // une cloture `null` est un trou — MESURE sur le Nikkei le 2026-09-11.
  for (let i = horodatages.length - 1; i >= 0; i -= 1) {
    const t = horodatages[i] as number;
    const c = clotures[i];
    if (t < referenceS && typeof c === "number" && Number.isFinite(c)) {
      const hint = meta["priceHint"];
      const decimales =
        typeof hint === "number" && Number.isInteger(hint) && hint >= 0 && hint <= 6 ? hint : 2;
      return { horodatageS: t, cloture: c, fuseau: meta["exchangeTimezoneName"], decimales };
    }
  }
  throw new Error(
    `donnee indisponible — aucune seance close dans la fenetre demandee pour ${symbole}`,
  );
}

/**
 * EP-005 : Yahoo rend des flottants 32 bits (8116.759765625 pour 8116,76).
 * Le `priceHint` de la reponse dit la precision reelle ; au-dela, ce sont des
 * artefacts de representation, pas une mesure.
 */
function arrondir(v: number, decimales: number): number {
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
}

/** Date de la seance dans le fuseau de la place, et non en UTC. */
function jourLocal(horodatageS: number, fuseau: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: fuseau,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(horodatageS * 1000));
  } catch {
    return new Date(horodatageS * 1000).toISOString().slice(0, 10);
  }
}

export function connecteurYahoo(options: OptionsYahoo = {}): ConnecteurDeMarche {
  const acces = new AccesMarche(POLITIQUE_YAHOO, options.dossier ?? null, options.horloge);
  const ttlMs = options.ttlMs ?? 6 * 3_600_000;

  async function lire(instrument: Instrument, reference: Date, ttl = ttlMs) {
    const y = instrument.yahoo;
    if (y === undefined) throw new Error(`Yahoo n'est pas branche pour « ${instrument.id} ».`);
    const referenceS = Math.floor(reference.getTime() / 1000);
    const r = await acces.obtenir(
      chemin(y.symbole),
      { period1: referenceS - FENETRE_JOURS * 86_400, period2: referenceS, interval: "1d" },
      { ttlMs: ttl, valider: (corps) => void lireChart(corps, y.symbole, y.devise, referenceS) },
    );
    return { r, y, seance: lireChart(r.corps, y.symbole, y.devise, referenceS) };
  }

  return {
    id: "yahoo",
    nom: "Yahoo Finance",

    couvre: (instrument: Instrument) => instrument.yahoo !== undefined,

    async releve(instrument: Instrument, reference: Date): Promise<ReleveDeMarche> {
      const { r, y, seance } = await lire(instrument, reference);
      const point: PointDeMarche = {
        instrument: y.symbole,
        mesure: `cloture de la seance du ${jourLocal(seance.horodatageS, seance.fuseau)} (${seance.fuseau})`,
        nature: y.nature,
        valeur: arrondir(seance.cloture, seance.decimales),
        unite: y.unite,
        horodatageDonnee: new Date(seance.horodatageS * 1000).toISOString(),
        horodatageRequete: r.horodatageRequete,
        source: "Yahoo Finance",
        url: r.url,
        fiabilite: "secondaire",
        perimetre: {
          type: "agrege",
          methode:
            "agregateur grand public, qui relaie les donnees de l'emetteur " +
            "d'origine sans engagement de service",
        },
        usage: "signal",
        reserves: [
          ...y.reserves,
          "Horodatage Yahoo : ouverture de la seance ; la cloture intervient le meme jour.",
          "Yahoo peut ajuster ses series retroactivement ; sa couverture hors " +
            "Etats-Unis est inegale et sa frequence de mise a jour varie.",
        ],
      };
      return { points: [point], url: r.url, brut: r.corps, depuisLeCache: r.depuisLeCache };
    },

    async sante() {
      const cac40 = INSTRUMENTS.find((i) => i.id === "cac40");
      if (cac40 === undefined) return { ok: false, detail: "instrument de sonde absent" };
      try {
        // Sans cache : une sonde servie depuis le cache ne sonderait rien.
        await lire(cac40, new Date(options.horloge?.maintenant() ?? Date.now()), 0);
        return { ok: true, detail: `Yahoo Finance : contrat ${CONTRAT_YAHOO} respecte.` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/**
 * Connecteur Binance — donnees de marche publiques, SANS CLEF.
 *
 * Dependances internes : `acces.ts` (liste blanche, debit, disjoncteur, cache),
 * `garde-fous.ts` (coherence des bougies), `types.ts` et `instruments.ts`
 * (types). Aucune dependance npm.
 *
 * CE QUE BINANCE EST POUR CE MEDIA
 *
 * L'emetteur de ses PROPRES cotations — d'ou le tier 1 decide par l'editeur —
 * et rien de plus. Son prix est « le prix du bitcoin sur Binance », jamais « le
 * prix du bitcoin » : le registre `protocol/sources-de-marche.ts` l'impose par
 * une regle bloquante. Pour un chiffre du marche global, c'est CoinGecko.
 *
 * PERIMETRE TECHNIQUE, fixe par l'editeur :
 *
 *  - hote `data-api.binance.vision`, reserve aux donnees de marche, et non
 *    `api.binance.com` ;
 *  - endpoints publics de la liste ci-dessous, et eux seuls. Aucun endpoint de
 *    compte, d'ordre ou signe : ce projet est un media, il ne passe jamais
 *    d'ordre. MESURE : `/api/v3/account` rend un 404 sur cet hote ;
 *  - delai de dix secondes, poids suivi par `x-mbx-used-weight-1m`.
 *
 * MESURES du 2026-09-11 : plafond annonce de 6000 unites de poids par minute
 * (`exchangeInfo`) ; une bougie journaliere pese 2 ; un symbole inconnu rend
 * HTTP 400 {"code":-1121,"msg":"Invalid symbol."}.
 *
 * POURQUOI LA BOUGIE DE LA VEILLE, et pas le ticker. `ticker/24hr` est une
 * fenetre GLISSANTE, et son URL rend autre chose a chaque appel : un lecteur
 * qui la suit ne retrouve pas notre chiffre. Une bougie close, bornee par
 * `startTime` et `endTime`, ne change plus jamais : l'URL citee se rejoue.
 * Le carnet d'ordres (`depth`), lui, ne porte AUCUN horodatage : il ne peut pas
 * fonder une claim datee, et n'est pas exploite.
 */

import { AccesMarche, schemaModifie, type Horloge, type PolitiqueDAcces } from "./acces.js";
import { verifierBougie } from "./garde-fous.js";
import type { Instrument } from "./instruments.js";
import type { ConnecteurDeMarche, PointDeMarche, ReleveDeMarche } from "./types.js";

const JOUR = 86_400_000;

/** Endpoints publics autorises par l'editeur, plus `ping` pour la sonde de sante. */
export const BINANCE_CHEMINS = [
  "/api/v3/klines",
  "/api/v3/ticker/24hr",
  "/api/v3/avgPrice",
  "/api/v3/depth",
  "/api/v3/aggTrades",
  "/api/v3/exchangeInfo",
  "/api/v3/ping",
] as const;

export const POLITIQUE_BINANCE: PolitiqueDAcces = {
  id: "binance",
  nom: "Binance",
  base: "https://data-api.binance.vision",
  chemins: BINANCE_CHEMINS,
  intervalleMinMs: 250,
  delaiMs: 10_000,
  essaisMax: 3,
  pause429Ms: 60_000,
  // Sans Retry-After, la duree d'un bannissement est inconnue : on retient
  // une pause longue plutot que de risquer une recidive, que Binance allonge.
  pause418Ms: 2 * 3_600_000,
  pause403Ms: 15 * 60_000,
  // Seuil a 80 % du plafond mesure : la marge absorbe les autres processus
  // qui partageraient notre adresse.
  poids: { entete: "x-mbx-used-weight-1m", plafond: 6000, seuil: 4800 },
  // -1007 : « Timeout waiting for response from backend server ». Pour une
  // lecture, reessayer n'a aucun effet de bord.
  codeTransitoire: (corps) =>
    typeof corps === "object" && corps !== null && (corps as { code?: unknown }).code === -1007,
};

export interface OptionsBinance {
  /** Dossier du cache et de l'etat du disjoncteur ; `null` = memoire seule. */
  dossier?: string | null;
  horloge?: Horloge;
  /** Validite en cache d'une bougie close. Elle ne change plus : sept jours par defaut. */
  ttlMs?: number;
}

interface BougieLue {
  ouverture: number;
  haut: number;
  bas: number;
  cloture: number;
  volumeBase: number;
  volumeCotation: number;
  fermetureMs: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function nombre(brut: unknown, champ: string): number {
  if (typeof brut !== "string" || !/^-?\d+(?:\.\d+)?$/.test(brut)) {
    throw schemaModifie(
      `le champ « ${champ} » n'est plus une chaine numerique (${String(JSON.stringify(brut)).slice(0, 40)})`,
    );
  }
  return Number(brut);
}

/**
 * Lit et controle la bougie. Appelee pendant la VALIDATION : une bougie
 * refusee n'est jamais mise en cache.
 */
function lireBougie(corps: unknown, debut: number, fin: number): BougieLue {
  if (!Array.isArray(corps)) throw schemaModifie("un tableau de bougies etait attendu");
  if (corps.length === 0) {
    throw new Error(
      "donnee indisponible — aucune bougie rendue pour la journee demandee : " +
        "symbole retire de la cote, ou journee sans echange",
    );
  }
  const k: unknown = corps[0];
  if (!Array.isArray(k) || k.length < 11) {
    throw schemaModifie("une bougie a 12 champs etait attendue");
  }
  const [ouvertureMs, o, h, b, c, vBase, fermetureMs, vCotation] = k as unknown[];
  if (typeof ouvertureMs !== "number" || typeof fermetureMs !== "number") {
    throw schemaModifie("les horodatages de la bougie ne sont plus des nombres");
  }
  if (ouvertureMs !== debut || fermetureMs !== fin) {
    throw new Error(
      `bougie inattendue : ${iso(ouvertureMs)} - ${iso(fermetureMs)} au lieu de ` +
        `${iso(debut)} - ${iso(fin)}`,
    );
  }
  const bougie: BougieLue = {
    ouverture: nombre(o, "open"),
    haut: nombre(h, "high"),
    bas: nombre(b, "low"),
    cloture: nombre(c, "close"),
    volumeBase: nombre(vBase, "volume"),
    volumeCotation: nombre(vCotation, "quoteAssetVolume"),
    fermetureMs,
  };
  const incoherence = verifierBougie(bougie);
  if (incoherence !== null) throw new Error(incoherence);
  return bougie;
}

export function connecteurBinance(options: OptionsBinance = {}): ConnecteurDeMarche {
  const acces = new AccesMarche(POLITIQUE_BINANCE, options.dossier ?? null, options.horloge);
  const ttlMs = options.ttlMs ?? 7 * JOUR;

  return {
    id: "binance",
    nom: "Binance",

    couvre: (instrument: Instrument) => instrument.binance !== undefined,

    async releve(instrument: Instrument, reference: Date): Promise<ReleveDeMarche> {
      const paire = instrument.binance;
      if (paire === undefined) {
        throw new Error(`Binance ne cote pas l'instrument « ${instrument.id} ».`);
      }
      // La journee UTC close qui precede la reference.
      const debut = reference.getTime() - JOUR;
      const fin = reference.getTime() - 1;

      const r = await acces.obtenir(
        "/api/v3/klines",
        { symbol: paire.symbole, interval: "1d", startTime: debut, endTime: fin },
        { ttlMs, valider: (corps) => void lireBougie(corps, debut, fin) },
      );
      const bougie = lireBougie(r.corps, debut, fin);
      const jour = iso(debut).slice(0, 10);

      const commun = {
        instrument: `${paire.base}/${paire.cotation}`,
        horodatageDonnee: iso(bougie.fermetureMs),
        horodatageRequete: r.horodatageRequete,
        source: "Binance",
        url: r.url,
        fiabilite: "primaire" as const,
        perimetre: { type: "plateforme-unique" as const, plateforme: "Binance" },
        usage: "citable" as const,
        reserves: [
          "Prix constates sur Binance uniquement : ils ne valent ni pour les autres " +
            "plateformes, ni pour le marche mondial.",
          `Unite : ${paire.cotation}, un stablecoin qui vise la parite avec le dollar — ` +
            `ce n'est pas le dollar americain.`,
          // Sans chiffres : le controle d'ancrage (§2) lit les nombres des
          // resumes comme des valeurs sources, et « 23:59:59 » y fournirait
          // trois nombres capables de « justifier » un chiffre invente.
          "Journee UTC, de minuit a minuit en temps universel — et non journee " +
            "calendaire de Paris.",
        ],
      };

      const points: PointDeMarche[] = [
        { ...commun, mesure: `cloture sur Binance de la journee UTC du ${jour}`, nature: "prix", valeur: bougie.cloture, unite: paire.cotation },
        { ...commun, mesure: `ouverture sur Binance de la journee UTC du ${jour}`, nature: "prix", valeur: bougie.ouverture, unite: paire.cotation },
        { ...commun, mesure: `plus haut sur Binance ce jour-la`, nature: "prix", valeur: bougie.haut, unite: paire.cotation },
        { ...commun, mesure: `plus bas sur Binance ce jour-la`, nature: "prix", valeur: bougie.bas, unite: paire.cotation },
        { ...commun, mesure: `volume de la paire echange sur Binance ce jour-la`, nature: "volume", valeur: bougie.volumeBase, unite: paire.base },
        { ...commun, mesure: `meme volume, exprime en ${paire.cotation}`, nature: "volume", valeur: bougie.volumeCotation, unite: paire.cotation },
      ];

      return { points, url: r.url, brut: r.corps, depuisLeCache: r.depuisLeCache };
    },

    async sante() {
      try {
        await acces.obtenir("/api/v3/ping", {}, {
          ttlMs: 0,
          valider: (corps) => {
            if (typeof corps !== "object" || corps === null || Array.isArray(corps)) {
              throw schemaModifie("le ping devait rendre un objet");
            }
          },
        });
        return { ok: true, detail: "Binance : le ping repond (data-api.binance.vision)." };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

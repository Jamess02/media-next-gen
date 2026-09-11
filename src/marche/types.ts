/**
 * Contrat commun des connecteurs de donnees de marche.
 *
 * Dependances : `instruments.ts` (type uniquement). Aucune dependance npm.
 *
 * UNE INTERFACE, PLUSIEURS FOURNISSEURS. Binance, CoinGecko et Yahoo la
 * partagent ; un quatrieme fournisseur n'a qu'a l'implementer. Aucun agent ne
 * l'appelle : un connecteur n'est joignable qu'a travers le pont
 * (`adaptateur.ts`) qui le branche sur la passerelle des sources — journal
 * d'audit, tier derive du domaine, filtre d'injection compris.
 *
 * CHAQUE POINT EST COMPLET. Valeur, unite, horodatage de la donnee ET de la
 * requete, source, fiabilite, perimetre : tout voyage avec le chiffre. Un
 * chiffre qui aurait perdu l'une de ces proprietes en route ne pourrait plus
 * etre verifie, ni correctement ecrit.
 */

import type { Instrument } from "./instruments.js";

/** Primaire : l'emetteur de la donnee (tier 1-2). Secondaire : un relais. */
export type Fiabilite = "primaire" | "secondaire";

/** Ce que couvre la donnee : une seule plateforme, ou un agregat calcule par un tiers. */
export type Perimetre =
  | { type: "plateforme-unique"; plateforme: string }
  | { type: "agrege"; methode: string };

/**
 * Nature de la mesure. Elle decide des garde-fous : un prix, un niveau
 * d'indice ou une capitalisation sont strictement positifs ; un volume peut
 * etre nul.
 */
export type NatureDeMesure = "prix" | "niveau" | "volume" | "capitalisation";

export interface PointDeMarche {
  /** Instrument tel que la source le designe : "BTC/USDT", "^FCHI". */
  instrument: string;
  /** Ce qui est mesure, en clair : "cloture de la journee UTC du 2026-09-10". */
  mesure: string;
  nature: NatureDeMesure;
  valeur: number;
  /** "USDT", "USD", "points"... Jamais implicite, jamais "$" par defaut. */
  unite: string;
  /** Ce que la donnee date, ISO-8601. */
  horodatageDonnee: string;
  /** Quand NOUS l'avons obtenue, ISO-8601. Survit au cache. */
  horodatageRequete: string;
  source: string;
  /** URL citable, reproductible, sans clef. */
  url: string;
  fiabilite: Fiabilite;
  perimetre: Perimetre;
  /** `signal` : sert a pre-verifier, ne se cite jamais. */
  usage: "citable" | "signal";
  /** Ce que le lecteur doit savoir pour ne pas mal lire le chiffre. */
  reserves: readonly string[];
}

/** Resultat d'un releve : des points issus d'UNE requete, et de quoi l'auditer. */
export interface ReleveDeMarche {
  points: readonly PointDeMarche[];
  /** URL exacte interrogee — celle que le lecteur peut rejouer. */
  url: string;
  /** Reponse brute, archivee telle quelle (§9.4). */
  brut: unknown;
  /** Vrai si la reponse vient du cache local : le journal doit le dire. */
  depuisLeCache: boolean;
}

export interface EtatDeSante {
  ok: boolean;
  detail: string;
}

export interface ConnecteurDeMarche {
  /** Identifiant court, repris dans les identifiants d'adaptateurs. */
  readonly id: string;
  /** Nom tel que le lecteur le reconnait. */
  readonly nom: string;
  /** Ce connecteur sait-il servir cet instrument ? */
  couvre(instrument: Instrument): boolean;
  /**
   * Releve de REFERENCE : l'etat de l'instrument a `reference` (minuit UTC).
   *
   * Une reference fixe, et non « maintenant », pour trois raisons : l'URL
   * reste rejouable par le lecteur ; deux sources relevees au meme instant se
   * comparent sans violer EP-006 ; une donnee close ne change plus, donc se
   * met en cache sans risque.
   */
  releve(instrument: Instrument, reference: Date): Promise<ReleveDeMarche>;
  /** Sonde legere : le service repond-il, avec la forme attendue ? */
  sante(): Promise<EtatDeSante>;
}

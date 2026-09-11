/**
 * Instruments suivis, et les sujets qui les appellent.
 *
 * Dependances : aucune, ni npm ni interne. Module pur.
 *
 * POURQUOI UNE TABLE FERMEE. Un instrument n'entre ici qu'avec son symbole
 * chez chaque fournisseur, son unite et — pour Yahoo — un emetteur d'origine
 * declare dans `protocol/sources-de-marche.ts`. Deviner un symbole depuis un
 * sujet libre ferait interroger n'importe quoi, et publier des chiffres dont
 * personne n'aurait verifie l'unite.
 *
 * LES MOTIFS portent sur le sujet NORMALISE (sans accents, en minuscules). Ils
 * sont volontairement etroits : un faux positif coute des requetes et une
 * observation hors sujet ; un faux negatif coute seulement l'absence d'un
 * chiffre que le Veilleur n'aurait de toute facon pas eu a arbitrer.
 */

export interface Instrument {
  id: string;
  libelle: string;
  motifs: RegExp;
  binance?: { symbole: string; base: string; cotation: string };
  coingecko?: { id: string };
  yahoo?: {
    symbole: string;
    /** Devise attendue dans la reponse. Un changement est une rupture de contrat. */
    devise: string;
    unite: string;
    nature: "niveau" | "prix";
    /** Ce que le lecteur doit savoir de ce symbole-la. */
    reserves: readonly string[];
  };
}

/** Termes generiques : un sujet « crypto » appelle les deux actifs principaux. */
const CRYPTO_GENERIQUE = "crypto\\w*|actifs? numeriques?|stablecoins?";

const CONTRAT_GLISSANT =
  "Contrat du mois le plus proche : Yahoo change de contrat a l'echeance, ce " +
  "qui cree une rupture dans la serie.";

export const INSTRUMENTS: readonly Instrument[] = [
  {
    id: "bitcoin",
    libelle: "bitcoin",
    motifs: new RegExp(`\\b(?:bitcoins?|btc|${CRYPTO_GENERIQUE})\\b`),
    binance: { symbole: "BTCUSDT", base: "BTC", cotation: "USDT" },
    coingecko: { id: "bitcoin" },
  },
  {
    id: "ether",
    libelle: "ether (Ethereum)",
    motifs: new RegExp(`\\b(?:ether|ethereum|eth|${CRYPTO_GENERIQUE})\\b`),
    binance: { symbole: "ETHUSDT", base: "ETH", cotation: "USDT" },
    coingecko: { id: "ethereum" },
  },
  {
    id: "cac40",
    libelle: "CAC 40",
    motifs: /\bcac\s*40\b/,
    yahoo: { symbole: "^FCHI", devise: "EUR", unite: "points", nature: "niveau", reserves: [] },
  },
  {
    id: "sp500",
    libelle: "S&P 500",
    motifs: /\bs\s*&\s*p\s*500\b|\bsp\s*500\b/,
    yahoo: { symbole: "^GSPC", devise: "USD", unite: "points", nature: "niveau", reserves: [] },
  },
  {
    id: "eurostoxx50",
    libelle: "Euro Stoxx 50",
    motifs: /\b(?:euro\s*)?stoxx\s*50\b/,
    yahoo: { symbole: "^STOXX50E", devise: "EUR", unite: "points", nature: "niveau", reserves: [] },
  },
  {
    id: "nikkei225",
    libelle: "Nikkei 225",
    motifs: /\bnikkei\b/,
    yahoo: { symbole: "^N225", devise: "JPY", unite: "points", nature: "niveau", reserves: [] },
  },
  {
    id: "brent",
    libelle: "petrole Brent (contrat NYMEX)",
    motifs: /\b(?:brent|petrole|opep|opec)\b/,
    yahoo: {
      symbole: "BZ=F",
      devise: "USD",
      unite: "dollars par baril",
      nature: "prix",
      reserves: [
        "Contrat NYMEX « Brent Last Day Financial », regle sur le Brent d'ICE : " +
          "ce n'est pas le prix de reference du Brent.",
        CONTRAT_GLISSANT,
      ],
    },
  },
  {
    id: "wti",
    libelle: "petrole WTI (contrat NYMEX)",
    motifs: /\b(?:wti|petrole)\b/,
    yahoo: {
      symbole: "CL=F",
      devise: "USD",
      unite: "dollars par baril",
      nature: "prix",
      reserves: [CONTRAT_GLISSANT],
    },
  },
  {
    id: "or",
    libelle: "or (contrat COMEX)",
    // « or » seul est une conjonction : on n'accepte que les tournures qui
    // designent le metal.
    motifs: /\b(?:cours|prix|once|onces|reserves?|lingots?)\s+d(?:e\s+l)?['’]\s*or\b|\bmetal jaune\b/,
    yahoo: {
      symbole: "GC=F",
      devise: "USD",
      unite: "dollars par once",
      nature: "prix",
      reserves: [CONTRAT_GLISSANT],
    },
  },
];

/** Sujet comparable : sans accents, en minuscules, apostrophes unifiees. */
export function normaliserSujet(sujet: string): string {
  return sujet
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'");
}

/** Instruments qu'un sujet appelle, dans l'ordre de la table. */
export function instrumentsPourSujet(sujet: string): Instrument[] {
  const s = normaliserSujet(sujet);
  return INSTRUMENTS.filter((i) => i.motifs.test(s));
}

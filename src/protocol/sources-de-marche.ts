/**
 * Sources de MARCHE — perimetre, usage et attribution, derives du domaine.
 *
 * Dependances : `interests.ts` (correspondance d'hote). Aucune dependance npm.
 * Place dans `protocol/` pour la meme raison qu'`interests.ts` : c'est une
 * regle EDITORIALE, qui s'applique a toute URL atteignant une claim, que la
 * donnee soit arrivee par un connecteur ou citee a la main.
 *
 * POURQUOI UN REGISTRE DE PLUS
 *
 * Le tier (§4) mesure la distance a la donnee. Il ne dit pas ce qu'une donnee
 * de marche COUVRE. Binance est l'emetteur de ses propres cotations — d'ou son
 * tier 1, decide par l'editeur — mais ces cotations ne valent que pour Binance.
 * « Le bitcoin vaut 76 568 USDT » et « le bitcoin vaut 76 568 USDT sur
 * Binance » citent la meme source au meme tier ; seule la seconde est vraie.
 *
 * Trois proprietes, derivees du domaine comme le tier et jamais declarees par
 * un agent :
 *
 *  - le PERIMETRE : une plateforme unique, ou un agregat calcule par un tiers ;
 *  - l'USAGE : citable, ou simple signal de pre-verification ;
 *  - la COTATION, quand elle n'est pas une monnaie officielle (l'USDT).
 *
 * Les regles qui les exploitent vivent dans `rules.ts` et sont bloquantes.
 */

import { hostMatchesDomain } from "./interests.js";

export type PerimetreDeMarche = "plateforme-unique" | "agrege";
export type UsageDeSource = "citable" | "signal";

export interface SourceDeMarche {
  /** Suffixe de domaine, compare sur l'hote. */
  domain: string;
  /** Nom exige dans le texte, tel que le lecteur le reconnait. */
  nom: string;
  perimetre: PerimetreDeMarche;
  usage: UsageDeSource;
  /** Formes acceptees pour nommer la source dans un texte. */
  aliases: readonly string[];
  /** Unite de cotation quand elle n'est PAS une monnaie officielle. */
  cotation?: string;
  /**
   * Attribution exigee par la LICENCE de la source : mention a afficher sur le
   * site, pres de la donnee, avec son lien.
   *
   * A ne pas confondre avec la formule editoriale (« selon CoinGecko »), qui
   * dit au lecteur d'ou vient le chiffre. Celle-ci est une CONDITION D'USAGE :
   * l'omettre n'est pas une maladresse, c'est une violation de licence.
   */
  attributionPublique?: { texte: string; lien: string };
  /** Pourquoi le nom doit accompagner la donnee. Repris dans les messages. */
  raison: string;
}

const RAISON_YAHOO =
  "agregateur grand public : ses donnees servent a pre-verifier, jamais a " +
  "prouver. La source citee est l'emetteur d'origine de la donnee.";

export const SOURCES_DE_MARCHE: readonly SourceDeMarche[] = [
  {
    domain: "data-api.binance.vision",
    nom: "Binance",
    perimetre: "plateforme-unique",
    usage: "citable",
    aliases: ["binance"],
    cotation: "USDT",
    raison:
      // Sans nommer d'actif : la raison accompagne le bitcoin comme l'ether, et
      // « le prix du bitcoin » dans le resume de l'ether egarait le lecteur.
      "Binance ne reflete que les echanges conclus sur sa plateforme. Presenter " +
      "l'un de ses prix comme « le prix » de l'actif confondrait une plateforme " +
      "avec le marche entier (EP-006).",
  },
  {
    domain: "api.coingecko.com",
    nom: "CoinGecko",
    perimetre: "agrege",
    usage: "citable",
    aliases: ["coingecko", "coin gecko"],
    // Le plan Demo est gratuit a cette condition, et son guide demande une
    // mention visible, proche de la donnee, avec un lien vers coingecko.com.
    attributionPublique: {
      texte: "Donnees de prix fournies par CoinGecko",
      lien: "https://www.coingecko.com",
    },
    raison:
      "un agregat depend de la methodologie de qui le calcule — un autre " +
      "agregateur publie une autre valeur — et les conditions du plan Demo de " +
      "CoinGecko exigent l'attribution a cote de la donnee.",
  },
  // Les deux hotes de donnees de Yahoo. PAS `finance.yahoo.com` : on y trouve
  // des depeches reprises (Reuters, AP), citables comme de la presse de tier 3.
  // Seules les donnees chiffrees sont un signal.
  {
    domain: "query1.finance.yahoo.com",
    nom: "Yahoo Finance",
    perimetre: "agrege",
    usage: "signal",
    aliases: ["yahoo"],
    raison: RAISON_YAHOO,
  },
  {
    domain: "query2.finance.yahoo.com",
    nom: "Yahoo Finance",
    perimetre: "agrege",
    usage: "signal",
    aliases: ["yahoo"],
    raison: RAISON_YAHOO,
  },
];

export interface EmetteurDOrigine {
  nom: string;
  domaine: string;
}

/**
 * Emetteurs d'origine des instruments que Yahoo relaie, par symbole Yahoo.
 *
 * C'est la source que le lecteur doit pouvoir consulter a la place de Yahoo.
 * Pour un indice, son administrateur ; pour un contrat a terme, la bourse qui
 * le cote.
 *
 * `BZ=F` n'est PAS le Brent de reference : MESURE du 2026-09-11, Yahoo le
 * declare sur le NYMEX (« Brent Crude Oil Last Day Financial Futures »), un
 * contrat regle sur le Brent d'ICE. Renvoyer le lecteur a ICE lui ferait
 * comparer deux contrats differents.
 */
export const EMETTEURS_YAHOO: Readonly<Record<string, EmetteurDOrigine>> = {
  "^FCHI": { nom: "Euronext", domaine: "euronext.com" },
  "^GSPC": { nom: "S&P Dow Jones Indices", domaine: "spglobal.com" },
  "^STOXX50E": { nom: "STOXX", domaine: "stoxx.com" },
  "^N225": { nom: "Nikkei Inc.", domaine: "indexes.nikkei.co.jp" },
  "BZ=F": { nom: "CME Group (NYMEX)", domaine: "cmegroup.com" },
  "CL=F": { nom: "CME Group (NYMEX)", domaine: "cmegroup.com" },
  "GC=F": { nom: "CME Group (COMEX)", domaine: "cmegroup.com" },
};

function hote(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Perimetre et usage d'une URL de marche, ou `null` si elle n'en est pas une. */
export function sourceDeMarche(url: string): SourceDeMarche | null {
  const h = hote(url);
  if (h === null) return null;
  return SOURCES_DE_MARCHE.find((s) => hostMatchesDomain(h, s.domain)) ?? null;
}

/**
 * Emetteur d'origine designe par un signal Yahoo, lu dans le chemin
 * `/v8/finance/chart/<symbole>`. `null` si l'URL n'est pas un signal connu.
 */
export function emetteurAttendu(url: string): EmetteurDOrigine | null {
  if (sourceDeMarche(url)?.usage !== "signal") return null;
  let chemin: string;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/chart\/([^/]+)$/.exec(chemin);
  if (m === null) return null;
  let symbole: string;
  try {
    symbole = decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
  return EMETTEURS_YAHOO[symbole] ?? null;
}

/**
 * Normalise pour comparer : accents, casse et espaces uniformises. Meme
 * logique qu'`interests.ts` — une regle ne doit pas devenir un concours de
 * dictee.
 */
function normaliser(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Vrai si le texte nomme la source, sous l'une de ses formes. */
export function nommeLaSource(texte: string, source: SourceDeMarche): boolean {
  const t = normaliser(texte);
  return [source.nom, ...source.aliases].some((alias) => t.includes(normaliser(alias)));
}

/** Formule a employer, selon le perimetre : « sur Binance », « selon CoinGecko ». */
export function formuleDAttribution(source: SourceDeMarche): string {
  return source.perimetre === "plateforme-unique" ? `sur ${source.nom}` : `selon ${source.nom}`;
}

/**
 * Attributions que le Redacteur doit ecrire, une par claim et par source de
 * marche citable.
 *
 * Meme principe que les divulgations d'interet : la formule est PRODUITE par
 * le registre et verifiee par la regle qui lit ce meme registre. Recopiee a la
 * main dans un prompt, elle finirait par diverger du controle, et un texte
 * conforme a la consigne serait bloque au gate. Un signal n'y figure jamais :
 * il ne se cite pas, donc ne s'attribue pas.
 */
/**
 * Attributions de LICENCE dues par un lot de claims, une fois chacune.
 *
 * Posees par le code a partir du registre, jamais demandees a un agent : une
 * consigne de redaction s'oublie, et cet oubli-la romprait les conditions
 * d'usage de la source.
 */
export function attributionsDeLicence(
  claims: ReadonlyArray<{ sources: ReadonlyArray<{ url: string }> }>,
): Array<{ texte: string; lien: string }> {
  const vues = new Map<string, { texte: string; lien: string }>();
  for (const claim of claims) {
    for (const s of claim.sources) {
      const m = sourceDeMarche(s.url);
      if (m?.attributionPublique !== undefined) vues.set(m.nom, m.attributionPublique);
    }
  }
  return [...vues.values()];
}

export function attributionsExigees(
  claims: ReadonlyArray<{ id: string; sources: ReadonlyArray<{ url: string }> }>,
): string[] {
  const exigences: string[] = [];
  for (const claim of claims) {
    const vues = new Map<string, SourceDeMarche>();
    for (const s of claim.sources) {
      const m = sourceDeMarche(s.url);
      if (m !== null && m.usage === "citable") vues.set(m.nom, m);
    }
    for (const m of vues.values()) {
      exigences.push(
        `« ${formuleDAttribution(m)} » — dans chaque paragraphe qui s'appuie sur ` +
          `[[${claim.id}]] : ${m.raison}`,
      );
    }
  }
  return exigences;
}

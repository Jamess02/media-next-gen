/**
 * Divulgation d'interet — sources qui commentent un marche ou elles sont
 * investies.
 *
 * Module feuille : aucun import, aucune dependance npm. Il est place dans
 * `protocol/` et non dans `sources/` parce que c'est une regle EDITORIALE, pas
 * une question de transport : elle s'applique a toute URL qui atteint une
 * claim, que la source soit branchee au catalogue ou citee a la main.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le §4 classe les sources par distance a la donnee (primaire, agregee,
 * secondaire). Il ne dit rien de leur INTERET : un fonds qui publie une note
 * sur un actif qu'il detient est une source secondaire comme une autre au sens
 * du tier, alors que le lecteur a besoin de savoir qui parle et avec quel
 * interet. Le tier mesure la distance a la donnee ; l'interet mesure la
 * distance a la neutralite. Les deux sont orthogonaux, d'ou un registre
 * distinct.
 *
 * POURQUOI LE REGISTRE, ET PAS UNE CONSIGNE AUX AGENTS
 *
 * Meme raison que pour le tier (voir sources/registry.ts) : une consigne dans
 * un prompt est une suggestion. Ici l'interet est DERIVE du domaine et la
 * mention est exigee par une regle bloquante (rules.ts, INTEREST_UNDISCLOSED).
 * Un modele qui oublie la mention ne publie pas — il n'a pas le choix de
 * l'omettre.
 *
 * CE QUE CE REGISTRE N'EST PAS
 *
 * Ce n'est pas une liste de sources suspectes, et l'inscription n'est pas une
 * sanction. Castle Island et Galaxy produisent des donnees que peu d'acteurs
 * publient. Le protocole ne les ecarte pas : il exige que leur position soit
 * visible au moment ou le lecteur lit ce qu'elles avancent.
 */

export interface DeclaredInterest {
  /** Suffixe de domaine, compare sur l'hote. */
  domain: string;
  /** Nom tel qu'il apparait dans la mention publiee. */
  name: string;
  /** Nature de l'interet, en une proposition. Termine la phrase de mention. */
  nature: string;
  /**
   * Formes sous lesquelles la source peut etre nommee dans un texte. Sert a
   * declencher l'exigence de mention meme quand aucune URL du domaine n'est
   * citee : reprendre un chiffre de Galaxy sans lier Galaxy reste un usage de
   * Galaxy.
   */
  aliases: readonly string[];
}

export const DECLARED_INTERESTS: readonly DeclaredInterest[] = [
  {
    domain: "castleisland.vc",
    name: "Castle Island Ventures",
    nature:
      "fonds de capital-risque investi dans les entreprises du secteur qu'il commente",
    aliases: ["castle island", "castleisland"],
  },
  {
    domain: "galaxy.com",
    name: "Galaxy Digital",
    nature:
      "societe d'investissement et de trading exposee aux actifs qu'elle analyse",
    aliases: ["galaxy digital", "galaxy research", "galaxy.com"],
  },
];

/**
 * Phrase de mention, sans le balisage. Une seule fonction la produit : si elle
 * etait recopiee a la main dans le prompt du Redacteur et dans la regle, les
 * deux finiraient par diverger et la regle bloquerait un texte conforme.
 */
export function disclosureText(interest: DeclaredInterest): string {
  return `Divulgation d'interet — ${interest.name} : ${interest.nature}.`;
}

/** La meme phrase, en gras markdown. C'est la forme exigee dans le corps. */
export function boldDisclosure(interest: DeclaredInterest): string {
  return `**${disclosureText(interest)}**`;
}

/**
 * Mention accolee aux observations de la source, des la collecte.
 *
 * Elle voyage avec le resume jusqu'a la claim : l'Analyste voit l'interet
 * avant de typer, pas seulement le Redacteur au moment d'ecrire.
 */
export function interestCaveat(interest: DeclaredInterest): string {
  return (
    `${disclosureText(interest)} A citer comme prise de position d'un acteur ` +
    `du marche, jamais comme donnee neutre ; la mention doit apparaitre en ` +
    `gras dans l'article (§4, EP-002).`
  );
}

/** Meme regle de correspondance que le registre de tiers : hote exact ou sous-domaine. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/** Rend l'interet declare pour une URL, ou `null`. Une URL invalide n'en porte aucun. */
export function interestForUrl(url: string): DeclaredInterest | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return (
    DECLARED_INTERESTS.find((i) => hostMatchesDomain(host, i.domain)) ?? null
  );
}

/** Interets distincts portes par un lot d'URLs, dans l'ordre du registre. */
export function interestsForUrls(
  urls: readonly string[],
): readonly DeclaredInterest[] {
  const found = new Set(
    urls.map((u) => interestForUrl(u)?.domain).filter((d): d is string => d !== undefined),
  );
  return DECLARED_INTERESTS.filter((i) => found.has(i.domain));
}

/**
 * Normalise pour comparer : accents retires, casse et espaces uniformises.
 *
 * Sans cela la regle serait un piege orthographique. Un modele qui ecrit
 * « interet » au lieu de « interet » (ou l'inverse) produit un texte
 * parfaitement conforme au fond ; le bloquer pour un accent transformerait une
 * garantie editoriale en concours de dictee, et la premiere reaction serait de
 * desactiver la regle.
 */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Contenus des passages en gras du markdown. */
function boldSpans(markdown: string): string[] {
  return [...markdown.matchAll(/\*\*([\s\S]+?)\*\*/g)].map((m) => m[1] ?? "");
}

/**
 * Vrai si la mention figure INTEGRALEMENT dans un meme passage en gras.
 *
 * Le test porte sur l'inclusion, pas sur l'egalite : une phrase en gras plus
 * longue qui contient la mention convient. Repartir la mention sur deux
 * passages en gras separes ne convient pas — ce serait la diluer, ce que la
 * regle existe pour empecher.
 */
export function isDisclosedInBold(
  body: string,
  interest: DeclaredInterest,
): boolean {
  const attendu = normalize(disclosureText(interest));
  return boldSpans(body).some((span) => normalize(span).includes(attendu));
}

/** Vrai si le texte nomme la source, sous n'importe laquelle de ses formes. */
export function mentionsInterest(
  text: string,
  interest: DeclaredInterest,
): boolean {
  const t = normalize(text);
  return [interest.name, ...interest.aliases].some((alias) =>
    t.includes(normalize(alias)),
  );
}

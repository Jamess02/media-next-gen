/**
 * Termes de recherche pour les agregateurs de presse.
 *
 * Dependances : aucune, ni npm ni interne. Module pur, partage par les
 * adaptateurs Currents et newsdata — deux copies divergeraient, et celle qui
 * n'est pas testee serait celle qui rend zero resultat.
 *
 * NE D'UN ECHEC REEL, le 2026-09-10. Les deux adaptateurs envoyaient le SUJET
 * ENTIER comme requete :
 *
 *   « inflation annuelle en zone euro : dernier releve publie par Eurostat »
 *
 * Les deux API traitent les mots comme un ET. Une vague de six articles les a
 * donc appeles douze fois, sans erreur, pour ZERO observation. Echec
 * parfaitement silencieux : HTTP 200, zero resultat, rien d'anormal dans le
 * journal d'audit. Les deux sources etaient branchees et inutiles, et seule
 * l'absence de toute reprise de presse dans les articles l'a revele.
 *
 * MESURE du meme jour, sur les deux API :
 *
 *   « inflation annuelle en zone euro : ... »  → 0
 *   « inflation zone euro Eurostat »           → 0
 *   « inflation euro »                         → 15
 *   « inflation »                              → 91
 *   « inflation OR Eurostat »                  → 94
 *
 * D'ou le OU : il elargit au lieu de restreindre. Le ET se vide des qu'on
 * precise — l'inverse du comportement attendu d'une recherche documentaire.
 */

/**
 * Mots outils francais, sans valeur discriminante dans une recherche.
 *
 * Liste courte et volontairement incomplete : le filtre de longueur en ecarte
 * deja la plupart. N'y figurent que des mots LONGS qui passeraient ce filtre
 * tout en n'apportant rien.
 */
const MOTS_OUTILS = new Set([
  "dans", "avec", "pour", "sans", "sous", "entre", "chez", "vers", "depuis",
  "selon", "apres", "avant", "entre", "leur", "leurs", "cette", "cettes",
  "ceux", "celle", "celles", "celui", "dont", "quoi", "plus", "moins",
  "tres", "aussi", "encore", "alors", "donc", "mais", "quand", "comme",
  "dernier", "derniere", "derniers", "dernieres", "annuelle", "annuel",
  "publie", "publiee", "niveau", "total", "totale",
]);

/** En dessous, un mot ne discrimine rien : « le », « et », « de », « en ». */
const LONGUEUR_MIN = 4;

/**
 * DEUX termes, pas davantage. Les API font un ET : chaque terme ajoute
 * RESTREINT. MESURE le 2026-09-10 sur newsdata :
 *
 *   « inflation zone euro Eurostat »  → 0
 *   « inflation zone »                → 19
 *
 * Au-dela de deux, la requete se vide.
 */
const MAX_TERMES = 2;

/**
 * Extrait les termes porteurs de sens d'un sujet de veille.
 *
 * L'ORDRE DU SUJET EST CONSERVE : les premiers mots portent l'intention
 * editoriale (« inflation… » avant « …Eurostat »), et c'est sur eux qu'on veut
 * concentrer la recherche quand il faut trancher.
 */
export function termesDeRecherche(sujet: string): string[] {
  const vus = new Set<string>();
  const retenus: string[] = [];

  for (const brut of sujet.split(/[^\p{L}\p{N}]+/u)) {
    if (brut.length < LONGUEUR_MIN) continue;
    const cle = brut.toLowerCase();
    if (MOTS_OUTILS.has(cle) || vus.has(cle)) continue;
    vus.add(cle);
    retenus.push(brut);
    if (retenus.length === MAX_TERMES) break;
  }
  return retenus;
}

/**
 * Requete prete a envoyer : deux termes, en ET implicite (espace).
 *
 * POURQUOI PAS `OR`, ESSAYE PUIS ABANDONNE. Les deux API acceptent `OR` en
 * majuscules, et il ramene beaucoup : « inflation OR euro OR Eurostat OR
 * releve » rendait 324 resultats. Mais un article n'a besoin de contenir qu'UN
 * terme pour ressortir, et la recolte reelle donnait « le syndrome de
 * Kessler », « des cambriolages dans des casernes », « des ballons a Rouen ».
 *
 * Six observations hors sujet sont PIRES que zero : elles occupent des places
 * dans la selection, et le §5.2 doit alors les ecarter au lieu de travailler.
 * Une source muette est honnete ; une source bavarde et hors sujet ne l'est
 * pas.
 *
 * ZERO EST UNE REPONSE VALIDE. Sur « bilan de la Reserve federale », la presse
 * francaise ne rend rien — parce qu'elle n'en parle pas. C'est l'information
 * juste, et il ne faut pas la maquiller en elargissant la requete.
 *
 * Quand aucun terme ne survit au filtre, on retombe sur le sujet debarrasse de
 * sa ponctuation : une requete faible vaut mieux qu'une requete VIDE, qui
 * rendrait la source muette sans que rien ne le signale — la faute meme que ce
 * module corrige.
 */
export function requeteDeRecherche(sujet: string): string {
  const termes = termesDeRecherche(sujet);
  if (termes.length > 0) return termes.join(" ");
  return sujet.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

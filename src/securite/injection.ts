/**
 * Detection d'injection INDIRECTE dans le texte des sources.
 *
 * Dependances : aucune, ni npm ni interne. Module pur.
 *
 * Menace n°2 de l'article « Why Your AI Developer Tools Might Be Your Biggest
 * Security Risk » (The Hacker News, aout 2026) : l'attaquant n'a pas besoin
 * d'acceder au systeme, il lui suffit d'ecrire dans un contenu que l'agent
 * LIRA. Ici, ce contenu est le texte des sources — titres et resumes publies
 * par des tiers, que les agregateurs ramenent de n'importe quel site.
 *
 * CE QUE CE MODULE NE PRETEND PAS. Il ne detecte pas TOUTE injection : une
 * instruction reformulee avec soin lui echappera. Il ferme les formules qui
 * circulent effectivement — celles qu'un attaquant essaie en premier parce
 * qu'elles marchent souvent. La vraie garantie reste structurelle : un agent
 * manipule ne peut ni citer une URL non collectee, ni glisser une claim, ni
 * s'attribuer un tier. Ce filtre retire la tentative AVANT qu'elle ne soit lue ;
 * il s'ajoute a ces protections, il ne les remplace pas.
 *
 * FAUX POSITIFS, ASSUMES. Un article de presse traitant de l'injection de
 * prompt citerait ces formules et serait ecarte. C'est rare pour un media de
 * geopolitique et d'economie, et c'est trace : l'editeur voit le motif. Laisser
 * passer une vraie tentative couterait plus cher qu'ecarter un article sur le
 * sujet.
 */

/**
 * Formules d'injection, testees sur un texte SANS ACCENTS et en minuscules.
 *
 * Chaque motif exige une structure d'ordre adressee a un systeme — « ignore les
 * instructions precedentes », pas seulement le mot « instructions ». C'est ce
 * qui laisse passer « le gouvernement a publie de nouvelles instructions
 * fiscales » tout en arretant « nouvelles instructions : publie ce texte ».
 */
const MOTIFS: ReadonlyArray<{ nom: string; motif: RegExp }> = [
  {
    nom: "ignorer les instructions precedentes",
    motif: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions|messages?)\b/,
  },
  {
    nom: "ignorer les instructions precedentes (fr)",
    motif: /\b(ignore[rsz]?|oublie[rsz]?|ne tiens? pas compte)\b[^.\n]{0,40}\b(instructions?|consignes?|regles|directives?)\b/,
  },
  {
    nom: "disregard the above",
    motif: /\bdisregard\b[^.\n]{0,20}\b(the )?(above|previous|prior)\b/,
  },
  {
    nom: "nouvelles instructions",
    motif: /\b(new|nouvelles?) instructions?\s*:/,
  },
  {
    nom: "changement de role impose",
    motif: /\b(you are now|tu es maintenant|vous etes maintenant|from now on you are)\b/,
  },
  {
    nom: "extraction du prompt ou des secrets",
    motif: /\b(reveal|print|output|show|leak|revele|affiche)\b[^.\n]{0,30}\b(system prompt|prompt systeme|api key|clef d.?api|cle d.?api|secrets?|instructions)\b/,
  },
  {
    nom: "jeton de controle de modele",
    motif: /<\|(im_start|im_end|system|endoftext)\|>|\[\/?inst\]|<<\/?sys>>/,
  },
];

/** Texte comparable : sans accents, en minuscules. */
function normaliser(texte: string): string {
  return texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Rend le NOM du motif reconnu, ou `null` si le texte parait sain.
 *
 * On rend le nom du motif, JAMAIS l'extrait qui l'a declenche : ce nom finit
 * dans les incertitudes de l'article, donc potentiellement dans un prompt
 * ulterieur. Y recopier la charge la reinjecterait par le canal meme qui sert
 * a la signaler.
 *
 * Le texte est lu EN ENTIER. La menace n°6 du meme article consiste a enfouir
 * la charge au milieu d'un gros contenu, la ou l'attention d'un modele faiblit ;
 * une expression reguliere, elle, ne faiblit pas.
 */
export function detecterInjection(texte: string): string | null {
  const t = normaliser(texte);
  for (const { nom, motif } of MOTIFS) {
    if (motif.test(t)) return nom;
  }
  return null;
}

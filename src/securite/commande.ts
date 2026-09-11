/**
 * Distinguer un SUJET d'article d'une commande mal tapee.
 *
 * Dependances : aucune, ni npm ni interne. Module pur.
 *
 * NE D'UN INCIDENT REEL, le 2026-09-11. `npm run dev -- verify-journal` voulait
 * verifier le journal d'audit ; la commande publique est `journal`, et
 * `verify-journal` n'en est que le nom interne. L'interface l'a pris pour un
 * sujet d'article et lance le pipeline : cinq appels reels au modele, pour
 * rien. Avec un fournisseur facture, une faute de frappe aurait coute de
 * l'argent.
 *
 * LE PRINCIPE. Tout argument inconnu devient un sujet, et un sujet declenche
 * des appels. Ce repli est commode — `npm run dev -- inflation` marche — mais il
 * transforme chaque erreur de frappe en action couteuse et silencieuse. On
 * refuse donc ce qui RESSEMBLE a une commande, en indiquant la bonne.
 *
 * FAUX POSITIFS. Un vrai sujet d'un seul mot proche d'une commande serait
 * refuse. Aucun des sujets du catalogue n'est dans ce cas, et le message
 * indique comment passer outre : formuler le sujet en plusieurs mots.
 */

/** Commandes publiques, telles que l'utilisateur les tape. */
const COMMANDES = [
  "valider",
  "vague",
  "vagues",
  "journal",
  "site",
  "preview",
  "studio",
  "revise",
  "marches",
] as const;

/**
 * Noms INTERNES, tapes par erreur a la place de la commande publique. C'est
 * exactement l'incident d'origine.
 */
const NOMS_INTERNES: Record<string, string> = {
  "verify-journal": "journal",
  "build-site": "site",
  "list-providers": "--providers",
};

/** Racines de commande, reperees a l'interieur d'un mot compose. */
const RACINES = /(verif|verify|build|list|journal|site|provider|publish|valider|vague|studio|preview|revise)/;

/** Distance d'edition : combien de lettres changer pour passer de a a b. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;
      const ligne = d[i] as number[];
      const precedente = d[i - 1] as number[];
      ligne[j] = Math.min(
        (precedente[j] as number) + 1,
        (ligne[j - 1] as number) + 1,
        (precedente[j - 1] as number) + cout,
      );
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * Drapeaux REFUSES, avec le message qui explique quoi faire a la place.
 *
 * `--mode=live` equivalait a `--provider=anthropic` : le seul fournisseur
 * FACTURE, que l'editeur a interdit le 2026-09-10. Rien dans son nom ne
 * l'annoncait — « live » evoque des sources reelles, pas une depense — et un
 * seul argument suffisait a la declencher. Il echoue desormais avec un
 * message plutot que de disparaitre en silence : un drapeau devenu inconnu
 * serait pris pour un SUJET d'article, et lancerait le pipeline.
 */
const DRAPEAUX_REFUSES: Record<string, string> = {
  "--mode=live":
    "--mode=live est refuse : il selectionnait Anthropic, un fournisseur FACTURE " +
    "que l'editeur a interdit. Aucun appel n'a ete lance.\n" +
    "Pour des sources reelles avec un fournisseur gratuit :\n" +
    "  npm run dev -- --provider=gemini --real-sources \"<sujet>\"",
};

/** Rend le message de refus si `arg` est un drapeau refuse, sinon `null`. */
export function drapeauRefuse(arg: string): string | null {
  return DRAPEAUX_REFUSES[arg] ?? null;
}

/**
 * Rend la commande a suggerer si `sujet` ressemble a une commande, sinon `null`.
 *
 * Un sujet de PLUSIEURS mots n'est jamais une commande : les sujets reels sont
 * des phrases, les commandes des mots isoles. Seul un argument d'un seul mot
 * est examine.
 */
export function ressembleAUneCommande(sujet: string): string | null {
  const s = sujet.trim().toLowerCase();
  if (s.length === 0 || /\s/.test(s)) return null;

  const interne = NOMS_INTERNES[s];
  if (interne !== undefined) return interne;

  // Faute de frappe : a une ou deux lettres pres d'une commande publique. Le
  // plancher de quatre lettres evite de rapprocher n'importe quel mot court.
  if (s.length >= 4) {
    const proche = COMMANDES.find((c) => c !== s && distance(s, c) <= 2);
    if (proche !== undefined) return proche;
  }

  // Mot compose de lettres seules, contenant une racine de commande :
  // « verifier-journal ». Les chiffres en sont exclus, pour laisser passer
  // « covid-19 ».
  if (/^[a-z]+(-[a-z]+)+$/.test(s) && RACINES.test(s)) {
    const racine = COMMANDES.find((c) => s.includes(c));
    return racine ?? "une commande";
  }

  return null;
}

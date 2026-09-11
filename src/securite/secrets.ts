/**
 * Detection de secrets dans les fichiers SUIVIS par git.
 *
 * Dependances : aucune, ni npm ni interne. Le module est volontairement pur —
 * il recoit un nom de fichier et son contenu, et ne lit ni le disque ni git.
 * C'est ce qui permet au test unitaire ET au hook de pre-commit d'utiliser le
 * MEME code : deux implementations divergeraient, et celle qui n'est pas
 * testee serait celle qui laisse passer.
 *
 * NE DE LA FUITE REELLE DU 2026-09-10 : la clef FRED de production etait
 * ecrite en dur dans un fichier de test, commitee, et poussee sur un depot
 * PUBLIC. Les dispositifs existants ne pouvaient pas la voir : `.gitignore`
 * protege `.env`, `audit/redaction.ts` nettoie les URLs du journal — les deux
 * supposent que le secret arrive par un fichier d'environnement ou par une
 * URL. Ecrit a la main dans du code source, il echappait aux deux.
 *
 * PRINCIPE : peu de regles, PRECISES. Un detecteur bruyant finit desactive, et
 * un controle desactive ne protege rien. D'ou l'absence de detection par
 * entropie generique, qui signalerait toutes les empreintes base64 de
 * `package-lock.json`.
 */

/** Une forme de clef reconnaissable a son gabarit. */
export interface FormeDeClef {
  /** Nom court, affiche dans le rapport. */
  nom: string;
  motif: RegExp;
}

/**
 * Gabarits couverts.
 *
 * `hex-32` merite un mot : c'est le format FRED, et donc celui qui a fuite.
 * Il est borne par `\b` des deux cotes ET exclu quand il fait partie d'une
 * chaine plus longue (une empreinte SHA-256 en contient deux). MESURE sur ce
 * depot : une seule occurrence dans tout le code suivi, la clef fuitee — donc
 * zero faux positif.
 */
export const FORMES_DE_CLEFS: readonly FormeDeClef[] = [
  { nom: "newsdata", motif: /\bpub_[0-9a-f]{24,}\b/g },
  { nom: "groq", motif: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { nom: "openai", motif: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { nom: "google", motif: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { nom: "google-oauth", motif: /\bAQ\.[A-Za-z0-9_-]{20,}\b/g },
  { nom: "github", motif: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { nom: "slack", motif: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { nom: "aws", motif: /\bAKIA[0-9A-Z]{16}\b/g },
  // Plan Demo de CoinGecko : « CG- » suivi de 24 caracteres. Le plancher de
  // 20 laisse passer « CG-Paris » ou « CG-40 », qui ne sont pas des clefs.
  { nom: "coingecko", motif: /\bCG-[A-Za-z0-9]{20,}\b/g },
  { nom: "hex-32", motif: /(?<![0-9a-fA-F])[0-9a-f]{32}(?![0-9a-fA-F])/g },
];

/**
 * Fichiers exclus de l'analyse.
 *
 * Les verrous de dependances sont pleins d'empreintes `sha512-` en base64 qui
 * ressemblent a des secrets sans en etre. Les inclure produirait des centaines
 * d'alertes a chaque installation, et le controle serait abandonne en une
 * semaine.
 */
const FICHIERS_IGNORES = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/];

/**
 * Echappatoire NOMMEE, sur la ligne concernee : `secret-autorise: <raison>`.
 *
 * Une exception explicite et justifiee vaut mieux qu'un motif affaibli : elle
 * se relit, se discute en revue, et laisse le detecteur strict pour tout le
 * reste. Sans elle, le premier faux positif ferait desactiver l'ensemble.
 */
const ECHAPPATOIRE = /secret-autorise\s*:/i;

/** Variables d'environnement dont le NOM annonce un secret. */
const NOM_DE_SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)$/;

/**
 * Longueur minimale d'une valeur pour etre traitee comme un secret.
 *
 * En dessous, on attrape des valeurs de configuration ordinaires ("fr", "abc")
 * qui apparaissent legitimement dans le code.
 */
const LONGUEUR_MIN_SECRET = 12;

/**
 * Chemins qui ne devraient JAMAIS figurer dans l'historique, quel que soit
 * leur contenu.
 *
 * Complementaire de la detection par contenu : `.env` peut contenir une valeur
 * qu'aucun gabarit ne reconnait, et une archive `audit/raw/` n'est pas
 * caviardee par conception. Pour ces chemins, la seule presence est la faute —
 * on n'a pas a inspecter ce qu'ils contiennent.
 *
 * `.env.example` est exclu de l'interdiction : un modele SANS valeurs est fait
 * pour etre versionne, et l'interdire priverait le projet du seul fichier qui
 * documente les variables attendues.
 */
const CHEMINS_INTERDITS: ReadonlyArray<{ motif: RegExp; motifDit: string }> = [
  {
    motif: /(^|\/)\.env(\.(?!example$|sample$|template$)[A-Za-z0-9_.-]+)?$/,
    motifDit: "fichier d'environnement : il porte les clefs en clair",
  },
  {
    motif: /(^|\/)audit\/raw\//,
    motifDit: "archive brute d'audit : non caviardee par conception",
  },
  {
    motif: /\.(pem|key|p12|pfx|jks|keystore)$/i,
    motifDit: "clef privee ou trousseau",
  },
  {
    motif: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
    motifDit: "clef privee SSH",
  },
];

/**
 * Dit si un chemin n'a rien a faire dans l'historique, et pourquoi.
 *
 * @returns le motif, ou `null` si le chemin est admissible.
 */
export function cheminInterdit(chemin: string): string | null {
  const normalise = chemin.replace(/\\/g, "/");
  for (const { motif, motifDit } of CHEMINS_INTERDITS) {
    if (motif.test(normalise)) return motifDit;
  }
  return null;
}

/**
 * Registre des fuites RECONNUES et REVOQUEES, par empreinte de blob.
 *
 * Pourquoi il faut ce registre. L'historique Git est immuable : une clef
 * poussee y reste. Sans registre, l'audit d'historique signalerait la meme
 * fuite a chaque execution, indefiniment. Un rapport toujours rouge n'est plus
 * lu, et la vraie alerte du mois prochain passerait inapercue au milieu du
 * bruit connu.
 *
 * Le registre ne « repare » rien et ne pretend pas le faire : il enregistre
 * qu'une fuite a ete traitee par le seul geste qui vaille — la revocation
 * chez le fournisseur. On y consigne l'empreinte du BLOB, pas la valeur.
 *
 * Format, une entree par ligne : `<sha40>  <raison>`. `#` commente.
 */
export function lireRevoques(contenu: string): Map<string, string> {
  const registre = new Map<string, string>();
  for (const ligne of contenu.split("\n")) {
    const net = ligne.trim();
    if (net.length === 0 || net.startsWith("#")) continue;
    const m = /^([0-9a-f]{40})\s+(.+)$/.exec(net);
    if (m === null) continue; // entree malformee : ignoree, jamais devinee
    registre.set(m[1] as string, (m[2] as string).trim());
  }
  return registre;
}

export interface Trouvaille {
  fichier: string;
  /** Numerotee a partir de 1, comme dans un editeur. */
  ligne: number;
  /** Gabarit reconnu, ou `valeur-.env`. */
  forme: string;
  /** Debut de la valeur, pour identifier sans republier. JAMAIS la valeur. */
  apercu: string;
}

/**
 * Extrait de `.env` les valeurs a considerer comme secretes.
 *
 * On ne retient QUE les variables dont le nom annonce un secret : `.env`
 * contient aussi `MEDIA_PROVIDER=gemini`, et traiter cette valeur comme
 * secrete ferait echouer sur chaque fichier citant "gemini" — donc partout.
 */
export function secretsDeEnv(contenuEnv: string): string[] {
  const valeurs: string[] = [];
  for (const ligne of contenuEnv.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(ligne);
    if (m === null) continue;
    const [, nom = "", brut = ""] = m;
    if (!NOM_DE_SECRET.test(nom)) continue;
    const valeur = brut.trim().replace(/^["']|["']$/g, "");
    if (valeur.length < LONGUEUR_MIN_SECRET) continue;
    valeurs.push(valeur);
  }
  return valeurs;
}

/** Les 6 premiers caracteres suffisent a identifier, jamais a reutiliser. */
function apercu(valeur: string): string {
  return `${valeur.slice(0, 6)}… (${valeur.length} car.)`;
}

/**
 * Cherche des secrets dans un fichier.
 *
 * @param fichier chemin relatif, tel que rendu par `git ls-files`
 * @param contenu contenu textuel du fichier
 * @param secretsEnv valeurs issues de `.env`, quand il est lisible
 */
export function chercherSecrets(
  fichier: string,
  contenu: string,
  secretsEnv: readonly string[] = [],
): Trouvaille[] {
  if (FICHIERS_IGNORES.some((m) => m.test(fichier))) return [];

  const trouvailles: Trouvaille[] = [];
  const lignes = contenu.split("\n");

  lignes.forEach((texte, i) => {
    if (ECHAPPATOIRE.test(texte)) return;
    const ligne = i + 1;

    // Valeurs de .env : attrape la recopie d'un secret ACTUEL.
    for (const valeur of secretsEnv) {
      if (texte.includes(valeur)) {
        trouvailles.push({ fichier, ligne, forme: "valeur-.env", apercu: apercu(valeur) });
      }
    }

    // Gabarits : attrapent un secret dont la valeur n'est PLUS dans .env —
    // le cas d'une clef revoquee puis remplacee, ou celle d'un autre projet.
    for (const forme of FORMES_DE_CLEFS) {
      // `matchAll` sur une regex globale n'a pas d'etat partage entre appels,
      // contrairement a `test`, qui retiendrait `lastIndex` d'une ligne a
      // l'autre et sauterait une occurrence sur deux.
      for (const m of texte.matchAll(forme.motif)) {
        const deja = trouvailles.some((t) => t.ligne === ligne && t.apercu === apercu(m[0]));
        if (!deja) {
          trouvailles.push({ fichier, ligne, forme: forme.nom, apercu: apercu(m[0]) });
        }
      }
    }
  });

  return trouvailles;
}

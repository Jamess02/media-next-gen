/**
 * Refuse un commit qui contiendrait un secret.
 *
 * Dependances : `src/securite/secrets.ts` (le MEME detecteur que
 * `tests/securite-secrets.test.ts`, pour qu'il n'existe pas deux
 * implementations dont une seule serait testee). Aucune dependance npm.
 *
 * DEUX MODES
 *
 *  - sans argument : analyse le contenu INDEXE (`git diff --cached`), c'est-a-
 *    dire ce qui va reellement etre commite. Analyser le disque laisserait
 *    passer un secret indexe puis retire du fichier de travail ;
 *  - `--tout` : analyse tous les fichiers suivis. Sert a verifier l'existant.
 *
 * POURQUOI UN HOOK EN PLUS DU TEST
 *
 * Le test attrape la faute APRES coup, quand quelqu'un lance la suite. Le hook
 * l'attrape AVANT que le secret n'entre dans l'historique — seul moment ou la
 * correction est encore gratuite. Une fois commite et pousse, aucun nettoyage
 * ne rattrape la publication : il ne reste qu'a revoquer.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { fichiersAControler } from "../src/securite/fichiers.js";
import {
  chercherSecrets,
  cheminInterdit,
  lireRevoques,
  secretsDeEnv,
  type Trouvaille,
} from "../src/securite/secrets.js";

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function fichiersIndexes(): string[] {
  // `ACMR` : ajoutes, copies, modifies, renommes. Les suppressions n'ont pas
  // de contenu a analyser.
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .filter((f) => f.trim().length > 0);
}

function contenuIndexe(fichier: string): string {
  try {
    return git(["show", `:${fichier}`]);
  } catch {
    return "";
  }
}

/**
 * Audite TOUT l'historique pousse, objet par objet.
 *
 * Pourquoi les objets et non `git log -p` : un patch montre les CHANGEMENTS.
 * Un secret ajoute puis retire apparait deux fois dans les patches et zero
 * fois dans l'arbre final — mais le blob qui le contient reste accessible
 * indefiniment, et GitHub le sert par son empreinte. Enumerer les BLOBS est
 * donc la seule facon de voir ce qui est reellement publie.
 *
 * On dedoublonne par empreinte : un fichier inchange sur trente commits est un
 * seul blob, donc une seule lecture.
 */
function auditerHistorique(secrets: readonly string[]): number {
  const objets = git(["rev-list", "--objects", "--remotes=origin"])
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const nommes = new Map<string, string>(); // empreinte -> chemin
  for (const ligne of objets) {
    const i = ligne.indexOf(" ");
    if (i === -1) continue; // commit ou tag : pas de chemin associe
    const sha = ligne.slice(0, i);
    const chemin = ligne.slice(i + 1).trim();
    if (chemin.length > 0 && !nommes.has(sha)) nommes.set(sha, chemin);
  }

  // Le TYPE d'abord, en un seul appel. `rev-list --objects` melange blobs et
  // arbres (un repertoire porte lui aussi un chemin) ; imposer le type `blob`
  // a un arbre echoue avec « bad file ». Distinguer explicitement evite de
  // confondre « repertoire, rien a lire » et « fichier illisible » — la
  // seconde laisserait un angle mort dans un audit cense etre exhaustif.
  const types = new Map<string, { type: string; taille: number }>();
  const lignes = execFileSync("git", ["cat-file", "--batch-check"], {
    encoding: "utf8",
    input: [...nommes.keys()].join("\n"),
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
  for (const l of lignes) {
    const [sha, type, taille] = l.trim().split(/\s+/);
    if (sha !== undefined && type !== undefined) {
      types.set(sha, { type, taille: Number(taille ?? 0) });
    }
  }

  const blobs = new Map(
    [...nommes].filter(([sha]) => types.get(sha)?.type === "blob"),
  );
  const arbres = nommes.size - blobs.size;

  const revoques = existsSync(".secrets-revoques")
    ? lireRevoques(readFileSync(".secrets-revoques", "utf8"))
    : new Map<string, string>();

  let connues = 0;
  let illisibles = 0;
  let trop_gros = 0;
  let lus = 0;
  let fautes = 0;

  for (const [sha, chemin] of blobs) {
    const motif = cheminInterdit(chemin);
    if (motif !== null) {
      fautes += 1;
      console.error(`  CHEMIN INTERDIT  ${chemin}  [${motif}]`);
      console.error(`                   blob ${sha.slice(0, 12)} — ${commitsPorteurs(sha)}`);
      continue;
    }

    // Les gros objets sont des verrous de dependances ou des binaires. On les
    // COMPTE au lieu de les ignorer en silence : un audit doit dire ce qu'il
    // n'a pas regarde.
    if ((types.get(sha)?.taille ?? 0) > 2_000_000) {
      trop_gros += 1;
      console.log(`  (non lu, ${types.get(sha)?.taille} octets) ${chemin}`);
      continue;
    }

    let contenu: string;
    try {
      contenu = git(["cat-file", "blob", sha]);
      lus += 1;
    } catch {
      illisibles += 1;
      console.error(`  ILLISIBLE  ${chemin}  blob ${sha.slice(0, 12)}`);
      continue;
    }

    const trouve = chercherSecrets(chemin, contenu, secrets);
    if (trouve.length === 0) continue;

    // Fuite deja traitee : signalee pour memoire, jamais comptee en faute.
    // L'historique ne se corrige pas ; seule la revocation compte, et elle a
    // eu lieu. Compter indefiniment ce qui est resolu ferait cesser la lecture
    // du rapport, donc manquer la fuite suivante.
    const raison = revoques.get(sha);
    if (raison !== undefined) {
      connues += 1;
      console.log(`  (revoque) ${chemin}  — ${raison}`);
      continue;
    }

    for (const t of trouve) {
      fautes += 1;
      console.error(`  SECRET  ${t.fichier}:${t.ligne}  [${t.forme}]  ${t.apercu}`);
      console.error(`          blob ${sha.slice(0, 12)} — ${commitsPorteurs(sha)}`);
    }
  }

  console.log("");
  console.log(
    `Couverture : ${objets.length} objets — ${blobs.size} fichiers (${lus} lus, ` +
      `${trop_gros} trop gros, ${illisibles} illisibles), ${arbres} repertoires.`,
  );
  if (connues > 0) {
    console.log(
      `${connues} fuite(s) deja revoquee(s), consignee(s) dans .secrets-revoques.`,
    );
  }
  if (illisibles > 0) {
    console.error("AUDIT INCOMPLET : des fichiers n'ont pas pu etre lus (ci-dessus).");
  }

  return fautes + illisibles;
}

/** Commits qui ont introduit ou retire ce blob. */
function commitsPorteurs(sha: string): string {
  try {
    const l = git(["log", "--oneline", "--all", `--find-object=${sha}`])
      .split("\n")
      .filter((x) => x.trim().length > 0);
    return l.length === 0 ? "commit non retrouve" : l.map((x) => x.slice(0, 60)).join(" | ");
  } catch {
    return "commit non retrouve";
  }
}

function main(): void {
  const tout = process.argv.includes("--tout");
  const historique = process.argv.includes("--historique");
  const secrets = existsSync(".env") ? secretsDeEnv(readFileSync(".env", "utf8")) : [];

  if (historique) {
    const fautes = auditerHistorique(secrets);
    console.log("");
    if (fautes === 0) {
      console.log("Aucun secret dans l'historique pousse.");
      return;
    }
    console.error(`${fautes} probleme(s) dans l'HISTORIQUE.`);
    console.error("");
    console.error("Un secret deja pousse ne s'efface pas : le retirer d'un commit");
    console.error("ne supprime ni les forks, ni les caches, ni les copies locales.");
    console.error("La seule remediation est la REVOCATION chez le fournisseur.");
    process.exit(1);
  }

  // `--tout` couvre les fichiers suivis ET les nouveaux non ignores. Scanner
  // les seuls fichiers suivis laissait passer un secret ecrit dans un fichier
  // tout juste cree — et le controle repondait « aucun secret » sans avoir
  // regarde. Un controle qui rassure a tort vaut moins que pas de controle.
  const fichiers = tout ? fichiersAControler() : fichiersIndexes();

  const trouvailles: Trouvaille[] = [];
  for (const f of fichiers) {
    let contenu: string;
    if (tout) {
      try {
        contenu = readFileSync(f, "utf8");
      } catch {
        continue;
      }
    } else {
      contenu = contenuIndexe(f);
    }
    trouvailles.push(...chercherSecrets(f, contenu, secrets));
  }

  if (trouvailles.length === 0) {
    console.log(
      `Aucun secret detecte (${fichiers.length} fichier(s) ${tout ? "a controler" : "indexes"}).`,
    );
    return;
  }

  // On nomme le fichier et la ligne, JAMAIS la valeur : ce message peut finir
  // dans un journal de CI, ou le secret serait republie par l'alerte meme.
  console.error("");
  console.error("COMMIT REFUSE — secret(s) detecte(s) :");
  console.error("");
  for (const t of trouvailles) {
    console.error(`  ${t.fichier}:${t.ligne}  [${t.forme}]  ${t.apercu}`);
  }
  console.error("");
  console.error("Un secret commite est un secret publie : l'historique le conserve,");
  console.error("et une reecriture n'efface pas les copies deja distribuees.");
  console.error("");
  console.error("  - deplacer la valeur dans .env (ignore par git) ;");
  console.error("  - si elle a DEJA ete poussee, la REVOQUER chez le fournisseur ;");
  console.error("  - si la valeur est fictive, l'annoter : // secret-autorise: <raison>");
  console.error("");
  process.exit(1);
}

main();

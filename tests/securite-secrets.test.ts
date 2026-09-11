/**
 * Aucun secret ne doit se trouver dans un fichier SUIVI par git.
 *
 * NE DE LA FUITE REELLE DU 2026-09-10. La clef FRED de production etait ecrite
 * en dur a `tests/securite-api.test.ts:42`, introduite par le commit c50b507
 * — intitule « Securite en TDD : six failles fermees ». Elle est restee dans
 * `origin/main` d'un depot PUBLIC jusqu'a sa revocation.
 *
 * POURQUOI LES CONTROLES EXISTANTS NE L'ONT PAS VUE
 *
 * Ils regardaient au mauvais endroit. `.gitignore` protege `.env` et
 * `audit/raw/`, et le caviardage (`audit/redaction.ts`) nettoie les URLs du
 * journal. Les deux supposaient que le secret arrive par une URL ou par un
 * fichier d'environnement. Ici il etait ecrit A LA MAIN dans du code source :
 * aucun de ces dispositifs ne regarde le code lui-meme.
 *
 * DEUX REGLES, POUR DEUX FAUTES DIFFERENTES
 *
 *  - valeurs de `.env` : attrape la recopie d'un secret ACTUEL ;
 *  - formes connues de clefs : attrape un secret dont la valeur n'est plus
 *    dans `.env` — precisement le cas ici, la clef ayant ete revoquee et
 *    remplacee. Sans cette seconde regle, la rotation aurait rendu la fuite
 *    invisible au controle cense la detecter.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fichiersAControler } from "../src/securite/fichiers.js";
import {
  FORMES_DE_CLEFS,
  chercherSecrets,
  cheminInterdit,
  lireRevoques,
  secretsDeEnv,
} from "../src/securite/secrets.js";

/** Fichiers suivis par git : ce sont EXACTEMENT ceux qui peuvent fuiter. */
function fichiersSuivis(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.trim().length > 0);
  } catch {
    return [];
  }
}

describe("detection — formes de clefs", () => {
  it("reconnait une clef FRED (32 hexadecimaux)", () => {
    // secret-autorise: gabarit de test, valeur fictive
    const t = chercherSecrets("cle.ts", 'const K = "0123456789abcdef0123456789abcdef";'); // secret-autorise: gabarit de test, valeur fictive
    expect(t).toHaveLength(1);
    expect(t[0]?.forme).toBe("hex-32");
    expect(t[0]?.ligne).toBe(1);
  });

  it("reconnait les prefixes de fournisseurs connus", () => {
    // TOUTES CES VALEURS SONT FICTIVES, et doivent le rester.
    //
    // La premiere version de ce tableau portait la VRAIE clef newsdata,
    // recopiee depuis .env comme « exemple » de gabarit — dans le fichier meme
    // qui teste la detection des secrets. Le hook de pre-commit l'a refusee,
    // ce qui etait son role ; mais elle n'aurait jamais du etre ecrite.
    //
    // Une valeur d'exemple ne se prend PAS dans .env, meme « juste pour
    // verifier que le motif correspond ».
    const cas: Array<[string, string]> = [
      // secret-autorise: gabarits de test, valeurs fictives
      ["pub_0000111122223333444455556666aaaa", "newsdata"], // secret-autorise: gabarit de test, valeur fictive
      ["gsk_abcdefghijklmnopqrstuvwxyz012345", "groq"], // secret-autorise: gabarit de test, valeur fictive
      ["sk-abcdefghijklmnopqrstuvwxyz012345", "openai"], // secret-autorise: gabarit de test, valeur fictive
      ["AIzaSyAbcdefghijklmnopqrstuvwxyz0123456", "google"], // secret-autorise: gabarit de test, valeur fictive
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github"], // secret-autorise: gabarit de test, valeur fictive
    ];
    for (const [valeur, forme] of cas) {
      const t = chercherSecrets("x.ts", `const K = "${valeur}";`);
      expect(t.map((x) => x.forme), valeur).toContain(forme);
    }
  });

  it("ne signale JAMAIS la valeur du secret dans son rapport", () => {
    // Le rapport est affiche en console et peut finir dans un journal de CI.
    // Y recopier le secret le republierait a l'endroit meme ou on l'annonce.
    const secret = "0123456789abcdef0123456789abcdef"; // secret-autorise: gabarit de test, valeur fictive
    const t = chercherSecrets("cle.ts", `const K = "${secret}";`);
    expect(JSON.stringify(t)).not.toContain(secret);
  });

  it("ne se declenche pas sur une empreinte SHA-256 (64 hex)", () => {
    // Le journal d'audit et le changelog en contiennent partout : les
    // confondre avec des clefs rendrait le controle inutilisable.
    const sha = "a".repeat(64);
    expect(chercherSecrets("audit.ts", `const h = "${sha}";`)).toHaveLength(0);
  });

  it("ne se declenche pas sur du texte ordinaire ni sur un UUID", () => {
    expect(chercherSecrets("a.ts", "const id = 'article-9bdb6030-b5ad-4187-b4fe-4c3767e914a7';")).toHaveLength(0);
    expect(chercherSecrets("b.md", "L'inflation atteint 2,47 % en 2025.")).toHaveLength(0);
  });

  it("ignore les fichiers de verrouillage, pleins d'empreintes base64", () => {
    const ligne = 'integrity: "sha512-dvLKvVtNTibSTBej1NCAbaGhWn9Ww1ZPx80qsahhPFe"';
    expect(chercherSecrets("package-lock.json", ligne)).toHaveLength(0);
  });

  it("accepte une valeur explicitement declaree fictive", () => {
    // Sans echappatoire nommee, le premier faux positif ferait desactiver le
    // controle en entier — et un controle desactive ne protege rien.
    const t = chercherSecrets(
      "x.ts",
      'const K = "0123456789abcdef0123456789abcdef"; // secret-autorise: exemple de documentation',
    );
    expect(t).toHaveLength(0);
  });
});

describe("detection — valeurs de .env", () => {
  it("attrape la recopie d'une valeur de .env", () => {
    const secrets = secretsDeEnv("FRED_API_KEY=valeur-secrete-de-test-123\nMEDIA_PROVIDER=gemini\n");
    const t = chercherSecrets("x.ts", 'const K = "valeur-secrete-de-test-123";', secrets);
    expect(t[0]?.forme).toBe("valeur-.env");
  });

  it("ne retient QUE les variables qui nomment un secret", () => {
    // `MEDIA_PROVIDER=gemini` est dans .env : traiter sa valeur comme secrete
    // ferait echouer sur chaque fichier citant "gemini", donc partout.
    const secrets = secretsDeEnv("MEDIA_PROVIDER=gemini\nMEDIA_MODEL=gemini-3.5-flash-lite\n");
    expect(secrets).toHaveLength(0);
  });

  it("ignore une valeur vide ou trop courte pour etre un secret", () => {
    expect(secretsDeEnv("RELIEFWEB_APPNAME=\nX_TOKEN=abc\n")).toHaveLength(0);
  });
});

describe("chemins qui ne devraient jamais entrer dans l'historique", () => {
  it("refuse .env et ses variantes", () => {
    for (const p of [".env", ".env.local", ".env.production", "config/.env", ".env.bak-1788993492"]) {
      expect(cheminInterdit(p), p).not.toBeNull();
    }
  });

  it("refuse les archives brutes d'audit, non caviardees par conception", () => {
    expect(cheminInterdit("audit/raw/abc.json")).not.toBeNull();
  });

  it("refuse les clefs privees et trousseaux", () => {
    for (const p of ["cle.pem", "id_rsa", "serveur.p12", "cert.pfx"]) {
      expect(cheminInterdit(p), p).not.toBeNull();
    }
  });

  it("laisse passer les fichiers ordinaires, y compris .env.example", () => {
    // Un modele sans valeurs est fait pour etre versionne : l'interdire
    // priverait le projet du seul fichier qui documente les variables.
    for (const p of ["src/index.ts", ".env.example", ".gitignore", "audit/journal.jsonl"]) {
      expect(cheminInterdit(p), p).toBeNull();
    }
  });
});

describe("registre des fuites reconnues et revoquees", () => {
  it("lit les empreintes de blobs declarees, en ignorant commentaires et vides", () => {
    const registre = lireRevoques(
      [
        "# clef FRED, revoquee le 2026-09-10",
        "747057ff5cea0000000000000000000000000000  clef FRED revoquee",
        "",
        "   ",
      ].join("\n"),
    );
    expect(registre.size).toBe(1);
    expect(registre.get("747057ff5cea0000000000000000000000000000")).toMatch(/revoquee/);
  });

  it("rend un registre vide quand le fichier est absent ou vide", () => {
    expect(lireRevoques("").size).toBe(0);
    expect(lireRevoques("# rien que des commentaires\n").size).toBe(0);
  });

  it("ignore une ligne dont l'empreinte n'a pas la forme d'un sha", () => {
    // Une entree malformee ne doit pas silencieusement blanchir autre chose.
    expect(lireRevoques("pas-un-sha  raison\n").size).toBe(0);
  });
});

describe("le depot lui-meme", () => {
  it("ne contient AUCUN secret dans un fichier suivi par git", () => {
    const fichiers = fichiersSuivis();
    expect(fichiers.length, "aucun fichier suivi : git indisponible ?").toBeGreaterThan(0);

    const secrets = existsSync(".env") ? secretsDeEnv(readFileSync(".env", "utf8")) : [];
    const trouvailles = fichiers.flatMap((f) => {
      let contenu: string;
      try {
        contenu = readFileSync(f, "utf8");
      } catch {
        return [];
      }
      return chercherSecrets(f, contenu, secrets);
    });

    // Le message nomme le fichier et la ligne, jamais la valeur.
    expect(
      trouvailles.map((t) => `${t.fichier}:${t.ligne} (${t.forme})`),
    ).toEqual([]);
  });

  it("verifie bien tout l'arbre, pas trois fichiers", () => {
    // Garde-fou du garde-fou : si `git ls-files` cassait, le test precedent
    // passerait sur une liste vide et n'assurerait plus rien.
    expect(fichiersSuivis().length).toBeGreaterThan(30);
  });

  it("expose les formes couvertes, pour qu'on puisse les completer", () => {
    expect(FORMES_DE_CLEFS.length).toBeGreaterThan(4);
  });
});

describe("le controle doit voir les fichiers NON ENCORE SUIVIS", () => {
  /**
   * FAILLE DU GARDE-FOU LUI-MEME, constatee le 2026-09-11.
   *
   * `npm run verifier-secrets` a repondu « aucun secret » alors qu'une vraie
   * clef d'API se trouvait dans un fichier de test tout juste cree. Motif : il
   * scannait `git ls-files`, donc les fichiers DEJA SUIVIS. Un secret ecrit
   * dans un fichier neuf — exactement le cas d'un travail en cours — restait
   * invisible.
   *
   * Le hook de pre-commit, lui, l'a bien refusee : il analyse l'INDEX. Mais un
   * controle qui affirme « aucun secret » alors qu'il n'a pas regarde vaut
   * moins que pas de controle du tout, parce qu'il rassure.
   *
   * `fichiersAControler` doit donc rendre les fichiers suivis ET les nouveaux
   * fichiers non ignores.
   */
  it("rend les fichiers suivis ET les nouveaux fichiers non ignores", () => {
    const suivis = fichiersSuivis();
    const tous = fichiersAControler();
    for (const f of suivis) expect(tous, f).toContain(f);
    expect(tous.length).toBeGreaterThanOrEqual(suivis.length);
  });

  it("n'inclut PAS ce que .gitignore exclut", () => {
    // `.env` et `audit/raw/` ne sont pas destines a etre versionnes : les
    // signaler produirait une alerte permanente, et une alerte permanente
    // finit ignoree.
    const tous = fichiersAControler();
    expect(tous).not.toContain(".env");
    expect(tous.some((f) => f.startsWith("audit/raw/"))).toBe(false);
  });

  it("ne rend aucun doublon", () => {
    const tous = fichiersAControler();
    expect(new Set(tous).size).toBe(tous.length);
  });
});

/**
 * §9.4 — "Toute connexion a une source externe [...] doit logger : URL exacte
 * interrogee, date d'observation, reponse brute archivee (pour audit et
 * correction ulterieure)."
 *
 * Deux artefacts distincts, pour deux usages :
 *
 *  - `audit/journal.jsonl` : une ligne par appel. Compact, VERSIONNE dans le
 *    repo. C'est la trace de preuve : elle survit au projet.
 *  - `audit/raw/<sha256>.json` : la reponse brute integrale. Volumineuse,
 *    parfois soumise aux CGU du fournisseur, et NON CAVIARDEE — elle peut donc
 *    contenir des secrets. Hors versionnement (voir .gitignore). Le journal
 *    pointe vers elle par empreinte.
 *
 * Parce que `journal.jsonl` est versionne — et potentiellement pousse sur un
 * depot public — les URLs et messages d'erreur qui y entrent sont caviardes de
 * leurs secrets (voir `redaction.ts`). Plusieurs sources du §4 transportent
 * leur clef d'API dans l'URL : sans ce filtre, les journaliser reviendrait a
 * les publier.
 *
 * L'adressage par contenu (sha256) donne la deduplication gratuitement et rend
 * une archive infalsifiable : modifier le fichier change son nom.
 *
 * Les appels LLM sont journalises au meme titre que les sources. Le protocole
 * ne l'exige pas explicitement, mais une correction ulterieure (§6) sur un
 * texte produit par un modele est intracable sans la requete d'origine.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactText, redactUrl } from "./redaction.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AUDIT_DIR = join(HERE, "..", "..", "audit");

export type AuditKind = "source" | "llm";

export interface AuditRecord {
  /** Horodatage de l'appel lui-meme. */
  logged_at: string;
  kind: AuditKind;
  /** Agent a l'origine de l'appel (EP-002 : une methode a un auteur). */
  agent: string;
  /** URL exacte interrogee, ou identifiant du modele pour un appel LLM. */
  target: string;
  /** §5.1 — date d'observation de la donnee, distincte de l'heure d'appel. */
  date_observed: string;
  /** Empreinte de la reponse brute ; nom du fichier dans audit/raw/. */
  raw_sha256: string;
  /**
   * Chemin RELATIF a la racine du journal (ex : "raw/<sha>.json").
   * Un chemin absolu rendrait le journal versionne inutilisable sur une autre
   * machine, alors que sa raison d'etre est justement d'etre relu par un tiers.
   */
  raw_path: string;
  /** Renseigne si l'appel a echoue. La trace d'un echec compte aussi. */
  error?: string;
  /**
   * Empreinte de l'entree PRECEDENTE. `GENESIS_SHA256` pour la premiere.
   *
   * C'est ce qui transforme un fichier append-only par usage en fichier
   * append-only VERIFIABLE : le journal est un texte, et quiconque peut ecrire
   * dans le depot peut y reecrire une ligne. Une trace qu'on peut editer sans
   * laisser de marque ne prouve rien — elle donne l'apparence d'une preuve, ce
   * qui est pire que pas de trace.
   */
  prev_sha256?: string;
  /** Empreinte de cette entree, chainage inclus. Voir `verifyJournal`. */
  entry_sha256?: string;
  /**
   * Parametres caviardes dans `target` et `error` (voir `redaction.ts`).
   * Present uniquement si un caviardage a eu lieu : une URL alteree en silence
   * ne serait plus une preuve, donc l'alteration se declare.
   */
  redacted_params?: readonly string[];
}

export interface AuditLogOptions {
  /** Racine du journal. Surchargeable pour les tests. */
  dir?: string;
  /**
   * Si faux, rien n'est ecrit sur disque (tests unitaires).
   * Le mode `mock` du pipeline ecrit quand meme : une execution simulee
   * doit produire un journal inspectable, sinon on ne teste pas le §9.4.
   */
  persist?: boolean;
}

export class AuditLog {
  private readonly dir: string;
  private readonly rawDir: string;
  private readonly journalPath: string;
  private readonly persist: boolean;
  private readonly records: AuditRecord[] = [];

  /**
   * Les ecritures sont serialisees par cette chaine de promesses. Deux agents
   * qui journalisent en parallele produiraient sinon des lignes JSONL
   * entrelacees, donc un journal illisible.
   */
  private writeQueue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  /**
   * Dernier maillon de la chaine. Repris du journal existant par `initChain`,
   * de sorte que la chaine soit continue d'une session a l'autre et non
   * seulement verifiable par segment.
   */
  private lastEntryHash: string = GENESIS_SHA256;
  private chainReady: Promise<void> | undefined;

  constructor(options: AuditLogOptions = {}) {
    this.dir = options.dir ?? DEFAULT_AUDIT_DIR;
    this.rawDir = join(this.dir, "raw");
    this.journalPath = join(this.dir, "journal.jsonl");
    this.persist = options.persist ?? true;
  }

  private async ensureDirs(): Promise<void> {
    this.ready ??= mkdir(this.rawDir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  /**
   * Reprend la chaine la ou le journal existant l'a laissee.
   *
   * SANS CELA, chaque session repartirait de la genese et la chaine serait
   * verifiable par SEGMENT seulement. Un attaquant pourrait alors tronquer un
   * segment et en recoller un forge partant de la genese : la verification n'y
   * verrait qu'une reprise legitime. Lire le dernier maillon supprime cette
   * couture.
   *
   * Tolerant par necessite : journal absent, tronque, ou derniere ligne
   * anterieure au chainage. Dans tous ces cas on repart de la genese — refuser
   * de demarrer parce qu'un journal est illisible transformerait un probleme
   * d'audit en panne de production.
   */
  private async initChain(): Promise<void> {
    this.chainReady ??= (async () => {
      if (!this.persist) return;
      try {
        const contenu = await readFile(this.journalPath, "utf8");
        const lignes = contenu.split("\n").filter((l) => l.trim().length > 0);
        const derniere = lignes.at(-1);
        if (derniere === undefined) return;
        const entree = JSON.parse(derniere) as Record<string, unknown>;
        const propre = entree["entry_sha256"];
        if (typeof propre === "string") this.lastEntryHash = propre;
      } catch {
        // Journal absent ou illisible : la chaine repart de la genese, et
        // `verifyJournal` le signalera comme tel.
      }
    })();
    return this.chainReady;
  }

  /**
   * Enregistre un appel externe et archive sa reponse brute.
   * Retourne l'enregistrement, dont `raw_path` permet de rejouer l'audit.
   */
  async record(input: {
    kind: AuditKind;
    agent: string;
    target: string;
    dateObserved: string;
    raw: unknown;
    error?: string;
  }): Promise<AuditRecord> {
    // La reprise de chaine precede la construction de l'entree : le maillon
    // precedent doit etre connu avant de sceller quoi que ce soit.
    await this.initChain();

    // Serialisation stable : une meme reponse doit toujours donner la meme
    // empreinte, sinon la deduplication et la verification d'integrite sautent.
    const serialized = JSON.stringify(input.raw, stableReplacer, 2);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    // Toujours en separateurs POSIX : le journal doit se lire a l'identique
    // quelle que soit la plateforme qui l'a produit.
    const relativePath = `raw/${sha256}.json`;
    const absolutePath = join(this.rawDir, `${sha256}.json`);

    // Caviardage AVANT ecriture. Impose ici, au point de passage unique du
    // journal : un adaptateur ne peut pas l'oublier, exactement comme il ne
    // peut pas oublier de journaliser.
    //
    // `target` et `error` sont tous deux traites : un message d'erreur du type
    // "HTTP 503 sur https://api...?api_key=SECRET" ferait autrement transiter
    // la clef par le champ `error`.
    const targetRedaction = redactUrl(input.target);
    const errorRedaction =
      input.error === undefined ? undefined : redactText(input.error);

    const redactedParams = [
      ...new Set([
        ...targetRedaction.redactedParams,
        ...(errorRedaction?.redactedParams ?? []),
      ]),
    ];

    const contenu = {
      logged_at: new Date().toISOString(),
      kind: input.kind,
      agent: input.agent,
      target: targetRedaction.redacted,
      date_observed: input.dateObserved,
      raw_sha256: sha256,
      raw_path: relativePath,
      ...(errorRedaction === undefined
        ? {}
        : { error: errorRedaction.redacted }),
      ...(redactedParams.length === 0 ? {} : { redacted_params: redactedParams }),
    };

    // §9.4 — chainage. L'entree scelle la precedente : modifier, supprimer,
    // inserer ou reordonner une ligne casse la chaine pour toutes les
    // suivantes, et `verifyJournal` dit ou.
    const prev = this.lastEntryHash;
    const propre = entryHash(contenu, prev);
    const record: AuditRecord = {
      ...contenu,
      prev_sha256: prev,
      entry_sha256: propre,
    };
    this.lastEntryHash = propre;

    this.records.push(record);

    if (this.persist) {
      this.writeQueue = this.writeQueue.then(async () => {
        await this.ensureDirs();
        await writeFile(absolutePath, serialized, "utf8");
        await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, "utf8");
      });
      await this.writeQueue;
    }

    return record;
  }

  /** Enregistrements de la session en cours (le journal sur disque est cumulatif). */
  entries(): readonly AuditRecord[] {
    return this.records;
  }

  /** Relit une reponse archivee. C'est ce qui rend une correction (§6) verifiable. */
  async readRaw(record: AuditRecord): Promise<unknown> {
    // `raw_path` est relatif au journal : on le resout ici, pas a l'ecriture.
    return JSON.parse(await readFile(join(this.dir, record.raw_path), "utf8"));
  }
}

/* -------------------------------------------------------------------------
 * §9.4 — chainage et verification
 * ---------------------------------------------------------------------- */

/** Maillon zero. Rend la premiere entree verifiable comme les autres. */
export const GENESIS_SHA256 = "0".repeat(64);

/** Champs de chainage, exclus du contenu qu'ils scellent. */
const CHAMPS_DE_CHAINE = ["prev_sha256", "entry_sha256"] as const;

/**
 * Empreinte d'une entree : son contenu, plus le maillon precedent.
 *
 * Inclure `prev` dans le hache est tout le mecanisme : sans lui, chaque entree
 * serait verifiable isolement et on pourrait en supprimer une sans que rien ne
 * s'en apercoive.
 */
function entryHash(contenu: unknown, prev: string): string {
  return createHash("sha256")
    .update(`${prev}\n${JSON.stringify(contenu, stableReplacer)}`)
    .digest("hex");
}

export interface JournalVerification {
  ok: boolean;
  /** Entrees chainees effectivement verifiees. */
  checked: number;
  /** Entrees anterieures au chainage : signalees, pas suspectes. */
  legacy: number;
  /** Index (0-base) de la premiere anomalie. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verifie la chaine d'un journal.
 *
 * CE QUE CELA DETECTE : la modification, la suppression, l'insertion et le
 * reordonnancement d'une entree. Chacune casse la chaine a partir du point
 * touche, et l'index est rendu.
 *
 * CE QUE CELA NE DETECTE PAS, et il faut le dire : une reecriture COMPLETE par
 * quelqu'un qui recalculerait toute la chaine, ni la troncature du journal a sa
 * fin. Seule une signature, ou une ancre publiee ailleurs (un commit signe, un
 * horodatage tiers), le ferait. Le chainage rend l'alteration PONCTUELLE
 * detectable — ce que la plupart des falsifications sont : rapides et locales.
 *
 * Les entrees sans champs de chaine sont comptees a part. Le journal existant a
 * ete ecrit avant cette protection : le declarer corrompu serait faux, et un
 * outil qui crie au loup sur des donnees legitimes finit desactive. En
 * revanche, une entree non chainee APRES le debut du chainage est une anomalie
 * — c'est ce que ferait quelqu'un qui retire les champs pour echapper au
 * controle.
 */
export function verifyJournal(lines: readonly string[]): JournalVerification {
  let precedent: string | undefined;
  let checked = 0;
  let legacy = 0;

  for (const [index, ligne] of lines.entries()) {
    let entree: Record<string, unknown>;
    try {
      entree = JSON.parse(ligne) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        checked,
        legacy,
        brokenAt: index,
        reason: "ligne illisible : le journal n'est plus du JSONL valide",
      };
    }

    const prev = entree["prev_sha256"];
    const propre = entree["entry_sha256"];

    if (typeof prev !== "string" || typeof propre !== "string") {
      if (precedent !== undefined) {
        return {
          ok: false,
          checked,
          legacy,
          brokenAt: index,
          reason:
            "entree sans champs de chaine apres le debut du chainage : " +
            "champs retires pour echapper au controle",
        };
      }
      legacy += 1;
      continue;
    }

    const attendu = precedent ?? GENESIS_SHA256;
    if (prev !== attendu) {
      return {
        ok: false,
        checked,
        legacy,
        brokenAt: index,
        reason:
          `chaine rompue : l'entree annonce ${prev.slice(0, 12)}… comme ` +
          `precedent, la chaine attend ${attendu.slice(0, 12)}…`,
      };
    }

    const contenu = { ...entree };
    for (const champ of CHAMPS_DE_CHAINE) delete contenu[champ];
    if (entryHash(contenu, prev) !== propre) {
      return {
        ok: false,
        checked,
        legacy,
        brokenAt: index,
        reason: "contenu modifie : l'empreinte ne correspond pas a l'entree",
      };
    }

    precedent = propre;
    checked += 1;
  }

  return { ok: true, checked, legacy };
}

/** Tri des clefs d'objet : rend `JSON.stringify` deterministe. */
function stableReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

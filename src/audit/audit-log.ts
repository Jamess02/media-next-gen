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

    const record: AuditRecord = {
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

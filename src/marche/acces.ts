/**
 * Acces reseau des connecteurs de marche : liste blanche, debit, disjoncteur,
 * cache et reprises.
 *
 * Dependances internes : `sources/http.ts` (safeFetch, readBodyCapped,
 * SourceFetchError) et `audit/redaction.ts` (isSecretParam). Modules Node :
 * `node:crypto`, `node:fs/promises`, `node:path`. AUCUNE dependance npm.
 *
 * `safeFetch` reste le seul point de sortie reseau : HTTPS exige, redirections
 * validees saut par saut, delai borne. Ce module ajoute ce que les donnees de
 * marche exigent en plus, et qu'un connecteur ne doit pas pouvoir oublier.
 *
 *  1. LISTE BLANCHE. Seuls les chemins declares partent. Les marques d'une
 *     requete signee (`signature`, `timestamp`) sont refusees avant l'appel,
 *     et une clef de compte Binance ne peut meme pas etre configuree : ce
 *     projet est un media, il ne passe jamais d'ordre.
 *
 *  2. DEBIT. Un espacement minimal entre requetes ; pour Binance, le poids
 *     consomme (`x-mbx-used-weight-1m`) est lu a chaque reponse et l'on
 *     s'arrete jusqu'a la minute suivante AVANT le plafond.
 *
 *  3. DISJONCTEUR. Sur 429, on n'insiste pas : des 429 repetes menent au
 *     bannissement. Sur 418 — le bannissement lui-meme, de quelques minutes a
 *     trois jours — l'etat est ecrit SUR DISQUE : un redemarrage ne doit pas
 *     relancer les requetes qu'il sanctionne.
 *
 *  4. REPRISES. Seules les pannes passageres (5xx, 408, reseau, delai) sont
 *     reessayees, avec un delai qui double. Sans ordre passe, reessayer une
 *     lecture n'a aucun effet de bord.
 *
 *  5. CACHE. Une reponse relue du cache garde l'horodatage de sa requete
 *     d'ORIGINE : sinon l'article pretendrait une observation plus fraiche
 *     qu'elle ne l'est. Et seule une reponse VALIDEE est mise en cache : un
 *     schema casse ne doit pas etre servi de nouveau pendant tout le TTL.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isSecretParam } from "../audit/redaction.js";
import { CacheDeReponses } from "../sources/cache.js";
import { SourceFetchError, readBodyCapped, safeFetch } from "../sources/http.js";

export interface PolitiqueDAcces {
  /** Identifiant court : nomme les fichiers d'etat et de cache. */
  id: string;
  /** Nom lisible, repris dans chaque message d'erreur. */
  nom: string;
  /** Racine unique, en https. */
  base: string;
  /** Chemins EXACTS autorises. Tout autre est refuse avant l'appel. */
  chemins: readonly string[];
  /** Espacement minimal entre deux requetes. */
  intervalleMinMs: number;
  /** Delai maximal d'une requete. */
  delaiMs: number;
  /** Nombre total d'essais pour une panne passagere. */
  essaisMax: number;
  /** Pause sur un 429 sans Retry-After. */
  pause429Ms: number;
  /** Pause sur un 418 (bannissement) sans Retry-After. */
  pause418Ms: number;
  /** Pause sur un 403 (pare-feu du fournisseur). */
  pause403Ms: number;
  /** Suivi du poids consomme, a la maniere de Binance. */
  poids?: { entete: string; plafond: number; seuil: number };
  /** En-tetes a joindre — la clef CoinGecko, jamais dans l'URL. */
  enTetes?: Readonly<Record<string, string>>;
  /** Code d'erreur du fournisseur a traiter comme passager (Binance -1007). */
  codeTransitoire?: (corps: unknown) => boolean;
}

/** L'heure, l'attente et le hasard, injectables : les tests n'attendent jamais. */
export interface Horloge {
  maintenant(): number;
  attendre(ms: number): Promise<void>;
  aleatoire(): number;
}

export const HORLOGE_REELLE: Horloge = {
  maintenant: () => Date.now(),
  attendre: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  aleatoire: () => Math.random(),
};

export interface OptionsDObtention {
  /** Duree de validite en cache de CETTE reponse. */
  ttlMs: number;
  /** Controle de forme. Leve si la reponse a change ; rien n'est alors mis en cache. */
  valider(corps: unknown): void;
}

export interface ReponseDAcces {
  corps: unknown;
  url: string;
  /** Date de la requete qui a obtenu la reponse — d'origine, meme depuis le cache. */
  horodatageRequete: string;
  depuisLeCache: boolean;
}

/** Marques d'une requete signee Binance : compte, ordres, retraits. */
const PARAMETRES_DE_SIGNATURE = new Set(["signature", "timestamp", "recvwindow"]);

/** En-tete de clef de compte Binance. Sa seule presence est la faute. */
const ENTETES_INTERDITS = new Set(["x-mbx-apikey"]);

const AGENT = "media-next-gen (pipeline editorial)";
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const JITTER_MS = 250;
/** Marge apres le changement de minute : les horloges ne sont jamais alignees. */
const MARGE_FENETRE_MS = 1_000;

interface Ouverture {
  jusqua: number;
  motif: string;
}

const estTransitoireHttp = (statut: number): boolean => statut === 408 || statut >= 500;

/**
 * Erreur a lever quand une reponse n'a plus la forme attendue.
 *
 * Le libelle est commun a tous les connecteurs : c'est ce que le journal et
 * les incertitudes de l'article montreront, et il doit dire que l'echec est
 * VOULU — une valeur plausible tiree d'un schema inconnu serait pire.
 */
export function schemaModifie(detail: string): Error {
  return new Error(
    `schema de reponse modifie — ${detail}. Echec volontaire : une valeur tiree ` +
      `d'une forme inconnue ne serait pas verifiable`,
  );
}

/** Message d'erreur tel que le fournisseur le formule, quand il en donne un. */
function messageDuFournisseur(corps: unknown): string {
  if (typeof corps !== "object" || corps === null) return "";
  const c = corps as Record<string, unknown>;
  const statut = c["status"] as Record<string, unknown> | undefined;
  const chart = (c["chart"] as Record<string, unknown> | undefined)?.["error"] as
    | Record<string, unknown>
    | undefined;
  const brut =
    c["msg"] ?? statut?.["error_message"] ?? chart?.["description"] ?? c["error"];
  if (typeof brut !== "string" || brut.length === 0) return "";
  const code = c["code"] ?? statut?.["error_code"] ?? chart?.["code"];
  return ` — ${brut.slice(0, 160)}${code === undefined ? "" : ` (code ${String(code)})`}`;
}

/** Detail d'une `SourceFetchError`, sans le nom ni l'URL qu'elle ajoute deja. */
function detailDe(e: SourceFetchError): string {
  let m = e.message;
  const prefixe = `${e.sourceName} : `;
  if (m.startsWith(prefixe)) m = m.slice(prefixe.length);
  const suffixe = ` (${e.requestedUrl})`;
  if (m.endsWith(suffixe)) m = m.slice(0, -suffixe.length);
  return m;
}

export class AccesMarche {
  private dernierAppel = Number.NEGATIVE_INFINITY;
  private pauseJusqua = 0;
  private ouverture: Ouverture | null = null;
  private etatLu = false;
  private file: Promise<unknown> = Promise.resolve();
  /**
   * Cache PARTAGE avec les adaptateurs de sources (`sources/cache.ts`).
   *
   * La logique vivait ici, privee. Elle a ete extraite quand les sources
   * technologiques en ont eu besoin a leur tour : une seconde implementation
   * aurait diverge, et c'est celle qu'aucun test ne couvre qui laisse passer
   * la faute.
   */
  private readonly cache: CacheDeReponses;

  /**
   * @param dossier ou ecrire cache et etat du disjoncteur ; `null` = memoire seule
   */
  constructor(
    readonly politique: PolitiqueDAcces,
    private readonly dossier: string | null = null,
    private readonly horloge: Horloge = HORLOGE_REELLE,
  ) {
    this.cache = new CacheDeReponses({
      id: politique.id,
      dir: dossier,
      horloge: () => this.horloge.maintenant(),
    });

    if (!politique.base.startsWith("https://")) {
      throw new Error(`${politique.nom} : racine non https refusee (${politique.base}).`);
    }
    for (const nom of Object.keys(politique.enTetes ?? {})) {
      if (ENTETES_INTERDITS.has(nom.toLowerCase())) {
        throw new Error(
          `${politique.nom} : l'en-tete ${nom} porte une clef de compte. Ce projet ` +
            `n'en configure aucune — c'est un media, il ne passe jamais d'ordre.`,
        );
      }
    }
  }

  /** Construit l'URL, apres controle de la liste blanche. Ne touche pas le reseau. */
  url(chemin: string, params: Readonly<Record<string, string | number>>): string {
    const { nom, base, chemins } = this.politique;
    if (!chemins.includes(chemin)) {
      throw new SourceFetchError(
        nom,
        `${base}${chemin}`,
        `chemin non autorise : ${chemin} ne figure pas dans la liste blanche des endpoints publics`,
      );
    }
    for (const parametre of Object.keys(params)) {
      if (PARAMETRES_DE_SIGNATURE.has(parametre.toLowerCase())) {
        throw new SourceFetchError(
          nom,
          `${base}${chemin}`,
          `requete signee refusee (parametre « ${parametre} ») : seuls les endpoints ` +
            `publics, sans compte, sont appeles`,
        );
      }
      if (isSecretParam(parametre)) {
        throw new SourceFetchError(
          nom,
          `${base}${chemin}`,
          `clef refusee dans l'URL (parametre « ${parametre} ») : l'URL est citee dans ` +
            `l'article et journalisee ; une clef voyage en en-tete`,
        );
      }
    }
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    return qs.length > 0 ? `${base}${chemin}?${qs}` : `${base}${chemin}`;
  }

  /** Obtient une reponse JSON validee : depuis le cache si possible, sinon du reseau. */
  async obtenir(
    chemin: string,
    params: Readonly<Record<string, string | number>>,
    options: OptionsDObtention,
  ): Promise<ReponseDAcces> {
    const url = this.url(chemin, params);
    const enCache = await this.cache.lire(url);
    if (enCache !== null) {
      return {
        corps: enCache.corps,
        url,
        horodatageRequete: enCache.horodatageRequete,
        depuisLeCache: true,
      };
    }
    // En file : deux adaptateurs du meme fournisseur, lances en parallele par
    // la passerelle, doivent quand meme respecter l'espacement.
    return this.enFile(() => this.interroger(url, options));
  }

  private enFile<T>(tache: () => Promise<T>): Promise<T> {
    const suite = this.file.then(tache, tache);
    this.file = suite.catch(() => undefined);
    return suite;
  }

  private async interroger(url: string, options: OptionsDObtention): Promise<ReponseDAcces> {
    const { nom, essaisMax } = this.politique;

    for (let essai = 1; ; essai += 1) {
      await this.verifierOuverture(url);
      await this.attendreSonTour();
      const horodatageRequete = new Date(this.horloge.maintenant()).toISOString();

      let reponse: Response;
      try {
        reponse = await safeFetch(
          url,
          {
            headers: {
              accept: "application/json",
              "user-agent": AGENT,
              ...(this.politique.enTetes ?? {}),
            },
          },
          nom,
          this.politique.delaiMs,
        );
      } catch (e) {
        this.dernierAppel = this.horloge.maintenant();
        if (!(e instanceof SourceFetchError) || !e.transitoire) throw e;
        if (essai < essaisMax) {
          await this.horloge.attendre(this.delaiDeReprise(essai));
          continue;
        }
        throw new SourceFetchError(
          nom,
          url,
          `donnee indisponible — ${detailDe(e)} ; abandon apres ${essai} essais`,
          undefined,
          true,
        );
      }
      this.dernierAppel = this.horloge.maintenant();
      this.lirePoids(reponse);

      if (reponse.status === 429 || reponse.status === 418 || reponse.status === 403) {
        const motif =
          reponse.status === 418
            ? "adresse bannie par le fournisseur (HTTP 418)"
            : reponse.status === 429
              ? "limite de debit atteinte (HTTP 429)"
              : "acces bloque par le pare-feu du fournisseur (HTTP 403)";
        const pause =
          this.retryAfter(reponse) ??
          (reponse.status === 418
            ? this.politique.pause418Ms
            : reponse.status === 429
              ? this.politique.pause429Ms
              : this.politique.pause403Ms);
        const jusqua = await this.ouvrir(pause, motif);
        throw new SourceFetchError(
          nom,
          url,
          `donnee indisponible — ${motif} ; aucune requete avant ${jusqua}`,
          reponse.status,
        );
      }

      const texte = await readBodyCapped(reponse, nom, url);
      let corps: unknown;
      let estJson = true;
      try {
        corps = JSON.parse(texte);
      } catch {
        estJson = false;
      }

      if (!reponse.ok) {
        const transitoire =
          estTransitoireHttp(reponse.status) ||
          (estJson && this.politique.codeTransitoire?.(corps) === true);
        if (transitoire && essai < essaisMax) {
          await this.horloge.attendre(this.delaiDeReprise(essai));
          continue;
        }
        const detail = `HTTP ${reponse.status}${estJson ? messageDuFournisseur(corps) : ""}`;
        throw new SourceFetchError(
          nom,
          url,
          transitoire
            ? `donnee indisponible — ${detail} ; abandon apres ${essai} essais`
            : detail,
          reponse.status,
          transitoire,
        );
      }

      if (!estJson) {
        throw new SourceFetchError(
          nom,
          url,
          `reponse non JSON (${texte.slice(0, 80).replace(/\s+/g, " ")}...) : la forme a ` +
            `change, ou une page d'erreur a ete servie`,
          reponse.status,
        );
      }

      // Valider AVANT de mettre en cache : un schema casse servi pendant tout
      // le TTL masquerait la reparation du fournisseur.
      try {
        options.valider(corps);
      } catch (e) {
        if (e instanceof SourceFetchError) throw e;
        throw new SourceFetchError(
          nom,
          url,
          e instanceof Error ? e.message : String(e),
          reponse.status,
        );
      }
      if (options.ttlMs > 0) {
        await this.cache.ecrire({
          url,
          horodatageRequete,
          expireA: this.horloge.maintenant() + options.ttlMs,
          corps,
        });
      }
      return { corps, url, horodatageRequete, depuisLeCache: false };
    }
  }

  /* --- Debit ------------------------------------------------------------- */

  private async attendreSonTour(): Promise<void> {
    const t = this.horloge.maintenant();
    const pret = Math.max(this.dernierAppel + this.politique.intervalleMinMs, this.pauseJusqua);
    if (pret > t) await this.horloge.attendre(pret - t);
  }

  private lirePoids(reponse: Response): void {
    const poids = this.politique.poids;
    if (poids === undefined) return;
    const brut = reponse.headers?.get?.(poids.entete);
    if (brut === null || brut === undefined) return;
    const utilise = Number(brut);
    if (!Number.isFinite(utilise) || utilise < poids.seuil) return;
    // Fenetre fixe d'une minute : on reprend a la suivante.
    const t = this.horloge.maintenant();
    this.pauseJusqua = Math.max(
      this.pauseJusqua,
      (Math.floor(t / 60_000) + 1) * 60_000 + MARGE_FENETRE_MS,
    );
  }

  private delaiDeReprise(essai: number): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (essai - 1));
    return base + Math.floor(this.horloge.aleatoire() * JITTER_MS);
  }

  /** Retry-After : un nombre de secondes, ou une date HTTP. */
  private retryAfter(reponse: Response): number | null {
    const brut = reponse.headers?.get?.("retry-after");
    if (brut === null || brut === undefined || brut.trim().length === 0) return null;
    const secondes = Number(brut);
    if (Number.isFinite(secondes)) return Math.max(1_000, secondes * 1_000);
    const date = Date.parse(brut);
    if (Number.isNaN(date)) return null;
    return Math.max(1_000, date - this.horloge.maintenant());
  }

  /* --- Disjoncteur ------------------------------------------------------- */

  private cheminEtat(): string | null {
    return this.dossier === null ? null : join(this.dossier, `etat-${this.politique.id}.json`);
  }

  private async ouvrir(pauseMs: number, motif: string): Promise<string> {
    const jusqua = this.horloge.maintenant() + pauseMs;
    this.ouverture = { jusqua, motif };
    const chemin = this.cheminEtat();
    if (chemin !== null) {
      await this.ecrireAtomique(
        chemin,
        JSON.stringify({ ouvertJusqua: new Date(jusqua).toISOString(), motif }, null, 2),
      );
    }
    return new Date(jusqua).toISOString();
  }

  private async verifierOuverture(url: string): Promise<void> {
    if (!this.etatLu) {
      this.etatLu = true;
      const lu = await this.lireEtat();
      if (lu !== null && (this.ouverture === null || lu.jusqua > this.ouverture.jusqua)) {
        this.ouverture = lu;
      }
    }
    if (this.ouverture !== null && this.horloge.maintenant() < this.ouverture.jusqua) {
      throw new SourceFetchError(
        this.politique.nom,
        url,
        `donnee indisponible — ${this.ouverture.motif} ; disjoncteur ouvert, aucune ` +
          `requete avant ${new Date(this.ouverture.jusqua).toISOString()}`,
      );
    }
  }

  private async lireEtat(): Promise<Ouverture | null> {
    const chemin = this.cheminEtat();
    if (chemin === null) return null;
    try {
      const brut = JSON.parse(await readFile(chemin, "utf8")) as {
        ouvertJusqua?: unknown;
        motif?: unknown;
      };
      const jusqua = typeof brut.ouvertJusqua === "string" ? Date.parse(brut.ouvertJusqua) : NaN;
      if (Number.isNaN(jusqua) || typeof brut.motif !== "string") return null;
      return { jusqua, motif: brut.motif };
    } catch {
      return null;
    }
  }

  /* --- Cache ------------------------------------------------------------- */


  /** Ecriture atomique : un arret brutal ne laisse jamais un fichier a moitie ecrit. */
  private async ecrireAtomique(chemin: string, contenu: string): Promise<void> {
    await mkdir(join(chemin, ".."), { recursive: true });
    const provisoire = `${chemin}.${process.pid}.tmp`;
    await writeFile(provisoire, contenu, "utf8");
    await rename(provisoire, chemin);
  }
}

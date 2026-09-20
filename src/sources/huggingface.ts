/**
 * Adaptateur REEL — Hub Hugging Face, diffusion des modeles (sans clef).
 *
 * Dependances : `http.ts`, `cache.ts`, `debit.ts`, `types.ts` (type seul).
 * Aucune npm.
 *
 * CE QUE CETTE SOURCE APPORTE. La technologie s'annonce beaucoup et se mesure
 * peu. Le Hub est l'un des rares endroits ou la DIFFUSION d'un modele porte un
 * chiffre public et verifiable, la ou le reste du secteur ne publie que des
 * communiques.
 *
 * ET C'EST EXACTEMENT LA QU'EST LE PIEGE. Deux chiffres coexistent, mesures le
 * 2026-09-19 sur `sentence-transformers/all-MiniLM-L6-v2` :
 *
 *   downloads        =   254 149 235   (trente derniers jours)
 *   downloadsAllTime = 3 901 265 576   (depuis la publication)
 *
 * Un facteur QUINZE. La page du modele intitule le premier « Downloads last
 * month » ; la specification OpenAPI du Hub, elle, ne documente ni l'un ni
 * l'autre. Publier `downloads` comme un cumul serait une erreur d'un ordre de
 * grandeur — et rien, dans la reponse, n'avertirait.
 *
 * UN TELECHARGEMENT N'EST PAS UN UTILISATEUR. La documentation officielle
 * (huggingface.co/docs/hub/en/models-download-stats, relevee le 2026-09-19)
 * est explicite : « Every HTTP request to these files, including GET and HEAD,
 * will be counted as a download », sur un fichier de configuration. Les
 * chaines d'integration continue sont comptees ; la deduplication par
 * utilisateur n'est possible qu'avec l'outil payant reserve aux editeurs. Le
 * chiffre est donc exact en tant que compteur et trompeur en tant que mesure
 * d'adoption : EP-005 impose qu'il voyage avec sa definition.
 *
 * LE CLASSEMENT DE TENDANCE EST OPAQUE. `trendingScore` n'est decrit nulle
 * part. Il est utilise parce qu'il est le seul tri qui remonte des modeles
 * notables — `sort=createdAt`, mesure le meme jour, ne rend que des depots
 * personnels vieux de quelques minutes et a zero telechargement — mais il est
 * declare pour ce qu'il est.
 *
 * DEBIT. Limites officielles relevees le 2026-09-19 : 500 requetes par fenetre
 * fixe de cinq minutes pour un appelant anonyme, et un HTTP 429 en cas de
 * depassement. Avec le cache, cet adaptateur en consomme une par heure.
 *
 * TIER : jamais declare ici. La passerelle le derive du domaine (§4).
 */

import { CacheDeReponses } from "./cache.js";
import { Espaceur } from "./debit.js";
import { SourceFetchError, buildUrl, fetchJson } from "./http.js";
import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT = "https://huggingface.co/api/models";
const SOURCE_NAME = "Hugging Face";

/**
 * Champs demandes explicitement.
 *
 * `downloadsAllTime` N'EST PAS rendu par defaut : sans cette demande, la
 * reponse ne porte que la fenetre de trente jours, et l'adaptateur n'aurait
 * aucun moyen de savoir laquelle des deux grandeurs il tient.
 */
const CHAMPS = [
  "downloads",
  "downloadsAllTime",
  "likes",
  "createdAt",
  "trendingScore",
  "author",
  "pipeline_tag",
] as const;

/**
 * Limite officielle, citee pour etre lisible dans le journal d'audit. Un
 * « HTTP 429 » nu obligerait a rouvrir la documentation au pire moment.
 */
const LIMITE_DOCUMENTEE =
  "limite officielle relevee le 2026-09-19 : 500 requetes par fenetre de " +
  "5 minutes pour un appelant anonyme";

/** Definition du compteur, reprise de la documentation officielle. */
const DEFINITION_TELECHARGEMENT =
  "Un « telechargement » compte ici CHAQUE requete HTTP (GET ou HEAD) vers un " +
  "fichier de configuration du depot, chaines d'integration continue " +
  "comprises, sans deduplication par utilisateur : ce ne sont pas des " +
  "utilisateurs (definition publiee par la plateforme, EP-005).";

/** Ce que vaut le classement qui a servi a selectionner ces modeles. */
const RESERVE_TENDANCE =
  "Modele retenu par le classement de tendance de la plateforme — mesure " +
  "OPAQUE, dont la methode de calcul n'est nulle part publiee : ce classement " +
  "n'ordonne ni le volume ni la qualite.";

interface ModeleDuHub {
  id?: unknown;
  author?: unknown;
  downloads?: unknown;
  downloadsAllTime?: unknown;
  likes?: unknown;
  createdAt?: unknown;
  trendingScore?: unknown;
  pipeline_tag?: unknown;
}

/** Espace les milliers sans rien arrondir : le compteur est exact, il reste exact. */
function groupe(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const estFini = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface HuggingFaceAdapterOptions {
  /** Nombre de modeles remontes. */
  limit?: number;
  /** Duree de validite du cache. Absente : aucune mise en cache. */
  ttlMs?: number;
  /** Racine du cache. `null` : memoire seule — ce que font les tests. */
  cacheDir?: string | null | undefined;
  /** Espacement minimal entre deux requetes. */
  intervalleMs?: number;
}

export function huggingFaceAdapter(
  options: HuggingFaceAdapterOptions = {},
): SourceAdapter {
  const limit = options.limit ?? 5;
  const ttlMs = options.ttlMs ?? 0;

  // Crees UNE fois par adaptateur : recrees a chaque collecte, ils ne
  // serviraient jamais et n'espaceraient rien.
  const cache =
    ttlMs > 0
      ? new CacheDeReponses({ id: "huggingface-modeles", dir: options.cacheDir ?? null })
      : null;

  const espaceur =
    options.intervalleMs !== undefined && options.intervalleMs > 0
      ? new Espaceur({ intervalleMs: options.intervalleMs })
      : null;

  return {
    id: "huggingface:modeles",
    describes:
      "Diffusion mesuree des modeles publics sur le Hub Hugging Face : " +
      "telechargements sur trente jours et depuis la publication",

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      const requestedUrl = buildUrl(API_ROOT, {
        sort: "trendingScore",
        direction: -1,
        limit,
        "expand[]": CHAMPS,
      });

      // Le cache porte la reponse BRUTE. L'horodatage est celui de la requete
      // d'ORIGINE : sans lui, l'article daterait l'observation du moment ou il
      // la relit (§5.1).
      const enCache = cache === null ? null : await cache.lire(requestedUrl);
      let raw: unknown;
      let horodatage: string;

      if (enCache !== null) {
        raw = JSON.parse(enCache.corps as string);
        horodatage = enCache.horodatageRequete;
      } else {
        horodatage = new Date().toISOString();
        const appel = (): Promise<unknown> =>
          fetchJson(requestedUrl, { sourceName: SOURCE_NAME });

        try {
          raw = espaceur === null ? await appel() : await espaceur.passer(appel);
        } catch (erreur) {
          // Un depassement de debit doit se lire sans rouvrir la
          // documentation : le journal d'audit porte alors la limite elle-meme.
          if (erreur instanceof SourceFetchError && erreur.status === 429) {
            throw new SourceFetchError(
              SOURCE_NAME,
              requestedUrl,
              `HTTP 429 — debit refuse par la plateforme (${LIMITE_DOCUMENTEE})`,
              429,
            );
          }
          throw erreur;
        }
      }

      if (!Array.isArray(raw)) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          "reponse inattendue : une liste de modeles etait attendue",
        );
      }

      // MIS EN CACHE APRES CONTROLE : une reponse dont la forme a change,
      // servie pendant tout le delai, masquerait le retablissement de la
      // source.
      if (cache !== null && enCache === null) {
        await cache.ecrire({
          url: requestedUrl,
          horodatageRequete: horodatage,
          expireA: Date.now() + ttlMs,
          corps: JSON.stringify(raw),
        });
      }

      const observations: Observation[] = [];
      let ecartes = 0;

      for (const entree of raw as ModeleDuHub[]) {
        const id = entree?.id;
        const cree = entree?.createdAt;
        const cumul = entree?.downloadsAllTime;
        const mois = entree?.downloads;

        // Trois refus, et le troisieme est le coeur du sujet : sans le cumul,
        // servir la fenetre de trente jours comme un total serait une erreur
        // d'un facteur quinze. Mieux vaut une observation de moins.
        if (
          typeof id !== "string" ||
          id.length === 0 ||
          typeof cree !== "string" ||
          Number.isNaN(Date.parse(cree)) ||
          !estFini(cumul) ||
          !estFini(mois)
        ) {
          ecartes += 1;
          continue;
        }

        const likes = estFini(entree.likes) ? entree.likes : null;
        const tache = typeof entree.pipeline_tag === "string" ? entree.pipeline_tag : null;

        observations.push({
          source: SOURCE_NAME,
          // L'adresse CITEE est l'enregistrement qui porte reellement les deux
          // chiffres. La page du modele n'affiche que la fenetre de trente
          // jours : la citer laisserait le lecteur sans moyen de verifier le
          // cumul.
          url: buildUrl(`${API_ROOT}/${id}`, { "expand[]": ["downloads", "downloadsAllTime"] }),
          date_observed: horodatage,
          date_published: new Date(cree).toISOString(),
          type: "diffusion-modele",
          resume:
            `Modele « ${id} » publie sur le Hub Hugging Face le ` +
            `${new Date(cree).toISOString().slice(0, 10)}` +
            (tache === null ? "" : ` (tache declaree : ${tache})`) +
            `. Telechargements : ${groupe(mois)} sur les 30 derniers jours, ` +
            `${groupe(cumul)} depuis la publication` +
            (likes === null ? "" : `, ${groupe(likes)} mentions « j'aime »`) +
            `. ${DEFINITION_TELECHARGEMENT} ${RESERVE_TENDANCE}`,
        });
      }

      if (observations.length === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucun modele exploitable parmi ${(raw as unknown[]).length} rendu(s)` +
            (ecartes > 0
              ? ` (${ecartes} ecarte(s) faute d'identifiant, de date de creation ou de cumul)`
              : ""),
        );
      }

      return { requestedUrl, raw, observations };
    },
  };
}

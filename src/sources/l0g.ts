/**
 * Adaptateur REEL — l0g.fr (tier 2, sans clef).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement).
 *
 * COUT : nul, et structurellement nul. Aucune clef, aucun compte, aucune
 * inscription — il n'existe aucun mecanisme par lequel cette source pourrait
 * facturer quoi que ce soit. CC BY 4.0 est une licence, pas un abonnement.
 * Le pire cas est la fermeture de l'API : l'adaptateur echoue alors comme
 * n'importe quelle source muette, et la passerelle le signale (§EP-003).
 *
 * OBLIGATIONS DE LICENCE, ET ELLES SONT REELLES
 *
 * CC BY 4.0 impose l'attribution. Le manifeste `agents.json` l'inscrit meme
 * dans ses usages INTERDITS : « Supprimer l'attribution l0g.fr ». Elle est donc
 * placee dans le resume de chaque observation, c'est-a-dire dans le texte qui
 * remonte jusqu'a la claim et jusqu'a l'article publie. Une attribution logee
 * ailleurs se perdrait au premier retraitement.
 *
 * REGLES D'USAGE RESPECTEES
 *
 * Le manifeste demande explicitement d'« utiliser freshness.json pour eviter de
 * presenter un snapshot ancien comme temps reel ». L'adaptateur lit donc
 * `staleAfter` a la source plutot que de coder un seuil en dur, et annonce
 * l'anciennete dans chaque resume quand le snapshot depasse ce delai.
 *
 * Les autres interdits du manifeste — ne pas comparer des scores 0-100 comme
 * des probabilites, ne pas renormaliser un score incomplet, ne jamais
 * transformer une inference en fait — recoupent EP-006, EP-005 et le §3. Ils
 * sont deja appliques par `protocol/rules.ts` et `protocol/scoring.ts`, donc
 * par construction et non par promesse. C'est aussi pourquoi cet adaptateur
 * n'ingere PAS les scores de risque : les publier demanderait de porter leur
 * methodologie et leurs limites, ce que le format d'observation ne transporte
 * pas.
 */

import { SourceFetchError, buildUrl, fetchJson } from "./http.js";
import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";

const BASE = "https://l0g.fr/api/v1";
const SOURCE_NAME = "l0g.fr";
const ATTRIBUTION = "Source : l0g.fr, CC BY 4.0.";

interface L0gArticle {
  canonicalId?: string;
  language?: string;
  url?: string;
  title?: string;
  date?: string;
  description?: string;
  topics?: string[];
}

interface RecentSurface {
  generated?: string;
  articles?: L0gArticle[];
  license?: string;
  attribution?: string;
}

interface FreshnessSurface {
  generated?: string;
  /** Duree ISO-8601, ex. "P2D". */
  staleAfter?: string;
}

export interface L0gAdapterOptions {
  /** Nombre maximal d'analyses remontees. */
  limit?: number;
  /** Langue souhaitee. Le corpus est bilingue. */
  language?: string;
}

/** Convertit une duree ISO-8601 simple (P2D, PT12H) en millisecondes. */
function parseDuration(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso.trim());
  if (m === null) return undefined;
  const [, j, h, min] = m;
  const ms =
    Number(j ?? 0) * 86_400_000 + Number(h ?? 0) * 3_600_000 + Number(min ?? 0) * 60_000;
  return ms > 0 ? ms : undefined;
}

/** Termes significatifs du sujet, pour filtrer un corpus de 200 analyses. */
function topicTerms(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 3);
}

export function l0gAdapter(options: L0gAdapterOptions = {}): SourceAdapter {
  const limit = options.limit ?? 3;
  const language = options.language ?? "fr";

  return {
    id: "l0g:recent-analyses",
    describes: "Analyses recentes de l0g.fr (corpus agent, CC BY 4.0)",

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      const requestedUrl = buildUrl(`${BASE}/articles/recent.json`, {});

      // Le manifeste demande de consulter la fraicheur avant de presenter un
      // snapshot. Un echec ici ne doit pas empecher la collecte : on perd la
      // borne de peremption, pas le contenu.
      let freshness: FreshnessSurface = {};
      try {
        freshness = (await fetchJson(`${BASE}/freshness.json`, {
          sourceName: SOURCE_NAME,
        })) as FreshnessSurface;
      } catch {
        freshness = {};
      }

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });
      const surface = raw as RecentSurface;
      const articles = surface.articles;

      if (!Array.isArray(articles)) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          "reponse inattendue : aucun tableau d'analyses",
        );
      }

      // Anciennete du snapshot, mesuree contre le seuil publie par la source.
      const genere = surface.generated ?? freshness.generated;
      const seuil = parseDuration(freshness.staleAfter);
      const ageMs =
        genere === undefined ? undefined : Date.now() - Date.parse(genere);
      const perime =
        ageMs !== undefined && seuil !== undefined && ageMs > seuil;
      const mentionFraicheur = perime
        ? ` ATTENTION : instantane genere le ${genere}, au-dela du delai de peremption ` +
          `${freshness.staleAfter} annonce par la source — ne pas presenter comme temps reel.`
        : "";

      const depuis = Date.parse(query.since);
      const termes = topicTerms(query.topic);

      const retenus = articles
        .filter((a) => a.language === undefined || a.language === language)
        .filter((a) => typeof a.url === "string" && typeof a.title === "string")
        // §5.1 — la fenetre de fraicheur filtre reellement.
        .filter((a) => {
          if (a.date === undefined || Number.isNaN(depuis)) return true;
          const d = Date.parse(`${a.date}T00:00:00Z`);
          return Number.isNaN(d) || d >= depuis;
        })
        .map((a) => {
          const foin = `${a.title ?? ""} ${a.description ?? ""} ${(a.topics ?? []).join(" ")}`.toLowerCase();
          return { article: a, score: termes.filter((t) => foin.includes(t)).length };
        })
        // Pertinence au sujet d'abord, puis fraicheur. Le critere est explicite
        // pour rester contestable, comme celui du Veilleur.
        .sort(
          (x, y) =>
            y.score - x.score ||
            Date.parse(y.article.date ?? "") - Date.parse(x.article.date ?? ""),
        )
        .slice(0, limit);

      if (retenus.length === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucune analyse en "${language}" depuis ${query.since} sur ${articles.length} publiees`,
        );
      }

      const observations: Observation[] = retenus.map(({ article: a, score }) => ({
        source: SOURCE_NAME,
        url: a.url as string,
        date_observed: new Date().toISOString(),
        date_published:
          a.date === undefined ? null : toIso(a.date),
        type: "analyse-secondaire",
        resume:
          `${a.title}. ${a.description ?? ""}`.trim() +
          (score > 0
            ? ` (${score} terme(s) du sujet present(s))`
            : " (aucun terme du sujet : retenue par fraicheur)") +
          mentionFraicheur +
          // L'attribution voyage avec le texte, donc jusqu'a l'article publie.
          ` ${ATTRIBUTION}`,
      }));

      return {
        requestedUrl,
        raw: { recent: surface, freshness },
        observations,
      };
    },
  };
}

/** l0g rend "2026-09-02" (date seule). Le §7 exige de l'ISO-8601 complet. */
function toIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

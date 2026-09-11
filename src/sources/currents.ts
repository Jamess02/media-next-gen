/**
 * Adaptateur REEL — Currents API (agregateur de presse).
 *
 * Dependances : `types.ts` (type uniquement) et `http.ts` (`safeFetch`,
 * `readBodyCapped`, `SourceFetchError`). Aucune dependance npm.
 *
 * CE QUE CURRENTS EST, ET CE QU'IL N'EST PAS
 *
 * Currents ne PRODUIT aucune information : il agrege des articles publies
 * ailleurs et rend, pour chacun, l'URL de l'editeur d'origine. C'est cette
 * URL-la qui est citee. Citer currentsapi.services reviendrait a citer
 * l'intermediaire au lieu de la source — exactement ce que EP-001 refuse, et
 * la raison pour laquelle Dataroma est reste un outil de REPERAGE.
 *
 * TIER : jamais declare ici, comme pour tout adaptateur. La passerelle le
 * derive du domaine de l'EDITEUR. Un article du Monde et un billet d'un
 * domaine inconnu du registre traversent ce meme code et ressortent avec des
 * tiers differents — le second retombe en tier 3, ce qui declenche le bandeau
 * "a confirmer" si une claim structurante ne repose que sur lui.
 *
 * QUALITE DU GISEMENT : elle est TRES inegale. Le catalogue de categories
 * comporte litteralement `crap`, et une recherche sur "inflation" a rendu un
 * article de jeuxvideo.com. On ne filtre pas ici sur la credibilite : le
 * registre de tiers et le plancher de preuve (§2) sont faits pour cela, et un
 * filtre de plus, invisible et non teste, serait une regle de moins.
 *
 * CONTRAINTES MESUREES le 2026-09-10 sur l'API reelle. Les pages de
 * documentation sont rendues en JavaScript, donc vides pour un client HTTP :
 * ces valeurs viennent de la spec OpenAPI (/json/swagger.json) et de sondes.
 *
 *  - la clef s'envoie en en-tete `Authorization` ; le parametre `apiKey` en
 *    URL n'est que l'ancienne methode, et l'employer ferait ARCHIVER la clef
 *    dans le journal d'audit (§9.4) ;
 *  - `start_date` doit etre en RFC 3339 ;
 *  - l'intervalle est plafonne : -6 jours rend HTTP 200, -7 jours rend
 *    HTTP 400 {"date_range":"Max range is 7 days"}. La fenetre de fraicheur du
 *    pipeline etant de 30 jours, passer `since` tel quel ferait echouer CHAQUE
 *    collecte. D'ou le bornage ci-dessous ;
 *  - quota vu en en-tetes : x-ratelimit-limit 250, fenetre ~4050 s.
 */

import { SourceFetchError, readBodyCapped, safeFetch } from "./http.js";
import { requeteDeRecherche } from "./mots-cles.js";
import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";

const BASE = "https://api.currentsapi.services/v1";
const SOURCE = "Currents API";
const TIMEOUT_MS = 20_000;

/**
 * Bornage a 6 jours, et non 7 : la mesure montre que 7 est DEJA refuse. Une
 * borne posee exactement sur la limite mesuree casserait au premier decalage
 * d'horloge entre notre machine et le fournisseur.
 */
const MAX_JOURS_INTERVALLE = 6;

export interface CurrentsAdapterOptions {
  /** Clef d'API. Lue depuis .env par le catalogue, jamais ecrite en dur. */
  apiKey: string;
  id?: string;
  describes?: string;
  /** Langue des articles. `fr` par defaut : le media publie en francais. */
  language?: string;
  /** Nombre maximal d'articles demandes. */
  limit?: number;
  type?: string;
  /**
   * Mention accolee a chaque resume, comme pour les flux de presse.
   *
   * Elle voyage avec le texte jusqu'a la claim : l'Analyste doit voir qu'il
   * lit une reprise editorialisee AVANT de typer sa claim en `fait`.
   */
  caveat?: string;
}

/**
 * Convertit le format de Currents — "2026-09-09 22:35:27 +0000" — en ISO.
 *
 * `new Date()` accepte cette chaine sur certains moteurs et pas sur d'autres :
 * le comportement n'est pas specifie. On la normalise donc explicitement
 * plutot que de dependre du moteur, et on rend `null` si la forme change —
 * une date inventee vaut moins qu'une date absente, que le pipeline sait
 * signaler.
 */
function dateIso(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})$/.exec(
    brut.trim(),
  );
  const iso = m === null ? brut.trim() : `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** URL citable : http(s) uniquement, hote present. Sinon l'entree est ecartee. */
function urlExploitable(brut: unknown): string | null {
  if (typeof brut !== "string" || brut.trim().length === 0) return null;
  try {
    const u = new URL(brut.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname.length === 0) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Borne la fenetre demandee au plafond du fournisseur (voir en-tete). */
function debutBorne(since: string): string {
  const plancher = Date.now() - MAX_JOURS_INTERVALLE * 86_400_000;
  const demande = Date.parse(since);
  const retenu = Number.isNaN(demande) ? plancher : Math.max(demande, plancher);
  return new Date(retenu).toISOString();
}

export function currentsAdapter(options: CurrentsAdapterOptions): SourceAdapter {
  const limit = options.limit ?? 6;

  return {
    id: options.id ?? "currents:search",
    describes:
      options.describes ??
      "Presse agregee (Currents API). L'URL citee est celle de l'editeur " +
        "d'origine ; le tier en est derive.",

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      const url = new URL(`${BASE}/search`);
      // PAS le sujet entier : les deux API font un ET sur les mots, et une
      // phrase complete rend zero resultat. Voir mots-cles.ts.
      url.searchParams.set("keywords", requeteDeRecherche(query.topic));
      url.searchParams.set("language", options.language ?? "fr");
      url.searchParams.set("page_size", String(limit));
      url.searchParams.set("start_date", debutBorne(query.since));

      // La clef part en EN-TETE. `requestedUrl` est archive tel quel (§9.4) :
      // une clef en parametre de requete serait versionnee.
      const reponse = await safeFetch(
        url.toString(),
        {
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            accept: "application/json",
            "user-agent": "media-next-gen (pipeline editorial)",
          },
        },
        SOURCE,
        TIMEOUT_MS,
      );

      const corps = await readBodyCapped(reponse, SOURCE, url.toString());

      if (!reponse.ok) {
        let motif = `HTTP ${reponse.status}`;
        try {
          const e = JSON.parse(corps) as { msg?: string };
          if (typeof e.msg === "string") motif += ` — ${e.msg}`;
        } catch {
          /* corps non JSON : le statut seul suffit a qualifier l'echec */
        }
        throw new SourceFetchError(SOURCE, url.toString(), motif, reponse.status);
      }

      let charge: { status?: string; msg?: string; news?: unknown };
      try {
        charge = JSON.parse(corps) as typeof charge;
      } catch {
        throw new SourceFetchError(SOURCE, url.toString(), "reponse non JSON");
      }

      // Un HTTP 200 ne suffit pas : Currents rend `status: "error"` avec un 200
      // sur clef invalide. Sans ce controle, l'echec passerait pour 0 resultat.
      if (charge.status !== undefined && charge.status !== "ok") {
        throw new SourceFetchError(
          SOURCE,
          url.toString(),
          charge.msg ?? `statut "${String(charge.status)}"`,
        );
      }
      if (!Array.isArray(charge.news)) {
        throw new SourceFetchError(
          SOURCE,
          url.toString(),
          "champ `news` absent : la reponse a change de forme",
        );
      }

      const observe = new Date().toISOString();
      const observations: Observation[] = [];

      for (const brut of charge.news) {
        if (typeof brut !== "object" || brut === null) continue;
        const n = brut as Record<string, unknown>;

        const lien = urlExploitable(n["url"]);
        if (lien === null) continue;

        const titre = typeof n["title"] === "string" ? n["title"].trim() : "";
        const resume = typeof n["description"] === "string" ? n["description"].trim() : "";
        if (titre.length === 0 && resume.length === 0) continue;

        // `author` est parfois vide dans les reponses reelles : on retombe sur
        // le domaine de l'editeur, qui est ce que le lecteur verifiera.
        const auteur = typeof n["author"] === "string" ? n["author"].trim() : "";
        const editeur = auteur.length > 0 ? auteur : new URL(lien).hostname;

        observations.push({
          source: editeur,
          url: lien,
          date_observed: observe,
          date_published: dateIso(n["published"]),
          type: options.type ?? "actualite",
          resume: [titre, resume, options.caveat ?? ""]
            .filter((p) => p.length > 0)
            .join(". "),
        });
      }

      return { observations, raw: charge, requestedUrl: url.toString() };
    },
  };
}

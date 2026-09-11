/**
 * Adaptateur REEL — newsdata.io (agregateur de presse).
 *
 * Dependances : `types.ts` (type uniquement) et `http.ts` (`safeFetch`,
 * `readBodyCapped`, `SourceFetchError`). Aucune dependance npm.
 *
 * MEME PRINCIPE QUE CURRENTS : newsdata ne PRODUIT rien, il agrege. Chaque
 * article porte `link`, l'URL de l'editeur d'origine, et c'est elle qui est
 * citee. Citer newsdata.io reviendrait a citer l'intermediaire au lieu de la
 * source — ce que EP-001 refuse.
 *
 * TIER : jamais declare ici. La passerelle le derive du domaine de l'EDITEUR ;
 * un domaine inconnu du registre retombe en tier 3.
 *
 * POURQUOI DEUX AGREGATEURS PLUTOT QU'UN
 *
 * Currents et newsdata ne moissonnent pas les memes titres. Deux agregateurs
 * donnent au §5.2 de quoi comparer des reprises independantes d'un meme fait ;
 * un seul importerait son perimetre sans contrepoids. C'est le meme
 * raisonnement que les deux titres de presse du catalogue.
 *
 * CONTRAINTES MESUREES le 2026-09-10 sur l'API reelle. La page de
 * documentation est rendue en JavaScript, donc vide pour un client HTTP : tout
 * ce qui suit vient de la spec OpenAPI (/openapi.json) et de sondes.
 *
 *  - la clef s'envoie en en-tete `X-ACCESS-KEY` ; le parametre `apikey` en URL
 *    est l'autre methode offerte, et l'employer ferait ARCHIVER la clef dans
 *    le journal d'audit (§9.4) ;
 *  - `size` est plafonne a 10 sur le palier gratuit : `size=50` rend un
 *    HTTP 422 {"code":"UnsupportedFilter"} ;
 *  - quota vu en en-tetes : x-ratelimit-limit 60, retry-after 900 s ;
 *  - en cas d'erreur, `results` est un OBJET et non un tableau.
 *
 * CE QU'ON N'UTILISE PAS, ET POURQUOI
 *
 * Le parametre `prioritydomain=top` promet de restreindre aux sources les
 * mieux classees. MESURE : sur une requete francaise, `top` a rendu Sudouest
 * (source_priority 5459) la ou la requete sans filtre rendait Boursorama
 * (1375) — or un rang PLUS BAS signifie mieux classe. Ce filtre ne fait donc
 * pas ce que son nom annonce, au moins en francais. On ne s'y fie pas : la
 * credibilite se juge au tier du domaine, pas au classement du fournisseur.
 */

import { SourceFetchError, readBodyCapped, safeFetch } from "./http.js";
import { requeteDeRecherche } from "./mots-cles.js";
import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";

const BASE = "https://newsdata.io/api/1/latest";
const SOURCE = "newsdata.io";
const TIMEOUT_MS = 20_000;

/** Palier gratuit : au-dela, HTTP 422 `UnsupportedFilter`. Mesure. */
const MAX_TAILLE_GRATUITE = 10;

export interface NewsdataAdapterOptions {
  /** Clef d'API. Lue depuis .env par le catalogue, jamais ecrite en dur. */
  apiKey: string;
  id?: string;
  describes?: string;
  /** Code ISO 639-1. `fr` par defaut : le media publie en francais. */
  language?: string;
  /** Nombre d'articles demandes. Borne a 10 par le palier gratuit. */
  limit?: number;
  type?: string;
  /** Mention accolee a chaque resume (voir l'adaptateur RSS). */
  caveat?: string;
}

/**
 * Combine `pubDate` et `pubDateTZ` en date ISO.
 *
 * `pubDate` ne porte AUCUN decalage : "2026-09-09 10:58:10". Le fuseau est
 * dans un champ separe, `pubDateTZ`, qui vaut "UTC" tant qu'on ne demande pas
 * autre chose. Concatener sans lui ferait interpreter l'heure dans le fuseau
 * LOCAL de la machine : la date serait fausse de plusieurs heures, et
 * silencieusement — une observation datee a tort est pire qu'une non datee,
 * que le pipeline sait signaler.
 *
 * Un fuseau autre qu'UTC est traite comme inconnu plutot que devine : ce
 * module n'embarque pas de table de fuseaux, et une conversion approximative
 * produirait exactement l'erreur qu'on cherche a eviter.
 */
function dateIso(pubDate: unknown, pubDateTZ: unknown): string | null {
  if (typeof pubDate !== "string" || pubDate.trim().length === 0) return null;
  const fuseau = typeof pubDateTZ === "string" ? pubDateTZ.trim().toUpperCase() : "UTC";
  if (fuseau !== "UTC") return null;

  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(pubDate.trim());
  if (m === null) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
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

/** Motif d'erreur, quelle que soit la forme rendue par le fournisseur. */
function motifErreur(charge: unknown): string | null {
  if (typeof charge !== "object" || charge === null) return null;
  const c = charge as { results?: unknown; message?: unknown };
  if (typeof c.message === "string") return c.message;
  if (typeof c.results === "object" && c.results !== null) {
    const r = c.results as { message?: unknown; code?: unknown };
    if (typeof r.message === "string") return r.message;
    if (typeof r.code === "string") return r.code;
  }
  return null;
}

export function newsdataAdapter(options: NewsdataAdapterOptions): SourceAdapter {
  const taille = Math.min(options.limit ?? 6, MAX_TAILLE_GRATUITE);

  return {
    id: options.id ?? "newsdata:latest",
    describes:
      options.describes ??
      "Presse agregee (newsdata.io). L'URL citee est celle de l'editeur " +
        "d'origine ; le tier en est derive.",

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      const url = new URL(BASE);
      // PAS le sujet entier : les deux API font un ET sur les mots, et une
      // phrase complete rend zero resultat. Voir mots-cles.ts.
      url.searchParams.set("q", requeteDeRecherche(query.topic));
      url.searchParams.set("language", options.language ?? "fr");
      url.searchParams.set("size", String(taille));
      // Ecarte les reprises identiques cote fournisseur : cinq sites relayant
      // le meme fait occuperaient sinon cinq places dans la selection.
      url.searchParams.set("removeduplicate", "1");
      // PERTINENCE, pas date. Le defaut `pubdatedesc` rend les articles les
      // plus RECENTS parmi ceux qui correspondent — d'ou, sur « inflation
      // zone », « On vous explique le syndrome de Kessler ». Avec `relevancy`,
      // la meme requete au meme instant rend « La BCE devrait relever son taux
      // de depot de 25 points ». Le tri comptait autant que la requete.
      url.searchParams.set("sort", "relevancy");

      // La clef part en EN-TETE. `requestedUrl` est archive tel quel (§9.4) :
      // une clef en parametre de requete serait versionnee.
      const reponse = await safeFetch(
        url.toString(),
        {
          headers: {
            "X-ACCESS-KEY": options.apiKey,
            accept: "application/json",
            "user-agent": "media-next-gen (pipeline editorial)",
          },
        },
        SOURCE,
        TIMEOUT_MS,
      );

      const corps = await readBodyCapped(reponse, SOURCE, url.toString());

      let charge: { status?: string; results?: unknown };
      try {
        charge = JSON.parse(corps) as typeof charge;
      } catch {
        if (!reponse.ok) {
          throw new SourceFetchError(
            SOURCE,
            url.toString(),
            `HTTP ${reponse.status}`,
            reponse.status,
          );
        }
        throw new SourceFetchError(SOURCE, url.toString(), "reponse non JSON");
      }

      if (!reponse.ok) {
        const motif = motifErreur(charge);
        throw new SourceFetchError(
          SOURCE,
          url.toString(),
          `HTTP ${reponse.status}${motif === null ? "" : ` — ${motif}`}`,
          reponse.status,
        );
      }

      // Le STATUT d'abord : sur erreur, `results` est un objet et non un
      // tableau. Verifier la forme avant le statut rendrait un message sur la
      // structure de la reponse au lieu du motif reel.
      if (charge.status !== undefined && charge.status !== "success") {
        throw new SourceFetchError(
          SOURCE,
          url.toString(),
          motifErreur(charge) ?? `statut "${String(charge.status)}"`,
        );
      }
      if (!Array.isArray(charge.results)) {
        throw new SourceFetchError(
          SOURCE,
          url.toString(),
          "champ `results` absent : la reponse a change de forme",
        );
      }

      const observe = new Date().toISOString();
      const depuis = Date.parse(query.since);
      const observations: Observation[] = [];

      for (const brut of charge.results) {
        if (typeof brut !== "object" || brut === null) continue;
        const a = brut as Record<string, unknown>;

        if (a["duplicate"] === true) continue;

        const lien = urlExploitable(a["link"]);
        if (lien === null) continue;

        const titre = typeof a["title"] === "string" ? a["title"].trim() : "";
        const resume = typeof a["description"] === "string" ? a["description"].trim() : "";
        if (titre.length === 0 && resume.length === 0) continue;

        // §5.1 — la fenetre de fraicheur filtre reellement. Une entree NON
        // datee est conservee : l'absence de date n'est pas une preuve
        // d'anciennete, et elle sera signalee au lecteur.
        const publie = dateIso(a["pubDate"], a["pubDateTZ"]);
        if (publie !== null && !Number.isNaN(depuis) && Date.parse(publie) < depuis) {
          continue;
        }

        const nom = typeof a["source_name"] === "string" ? a["source_name"].trim() : "";
        const editeur = nom.length > 0 ? nom : new URL(lien).hostname;

        observations.push({
          source: editeur,
          url: lien,
          date_observed: observe,
          date_published: publie,
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

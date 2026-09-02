/**
 * Surface machine du site : manifeste d'agent, contrat §7 exposé, empreintes.
 *
 * Dependances : les constantes du protocole et les types locaux. Aucune npm.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le §0 promet qu'un article puisse etre « relu, contesté et corrigé — par un
 * humain ou par un AUTRE AGENT ». Un site en HTML ne tient que la premiere
 * moitie de cette promesse : un agent tiers ne peut ni lire nos claims, ni
 * verifier nos niveaux de preuve, ni constater qu'un contenu n'a pas bouge.
 *
 * Methode empruntee a l'agent surface de l0g.fr — que ce projet ne prend PAS
 * comme source, mais dont l'approche est la bonne : publier ce qu'on affirme
 * dans une forme qu'une machine peut contester.
 *
 * TROIS SURFACES
 *
 *  - `/agents.json`      ce que le site expose, sous quelle licence, et ce
 *                        qu'on ne doit PAS en faire ;
 *  - `/api/articles.json` le contrat §7 lui-meme, integral ;
 *  - `/integrity.json`   les empreintes canoniques, pour verifier qu'un
 *                        contenu servi correspond a celui qui a ete relu.
 */

import { createHash } from "node:crypto";

import {
  CLAIM_TYPES,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_LABELS,
  MAX_STRUCTURAL_CLAIMS,
  MIN_PUBLISHABLE_EVIDENCE_LEVEL,
  PROTOCOL_VERSION,
  SOURCE_TIER_LABELS,
  SOURCE_TIERS,
} from "../protocol/constants.js";
import type { ReviewRecord } from "../editorial/validation.js";
import type { Article } from "../protocol/schema.js";
import { SITE_NAME, SITE_TAGLINE, siteUrl } from "./templates.js";

/**
 * Forme canonique d'une valeur JSON : clefs triees RECURSIVEMENT.
 *
 * Meme regle que pour les attestations de relecture, et pour la meme raison :
 * une empreinte doit dependre du contenu, pas de l'ordre de serialisation.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const objet = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(objet)
        .sort()
        .map((k) => [k, canonicalValue(objet[k])]),
    );
  }
  return value;
}

export function sha256(contenu: string): string {
  return createHash("sha256").update(contenu, "utf8").digest("hex");
}

/**
 * Empreinte d'une surface JSON, champ `generated` exclu.
 *
 * Ce champ change a chaque generation : l'inclure ferait varier l'empreinte
 * sans qu'aucun contenu utile ait bouge, et la rendrait inutilisable pour
 * detecter un vrai changement.
 */
export function canonicalJsonHash(surface: Record<string, unknown>): string {
  const { generated: _ignore, ...reste } = surface;
  return sha256(JSON.stringify(canonicalValue(reste)));
}

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------
 * /agents.json
 * ---------------------------------------------------------------------- */

export function agentManifest(articles: readonly Article[]): Record<string, unknown> {
  const base = siteUrl();
  return {
    name: `${SITE_NAME} — surface agent`,
    url: base,
    generated: now(),
    description: SITE_TAGLINE,
    language: "fr",
    protocol: {
      name: "Protocole Editorial",
      version: PROTOCOL_VERSION,
      document: `${base}/protocole.html`,
      correctionPolicy: `${base}/changelog.html`,
    },
    endpoints: {
      articles: `${base}/api/articles.json`,
      integrity: `${base}/integrity.json`,
      feed: `${base}/feed.xml`,
      sitemap: `${base}/sitemap.xml`,
    },
    counts: {
      articles: articles.length,
      claims: articles.reduce((n, a) => n + a.claims.length, 0),
    },
    /**
     * §2 et §3 exposes : un agent tiers doit pouvoir interpreter nos niveaux
     * sans lire le protocole en prose.
     */
    proofPolicy: {
      claimKinds: CLAIM_TYPES,
      depthScale: EVIDENCE_LEVELS.map((n) => ({
        level: n,
        label: EVIDENCE_LEVEL_LABELS[n],
      })),
      publicationFloor: {
        level: MIN_PUBLISHABLE_EVIDENCE_LEVEL,
        rule: "Aucune claim structurante sous le niveau 2 n'est publiee (§2).",
      },
      structuralClaimCeiling: MAX_STRUCTURAL_CLAIMS,
      sourceTiers: SOURCE_TIERS.map((t) => ({
        tier: t,
        label: SOURCE_TIER_LABELS[t],
      })),
      humanReview: {
        required: true,
        rule:
          "Aucun article n'est publie sans relecture humaine nommee. " +
          "L'attestation porte l'empreinte du contenu relu : toute modification " +
          "ulterieure l'invalide et retire l'article du site.",
      },
    },
    /**
     * Ce qu'on ne doit PAS faire de ces donnees. Enoncer les interdits est
     * plus utile que de lister les permissions : c'est ce qui manque quand un
     * tiers reutilise un corpus de bonne foi.
     */
    prohibitedUse: [
      "Transformer une inference ou un scenario en fait observe (§3, §8).",
      "Presenter un niveau de preuve comme une probabilite ou un score de confiance.",
      "Comparer directement deux claims issues d'instruments differents sans exposer qu'elles ne mesurent pas la meme chose (EP-006).",
      "Republier une claim en supprimant son type, son niveau de preuve ou la date de ses sources (§8).",
      "Presenter ces analyses comme un conseil d'investissement, une recommandation politique ou electorale (EP-007).",
      "Presenter un article dont l'attestation de relecture ne correspond plus au contenu.",
    ],
    caveat:
      "Les articles sont produits par un pipeline multi-agents. Le typage des " +
      "claims et l'attribution des niveaux de preuve sont assistes par modele, " +
      "puis contraints par des regles deterministes et valides par une " +
      "relecture humaine nommee. Le controle d'absence de recommandation " +
      "implicite (EP-007) reste partiellement lexical : il n'a pas valeur de " +
      "certification de neutralite.",
  };
}

/* -------------------------------------------------------------------------
 * /api/articles.json — le contrat §7, expose
 * ---------------------------------------------------------------------- */

export function articlesSurface(
  articles: readonly Article[],
  reviews: ReadonlyMap<string, ReviewRecord>,
): Record<string, unknown> {
  const base = siteUrl();
  return {
    schema: "Protocole Editorial §7",
    protocolVersion: PROTOCOL_VERSION,
    generated: now(),
    license: "Voir la page protocole. Attribution requise.",
    count: articles.length,
    articles: articles.map((a) => {
      const review = reviews.get(a.id);
      return {
        // Le contrat §7 integral, sans reduction : c'est ce qui rend l'article
        // contestable. En transmettre un resume serait le rendre invérifiable.
        ...a,
        canonicalUrl: `${base}/articles/${encodeURIComponent(a.id)}.html`,
        review:
          review === undefined
            ? null
            : {
                reviewer: review.reviewer,
                reviewed_at: review.reviewed_at,
                content_sha256: review.content_sha256,
                note: review.note,
              },
      };
    }),
  };
}

/* -------------------------------------------------------------------------
 * /integrity.json
 * ---------------------------------------------------------------------- */

export interface SurfaceEntry {
  path: string;
  mediaType: string;
  sha256: string;
}

export function integritySurface(
  entrees: readonly SurfaceEntry[],
): Record<string, unknown> {
  const base = siteUrl();
  return {
    generated: now(),
    algorithm: "sha-256",
    canonicalization: {
      json: "Clefs triees recursivement, sans espaces, champ `generated` exclu.",
      autres: "Empreinte des octets servis, tels quels.",
      raison:
        "Le champ `generated` change a chaque generation : l'inclure ferait " +
        "varier l'empreinte sans qu'aucun contenu utile ait bouge.",
    },
    verification:
      "Une empreinte qui change alors que le contenu ne devrait pas avoir " +
      "bouge signale une republication non declaree. Les corrections, elles, " +
      "sont consignees au changelog editorial (§6).",
    counts: { surfaces: entrees.length },
    surfaces: entrees.map((e) => ({
      ...e,
      url: `${base}${e.path}`,
    })),
  };
}

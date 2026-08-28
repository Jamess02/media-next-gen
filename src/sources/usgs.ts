/**
 * Adaptateur REEL — USGS, service FDSN des seismes (tier 1, sans clef).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement).
 *
 * PARTICULARITES EXPLOITEES
 *
 *  - §5.1 : premier adaptateur a utiliser reellement `query.since`. La fenetre
 *    de fraicheur devient un parametre de requete (`starttime`), pas une
 *    decoration.
 *  - §5.2 : "Repere les revisions". Chaque solution USGS porte un `status` —
 *    `automatic` (calcul preliminaire, revisable) ou `reviewed` (validee par un
 *    sismologue). Publier une magnitude automatique comme definitive serait
 *    exactement l'erreur que le protocole demande d'eviter, donc le statut est
 *    remonte dans le resume de chaque evenement.
 *  - Une observation par seisme, chacune avec sa propre page evenement. Un
 *    agregat unique priverait le lecteur de la source precise de chaque fait.
 */

import { SourceFetchError, buildUrl, fetchJson, formatMeasure } from "./http.js";
import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";

const API_ROOT = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const SOURCE_NAME = "USGS";

interface UsgsFeature {
  properties?: {
    mag?: number | null;
    place?: string | null;
    time?: number | null;
    updated?: number | null;
    url?: string | null;
    status?: string | null;
    tsunami?: number | null;
    alert?: string | null;
  };
  geometry?: { coordinates?: number[] };
}

interface UsgsPayload {
  type?: string;
  features?: UsgsFeature[];
}

export interface UsgsAdapterOptions {
  /** Magnitude minimale. 6 retient les seismes a portee geopolitique. */
  minMagnitude?: number;
  /** Nombre maximal d'evenements remontes. */
  limit?: number;
}

export function usgsAdapter(options: UsgsAdapterOptions = {}): SourceAdapter {
  const minMagnitude = options.minMagnitude ?? 6;
  const limit = options.limit ?? 5;

  return {
    id: `usgs:earthquakes:m${minMagnitude}`,
    describes: `Seismes de magnitude >= ${minMagnitude} (USGS FDSN)`,

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      const requestedUrl = buildUrl(API_ROOT, {
        format: "geojson",
        minmagnitude: minMagnitude,
        limit,
        orderby: "time",
        // §5.1 — la fenetre de fraicheur pilote reellement la requete.
        starttime: query.since,
      });

      const raw = await fetchJson(requestedUrl, { sourceName: SOURCE_NAME });
      const payload = raw as UsgsPayload;

      if (payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          "reponse non conforme au format GeoJSON attendu",
        );
      }

      const observations: Observation[] = [];
      let skipped = 0;

      for (const feature of payload.features) {
        const p = feature.properties;
        // Un evenement sans magnitude, sans date ou sans page citable n'est pas
        // publiable : il ne pourrait pas atteindre le niveau de preuve 2 (§2).
        if (
          p === undefined ||
          typeof p.mag !== "number" ||
          typeof p.time !== "number" ||
          typeof p.url !== "string"
        ) {
          skipped += 1;
          continue;
        }

        const depth = feature.geometry?.coordinates?.[2];
        const status = p.status ?? "inconnu";
        const statusNote =
          status === "reviewed"
            ? "solution revue par un sismologue"
            : `solution ${status} — PRELIMINAIRE, la magnitude peut etre revisee`;

        observations.push({
          source: SOURCE_NAME,
          url: p.url,
          date_observed: new Date().toISOString(),
          date_published: new Date(p.time).toISOString(),
          type: "evenement-sismique",
          resume:
            `Seisme de magnitude ${formatMeasure(p.mag, 1)} — ${p.place ?? "localisation non precisee"}, ` +
            `le ${new Date(p.time).toISOString()}` +
            (typeof depth === "number"
              ? `, profondeur ${formatMeasure(depth, 1)} km`
              : "") +
            `. Statut : ${statusNote}.` +
            (p.tsunami === 1 ? " Alerte tsunami emise." : "") +
            (typeof p.alert === "string" && p.alert.length > 0
              ? ` Niveau d'alerte PAGER : ${p.alert}.`
              : ""),
        });
      }

      if (observations.length === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          requestedUrl,
          `aucun seisme exploitable de magnitude >= ${minMagnitude} depuis ${query.since}` +
            (skipped > 0 ? ` (${skipped} evenement(s) incomplet(s) ecarte(s))` : ""),
        );
      }

      return { requestedUrl, raw, observations };
    },
  };
}

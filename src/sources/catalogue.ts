/**
 * Catalogue des sources reelles.
 *
 * Dependances : les adaptateurs concrets, plus `types.ts`. C'est le SEUL module
 * de `sources/` qui lit `process.env`. Les adaptateurs recoivent leurs clefs en
 * parametre, ce qui les rend testables sans variable globale et evite qu'une
 * clef soit lue a dix endroits differents.
 *
 * §EP-003 — une source absente n'est pas une source vide. Le catalogue rend la
 * liste des adaptateurs ecartes ET le motif, pour que le pipeline puisse le
 * declarer au lecteur au lieu de laisser croire a une couverture complete.
 */

import { eurostatAdapter } from "./eurostat.js";
import { fredAdapter } from "./fred.js";
import { imfAdapter } from "./imf.js";
import { l0gAdapter } from "./l0g.js";
import type { SourceAdapter } from "./types.js";
import { usgsAdapter } from "./usgs.js";
import { worldBankAdapter } from "./worldbank.js";

export interface SkippedSource {
  id: string;
  reason: string;
}

export interface SourceCatalogue {
  adapters: SourceAdapter[];
  skipped: SkippedSource[];
}

/**
 * Construit la liste des sources disponibles.
 *
 * Les sources sans clef sont toujours presentes. Celles qui en exigent une ne
 * sont incluses que si la clef est effectivement fournie : mieux vaut une
 * source declaree absente qu'un adaptateur qui echoue a chaque appel et pollue
 * le journal d'audit d'erreurs previsibles.
 */
export function buildSourceCatalogue(
  env: NodeJS.ProcessEnv = process.env,
): SourceCatalogue {
  const adapters: SourceAdapter[] = [
    // --- Tier 1, sans clef ------------------------------------------------
    worldBankAdapter({ country: "EMU", indicator: "FP.CPI.TOTL.ZG" }),
    worldBankAdapter({ country: "WLD", indicator: "NY.GDP.MKTP.KD.ZG" }),
    imfAdapter({
      country: "FRA",
      indicator: "NGDP_RPCH",
      label: "Croissance du PIB reel",
    }),
    eurostatAdapter({
      dataset: "prc_hicp_manr",
      filters: { geo: "EA", coicop: "CP00", unit: "RCH_A", freq: "M" },
      label: "IPCH, taux de variation annuel",
    }),
    usgsAdapter({ minMagnitude: 6, limit: 5 }),

    // --- Tier 2, sans clef ------------------------------------------------
    // Analyses secondaires. EP-001 leur reste applicable : la passerelle
    // signale celles qu'une source primaire du meme lot eclipse.
    l0gAdapter({ limit: 3 }),
  ];

  const skipped: SkippedSource[] = [];

  // --- Tier 1, clef requise ----------------------------------------------
  const fredKey = env["FRED_API_KEY"];
  if (fredKey !== undefined && fredKey.trim().length > 0) {
    adapters.push(
      fredAdapter({
        seriesId: "FEDFUNDS",
        label: "Taux effectif des fonds federaux",
        apiKey: fredKey,
      }),
    );
  } else {
    skipped.push({
      id: "fred:FEDFUNDS",
      reason:
        "FRED_API_KEY absente de l'environnement. Clef gratuite sur " +
        "https://fredaccount.stlouisfed.org/apikeys — a placer dans .env.",
    });
  }

  // --- Sources ecartees pour raisons externes -----------------------------
  // Documentees ici plutot que supprimees : le lecteur du code doit savoir
  // pourquoi une source du §4 n'est pas branchee.
  skipped.push(
    {
      id: "gdelt:doc",
      reason:
        "api.gdeltproject.org presente un certificat TLS expire. Contourner la " +
        "verification TLS exposerait le pipeline a une interception : on attend " +
        "que la source corrige son certificat.",
    },
    {
      id: "reliefweb:reports",
      reason:
        "L'API v1 est decommissionnee et la v2 exige un `appname` approuve par " +
        "ReliefWeb (demande sur https://apidoc.reliefweb.int/parameters#appname).",
    },
    {
      id: "opensanctions:search",
      reason:
        "Clef d'API requise (OPENSANCTIONS_API_KEY non geree pour l'instant).",
    },
  );

  return { adapters, skipped };
}

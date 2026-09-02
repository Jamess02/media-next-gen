/**
 * Adaptateur REEL — OFAC, actions de sanctions (tier 1, sans clef).
 *
 * Dependances : `http.ts` et `types.ts` (type uniquement).
 *
 * POURQUOI LE FICHIER DE DELTAS, ET PAS LA LISTE COMPLETE
 *
 * `SDN.CSV` fait 5,6 Mo : le telecharger a chaque execution gonflerait
 * l'archive d'audit sans rien apporter. Un media couvre les ACTIONS — qui
 * vient d'etre designe, sous quel programme — pas l'etat du stock. Le fichier
 * de deltas fait 11 Ko et ne contient que cela.
 *
 * CE QUE CET ADAPTATEUR NE PUBLIE PAS : LES NOMS
 *
 * Le delta contient l'identite des personnes designees. Il ne les extrait pas,
 * et c'est delibere.
 *
 * Ce pipeline a deja produit, avec de vrais modeles, un chiffre partiel type
 * `fait` et un taux invente adosse a des sources qui n'en parlaient pas. Les
 * memes mecanismes appliques a « X a ete sanctionne » produiraient une
 * imputation nominative fausse — c'est-a-dire une diffamation, pas une erreur
 * de chiffre.
 *
 * L'observation porte donc sur l'ACTION : sa date, son type, le nombre
 * d'entites touchees, les programmes invoques et l'autorite legale. Ce sont des
 * faits agreges, verifiables, et sans imputation individuelle. Le lecteur suit
 * l'URL vers OFAC pour les noms, a la source.
 *
 * SUR LE FORMAT
 *
 * Le service rend du XML meme quand on demande `format=json`. Ce fichier
 * n'implemente PAS un parseur XML : il extrait quelques champs d'un document
 * dont le schema est publie, et echoue bruyamment si la structure attendue est
 * absente. Une extraction etroite qui se sait etroite vaut mieux qu'un parseur
 * approximatif — et mieux qu'une dependance pour lire quatre balises.
 */

import { SourceFetchError } from "./http.js";
import type { FetchOutcome, SourceAdapter, SourceQuery } from "./types.js";

const DELTA_URL =
  "https://sanctionslistservice.ofac.treas.gov/changes/latest?format=json";
const PAGE_PUBLIQUE = "https://ofac.treasury.gov/recent-actions";
const SOURCE_NAME = "OFAC (US Treasury)";
const TIMEOUT_MS = 20_000;

const extraire = (xml: string, balise: string): string | undefined =>
  new RegExp(`<${balise}>([^<]+)</${balise}>`).exec(xml)?.[1]?.trim();

const compter = (xml: string, motif: RegExp): Record<string, number> => {
  const compte: Record<string, number> = {};
  for (const m of xml.matchAll(motif)) {
    const cle = (m[1] ?? "").trim();
    if (cle.length > 0) compte[cle] = (compte[cle] ?? 0) + 1;
  }
  return compte;
};

const enumerer = (compte: Record<string, number>): string =>
  Object.entries(compte)
    .sort(([, a], [, b]) => b - a)
    .map(([cle, n]) => (n > 1 ? `${cle} (${n})` : cle))
    .join(", ");

export function ofacAdapter(): SourceAdapter {
  return {
    id: "ofac:recent-actions",
    describes: "Dernieres actions de sanctions publiees par l'OFAC",

    async fetch(_query: SourceQuery): Promise<FetchOutcome> {
      let reponse: Response;
      try {
        reponse = await fetch(DELTA_URL, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "user-agent": "media-next-gen (pipeline editorial)" },
        });
      } catch (error) {
        throw new SourceFetchError(
          SOURCE_NAME,
          DELTA_URL,
          error instanceof Error ? `echec reseau — ${error.message}` : "echec reseau",
        );
      }

      if (!reponse.ok) {
        throw new SourceFetchError(SOURCE_NAME, DELTA_URL, `HTTP ${reponse.status}`, reponse.status);
      }

      const xml = await reponse.text();

      const datePublished = extraire(xml, "datePublished");
      if (datePublished === undefined) {
        throw new SourceFetchError(
          SOURCE_NAME,
          DELTA_URL,
          "structure inattendue : aucune date de publication dans le fichier de deltas",
        );
      }

      const actions = compter(xml, /<entity id="\d+" action="(\w+)">/g);
      const total = Object.values(actions).reduce((a, b) => a + b, 0);
      if (total === 0) {
        throw new SourceFetchError(
          SOURCE_NAME,
          DELTA_URL,
          `aucune entite modifiee dans la publication du ${datePublished}`,
        );
      }

      const typeAction = extraire(xml, "publicationType") ?? "type non precise";
      const typesEntite = compter(xml, /<entityType refId="\d+">([^<]+)<\/entityType>/g);
      const programmes = compter(xml, /<sanctionsProgram id="\d+" refId="\d+">([^<]+)<\/sanctionsProgram>/g);
      const autorites = compter(xml, /<legalAuthority id="\d+" refId="\d+">([^<]+)<\/legalAuthority>/g);
      const mesures = compter(xml, /<sanctionsType id="\d+" refId="\d+">([^<]+)<\/sanctionsType>/g);

      const publiee = toIso(datePublished);

      return {
        requestedUrl: DELTA_URL,
        raw: xml,
        observations: [
          {
            source: SOURCE_NAME,
            // Page publique de l'action, ou figurent les noms. C'est la que le
            // lecteur va les chercher, pas dans notre resume.
            url: PAGE_PUBLIQUE,
            date_observed: new Date().toISOString(),
            date_published: publiee,
            type: "action-sanctions",
            resume:
              `Publication OFAC du ${datePublished} (${typeAction}) : ` +
              `${total} entite(s) modifiee(s) — ${enumerer(actions)}. ` +
              `Nature : ${enumerer(typesEntite) || "non precisee"}. ` +
              `Programme(s) : ${enumerer(programmes) || "non precise"}. ` +
              `Mesure(s) : ${enumerer(mesures) || "non precisee"}. ` +
              `Autorite(s) legale(s) : ${enumerer(autorites) || "non precisee"}. ` +
              `Les identites designees ne sont pas reprises ici : les consulter a la source.`,
          },
        ],
      };
    },
  };
}

/** OFAC rend "2026-08-28T00:00:00-04:00". Le §7 exige de l'ISO-8601 complet. */
function toIso(valeur: string): string | null {
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

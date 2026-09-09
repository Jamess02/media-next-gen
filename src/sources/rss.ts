/**
 * Adaptateur REEL generique — flux RSS et Atom.
 *
 * Dependances : `types.ts` (type uniquement). Aucune npm.
 *
 * POURQUOI PAS UN PARSEUR RSS DU MARCHE
 *
 * Meme raison que pour le rendu markdown du site : les parseurs generalistes
 * acceptent beaucoup et signalent peu. Ici on extrait cinq champs d'un format
 * stable, et on ECHOUE quand la structure attendue est absente — un flux qui
 * change de forme doit se voir, pas se degrader en observations vides.
 *
 * CE QUE CET ADAPTATEUR NE FAIT PAS
 *
 * Il ne recupere que ce que l'editeur publie DANS son flux : titre, lien, date,
 * description. Aucune visite de page, aucune extraction d'article. Un flux est
 * fait pour etre consomme ; le contenu derriere ne l'est pas necessairement, et
 * la plupart de ces editeurs le protegent.
 *
 * TIER : jamais declare ici. La passerelle le derive du domaine (§4). Un flux
 * de banque centrale et un flux de presse passent par le meme code et
 * ressortent avec des tiers differents, ce qui est exactement le but.
 */

import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";
import { SourceFetchError, readBodyCapped, safeFetch } from "./http.js";

const TIMEOUT_MS = 20_000;

export interface RssAdapterOptions {
  /** Identifiant stable de l'adaptateur. */
  id: string;
  /** Nom de l'editeur, tel qu'il apparaitra dans l'observation. */
  source: string;
  url: string;
  describes: string;
  /** Nombre maximal d'entrees retenues. */
  limit?: number;
  /** Type d'observation, pour l'analyse en aval. */
  type?: string;
  /**
   * Mention accolee a chaque resume. Sert aux flux dont la nature doit
   * accompagner la donnee — ligne editoriale connue, statut officiel.
   */
  caveat?: string;
}

/** Retire les CDATA et decode les entites les plus courantes. */
function texte(brut: string | undefined): string {
  if (brut === undefined) return "";
  return brut
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // L'esperluette en DERNIER : la decoder avant relancerait les autres.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const champ = (bloc: string, nom: string): string | undefined =>
  new RegExp(`<${nom}[^>]*>([\\s\\S]*?)</${nom}>`, "i").exec(bloc)?.[1];

/** Atom place le lien en attribut ; RSS dans le contenu de la balise. */
function lien(bloc: string): string | undefined {
  const rss = champ(bloc, "link");
  if (rss !== undefined && rss.trim().length > 0) return texte(rss);
  return /<link[^>]*href="([^"]+)"/i.exec(bloc)?.[1];
}

function dateIso(bloc: string): string | null {
  for (const nom of ["pubDate", "updated", "published", "dc:date"]) {
    const brut = champ(bloc, nom);
    if (brut === undefined) continue;
    const d = new Date(texte(brut));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export function rssAdapter(options: RssAdapterOptions): SourceAdapter {
  const limit = options.limit ?? 4;

  return {
    id: options.id,
    describes: options.describes,

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      // `redirect: "follow"` etait ici la faille : un flux qui redirige vers
      // 169.254.169.254 ou vers la boucle locale faisait emettre la requete par
      // notre infrastructure. `safeFetch` valide chaque saut AVANT de l'appeler.
      const reponse = await safeFetch(
        options.url,
        {
          headers: {
            "user-agent": "media-next-gen (pipeline editorial)",
            accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
          },
        },
        options.source,
        TIMEOUT_MS,
      );

      if (!reponse.ok) {
        throw new SourceFetchError(
          options.source,
          options.url,
          `HTTP ${reponse.status}`,
          reponse.status,
        );
      }

      // Plafonne AVANT l'analyse : sur un corps demesure, la regex d'extraction
      // part en explosion combinatoire (worker tue en test).
      const xml = await readBodyCapped(reponse, options.source, options.url);
      const blocs = [
        ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
        ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
      ].map((m) => m[0]);

      if (blocs.length === 0) {
        throw new SourceFetchError(
          options.source,
          options.url,
          "aucune entree : le flux a change de forme ou est vide",
        );
      }

      const depuis = Date.parse(query.since);
      const termes = query.topic
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 3);

      const entrees = blocs
        .map((bloc) => ({
          titre: texte(champ(bloc, "title")),
          url: lien(bloc),
          date: dateIso(bloc),
          resume: texte(champ(bloc, "description") ?? champ(bloc, "summary")),
        }))
        .filter((e) => e.titre.length > 0 && typeof e.url === "string")
        // §5.1 — la fenetre de fraicheur filtre reellement. Une entree non
        // datee est conservee : l'absence de date n'est pas une preuve
        // d'anciennete, et elle sera signalee au lecteur.
        .filter((e) => e.date === null || Number.isNaN(depuis) || Date.parse(e.date) >= depuis)
        .map((e) => {
          const foin = `${e.titre} ${e.resume}`.toLowerCase();
          return { ...e, score: termes.filter((t) => foin.includes(t)).length };
        })
        // Pertinence au sujet, puis fraicheur. Critere explicite, donc
        // contestable — comme celui du Veilleur.
        .sort(
          (a, b) => b.score - a.score || Date.parse(b.date ?? "") - Date.parse(a.date ?? ""),
        )
        .slice(0, limit);

      if (entrees.length === 0) {
        throw new SourceFetchError(
          options.source,
          options.url,
          `aucune entree depuis ${query.since} sur ${blocs.length} publiee(s)`,
        );
      }

      const observations: Observation[] = entrees.map((e) => ({
        source: options.source,
        url: e.url as string,
        date_observed: new Date().toISOString(),
        date_published: e.date,
        type: options.type ?? "flux-editeur",
        resume:
          `${e.titre}.` +
          (e.resume.length > 0 ? ` ${e.resume.slice(0, 400)}` : "") +
          (e.date === null ? " (entree non datee par l'editeur)" : "") +
          (e.score === 0 ? " (aucun terme du sujet : retenue par fraicheur)" : "") +
          (options.caveat === undefined ? "" : ` ${options.caveat}`),
      }));

      return { requestedUrl: options.url, raw: xml, observations };
    },
  };
}

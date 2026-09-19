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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchOutcome, Observation, SourceAdapter, SourceQuery } from "./types.js";
import { CacheDeReponses } from "./cache.js";
import { Espaceur } from "./debit.js";
import { SourceFetchError, readBodyCapped, safeFetch } from "./http.js";

const TIMEOUT_MS = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Hors versionnement : c'est un cache, pas du code (voir .gitignore). */
const CACHE_DU_DEPOT = join(HERE, "..", "..", ".cache", "sources");

/**
 * Racine du cache des flux, surchargeable par `SOURCES_CACHE_DIR`.
 *
 * POURQUOI CE LEVIER EXISTE. Un test qui construit le catalogue et bouchonne
 * `fetch` ecrivait son FLUX FABRIQUE dans le cache de production, ou le vrai
 * pipeline l'aurait ensuite servi pendant toute la duree du TTL comme s'il
 * venait de la source. Constate le 2026-09-19, une minute apres avoir branche
 * le cache d'arXiv : la suite avait depose un faux flux dans .cache/sources.
 *
 * LUE A LA CONSTRUCTION, pas au chargement du module : un test qui veut un
 * cache neuf pose la variable puis reconstruit le catalogue. Une constante de
 * module aurait fige la valeur du tout premier import.
 *
 * Accessoirement, un deploiement en conteneur peut ainsi pointer un volume qui
 * survit au redemarrage.
 */
function racineDuCache(): string {
  const brut = process.env["SOURCES_CACHE_DIR"];
  return brut !== undefined && brut.trim().length > 0 ? brut.trim() : CACHE_DU_DEPOT;
}

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
  /**
   * Duree de validite en cache. Absente : aucune mise en cache, comportement
   * inchange pour les flux deja branches.
   *
   * Une vague produit six articles, et la passerelle interroge les sources de
   * chacun : sans cache, six requetes identiques partent vers une source qui,
   * pour certaines, n'en autorise qu'une toutes les trois secondes.
   */
  ttlMs?: number;
  /** Racine du cache. `null` : memoire seule — ce que font les tests. */
  cacheDir?: string | null;
  /**
   * Espacement minimal entre deux requetes vers cette source. Absent : aucun.
   *
   * Pour les fournisseurs qui formulent leur limite en conditions d'usage
   * plutot qu'en code de retour : aucun 429 ne viendra avertir.
   */
  intervalleMs?: number;
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
    // SECOND retrait des balises, APRES le decodage des entites.
    //
    // MESURE du 2026-09-19 : Business Recorder encode son HTML deux fois — son
    // flux porte « &lt;p&gt;&lt;strong&gt;LAHORE: … ». Le premier retrait ne
    // voit rien, les chevrons etant encore des entites ; le decodage les
    // restaure ensuite, et le resume partait avec « <p><strong> » en clair vers
    // l'Analyste, donc vers les prompts et jusqu'a l'article.
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const champ = (bloc: string, nom: string): string | undefined =>
  new RegExp(`<${nom}[^>]*>([\\s\\S]*?)</${nom}>`, "i").exec(bloc)?.[1];

/**
 * Normalise le CHEMIN d'une adresse de flux.
 *
 * MESURE du 2026-09-19 : le blog de la BCE publie ses liens sous la forme
 * « https://www.ecb.europa.eu//press/blog/... ». L'adresse fonctionne — les
 * serveurs tolerent la barre doublee — mais elle est citee VERBATIM dans
 * l'article et dans la fiche de preuve, et une citation dont l'adresse est mal
 * formee se relit mal et se verifie moins bien.
 *
 * SEUL LE CHEMIN est touche. Une barre doublee dans les parametres peut etre
 * significative — « ?cible=https://autre.test/x » — et la reecrire demanderait
 * une AUTRE ressource que celle publiee.
 *
 * Une adresse inanalysable ressort TELLE QUELLE. Ce n'est pas a l'adaptateur de
 * la refuser : le contrat le fait plus loin, et il sait dire pourquoi.
 */
function normaliserUrl(brut: string): string {
  try {
    const u = new URL(brut);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  } catch {
    return brut;
  }
}

/** Atom place le lien en attribut ; RSS dans le contenu de la balise. */
function lien(bloc: string): string | undefined {
  const rss = champ(bloc, "link");
  if (rss !== undefined && rss.trim().length > 0) return normaliserUrl(texte(rss));
  const atom = /<link[^>]*href="([^"]+)"/i.exec(bloc)?.[1];
  return atom === undefined ? undefined : normaliserUrl(atom);
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
  const ttlMs = options.ttlMs ?? 0;

  // Crees UNE fois par adaptateur : un cache et une file recrees a chaque
  // collecte ne serviraient jamais et n'espaceraient rien.
  const cache =
    ttlMs > 0
      ? new CacheDeReponses({
          id: options.id.replace(/[^a-z0-9]+/gi, "-"),
          dir: options.cacheDir === undefined ? racineDuCache() : options.cacheDir,
        })
      : null;

  const espaceur =
    options.intervalleMs !== undefined && options.intervalleMs > 0
      ? new Espaceur({ intervalleMs: options.intervalleMs })
      : null;

  return {
    id: options.id,
    describes: options.describes,

    async fetch(query: SourceQuery): Promise<FetchOutcome> {
      // `redirect: "follow"` etait ici la faille : un flux qui redirige vers
      // 169.254.169.254 ou vers la boucle locale faisait emettre la requete par
      // notre infrastructure. `safeFetch` valide chaque saut AVANT de l'appeler.
      // Le cache porte le XML BRUT, pas les observations : le filtrage depend
      // du sujet de l'article, si bien qu'une meme reponse sert six sujets
      // differents. L'horodatage est celui de la requete d'ORIGINE — sans lui,
      // l'article daterait l'observation du moment ou il la relit (§5.1).
      const enCache = cache === null ? null : await cache.lire(options.url);
      let xml: string;
      let horodatage: string;

      if (enCache !== null) {
        xml = enCache.corps as string;
        horodatage = enCache.horodatageRequete;
      } else {
        horodatage = new Date().toISOString();
        const appel = (): Promise<Response> =>
          safeFetch(
            options.url,
            {
              headers: {
                "user-agent": "media-next-gen (pipeline editorial)",
                accept:
                  "application/rss+xml, application/atom+xml, application/xml, text/xml",
              },
            },
            options.source,
            TIMEOUT_MS,
          );

        const reponse = espaceur === null ? await appel() : await espaceur.passer(appel);

        if (!reponse.ok) {
          throw new SourceFetchError(
            options.source,
            options.url,
            `HTTP ${reponse.status}`,
            reponse.status,
          );
        }

        // Plafonne AVANT l'analyse : sur un corps demesure, la regex
        // d'extraction part en explosion combinatoire (worker tue en test).
        xml = await readBodyCapped(reponse, options.source, options.url);
      }

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

      // MIS EN CACHE APRES CONTROLE, jamais avant : un echec ou un flux dont la
      // forme a change, servi pendant tout le delai, masquerait le
      // retablissement de la source — et l'article porterait « source
      // indisponible » sans raison.
      if (cache !== null && enCache === null) {
        await cache.ecrire({
          url: options.url,
          horodatageRequete: horodatage,
          expireA: Date.now() + ttlMs,
          corps: xml,
        });
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
        date_observed: horodatage,
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

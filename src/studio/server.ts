/**
 * Interface de pilotage locale.
 *
 * Dependances : `node:http` et les modules du pipeline. Aucune dependance npm —
 * ni Express, ni framework front. L'interface est une page unique servie en
 * dur, l'echange se fait en SSE, natif cote navigateur.
 *
 * SECURITE — deux contraintes, pas des precautions de style :
 *
 *  1. Ecoute sur 127.0.0.1 UNIQUEMENT. Ce serveur declenche le pipeline, donc
 *     des appels a des APIs potentiellement facturees. Il ne doit etre
 *     joignable ni depuis le reseau local, ni depuis Internet.
 *  2. Aucune donnee de l'utilisateur n'est interpolee en HTML cote serveur :
 *     la page est statique, tout le contenu dynamique est insere par le
 *     navigateur via `textContent`, jamais `innerHTML`.
 *
 * C'est un outil de travail, pas un produit : il montre ce que le pipeline
 * fait, y compris et surtout quand il refuse de publier.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTIVE_RESPONDERS } from "../fixtures/adaptive-responders.js";
import { MOCK_RESPONDERS } from "../fixtures/mock-scenario.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  FREE_PROVIDERS,
  ProviderUnavailable,
  resolveProvider,
  type ProviderName,
} from "../llm/providers.js";
import { SuiviIndicateurs } from "../infographie/suivi.js";
import {
  THEMATIQUES,
  thematiqueDesSources,
} from "../sources/thematiques.js";
import { EditorialPipeline } from "../pipeline.js";
import {
  TAILLE_VAGUE,
  executerVague,
} from "../planification/vagues.js";
import { EditorialChangelog } from "../editorial/changelog.js";
import { validateArticle } from "../editorial/validation.js";
import { ArticleSchema } from "../protocol/schema.js";
import { buildSourceCatalogue } from "../sources/catalogue.js";
import { MOCK_ADAPTERS } from "../sources/mock-sources.js";
import { buildSite } from "../site/build.js";
import { articlePage } from "../site/templates.js";
import { STUDIO_PAGE } from "./page.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACINE = join(HERE, "..", "..");
const OUTPUT_DIR = join(RACINE, "output");
const AUDIT_JOURNAL = join(RACINE, "audit", "journal.jsonl");

/**
 * En-tetes de securite, sur CHAQUE reponse.
 *
 * `no-referrer` n'est pas cosmetique ICI : le jeton de session voyage dans
 * l'URL — c'est ce qui permet a la page de le distribuer sans cookie. Sans cet
 * en-tete, le premier lien externe suivi depuis un apercu l'emporterait chez
 * l'editeur du site cite, dans le `Referer`.
 *
 * `nosniff` empeche un navigateur d'executer comme script ce qui est servi
 * comme donnee ; `SAMEORIGIN` empeche un site tiers d'encadrer le studio pour
 * faire cliquer l'editeur a son insu.
 */
const SECURITE: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
};

/** Politique minimale : une reponse de donnees n'a rien a charger. */
const CSP_DONNEES = "default-src 'none'; frame-ancestors 'self'";

/**
 * Politique de securite du contenu, calculee sur le HTML qui PART.
 *
 * Les empreintes sont prises sur les scripts reellement emis : une retouche de
 * la page ne peut pas desynchroniser la politique et casser le studio. Tout
 * script qui n'y figure pas — donc tout script injecte — ne s'execute pas.
 */
function cspDeLaPage(html: string): string {
  const empreintes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1] ?? "", "utf8").digest("base64")}'`)
    .join(" ");
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    `script-src ${empreintes}`,
    "connect-src 'self'",
    // L'apercu d'un brouillon est affiche dans un cadre de meme origine.
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * Compare deux jetons en TEMPS CONSTANT.
 *
 * Le jeton est la seule authentification du studio, et il vit dans le
 * navigateur de l'editeur, ou une page tierce peut mesurer des temps de
 * reponse. Une comparaison de chaines s'arrete au premier caractere
 * different : elle laisse fuir, octet par octet, de quoi le reconstituer.
 *
 * Un jeton vide ne vaut jamais : c'est ce que rend un parametre absent.
 */
export function jetonValide(attendu: string, recu: string): boolean {
  if (attendu.length === 0 || attendu.length !== recu.length) return false;
  return timingSafeEqual(Buffer.from(attendu, "utf8"), Buffer.from(recu, "utf8"));
}

const json = (res: ServerResponse, code: number, data: unknown): void => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...SECURITE,
    "content-security-policy": CSP_DONNEES,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
};

/* -------------------------------------------------------------------------
 * Etat courant
 * ---------------------------------------------------------------------- */

/**
 * Lit l'attestation de relecture d'un article, si elle existe.
 *
 * Son absence n'est PAS une anomalie : c'est l'etat normal d'un brouillon que
 * personne n'a encore relu. On rend `null`, jamais un relecteur suppose.
 */
async function lireRelecteur(publishedDir: string, id: string): Promise<string | null> {
  const p = join(publishedDir, `${id}.review.json`);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(await readFile(p, "utf8")) as { reviewer?: unknown };
    return typeof r.reviewer === "string" ? r.reviewer : null;
  } catch {
    return null;
  }
}

async function lireArticles(
  draftDir: string,
  publishedDir: string,
): Promise<unknown[]> {
  if (!existsSync(draftDir)) return [];
  const fichiers = (await readdir(draftDir)).filter((f) => f.endsWith(".json"));
  const articles: unknown[] = [];

  for (const f of fichiers) {
    const parsed = ArticleSchema.safeParse(
      JSON.parse(await readFile(join(draftDir, f), "utf8")),
    );
    if (!parsed.success) continue;
    const a = parsed.data;
    const relecteur = await lireRelecteur(publishedDir, a.id);
    articles.push({
      id: a.id,
      titre: a.title,
      publie: a.published_at,
      revise: a.revised_at,
      // L'attestation est la SEULE preuve de relecture. Pas de fichier, pas de
      // relecteur : l'article reste un brouillon, quoi qu'affiche l'interface.
      valide: relecteur !== null,
      relecteur,
      claims: a.claims.map((c) => ({
        id: c.id,
        type: c.type,
        niveau: c.evidence_level,
        sources: c.sources.length,
      })),
      incertitudes: a.editorial_notes.uncertainty_flags.length,
      ecartees: a.editorial_notes.excluded_claims.length,
      // Rangement DERIVE des emetteurs cites, jamais devine du titre. Il ne
      // quitte pas le studio : ni le contrat §7, ni l'article, ni le site.
      thematique: thematiqueDesSources(
        a.claims.flatMap((c) => c.sources.map((s) => s.url)),
      ),
    });
  }

  // Groupe par thematique, puis du plus recent au plus ancien A L'INTERIEUR de
  // chaque groupe.
  //
  // LE TRI EST FAIT ICI, ET NON DANS LA PAGE. Un ordre calcule par le
  // navigateur echapperait aux tests, et finirait par dependre de l'ordre de
  // lecture du disque — qui n'est garanti par rien.
  //
  // « non classe » ferme la liste : ce sont les articles dont on sait le
  // moins, pas ceux qu'il faut relire en premier.
  const rang = (t: string): number => {
    const i = (THEMATIQUES as readonly string[]).indexOf(t);
    return i < 0 ? THEMATIQUES.length : i;
  };

  articles.sort((x, y) => {
    const a = x as { publie: string; thematique: string };
    const b = y as { publie: string; thematique: string };
    return (
      rang(a.thematique) - rang(b.thematique) ||
      String(b.publie).localeCompare(String(a.publie))
    );
  });
  return articles;
}

async function lireAudit(limite = 60): Promise<unknown[]> {
  if (!existsSync(AUDIT_JOURNAL)) return [];
  const lignes = (await readFile(AUDIT_JOURNAL, "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lignes.slice(-limite).reverse().map((l) => JSON.parse(l));
}

function etatFournisseurs(): unknown[] {
  return [
    { nom: "mock", pret: true, note: "hors ligne, aucun appel" },
    ...Object.entries(FREE_PROVIDERS).map(([nom, spec]) => ({
      nom,
      pret: spec.envKey === null || Boolean(process.env[spec.envKey]?.trim()),
      note:
        spec.envKey === null
          ? "serveur local"
          : process.env[spec.envKey]?.trim()
            ? `clef presente — ${spec.defaultModel}`
            : `${spec.envKey} absente`,
    })),
    {
      nom: "anthropic",
      pret: Boolean(process.env["ANTHROPIC_API_KEY"]?.trim()),
      note: process.env["ANTHROPIC_API_KEY"]?.trim()
        ? "clef presente — FACTURE"
        : "ANTHROPIC_API_KEY absente",
    },
  ];
}

/* -------------------------------------------------------------------------
 * Execution du pipeline, diffusee en SSE
 * ---------------------------------------------------------------------- */

async function executer(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
  /** D'ou viennent les observations des relecteurs (§6). */
  publishedDir: string,
): Promise<void> {
  res.writeHead(200, {
    ...SECURITE,
    "content-security-policy": CSP_DONNEES,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const envoyer = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sujet = params.get("sujet")?.trim() ?? "";
  const provider = (params.get("provider") ?? "mock") as ProviderName;
  const sourcesReelles = params.get("sources") === "reelles";

  if (sujet.length === 0) {
    envoyer("erreur", { message: "Sujet vide." });
    res.end();
    return;
  }

  const audit = new AuditLog();

  try {
    const resolved = resolveProvider({
      provider,
      audit,
      responders: sourcesReelles ? ADAPTIVE_RESPONDERS : MOCK_RESPONDERS,
    });

    for (const notice of resolved.notices) envoyer("avertissement", { message: notice });

    let adapters = MOCK_ADAPTERS;
    if (sourcesReelles) {
      const catalogue = buildSourceCatalogue();
      adapters = catalogue.adapters;
      for (const s of catalogue.skipped) {
        envoyer("source-ecartee", { id: s.id, motif: s.reason });
      }
    }

    envoyer("demarrage", {
      sujet,
      modele: resolved.client.modelId,
      sources: sourcesReelles ? "reelles" : "simulees",
      nbAdapters: adapters.length,
    });

    const pipeline = new EditorialPipeline({
      ctx: { llm: resolved.client, audit },
      adapters,
      // Meme registre que le CLI : un article produit depuis le studio compte
      // autant dans la comparaison entre editions.
      suivi: new SuiviIndicateurs(),
      // Les remarques laissees en validant orientent l'article suivant.
      publishedDir,
      onStage: (etape, detail) => envoyer("etape", { etape, detail }),
    });

    const resultat = await pipeline.run(sujet);

    if (resultat.status === "halted") {
      // Un arret n'est PAS une erreur : c'est le gate qui fait son travail.
      // L'interface doit le montrer comme un resultat, pas comme une panne.
      envoyer("arret", {
        etape: resultat.stage,
        motif: resultat.reason,
        details: resultat.details,
      });
    } else {
      envoyer("publie", {
        id: resultat.article.id,
        titre: resultat.article.title,
        claims: resultat.article.claims.length,
        ajustements: resultat.adjustments,
        avertissements: resultat.warnings.map(
          (w) => `[${w.clause} ${w.rule}] ${w.message}`,
        ),
      });
    }

    envoyer("audit", { appels: audit.entries().length });
  } catch (error) {
    envoyer("erreur", {
      message:
        error instanceof ProviderUnavailable
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
    });
  } finally {
    envoyer("fin", {});
    res.end();
  }
}

/* -------------------------------------------------------------------------
 * Serveur
 * ---------------------------------------------------------------------- */

/** Lit un corps JSON, borne pour qu'un client bavard ne sature pas la memoire. */
async function lireCorpsJson(req: IncomingMessage, max = 64_000): Promise<unknown> {
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) throw new Error("corps trop volumineux");
    morceaux.push(buf);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(morceaux).toString("utf8"));
}

/**
 * Valide un article relu — l'acte qui fait passer un brouillon a la publication.
 *
 * LE NOM DU RELECTEUR VIENT DE L'UTILISATEUR, TOUJOURS.
 *
 * Aucune valeur par defaut, aucun « editeur » generique, aucun nom devine
 * depuis la configuration git ou l'environnement. Une attestation affirme
 * qu'une personne a lu et engage sa responsabilite (§6) ; la remplir a sa
 * place la reduirait a une formalite, et le dispositif entier deviendrait
 * decoratif. C'est pourquoi un champ vide est un refus, pas un defaut a combler.
 */
async function validerDepuisStudio(
  req: IncomingMessage,
  res: ServerResponse,
  draftDir: string,
  publishedDir: string,
  changelog: EditorialChangelog,
): Promise<void> {
  let corps: { id?: unknown; relecteur?: unknown; note?: unknown };
  try {
    corps = (await lireCorpsJson(req)) as typeof corps;
  } catch {
    json(res, 400, { erreur: "corps JSON illisible" });
    return;
  }

  const id = typeof corps.id === "string" ? corps.id.trim() : "";
  const relecteur = typeof corps.relecteur === "string" ? corps.relecteur.trim() : "";
  const note = typeof corps.note === "string" && corps.note.trim().length > 0
    ? corps.note.trim()
    : undefined;

  if (relecteur.length === 0) {
    json(res, 400, {
      erreur:
        "relecteur manquant : une relecture anonyme n'engage personne. " +
        "Ce champ ne peut pas etre rempli a votre place.",
    });
    return;
  }
  if (id.length === 0) {
    json(res, 400, { erreur: "identifiant d'article manquant" });
    return;
  }

  try {
    const r = await validateArticle({
      articleId: id,
      reviewer: relecteur,
      ...(note === undefined ? {} : { note }),
      draftDir,
      publishedDir,
      changelog,
    });
    json(res, 200, {
      id: r.article.id,
      titre: r.article.title,
      relecteur: r.review.reviewer,
      relu_le: r.review.reviewed_at,
      empreinte: r.review.content_sha256,
      chemin: r.articlePath,
      avertissements: r.warnings.map((w) => `[${w.clause} ${w.rule}] ${w.message}`),
    });
  } catch (e) {
    // Le motif est rendu tel quel : refus du gate, brouillon absent,
    // identifiant hors repertoire. L'editeur doit savoir CE QUI bloque.
    json(res, 400, { erreur: e instanceof Error ? e.message : String(e) });
  }
}

export interface StudioOptions {
  port?: number;
  /**
   * Repertoires, surchargeables pour les tests.
   *
   * Sans cette injection, exercer la validation ecrirait dans les `output/` et
   * `articles/` REELS de l'editeur : un test aurait promu de vrais brouillons
   * et signe de vraies attestations. Un dispositif dont la verification
   * fabrique ce qu'il est cense proteger ne protege rien.
   */
  draftDir?: string;
  publishedDir?: string;
  changelogPath?: string;
}

export interface StudioInstance {
  url: string;
  close: () => Promise<void>;
}

/**
 * Une vague de six articles, declenchee a la main depuis le studio.
 *
 * MEME MOTEUR que la boucle automatique : `executerVague`. Deux chemins qui
 * composeraient leurs vagues differemment finiraient par diverger, et le bouton
 * cesserait de reproduire ce que l'automatisation fait vraiment.
 *
 * L'index de rotation est passe par l'appelant pour que deux declenchements
 * manuels successifs ne redonnent pas les six memes sujets.
 */
async function executerVagueSse(
  res: ServerResponse,
  params: URLSearchParams,
  /** D'ou viennent les observations des relecteurs (§6). */
  publishedDir: string,
): Promise<void> {
  res.writeHead(200, {
    ...SECURITE,
    "content-security-policy": CSP_DONNEES,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const envoyer = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const provider = (params.get("provider") ?? "mock") as ProviderName;
  const index = Number(params.get("index") ?? "0");
  const audit = new AuditLog();

  try {
    const resolved = resolveProvider({
      provider,
      audit,
      responders: ADAPTIVE_RESPONDERS,
    });
    const catalogue = buildSourceCatalogue();

    envoyer("vague-demarrage", {
      index,
      taille: TAILLE_VAGUE,
      modele: resolved.client.modelId,
      sources: catalogue.adapters.length,
    });

    const rapport = await executerVague({
      index: Number.isFinite(index) && index >= 0 ? index : 0,
      executer: (sujet) =>
        new EditorialPipeline({
          ctx: { llm: resolved.client, audit },
          adapters: catalogue.adapters,
          mode: sujet.mode,
          suivi: new SuiviIndicateurs(),
          publishedDir,
        }).run(sujet.sujet),
      onProgres: (fait, total, sujet) =>
        envoyer("vague-progres", {
          fait,
          total,
          mode: sujet.mode,
          sujet: sujet.sujet,
        }),
    });

    for (const l of rapport.lignes) envoyer("vague-ligne", l);
    envoyer("vague-fin", {
      publies: rapport.publies,
      arretes: rapport.arretes,
      erreurs: rapport.erreurs.length,
    });
  } catch (error) {
    envoyer("erreur", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    envoyer("fin", {});
    res.end();
  }
}

/* -------------------------------------------------------------------------
 * Confinement au navigateur de l'utilisateur
 *
 * Ecouter sur 127.0.0.1 protege du reseau, PAS du navigateur : une page ouverte
 * dans un autre onglet peut emettre des requetes vers la boucle locale. Deux
 * scenarios, tous deux realisables sans faille de navigateur :
 *
 *  - requete simple inter-origine. `<img src="http://127.0.0.1:5173/api/
 *    publier?provider=anthropic&sujet=...">` part sans pre-vol CORS. La page
 *    attaquante ne lit pas la reponse — mais le pipeline a demarre, avec des
 *    appels FACTURES et des fichiers ecrits ;
 *  - reattachement DNS. Un domaine de l'attaquant repointe vers 127.0.0.1
 *    apres chargement ; le navigateur voit alors une meme origine et la reponse
 *    devient lisible. L'en-tete `Host` trahit l'attaque : il porte le domaine
 *    de l'attaquant, jamais la boucle locale.
 *
 * Trois controles, parce qu'aucun ne suffit seul : `Host` casse le
 * reattachement, `Origin` casse l'appel inter-origine explicite, et le jeton
 * casse l'appel AVEUGLE, celui qui declenche sans lire.
 * ---------------------------------------------------------------------- */

const HOTES_ADMIS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Vrai si l'en-tete Host designe bien la boucle locale. */
function hoteLocal(host: string | undefined): boolean {
  if (host === undefined) return false;
  // Le port est ignore : c'est l'HOTE qui distingue une requete legitime d'un
  // reattachement DNS.
  const sansPort = host.replace(/:\d+$/, "").toLowerCase();
  return HOTES_ADMIS.has(sansPort);
}

/**
 * Vrai si l'origine declaree est la notre.
 *
 * Une origine ABSENTE est acceptee : les requetes de meme origine n'en portent
 * pas toujours, et `EventSource` n'en envoie pas. C'est precisement pourquoi le
 * jeton existe — l'absence d'origine ne doit pas valoir laissez-passer.
 */
function origineAdmise(origin: string | undefined): boolean {
  if (origin === undefined || origin === "null") return origin === undefined;
  try {
    return hoteLocal(new URL(origin).host);
  } catch {
    return false;
  }
}

export async function startStudio(
  options: StudioOptions = {},
): Promise<StudioInstance> {
  const port = options.port ?? 5173;
  const draftDir = options.draftDir ?? OUTPUT_DIR;
  const publishedDir = options.publishedDir ?? join(RACINE, "articles");
  const changelog = new EditorialChangelog(
    options.changelogPath ?? join(RACINE, "changelog-editorial.md"),
  );

  // Un secret par DEMARRAGE. Fixe, il finirait dans une capture d'ecran ou un
  // historique de navigation et vaudrait pour toutes les sessions suivantes.
  const jeton = randomUUID().replace(/-/g, "");

  /** Methodes admises par route. Tout le reste est refuse. */
  const METHODES: Record<string, readonly string[]> = {
    "/": ["GET"],
    "/api/etat": ["GET"],
    "/api/publier": ["GET"], // EventSource ne sait faire que du GET.
    "/api/vague": ["GET"],   // idem : SSE, donc GET.
    "/api/site": ["POST"],
    // Valider est une ECRITURE, et une ecriture qui engage un nom : POST
    // uniquement. En GET, elle serait declenchable par une simple balise
    // <img> sur n'importe quelle page ouverte dans le meme navigateur.
    "/apercu": ["GET"],
    "/api/article": ["GET"],
    "/api/valider": ["POST"],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    void (async () => {
      try {
        if (!hoteLocal(req.headers.host)) {
          json(res, 403, {
            erreur:
              "hote non local : requete refusee (protection contre le reattachement DNS)",
          });
          return;
        }
        if (!origineAdmise(req.headers.origin)) {
          json(res, 403, { erreur: "origine etrangere : requete refusee" });
          return;
        }

        const methodes = METHODES[url.pathname];
        if (methodes !== undefined && !methodes.includes(req.method ?? "GET")) {
          json(res, 405, { erreur: `methode non admise sur ${url.pathname}` });
          return;
        }

        // La PAGE reste ouvrable sans jeton : c'est elle qui le distribue.
        // Tout le reste l'exige.
        if (url.pathname !== "/" && !jetonValide(jeton, url.searchParams.get("jeton") ?? "")) {
          json(res, 403, {
            erreur:
              "jeton de session absent ou invalide. Ouvrir le studio depuis la page servie par ce serveur.",
          });
          return;
        }

        switch (url.pathname) {
          case "/":
            const pageHtml = STUDIO_PAGE.replace("__JETON__", jeton);
            res.writeHead(200, {
              ...SECURITE,
              "content-security-policy": cspDeLaPage(pageHtml),
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(pageHtml);
            return;
          case "/apercu": {
            // L'apercu emprunte le MEME gabarit que le site, pas un gabarit
            // ressemblant : deux rendus distincts divergeraient a la premiere
            // evolution de l'un des deux, et l'editeur attesterait alors d'une
            // forme que le lecteur ne verra pas.
            //
            // Le markdown brut ne suffisait pas : il ne porte ni fiches de
            // preuve, ni tableau de chiffres, ni encart d'incertitudes, ni
            // divulgation en gras — c'est-a-dire precisement ce qu'une
            // relecture doit controler.
            const id = url.searchParams.get("id") ?? "";
            if (!/^article-[0-9a-fA-F-]{36}$/.test(id)) {
              json(res, 400, { erreur: "identifiant d'article invalide" });
              return;
            }
            const chemin = join(draftDir, `${id}.json`);
            if (!existsSync(chemin)) {
              json(res, 404, { erreur: "brouillon introuvable" });
              return;
            }
            const parsed = ArticleSchema.safeParse(
              JSON.parse(await readFile(chemin, "utf8")),
            );
            if (!parsed.success) {
              json(res, 422, {
                erreur: "brouillon non conforme au contrat §7",
                detail: parsed.error.issues.map((i) => i.message),
              });
              return;
            }
            // Le cadre d'apercu est en sandbox SANS scripts : le script de theme
            // du site ne s'y execute pas. Le studio transmet donc le choix de
            // l'editeur, et le serveur le pose sur la racine du document.
            //
            // LISTE BLANCHE, deux valeurs. Ce parametre est recopie dans le
            // HTML : une valeur libre y ouvrirait une injection d'attribut.
            // Toute autre valeur est ignoree, et le systeme decide.
            const theme = url.searchParams.get("theme");
            let html = articlePage(parsed.data);
            if (theme === "dark" || theme === "light") {
              html = html.replace(/<html lang="fr">/, `<html lang="fr" data-theme="${theme}">`);
            }
            res.writeHead(200, {
              ...SECURITE,
              "content-security-policy": cspDeLaPage(html),
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(html);
            return;
          }
          case "/api/article": {
            // Lire AVANT d'attester. Sans cela, le bouton de validation ne
            // certifierait qu'un clic.
            const id = url.searchParams.get("id") ?? "";
            if (!/^article-[0-9a-fA-F-]{36}$/.test(id)) {
              json(res, 400, { erreur: "identifiant d'article invalide" });
              return;
            }
            const chemin = join(draftDir, `${id}.md`);
            if (!existsSync(chemin)) {
              json(res, 404, { erreur: "brouillon introuvable" });
              return;
            }
            json(res, 200, { id, markdown: await readFile(chemin, "utf8") });
            return;
          }
          case "/api/valider":
            await validerDepuisStudio(req, res, draftDir, publishedDir, changelog);
            return;
          case "/api/etat":
            json(res, 200, {
              articles: await lireArticles(draftDir, publishedDir),
              fournisseurs: etatFournisseurs(),
              audit: await lireAudit(),
            });
            return;
          case "/api/publier":
            await executer(req, res, url.searchParams, publishedDir);
            return;
          case "/api/vague":
            await executerVagueSse(res, url.searchParams, publishedDir);
            return;
          case "/api/site": {
            const r = await buildSite();
            json(res, 200, {
              publies: r.published,
              pages: r.pages.length,
              rejetes: r.rejected,
              dossier: r.siteDir,
            });
            return;
          }
          default:
            json(res, 404, { erreur: "route inconnue" });
        }
      } catch (error) {
        json(res, 500, {
          erreur: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    // 127.0.0.1 et non 0.0.0.0 : ce serveur declenche des appels facturables.
    server.listen(port, "127.0.0.1", resolve);
  });

  // Port reel : `port: 0` laisse le systeme en choisir un libre, ce dont les
  // tests ont besoin pour tourner en parallele sans se disputer 5173.
  const adresse = server.address();
  const portReel =
    adresse !== null && typeof adresse === "object" ? adresse.port : port;

  return {
    url: `http://127.0.0.1:${portReel}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

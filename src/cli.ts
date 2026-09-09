/**
 * Point d'entree du pipeline.
 *
 *   npm run dev -- "politique monetaire et flux commerciaux"
 *   npm run dev -- --real-sources "inflation en zone euro"
 *   npm run dev -- --mode=live "sanctions et flux energetiques"
 *   npm run dev -- revise <article-id> --type=factuelle "Chiffre corrige : ..."
 *
 * Le mode `mock` est le defaut et le reste tant qu'aucune clef n'est presente.
 * Basculer en `live` doit etre un acte explicite : un pipeline qui appellerait
 * une API payante et publierait de vraies affirmations parce qu'une variable
 * d'environnement trainait ne serait pas un comportement acceptable.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PublicationRefused } from "./agents/editeur.js";
import { AuditLog, verifyJournal } from "./audit/audit-log.js";
import { verifyChangelog } from "./editorial/changelog.js";
import { validateArticle } from "./editorial/validation.js";
import { buildSite } from "./site/build.js";
import { serveSite } from "./site/serve.js";
import { startStudio } from "./studio/server.js";
import { ArticleNotFound, reviseArticle } from "./editorial/revision.js";
import { ADAPTIVE_RESPONDERS } from "./fixtures/adaptive-responders.js";
import { MOCK_RESPONDERS } from "./fixtures/mock-scenario.js";
import {
  ProviderUnavailable,
  describeProviders,
  resolveProvider,
  type ProviderName,
  type ResolvedProvider,
} from "./llm/providers.js";
import {
  CHANGELOG_TYPES,
  type ArticleMode,
  type ChangelogType,
} from "./protocol/constants.js";
import { EditorialPipeline, type PipelineStage } from "./pipeline.js";
import { buildSourceCatalogue } from "./sources/catalogue.js";
import { MOCK_ADAPTERS } from "./sources/mock-sources.js";
import type { SourceAdapter } from "./sources/types.js";

// Node >= 20.12 charge les .env nativement : pas besoin de dotenv.
try {
  process.loadEnvFile();
} catch {
  // Pas de .env : les variables du shell suffisent.
}

/* -------------------------------------------------------------------------
 * Analyse des arguments
 * ---------------------------------------------------------------------- */

interface PublishCommand {
  kind: "publish";
  topic: string;
  provider: ProviderName;
  realSources: boolean;
  mode: ArticleMode;
}

interface ReviseCommand {
  kind: "revise";
  articleId: string;
  type: ChangelogType;
  description: string;
}

type Command =
  | PublishCommand
  | ReviseCommand
  | { kind: "list-providers" }
  | { kind: "validate"; articleId: string; reviewer: string; note?: string }
  | { kind: "verify-journal" }
  | { kind: "build-site"; drafts: boolean }
  | { kind: "preview"; port: number; drafts: boolean }
  | { kind: "studio"; port: number }
  | { kind: "error"; message: string };

function parseArgs(argv: readonly string[]): Command {
  const positional: string[] = [];
  let provider = (process.env["MEDIA_PROVIDER"] ?? "mock") as ProviderName;
  let realSources = false;
  let mode: ArticleMode = "constat";
  let type: string | undefined;
  let relecteur: string | undefined;
  let drafts = false;

  for (const arg of argv) {
    if (arg.startsWith("--relecteur=")) {
      relecteur = arg.slice("--relecteur=".length).replace(/^["']|["']$/g, "");
      continue;
    }
    if (arg === "--brouillons") {
      drafts = true;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length) as ProviderName;
    }
    // `--mode=live` conserve pour compatibilite : equivaut a --provider=anthropic.
    else if (arg === "--mode=live") provider = "anthropic";
    else if (arg === "--mode=mock") provider = "mock";
    else if (arg === "--real-sources") realSources = true;
    else if (arg === "--prospectif") mode = "prospectif";
    else if (arg === "--providers") return { kind: "list-providers" };
    else if (arg.startsWith("--type=")) type = arg.slice("--type=".length);
    else positional.push(arg);
  }

  if (positional[0] === "valider") {
    const articleId = positional[1];
    const note = positional.slice(2).join(" ").trim();
    if (articleId === undefined) {
      return {
        kind: "error",
        message: 'Usage : valider <article-id> --relecteur="Nom" ["observation"]',
      };
    }
    if (relecteur === undefined || relecteur.trim().length === 0) {
      return {
        kind: "error",
        message:
          "--relecteur est obligatoire : une relecture anonyme n'engage personne.\n" +
          '  npm run dev -- valider <article-id> --relecteur="Ton Nom"',
      };
    }
    return {
      kind: "validate",
      articleId,
      reviewer: relecteur,
      ...(note.length > 0 ? { note } : {}),
    };
  }

  if (positional[0] === "journal") return { kind: "verify-journal" };
  if (positional[0] === "site") return { kind: "build-site", drafts };
  if (positional[0] === "preview") {
    const port = Number(positional[1]);
    return {
      kind: "preview",
      port: Number.isFinite(port) && port > 0 ? port : 4321,
      drafts,
    };
  }
  if (positional[0] === "studio") {
    const port = Number(positional[1]);
    return { kind: "studio", port: Number.isFinite(port) && port > 0 ? port : 5173 };
  }

  if (positional[0] === "revise") {
    const articleId = positional[1];
    const description = positional.slice(2).join(" ").trim();

    if (articleId === undefined) {
      return { kind: "error", message: "Usage : revise <article-id> --type=<type> \"description\"" };
    }
    if (type === undefined || !isChangelogType(type)) {
      return {
        kind: "error",
        message: `--type est obligatoire et doit valoir : ${CHANGELOG_TYPES.join(" | ")} (§6).`,
      };
    }
    if (description.length === 0) {
      return {
        kind: "error",
        message:
          "Une description est obligatoire : elle est publiee telle quelle dans le changelog public (§6).",
      };
    }
    return { kind: "revise", articleId, type, description };
  }

  return {
    kind: "publish",
    topic: positional.join(" ").trim() || "politique monetaire et flux commerciaux",
    provider,
    realSources,
    mode,
  };
}

function isChangelogType(value: string): value is ChangelogType {
  return (CHANGELOG_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
 * Commandes
 * ---------------------------------------------------------------------- */

async function publish(command: PublishCommand): Promise<void> {
  const audit = new AuditLog();

  // Deux jeux de reponses simulees, pour deux usages distincts :
  //  - scripte (Zembla) : pose des pieges precis pour exercer le gate ;
  //  - adaptatif : derive ses sorties des donnees reellement collectees.
  // Utiliser le scenario Zembla sur de vraies sources produirait des claims
  // fictives citant des donnees reelles — ce que le protocole interdit.
  const responders = command.realSources ? ADAPTIVE_RESPONDERS : MOCK_RESPONDERS;

  let resolved: ResolvedProvider;
  try {
    resolved = resolveProvider({
      provider: command.provider,
      audit,
      responders,
    });
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      console.error(error.message);
      console.error("");
      console.error(describeProviders());
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const llm = resolved.client;

  let adapters: readonly SourceAdapter[];
  if (command.realSources) {
    const catalogue = buildSourceCatalogue();
    adapters = catalogue.adapters;
    // §EP-003 — une source absente se declare. La taire laisserait croire a une
    // couverture complete.
    if (catalogue.skipped.length > 0) {
      console.log("Sources non branchees :");
      for (const s of catalogue.skipped) {
        console.log(`  - ${s.id} : ${s.reason}`);
      }
      console.log("");
    }
  } else {
    adapters = MOCK_ADAPTERS;
  }

  console.log(`Sujet   : ${command.topic}`);
  console.log(`Modele  : ${llm.modelId}`);
  console.log(`Sources : ${command.realSources ? "reelles" : "simulees"}`);
  console.log(`Mode    : ${command.mode}`);
  if (resolved.notices.length > 0) {
    console.log("");
    for (const notice of resolved.notices) console.log(`! ${notice}`);
  }
  console.log("");

  const pipeline = new EditorialPipeline({
    ctx: { llm, audit },
    adapters,
    mode: command.mode,
    onStage: (stage: PipelineStage, detail: string) =>
      console.log(`  [${stage.padEnd(13)}] ${detail}`),
  });

  const result = await pipeline.run(command.topic);
  console.log("");

  if (result.status === "halted") {
    console.log(`ARRET du pipeline a l'etape "${result.stage}".`);
    console.log(`Motif : ${result.reason}`);
    for (const detail of result.details) console.log(`  - ${detail}`);
    console.log("");
    console.log(
      "Un arret n'est pas une panne : c'est le gate du §9.3 qui fait son travail.",
    );
    // Le protocole prefere ne rien publier a publier une claim non soutenue :
    // on sort en 0, le pipeline s'est comporte comme prevu.
    return;
  }

  console.log("PUBLIE");
  console.log(`  ${result.markdownPath}`);
  console.log(`  ${result.jsonPath}`);
  console.log("");
  console.log(`Pour corriger cet article plus tard (§6) :`);
  console.log(
    `  npm run dev -- revise ${result.article.id} --type=factuelle "ce qui change"`,
  );

  if (result.adjustments.length > 0) {
    console.log("");
    console.log("Ajustements appliques par le gate :");
    for (const a of result.adjustments) console.log(`  - ${a}`);
  }
  if (result.warnings.length > 0) {
    console.log("");
    console.log("Avertissements (non bloquants) :");
    for (const w of result.warnings) {
      console.log(`  - [${w.clause} ${w.rule}] ${w.message}`);
    }
  }

  console.log("");
  console.log(
    `Journal d'audit : ${audit.entries().length} appel(s) externe(s) enregistre(s).`,
  );
}

async function revise(command: ReviseCommand): Promise<void> {
  const result = await reviseArticle({
    articleId: command.articleId,
    type: command.type,
    description: command.description,
  });

  console.log("ARTICLE REVISE");
  console.log(`  Titre         : ${result.article.title}`);
  console.log(`  Publie le     : ${result.article.published_at}  (inchange)`);
  console.log(`  Revise le     : ${result.article.revised_at}`);
  console.log(`  Corrections   : ${result.revisionCount}`);
  console.log(`  ${result.markdownPath}`);
  console.log("");
  console.log("L'entree est consignee dans changelog-editorial.md (§6, append-only).");
}

async function validateCommand(command: {
  articleId: string;
  reviewer: string;
  note?: string;
}): Promise<void> {
  const r = await validateArticle({
    articleId: command.articleId,
    reviewer: command.reviewer,
    ...(command.note === undefined ? {} : { note: command.note }),
  });

  console.log("ARTICLE VALIDE ET PUBLIE");
  console.log(`  Titre     : ${r.article.title}`);
  console.log(`  Relecteur : ${r.review.reviewer}`);
  console.log(`  Relu le   : ${r.review.reviewed_at}`);
  console.log(`  Empreinte : ${r.review.content_sha256.slice(0, 16)}…`);
  console.log(`  ${r.articlePath}`);

  if (r.warnings.length > 0) {
    console.log("");
    console.log("Avertissements acceptes en validant :");
    for (const w of r.warnings) {
      console.log(`  - [${w.clause} ${w.rule}] ${w.message}`);
    }
  }

  console.log("");
  console.log("Prochaine etape : `npm run site`, puis commiter articles/.");
  console.log("Toute modification ulterieure de l'article invalidera la relecture.");
}

async function buildSiteCommand(drafts: boolean): Promise<void> {
  const r = drafts
    ? await buildSite({
        outputDir: join(process.cwd(), "output"),
        requireReview: false,
      })
    : await buildSite();

  if (drafts) {
    console.log("! APERCU DE BROUILLONS — articles NON relus, ne pas deployer.\n");
  }
  console.log(`SITE GENERE — ${r.published} article(s), ${r.pages.length} page(s)`);
  console.log(`  ${r.siteDir}`);

  // Un fichier ecarte ne doit pas disparaitre en silence : c'est le signe
  // d'un article modifie a la main ou produit par une version anterieure.
  if (r.rejected.length > 0) {
    console.log("");
    console.log("Fichiers ecartes :");
    for (const rej of r.rejected) console.log(`  - ${rej.file} : ${rej.reason}`);
    // Sortie en echec : un article versionne mais non publiable est un
    // probleme a traiter, pas une information a faire defiler. C'est ce qui
    // permet a la CI d'arreter un article modifie apres relecture.
    process.exitCode = 1;
  }
  if (r.published === 0 && !drafts) {
    console.log("");
    console.log("Aucun article relu. Valider un brouillon :");
    console.log('  npm run dev -- valider <article-id> --relecteur="Ton Nom"');
  }
  console.log("");
  console.log("Ouvrir : " + join(r.siteDir, "index.html"));
}

async function previewCommand(port: number, drafts: boolean): Promise<void> {
  // Toujours regenerer avant de servir : relire une version obsolete du site
  // serait pire que ne pas le relire.
  const build = drafts
    ? await buildSite({
        outputDir: join(process.cwd(), "output"),
        requireReview: false,
      })
    : await buildSite();

  const serveur = await serveSite({ root: build.siteDir, port });

  console.log(`SITE EN LIGNE — ${serveur.url}`);
  console.log("");
  console.log(`  ${build.published} article(s) publie(s), ${build.pages.length} page(s)`);
  if (drafts) {
    console.log("  ! APERCU DE BROUILLONS — articles NON relus.");
  }
  for (const rej of build.rejected) {
    console.log(`  ! ecarte : ${rej.file} — ${rej.reason}`);
  }
  console.log("");
  console.log("  Pages    : /  /protocole.html  /changelog.html");
  console.log("  Machines : /feed.xml  /sitemap.xml  /robots.txt");
  console.log("");
  console.log("Ecoute sur la boucle locale uniquement. Ctrl+C pour arreter.");
  console.log("");
  // Question posee, donc reponse ecrite : sinon elle se repose a chaque fois.
  console.log("En http, et c'est voulu : les navigateurs traitent 127.0.0.1");
  console.log("comme un contexte SUR — le trafic ne quitte pas la machine. Un");
  console.log("certificat auto-signe n'ajouterait rien et entrainerait a cliquer");
  console.log("sur les avertissements. Le site PUBLIE, lui, est en https (voir");
  console.log("MEDIA_SITE_URL, qui refuse desormais toute autre valeur).");
}

/**
 * §9.4 — verifie la chaine d'empreintes du journal d'audit.
 *
 * Sans cette commande, le chainage existerait sans que personne puisse
 * l'invoquer : une garantie qu'on ne peut pas constater n'en est pas une.
 * Sortie en echec si la chaine est rompue, pour qu'une CI puisse s'en servir.
 */
async function verifyJournalCommand(): Promise<void> {
  const chemin = join(process.cwd(), "audit", "journal.jsonl");
  if (!existsSync(chemin)) {
    console.log("Aucun journal d'audit a verifier.");
    return;
  }

  const lignes = (await readFile(chemin, "utf8"))
    .split("\n")
    .filter((l: string) => l.trim().length > 0);
  const r = verifyJournal(lignes);

  console.log("VERIFICATION D'INTEGRITE");
  console.log("");
  console.log(`JOURNAL D'AUDIT — ${lignes.length} entree(s)`);
  console.log(`  ${r.checked} chainee(s) et verifiee(s)`);
  if (r.legacy > 0) {
    console.log(
      `  ${r.legacy} anterieure(s) au chainage : non verifiables, pas suspectes`,
    );
  }
  console.log("");

  if (r.ok) {
    console.log("  chaine INTACTE");
  } else {
    console.error(`  CHAINE ROMPUE a l'entree ${r.brokenAt} — ${r.reason}`);
    process.exitCode = 1;
  }

  /* --- Archives brutes : l'adressage par contenu, verifie ---------------- */
  // Sans ce controle, `raw/<sha256>.json` n'est qu'une convention de nommage.
  // C'est ici qu'on constate qu'une reponse archivee n'a pas ete retouchee
  // apres coup pour correspondre a ce qu'un article affirme.
  console.log("");
  console.log("ARCHIVES BRUTES");
  let verifiees = 0;
  let manquantes = 0;
  let alterees = 0;
  const vues = new Set<string>();

  for (const ligne of lignes) {
    let e: { raw_path?: string; raw_sha256?: string };
    try {
      e = JSON.parse(ligne) as typeof e;
    } catch {
      continue;
    }
    if (typeof e.raw_path !== "string" || typeof e.raw_sha256 !== "string") continue;
    if (vues.has(e.raw_path)) continue;
    vues.add(e.raw_path);

    const fichier = join(process.cwd(), "audit", e.raw_path);
    if (!existsSync(fichier)) {
      manquantes += 1;
      continue;
    }
    const reel = createHash("sha256")
      .update(await readFile(fichier, "utf8"))
      .digest("hex");
    if (reel === e.raw_sha256) verifiees += 1;
    else {
      alterees += 1;
      console.error(`  ALTEREE : ${e.raw_path}`);
    }
  }

  console.log(`  ${verifiees} archive(s) verifiee(s)`);
  if (manquantes > 0) {
    // `audit/raw/` est hors versionnement : sur un depot fraichement clone,
    // toutes les archives manquent, et ce n'est pas une anomalie.
    console.log(`  ${manquantes} absente(s) — normal hors de la machine qui a collecte`);
  }
  if (alterees > 0) {
    console.error(`  ${alterees} ALTEREE(S) : le contenu ne correspond plus a son empreinte`);
    process.exitCode = 1;
  }

  /* --- Changelog editorial (§9.6) --------------------------------------- */
  console.log("");
  console.log("CHANGELOG EDITORIAL");
  const cheminChangelog = join(process.cwd(), "changelog-editorial.md");
  if (!existsSync(cheminChangelog)) {
    console.log("  aucun registre a verifier");
  } else {
    const c = verifyChangelog(await readFile(cheminChangelog, "utf8"));
    console.log(`  ${c.checked} entree(s) chainee(s)`);
    if (c.ok) console.log("  chaine INTACTE");
    else {
      console.error(`  CHAINE ROMPUE a l'entree ${c.brokenAt} — ${c.reason}`);
      process.exitCode = 1;
    }
  }

  console.log("");
  console.log("PORTEE DE CES GARANTIES — a lire avant de s'y fier.");
  console.log("Sont detectes : la modification, la suppression, l'insertion et le");
  console.log("reordonnancement d'une entree, ainsi que l'alteration d'une archive.");
  console.log("Ne le sont PAS : une reecriture complete avec recalcul de la chaine,");
  console.log("ni une troncature finale. Il y faudrait une ancre externe — un commit");
  console.log("signe, ou l'empreinte publiee ailleurs.");
}

async function studioCommand(port: number): Promise<void> {
  const studio = await startStudio({ port });
  console.log(`STUDIO — interface de pilotage sur ${studio.url}`);
  console.log("");
  console.log("Ecoute sur la boucle locale uniquement : ce serveur declenche le");
  console.log("pipeline, donc des appels potentiellement factures.");
  console.log("");
  console.log("Ctrl+C pour arreter.");
}

/* -------------------------------------------------------------------------
 * Entree
 * ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "error":
      console.error(command.message);
      process.exitCode = 1;
      return;
    case "list-providers":
      console.log(describeProviders());
      return;
    case "validate":
      return validateCommand(command);
    case "verify-journal":
      return verifyJournalCommand();
    case "build-site":
      return buildSiteCommand(command.drafts);
    case "preview":
      return previewCommand(command.port, command.drafts);
    case "studio":
      return studioCommand(command.port);
    case "revise":
      return revise(command);
    case "publish":
      return publish(command);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArticleNotFound) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (error instanceof PublicationRefused) {
    console.error(error.message);
    for (const v of error.violations) {
      console.error(`  - [${v.clause} ${v.rule}] ${v.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

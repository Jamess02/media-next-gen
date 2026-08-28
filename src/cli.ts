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

import { PublicationRefused } from "./agents/editeur.js";
import { AuditLog } from "./audit/audit-log.js";
import { ArticleNotFound, reviseArticle } from "./editorial/revision.js";
import { ADAPTIVE_RESPONDERS } from "./fixtures/adaptive-responders.js";
import { MOCK_RESPONDERS } from "./fixtures/mock-scenario.js";
import { AnthropicLlmClient } from "./llm/anthropic-client.js";
import { MockLlmClient } from "./llm/mock-client.js";
import type { LlmClient } from "./llm/types.js";
import { CHANGELOG_TYPES, type ChangelogType } from "./protocol/constants.js";
import { EditorialPipeline, type PipelineStage } from "./pipeline.js";
import { MOCK_ADAPTERS } from "./sources/mock-sources.js";
import { worldBankAdapter } from "./sources/worldbank.js";
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
  mode: "mock" | "live";
  realSources: boolean;
}

interface ReviseCommand {
  kind: "revise";
  articleId: string;
  type: ChangelogType;
  description: string;
}

type Command = PublishCommand | ReviseCommand | { kind: "error"; message: string };

function parseArgs(argv: readonly string[]): Command {
  const positional: string[] = [];
  let mode: "mock" | "live" =
    process.env["MEDIA_MODE"] === "live" ? "live" : "mock";
  let realSources = false;
  let type: string | undefined;

  for (const arg of argv) {
    if (arg === "--mode=live") mode = "live";
    else if (arg === "--mode=mock") mode = "mock";
    else if (arg === "--real-sources") realSources = true;
    else if (arg.startsWith("--type=")) type = arg.slice("--type=".length);
    else positional.push(arg);
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
    mode,
    realSources,
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

  let llm: LlmClient;
  if (command.mode === "live") {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      console.error(
        "Mode live demande mais ANTHROPIC_API_KEY est absente.\n" +
          "Renseigner la clef dans .env, ou retirer --mode=live pour tourner en simulation.",
      );
      process.exitCode = 1;
      return;
    }
    llm = new AnthropicLlmClient({
      audit,
      ...(process.env["MEDIA_MODEL"] === undefined
        ? {}
        : { model: process.env["MEDIA_MODEL"] }),
    });
  } else {
    // Deux jeux de reponses simulees, pour deux usages distincts :
    //  - scripte (Zembla) : pose des pieges precis pour exercer le gate ;
    //  - adaptatif : derive ses sorties des donnees reellement collectees.
    // Utiliser le scenario Zembla sur de vraies sources produirait des claims
    // fictives citant des donnees reelles — exactement ce que le protocole
    // interdit.
    llm = new MockLlmClient({
      audit,
      responders: command.realSources ? ADAPTIVE_RESPONDERS : MOCK_RESPONDERS,
    });
  }

  let adapters: readonly SourceAdapter[];
  if (command.realSources) {
    // Sources reelles, sans clef d'API requise.
    adapters = [
      worldBankAdapter({ country: "EMU", indicator: "FP.CPI.TOTL.ZG" }),
      worldBankAdapter({ country: "WLD", indicator: "NY.GDP.MKTP.KD.ZG" }),
    ];
  } else {
    adapters = MOCK_ADAPTERS;
  }

  console.log(`Sujet   : ${command.topic}`);
  console.log(`Mode    : ${command.mode} (modele : ${llm.modelId})`);
  console.log(`Sources : ${command.realSources ? "reelles" : "simulees"}`);
  console.log("");

  const pipeline = new EditorialPipeline({
    ctx: { llm, audit },
    adapters,
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

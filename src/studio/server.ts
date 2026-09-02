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
import { EditorialPipeline } from "../pipeline.js";
import { ArticleSchema } from "../protocol/schema.js";
import { buildSourceCatalogue } from "../sources/catalogue.js";
import { MOCK_ADAPTERS } from "../sources/mock-sources.js";
import { buildSite } from "../site/build.js";
import { STUDIO_PAGE } from "./page.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACINE = join(HERE, "..", "..");
const OUTPUT_DIR = join(RACINE, "output");
const AUDIT_JOURNAL = join(RACINE, "audit", "journal.jsonl");

const json = (res: ServerResponse, code: number, data: unknown): void => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
};

/* -------------------------------------------------------------------------
 * Etat courant
 * ---------------------------------------------------------------------- */

async function lireArticles(): Promise<unknown[]> {
  if (!existsSync(OUTPUT_DIR)) return [];
  const fichiers = (await readdir(OUTPUT_DIR)).filter((f) => f.endsWith(".json"));
  const articles: unknown[] = [];

  for (const f of fichiers) {
    const parsed = ArticleSchema.safeParse(
      JSON.parse(await readFile(join(OUTPUT_DIR, f), "utf8")),
    );
    if (!parsed.success) continue;
    const a = parsed.data;
    articles.push({
      id: a.id,
      titre: a.title,
      publie: a.published_at,
      revise: a.revised_at,
      claims: a.claims.map((c) => ({
        id: c.id,
        type: c.type,
        niveau: c.evidence_level,
        sources: c.sources.length,
      })),
      incertitudes: a.editorial_notes.uncertainty_flags.length,
      ecartees: a.editorial_notes.excluded_claims.length,
    });
  }
  articles.sort((x, y) =>
    String((y as { publie: string }).publie).localeCompare(
      String((x as { publie: string }).publie),
    ),
  );
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
): Promise<void> {
  res.writeHead(200, {
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

export interface StudioOptions {
  port?: number;
}

export async function startStudio(options: StudioOptions = {}): Promise<string> {
  const port = options.port ?? 5173;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    void (async () => {
      try {
        switch (url.pathname) {
          case "/":
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(STUDIO_PAGE);
            return;
          case "/api/etat":
            json(res, 200, {
              articles: await lireArticles(),
              fournisseurs: etatFournisseurs(),
              audit: await lireAudit(),
            });
            return;
          case "/api/publier":
            await executer(req, res, url.searchParams);
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

  return `http://127.0.0.1:${port}`;
}

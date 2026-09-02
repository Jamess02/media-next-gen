/**
 * Generation du site statique.
 *
 * Dependances : les gabarits locaux, le schema du §7 pour valider ce qu'on
 * publie, et `node:fs`. Aucune dependance npm — pas de generateur de site,
 * pas de moteur de templates.
 *
 * ENTREE : les fichiers `output/*.json`, c'est-a-dire le contrat §7.
 * SORTIE : `public/`, du HTML statique deployable tel quel.
 *
 * Un article dont le JSON ne valide plus contre le schema n'est PAS publie.
 * C'est une derniere barriere, apres celle de l'Editeur : un fichier modifie a
 * la main, ou produit par une version anterieure du pipeline, ne doit pas
 * atteindre le site sous pretexte qu'il existe sur le disque.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ArticleSchema, type Article } from "../protocol/schema.js";
import { documentPage, articlePage, indexPage } from "./templates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACINE = join(HERE, "..", "..");

export interface BuildOptions {
  outputDir?: string;
  siteDir?: string;
  protocolPath?: string;
  changelogPath?: string;
}

export interface BuildResult {
  siteDir: string;
  published: number;
  /** Fichiers ecartes, avec le motif. Un silence serait pire qu'une erreur. */
  rejected: Array<{ file: string; reason: string }>;
  pages: string[];
}

export async function buildSite(
  options: BuildOptions = {},
): Promise<BuildResult> {
  const outputDir = options.outputDir ?? join(RACINE, "output");
  const siteDir = options.siteDir ?? join(RACINE, "public");
  const protocolPath =
    options.protocolPath ?? join(RACINE, "protocole-editorial-v1.md");
  const changelogPath =
    options.changelogPath ?? join(RACINE, "changelog-editorial.md");

  const rejected: BuildResult["rejected"] = [];
  const articles: Article[] = [];

  if (existsSync(outputDir)) {
    const files = (await readdir(outputDir)).filter((f) => f.endsWith(".json"));
    for (const file of files.sort()) {
      const raw = await readFile(join(outputDir, file), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejected.push({ file, reason: "JSON illisible" });
        continue;
      }
      const check = ArticleSchema.safeParse(parsed);
      if (!check.success) {
        rejected.push({
          file,
          reason: `non conforme au §7 — ${check.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(" ; ")}`,
        });
        continue;
      }
      articles.push(check.data);
    }
  }

  // Le plus recent d'abord : un media date se lit dans cet ordre.
  articles.sort(
    (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
  );

  // Regeneration complete : un article retire de `output/` doit disparaitre du
  // site. Une generation incrementale laisserait des pages orphelines.
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(join(siteDir, "articles"), { recursive: true });

  const pages: string[] = [];
  const ecrire = async (relatif: string, html: string): Promise<void> => {
    await writeFile(join(siteDir, relatif), html, "utf8");
    pages.push(relatif);
  };

  await ecrire("index.html", indexPage(articles));

  for (const article of articles) {
    await ecrire(`articles/${article.id}.html`, articlePage(article));
  }

  await ecrire(
    "protocole.html",
    documentPage(
      "Protocole editorial",
      await readFile(protocolPath, "utf8"),
      "protocole",
    ),
  );

  await ecrire(
    "changelog.html",
    documentPage(
      "Changelog editorial",
      existsSync(changelogPath)
        ? await readFile(changelogPath, "utf8")
        : "# Changelog editorial\n\nAucune correction consignee.",
      "changelog",
    ),
  );

  // Empeche GitHub Pages de traiter la sortie avec Jekyll, qui ignorerait les
  // dossiers commencant par un underscore et reecrirait certaines pages.
  await writeFile(join(siteDir, ".nojekyll"), "", "utf8");

  return { siteDir, published: articles.length, rejected, pages };
}

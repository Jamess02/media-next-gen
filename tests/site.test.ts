/**
 * Site statique.
 *
 * Le site est le point ou du texte controle par des tiers devient du HTML
 * execute par le navigateur d'un lecteur. Les tests d'injection de ce fichier
 * sont donc les plus importants du projet cote publication : s'ils tombent,
 * une source hostile peut executer du code chez les lecteurs.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSite } from "../src/site/build.js";
import { escapeHtml, renderMarkdown } from "../src/site/markdown.js";
import { articlePage, indexPage } from "../src/site/templates.js";
import type { Article } from "../src/protocol/schema.js";
import { article, claim } from "./helpers.js";

/* -------------------------------------------------------------------------
 * Rendu markdown
 * ---------------------------------------------------------------------- */

describe("rendu markdown — securite", () => {
  it("neutralise le HTML brut", () => {
    const html = renderMarkdown("Texte <script>vol()</script> fin.");
    expect(html).not.toMatch(/<script>/);
    expect(html).toMatch(/&lt;script&gt;/);
  });

  it("neutralise une image a gestionnaire d'evenement", () => {
    const html = renderMarkdown('<img src=x onerror="vol()">');
    // La chaine "onerror=" PEUT figurer dans la sortie sans danger : le `<`
    // etant echappe, le navigateur affiche du texte, il n'ouvre aucune balise.
    // Ce qui compte est qu'aucune balise ne soit ouverte.
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img/);
  });

  it("italise apres une apostrophe francaise", () => {
    // `de l'*italique*` : la frontiere d'italique doit inclure l'apostrophe,
    // pas seulement l'espace.
    expect(renderMarkdown("de l'*italique* ici")).toMatch(/<em>italique<\/em>/);
    expect(renderMarkdown("« *cite* »")).toMatch(/<em>cite<\/em>/);
  });

  it("n'italise pas un underscore au milieu d'un mot", () => {
    // Les noms de champs du §7 sont cites en clair dans les articles.
    const html = renderMarkdown("Le champ evidence_level vaut 3.");
    expect(html).not.toMatch(/<em>/);
    expect(html).toMatch(/evidence_level/);
  });

  it("refuse un lien javascript:", () => {
    const html = renderMarkdown("Voir [ici](javascript:vol())");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("refuse un lien data:", () => {
    const html = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toMatch(/href="data:/);
  });

  it("accepte un lien http(s) et le marque noopener", () => {
    const html = renderMarkdown("[FRED](https://fred.stlouisfed.org/series/X)");
    expect(html).toMatch(/href="https:\/\/fred\.stlouisfed\.org\/series\/X"/);
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
  });

  it("echappe avant d'interpreter, donc aucun HTML source ne survit", () => {
    // Le point cle : l'echappement precede toute mise en forme. Il n'existe
    // aucun chemin par lequel du HTML source atteint la sortie.
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("rendu markdown — mise en forme", () => {
  it("rend titres, paragraphes et listes", () => {
    const html = renderMarkdown("# Titre\n\nTexte.\n\n- un\n- deux");
    expect(html).toMatch(/<h1>Titre<\/h1>/);
    expect(html).toMatch(/<p>Texte\.<\/p>/);
    expect(html).toMatch(/<ul><li>un<\/li><li>deux<\/li><\/ul>/);
  });

  it("rend gras, italique et code", () => {
    const html = renderMarkdown("Du **gras**, de l'*italique* et du `code`.");
    expect(html).toMatch(/<strong>gras<\/strong>/);
    expect(html).toMatch(/<em>italique<\/em>/);
    expect(html).toMatch(/<code>code<\/code>/);
  });

  it("n'applique aucune regle a l'interieur du code inline", () => {
    const html = renderMarkdown("Voir `**pas du gras**` ici.");
    expect(html).toMatch(/<code>\*\*pas du gras\*\*<\/code>/);
  });

  it("rend citations et regles horizontales", () => {
    const html = renderMarkdown("> cite\n\n---");
    expect(html).toMatch(/<blockquote>cite<\/blockquote>/);
    expect(html).toMatch(/<hr>/);
  });

  it("transforme une reference de claim en lien vers sa preuve", () => {
    const html = renderMarkdown("Affirmation [[claim-1]].", {
      claimAnchor: (id) => `#${id}`,
    });
    expect(html).toMatch(/<a class="ref" href="#claim-1"/);
  });

  it("laisse une reference inconnue en texte litteral", () => {
    // Un lien mort serait pire qu'un texte brut : le lecteur cliquerait dans
    // le vide en croyant acceder a une preuve.
    const html = renderMarkdown("Voir [[claim-fantome]].", {
      claimAnchor: () => undefined,
    });
    expect(html).not.toMatch(/<a class="ref"/);
    expect(html).toMatch(/\[\[claim-fantome\]\]/);
  });
});

/* -------------------------------------------------------------------------
 * Gabarits
 * ---------------------------------------------------------------------- */

describe("page d'article", () => {
  it("affiche type, niveau de preuve et tier", () => {
    const html = articlePage(article());
    expect(html).toMatch(/preuve 3\/4/);
    expect(html).toMatch(/badge type"[^>]*>fait/);
    expect(html).toMatch(/tier 1/);
  });

  it("ancre chaque claim pour que la reference soit cliquable", () => {
    const html = articlePage(article());
    expect(html).toMatch(/<section class="claim" id="claim-1">/);
    expect(html).toMatch(/href="#claim-1"/);
  });

  it("resiste a une charge hostile dans tous les champs", () => {
    const html = articlePage(
      article({
        title: "Titre <script>alert(1)</script>",
        claims: [claim({ text: '<img src=x onerror="vol()">' })],
        editorial_notes: {
          uncertainty_flags: ["<iframe src=evil></iframe>"],
          excluded_claims: ["<svg onload=alert(1)>"],
        },
        body: "Corps <script>vol()</script> [[claim-1]].",
      }),
    );

    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<iframe/);
    expect(html).not.toMatch(/<svg onload/);
    // Neutralise, mais toujours visible : on ne censure pas le lecteur.
    expect(html).toMatch(/&lt;iframe/);
  });

  it("signale une revision dans la dateline", () => {
    const html = articlePage(
      article({
        revised_at: "2026-09-01T10:00:00Z",
        changelog: [
          { date: "2026-09-01T10:00:00Z", type: "factuelle", description: "corrige" },
        ],
      }),
    );
    expect(html).toMatch(/class="revise"/);
    expect(html).toMatch(/historique des corrections/);
  });
});

describe("index", () => {
  it("numerote les entrees et affiche le niveau le plus faible", () => {
    const html = indexPage([
      article({ claims: [claim({ evidence_level: 3 }), claim({ id: "claim-2", evidence_level: 2 })] }),
    ]);
    expect(html).toMatch(/<span class="numero">01<\/span>/);
    // Le minimum, pas la moyenne : c'est la claim la plus faible qui
    // determine ce que vaut l'article.
    expect(html).toMatch(/preuve 2\/4/);
  });

  it("affiche un etat vide explicite", () => {
    expect(indexPage([])).toMatch(/Aucun article publie/);
  });
});

/* -------------------------------------------------------------------------
 * Generation complete
 * ---------------------------------------------------------------------- */

describe("generation du site", () => {
  let workDir: string;
  let outputDir: string;
  let siteDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "site-"));
    outputDir = join(workDir, "output");
    siteDir = join(workDir, "public");
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(workDir, "protocole.md"),
      "# Protocole\n\nContenu.",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const build = () =>
    buildSite({
      outputDir,
      siteDir,
      protocolPath: join(workDir, "protocole.md"),
      changelogPath: join(workDir, "changelog.md"),
    });

  const seed = async (a: Article) =>
    writeFile(join(outputDir, `${a.id}.json`), JSON.stringify(a), "utf8");

  it("genere index, article, protocole et changelog", async () => {
    await seed(article());
    const r = await build();

    expect(r.published).toBe(1);
    expect(r.pages).toContain("index.html");
    expect(r.pages).toContain("protocole.html");
    expect(r.pages).toContain("changelog.html");
    expect(r.pages.some((p) => p.startsWith("articles/"))).toBe(true);
  });

  it("ECARTE un article non conforme au §7, et le dit", async () => {
    // Derniere barriere : un fichier modifie a la main ou produit par une
    // version anterieure du pipeline ne doit pas atteindre le site.
    await seed(article());
    await writeFile(
      join(outputDir, "article-corrompu.json"),
      JSON.stringify({ id: "x", title: "sans le reste" }),
      "utf8",
    );

    const r = await build();
    expect(r.published).toBe(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/non conforme au §7/);
  });

  it("ecarte un JSON illisible", async () => {
    await writeFile(join(outputDir, "casse.json"), "{ pas du json", "utf8");
    const r = await build();
    expect(r.rejected[0]?.reason).toMatch(/illisible/);
  });

  it("regenere entierement : un article retire disparait du site", async () => {
    const a = article();
    await seed(a);
    await build();

    await rm(join(outputDir, `${a.id}.json`));
    const r = await build();

    expect(r.published).toBe(0);
    expect(r.pages.some((p) => p.includes(a.id))).toBe(false);
  });

  it("trie du plus recent au plus ancien", async () => {
    await seed(
      article({
        id: "article-00000000-0000-4000-8000-000000000001",
        title: "ancien",
        published_at: "2026-01-01T10:00:00Z",
      }),
    );
    await seed(
      article({
        id: "article-00000000-0000-4000-8000-000000000002",
        title: "recent",
        published_at: "2026-08-01T10:00:00Z",
      }),
    );

    await build();
    const index = await readFile(join(siteDir, "index.html"), "utf8");
    expect(index.indexOf("recent")).toBeLessThan(index.indexOf("ancien"));
  });

  it("depose .nojekyll pour GitHub Pages", async () => {
    const r = await build();
    expect(r.pages.length).toBeGreaterThan(0);
    await expect(readFile(join(siteDir, ".nojekyll"), "utf8")).resolves.toBe("");
  });
});

/**
 * §5.4 — Publication (volet Editeur).
 *
 * "L'Editeur formate pour le site, verifie les metadonnees (date, sources
 * citees, niveau de preuve affiche), publie."
 *
 * CHOIX ASSUME : l'Editeur n'est PAS un agent LLM.
 *
 * Tout ce que le §5.4 lui demande est deterministe : appliquer un gabarit,
 * verifier des champs, ecrire des fichiers. Lui donner un modele introduirait
 * de la variabilite dans la seule etape qui doit etre parfaitement
 * reproductible — et la reproductibilite est ici une exigence editoriale
 * (§2 niveau 4), pas une preference technique.
 *
 * Corollaire : l'affichage du niveau de preuve n'est pas optionnel. Le gabarit
 * rend obligatoirement, pour chaque claim, son type, son niveau et ses sources
 * datees. Le lecteur voit ce sur quoi repose ce qu'il lit — c'est la promesse
 * du §0.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_LEVEL_LABELS,
  SOURCE_TIER_LABELS,
} from "../protocol/constants.js";
import { ArticleSchema, type Article, type Claim } from "../protocol/schema.js";
import { runEditorialGate, type Violation } from "../protocol/rules.js";
import { EditorialChangelog } from "../editorial/changelog.js";
import {
  escapeLinkTarget,
  escapeSourceText,
  neutralizeAuthoredMarkdown,
} from "../editorial/markdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = join(HERE, "..", "..", "output");

export class PublicationRefused extends Error {
  constructor(readonly violations: readonly Violation[]) {
    super(
      `Publication refusee : ${violations.filter((v) => v.severity === "blocking").length} violation(s) bloquante(s).`,
    );
    this.name = "PublicationRefused";
  }
}

export interface PublicationResult {
  article: Article;
  jsonPath: string;
  markdownPath: string;
  warnings: readonly Violation[];
}

export class Editeur {
  constructor(
    private readonly outputDir: string = DEFAULT_OUTPUT_DIR,
    private readonly changelog: EditorialChangelog = new EditorialChangelog(),
  ) {}

  /**
   * Derniere barriere avant le site. Revalide TOUT, meme ce que les etapes
   * amont ont deja verifie : c'est une redondance voulue, pas un oubli. Une
   * regression dans le pipeline ne doit pas atteindre le lecteur.
   */
  async publish(candidate: unknown): Promise<PublicationResult> {
    const parsed = ArticleSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new PublicationRefused(
        parsed.error.issues.map((issue) => ({
          rule: "SCHEMA_INVALID",
          clause: "§7",
          severity: "blocking" as const,
          message: issue.message,
          path: issue.path.join("."),
        })),
      );
    }

    const article = parsed.data;
    const gate = runEditorialGate(article);
    if (!gate.passed) throw new PublicationRefused(gate.violations);

    await mkdir(this.outputDir, { recursive: true });
    const jsonPath = join(this.outputDir, `${article.id}.json`);
    const markdownPath = join(this.outputDir, `${article.id}.md`);

    // Le JSON est publie a cote du markdown : le §7 est un contrat entre
    // agents, mais c'est aussi ce qui rend l'article contestable par un tiers.
    await writeFile(jsonPath, JSON.stringify(article, null, 2), "utf8");
    await writeFile(markdownPath, renderArticle(article), "utf8");

    // PAS d'entree au changelog public ici. L'Editeur produit un BROUILLON
    // dans `output/` ; la publication au sens du §6 est l'instant ou un humain
    // relit et engage sa responsabilite (voir editorial/validation.ts).
    // Consigner chaque passage du pipeline remplirait le registre editorial
    // public de textes que personne n'a lus.

    return {
      article,
      jsonPath,
      markdownPath,
      warnings: gate.violations.filter((v) => v.severity === "warning"),
    };
  }
}

/* -------------------------------------------------------------------------
 * Gabarit de rendu
 * ---------------------------------------------------------------------- */

/** §2 / EP-002 — le niveau de preuve est affiche, jamais implicite. */
function renderClaim(claim: Claim, index: number): string {
  // Le schema garantit deja un schema http(s) (protocol/url.ts). L'encodage
  // ici empeche seulement de casser la syntaxe du lien.
  const sources = claim.sources
    .map(
      (s) =>
        `  - [${escapeSourceText(s.url)}](${escapeLinkTarget(s.url)}) — ` +
        `tier ${s.tier} (${SOURCE_TIER_LABELS[s.tier]}) · ` +
        `observe le ${s.date_observed}` +
        (s.date_published === null
          ? " · date de publication inconnue"
          : ` · publie le ${s.date_published}`),
    )
    .join("\n");

  return [
    `### Claim ${index + 1} — \`${escapeSourceText(claim.id)}\``,
    "",
    // Texte issu d'une source externe : aucune mise en forme n'y est legitime.
    `> ${escapeSourceText(claim.text)}`,
    "",
    `- **Type** : \`${claim.type}\``,
    `- **Niveau de preuve** : ${claim.evidence_level} — ${EVIDENCE_LEVEL_LABELS[claim.evidence_level]}`,
    `- **Sources** :`,
    sources || "  - _aucune_",
  ].join("\n");
}

export function renderArticle(article: Article): string {
  const parts: string[] = [
    `# ${escapeSourceText(article.title)}`,
    "",
    `*Publie le ${article.published_at}` +
      (article.revised_at === null
        ? ""
        : ` · **revise le ${article.revised_at}**`) +
      `*`,
    "",
    `*Produit par : ${article.authors_agents.join(", ")}*`,
    "",
  ];

  // EP-003 — l'incertitude est affichee AVANT le corps, pas reléguée en note.
  if (article.editorial_notes.uncertainty_flags.length > 0) {
    parts.push(
      "> **Incertitudes declarees**",
      ...article.editorial_notes.uncertainty_flags.map(
        (f) => `> - ${escapeSourceText(f)}`,
      ),
      "",
    );
  }

  // Le corps est redige par le Redacteur : sa mise en forme est legitime, on
  // n'y retire donc que le HTML brut et les cibles de lien non autorisees.
  parts.push(
    "---",
    "",
    neutralizeAuthoredMarkdown(article.body),
    "",
    "---",
    "",
    "## Preuves",
    "",
  );
  parts.push(article.claims.map(renderClaim).join("\n\n"));

  if (article.editorial_notes.excluded_claims.length > 0) {
    parts.push(
      "",
      "## Affirmations ecartees",
      "",
      "Ces affirmations ont ete envisagees puis REJETEES par le fact-checker :",
      "elles ne figurent pas dans l'article. Elles sont listees pour que le",
      "lecteur sache ce qui n'a pas ete retenu, et pourquoi.",
      "",
      ...article.editorial_notes.excluded_claims.map(
        (c) => `- ${escapeSourceText(c)}`,
      ),
    );
  }

  if (article.changelog.length > 0) {
    parts.push(
      "",
      "## Historique des corrections",
      "",
      ...article.changelog.map(
        (c) => `- **${c.date}** · _${c.type}_ — ${escapeSourceText(c.description)}`,
      ),
    );
  }

  parts.push(
    "",
    "---",
    "",
    "*Article produit par un pipeline multi-agents sous Protocole Editorial v1.0.*",
    "*Ce document ne constitue ni un conseil d'investissement, ni une recommandation politique ou electorale (EP-007).*",
    "",
  );

  return parts.join("\n");
}

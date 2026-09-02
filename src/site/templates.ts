/**
 * Gabarits HTML du site public.
 *
 * Dependances : `markdown.ts` et `styles.ts` (locaux), plus les constantes et
 * types du protocole. Aucune dependance npm : le site est du HTML statique.
 *
 * SOURCE DES DONNEES : le JSON du §7, pas le markdown publie. Claims, niveaux
 * de preuve, tiers et dates sont des donnees TYPEES — les afficher depuis le
 * contrat plutot que depuis un texte reanalyse supprime toute possibilite de
 * divergence entre ce que l'article affirme et ce que le pipeline a valide.
 * Seul le corps redige passe par le rendu markdown.
 */

import {
  EVIDENCE_LEVEL_LABELS,
  SOURCE_TIER_LABELS,
  type EvidenceLevel,
  type SourceTier,
} from "../protocol/constants.js";
import type { Article, Claim } from "../protocol/schema.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { STYLES } from "./styles.js";

export const SITE_NAME = "Media Next Gen";
export const SITE_TAGLINE =
  "Analyses geopolitiques et economiques produites par un pipeline multi-agents sous protocole editorial opposable.";

interface PageOptions {
  title: string;
  /** Profondeur par rapport a la racine, pour les liens relatifs. */
  depth?: number;
  active?: "articles" | "protocole" | "changelog";
  body: string;
}

export function page({ title, depth = 0, active, body }: PageOptions): string {
  const root = depth === 0 ? "." : "..";
  const nav = (
    [
      ["articles", `${root}/index.html`, "articles"],
      ["protocole", `${root}/protocole.html`, "protocole"],
      ["changelog", `${root}/changelog.html`, "corrections"],
    ] as const
  )
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${active === key ? ' class="actif"' : ""}>${label}</a>`,
    )
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(SITE_TAGLINE)}">
<style>${STYLES}</style>
</head>
<body>
<div class="enveloppe">
<header class="site">
  <a class="titre" href="${root}/index.html">${escapeHtml(SITE_NAME)}</a>
  <div class="accroche">${escapeHtml(SITE_TAGLINE)}</div>
  <nav class="site">${nav}</nav>
</header>
${body}
<footer class="site">
  Chaque affirmation est typee, sourcee, datee et rattachee a son niveau de preuve.<br>
  Produit par un pipeline multi-agents sous Protocole Editorial v1.0.<br>
  Ne constitue ni un conseil d'investissement, ni une recommandation politique ou electorale (EP-007).
</footer>
</div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------
 * Badges — §2, §3, §4 rendus lisibles d'un coup d'oeil
 * ---------------------------------------------------------------------- */

export function badgeNiveau(level: EvidenceLevel): string {
  return (
    `<span class="badge niveau-${level}" title="§2 — ${escapeHtml(EVIDENCE_LEVEL_LABELS[level])}">` +
    `preuve ${level}/4</span>`
  );
}

export function badgeType(type: Claim["type"]): string {
  return `<span class="badge type" title="§3 — typologie des claims">${escapeHtml(type)}</span>`;
}

export function badgeTier(tier: SourceTier): string {
  return (
    `<span class="badge tier-${tier}" title="§4 — ${escapeHtml(SOURCE_TIER_LABELS[tier])}">` +
    `tier ${tier}</span>`
  );
}

/* -------------------------------------------------------------------------
 * Article
 * ---------------------------------------------------------------------- */

const jour = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? escapeHtml(iso)
    : d.toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
};

const horodatage = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toISOString();
};

function renderClaim(claim: Claim, index: number): string {
  const sources = claim.sources
    .map(
      (s) =>
        `<li>${badgeTier(s.tier)} <a href="${escapeHtml(s.url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(s.url)}</a>` +
        ` &middot; observe ${horodatage(s.date_observed)}` +
        (s.date_published === null
          ? " &middot; publication non datee par la source"
          : ` &middot; publie ${horodatage(s.date_published)}`) +
        `</li>`,
    )
    .join("");

  return `<section class="claim" id="${escapeHtml(claim.id)}">
  <div class="entete">
    <span class="cid">${escapeHtml(claim.id)}</span>
    ${badgeType(claim.type)}
    ${badgeNiveau(claim.evidence_level)}
  </div>
  <p class="texte">${escapeHtml(claim.text)}</p>
  <ul class="sources">${sources || "<li>aucune source</li>"}</ul>
</section>`;
}

export function articlePage(article: Article): string {
  const declares = new Set(article.claims.map((c) => c.id));
  const corps = renderMarkdown(article.body, {
    // Le §0 promet qu'une affirmation puisse etre relue et contestee : chaque
    // reference devient un lien vers sa preuve.
    claimAnchor: (id) => (declares.has(id) ? `#${encodeURIComponent(id)}` : undefined),
  });

  const flags = article.editorial_notes.uncertainty_flags;
  const avertissement =
    flags.length === 0
      ? ""
      : `<div class="avertissement">
  <div class="section">incertitudes declarees</div>
  <ul>${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
</div>`;

  const ecartees = article.editorial_notes.excluded_claims;
  const blocEcartees =
    ecartees.length === 0
      ? ""
      : `<div class="section">affirmations ecartees</div>
<p class="entree-resume">Envisagees puis rejetees par le fact-checker : elles ne figurent pas dans l'article. Listees pour que le lecteur sache ce qui n'a pas ete retenu.</p>
<ul class="ecartees">${ecartees.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`;

  const changelog =
    article.changelog.length === 0
      ? ""
      : `<div class="section">historique des corrections</div>
<ul class="ecartees">${article.changelog
          .map(
            (c) =>
              `<li><strong>${jour(c.date)}</strong> &middot; ${escapeHtml(c.type)} — ${escapeHtml(c.description)}</li>`,
          )
          .join("")}</ul>`;

  const body = `<article>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="dateline">
    publie ${horodatage(article.published_at)}
    ${article.revised_at === null ? "" : `&middot; <span class="revise">revise ${horodatage(article.revised_at)}</span>`}
    &middot; ${article.claims.length} claim(s) structurante(s)
  </div>
  ${avertissement}
  <div class="corps">${corps}</div>
  <div class="section">preuves</div>
  ${article.claims.map(renderClaim).join("")}
  ${blocEcartees}
  ${changelog}
</article>`;

  return page({ title: `${article.title} — ${SITE_NAME}`, depth: 1, active: "articles", body });
}

/* -------------------------------------------------------------------------
 * Index
 * ---------------------------------------------------------------------- */

export function indexPage(articles: readonly Article[]): string {
  if (articles.length === 0) {
    return page({
      title: SITE_NAME,
      active: "articles",
      body: `<div class="section">a la une</div>
<div class="vide">Aucun article publie.<br>Lancer le pipeline, puis regenerer le site avec <code>npm run site</code>.</div>`,
    });
  }

  const entrees = articles
    .map((a, i) => {
      const minLevel = Math.min(
        ...a.claims.map((c) => c.evidence_level),
      ) as EvidenceLevel;
      const types = [...new Set(a.claims.map((c) => c.type))];
      const premier = a.body.split("\n").find((l) => l.trim().length > 0) ?? "";
      const resume = premier.replace(/\[\[[^\]]+\]\]/g, "").replace(/[*_`#>]/g, "").trim();

      return `<li>
  <div class="entree-meta">
    <span class="numero">${String(i + 1).padStart(2, "0")}</span>
    <span>${jour(a.published_at)}</span>
    ${a.revised_at === null ? "" : '<span class="badge">revise</span>'}
    ${badgeNiveau(minLevel)}
    ${types.map(badgeType).join(" ")}
  </div>
  <a class="entree-titre" href="articles/${encodeURIComponent(a.id)}.html">${escapeHtml(a.title)}</a>
  <p class="entree-resume">${escapeHtml(resume.slice(0, 240))}${resume.length > 240 ? "&hellip;" : ""}</p>
  <a class="lire" href="articles/${encodeURIComponent(a.id)}.html">lire l'analyse</a>
</li>`;
    })
    .join("");

  return page({
    title: SITE_NAME,
    active: "articles",
    body: `<div class="section">a la une</div>
<ol class="articles">${entrees}</ol>`,
  });
}

/* -------------------------------------------------------------------------
 * Pages documentaires
 * ---------------------------------------------------------------------- */

export function documentPage(
  title: string,
  markdown: string,
  active: NonNullable<PageOptions["active"]>,
): string {
  return page({
    title: `${title} — ${SITE_NAME}`,
    active,
    body: `<article><div class="corps">${renderMarkdown(markdown)}</div></article>`,
  });
}

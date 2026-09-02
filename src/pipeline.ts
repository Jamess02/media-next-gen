/**
 * §5 — La chaine de publication, de bout en bout.
 *
 * L'orchestrateur ne contient AUCUNE regle editoriale : il enchaine des etapes
 * et respecte leurs verdicts. Les regles vivent dans `protocol/rules.ts`, le
 * gate dans `agents/fact-checker.ts`. Si une regle apparaissait ici, elle
 * echapperait aux tests du gate — c'est exactement ce qu'on veut eviter.
 *
 * Un arret de pipeline est une ISSUE NORMALE, pas une panne. Le §9.3 prevoit
 * qu'un article ne passe pas : le resultat le dit alors explicitement, avec le
 * motif et l'etape, au lieu de lever une exception.
 */

import { randomUUID } from "node:crypto";

import { Analyste, type AnalysteOutput } from "./agents/analyste.js";
import type { AgentContext } from "./agents/base.js";
import { Editeur, PublicationRefused } from "./agents/editeur.js";
import {
  FactChecker,
  applyVerdicts,
  reconcileTiers,
  type GateDecision,
} from "./agents/fact-checker.js";
import { Redacteur } from "./agents/redacteur.js";
import {
  RedacteurEnChef,
  effectiveVerdict,
} from "./agents/redacteur-en-chef.js";
import { Veilleur, applySelection } from "./agents/veilleur.js";
import { WEAK_TIERS, WEAK_TIER_DISCLAIMER } from "./protocol/constants.js";
import {
  detectIllegalPromotions,
  detectUngroundedFigures,
  type Violation,
} from "./protocol/rules.js";
import { ArticleSchema, type Article } from "./protocol/schema.js";
import { SourceGateway } from "./sources/gateway.js";
import type { SourceAdapter } from "./sources/types.js";

export type PipelineStage =
  | "collecte"
  | "selection"
  | "analyse"
  | "fact-checking"
  | "redaction"
  | "validation"
  | "publication";

export interface PipelineHalted {
  status: "halted";
  stage: PipelineStage;
  reason: string;
  details: readonly string[];
}

export interface PipelinePublished {
  status: "published";
  article: Article;
  jsonPath: string;
  markdownPath: string;
  warnings: readonly Violation[];
  adjustments: readonly string[];
}

export type PipelineResult = PipelineHalted | PipelinePublished;

export interface PipelineOptions {
  ctx: AgentContext;
  adapters: readonly SourceAdapter[];
  editeur?: Editeur;
  /** Borne basse de fraicheur (§5.1). Defaut : 30 jours glissants. */
  since?: string;
  /** Journal de progression. Injecte pour rester testable. */
  onStage?: (stage: PipelineStage, detail: string) => void;
}

export class EditorialPipeline {
  private readonly gateway: SourceGateway;
  private readonly veilleur: Veilleur;
  private readonly analyste: Analyste;
  private readonly factChecker: FactChecker;
  private readonly redacteur: Redacteur;
  private readonly redacteurEnChef: RedacteurEnChef;
  private readonly editeur: Editeur;
  private readonly since: string;
  private readonly onStage: (stage: PipelineStage, detail: string) => void;

  constructor(private readonly options: PipelineOptions) {
    const { ctx } = options;
    this.gateway = new SourceGateway(options.adapters, ctx.audit);
    this.veilleur = new Veilleur(ctx);
    this.analyste = new Analyste(ctx);
    this.factChecker = new FactChecker(ctx);
    this.redacteur = new Redacteur(ctx);
    this.redacteurEnChef = new RedacteurEnChef(ctx);
    this.editeur = options.editeur ?? new Editeur();
    this.since =
      options.since ??
      new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    this.onStage = options.onStage ?? (() => {});
  }

  async run(topic: string): Promise<PipelineResult> {
    /* --- §5.1 Collecte --------------------------------------------------- */
    this.onStage("collecte", `interrogation de ${this.options.adapters.length} source(s)`);
    const collection = await this.gateway.collect(
      { topic, since: this.since },
      "veilleur",
    );

    if (collection.events.length === 0) {
      return halt("collecte", "aucune observation collectee", [
        ...collection.failures.map((f) => `${f.adapterId} : ${f.error}`),
      ]);
    }

    /* --- §5.1 Selection editoriale --------------------------------------- */
    const selection = await this.veilleur.run({ topic, collection });
    const retained = applySelection(collection.events, selection);
    this.onStage(
      "selection",
      `${retained.length} observation(s) retenue(s), ${selection.set_aside.length} ecartee(s)`,
    );

    if (retained.length === 0) {
      return halt("selection", "le veilleur n'a retenu aucune source", [
        ...selection.set_aside.map((s) => `${s.url} : ${s.reason}`),
      ]);
    }

    /* --- §5.2 Analyse ---------------------------------------------------- */
    const analysis: AnalysteOutput = await this.analyste.run({
      topic,
      events: retained,
      freshnessAssessment: selection.freshness_assessment,
    });
    this.onStage("analyse", `${analysis.candidates.length} claim(s) candidate(s)`);

    if (analysis.candidates.length === 0) {
      return halt("analyse", "aucune claim candidate produite", []);
    }

    /* --- §5.2 / §9.3 Gate bloquant --------------------------------------- */
    // Pre-controle : les tiers annonces sont reverifies AVANT le modele.
    const { candidates, corrections } = reconcileTiers(analysis.candidates);
    if (corrections.length > 0) {
      this.onStage(
        "fact-checking",
        `${corrections.length} tier(s) corrige(s) depuis le registre`,
      );
    }

    let verdicts = await this.factChecker.run({
      candidates,
      publicationCaveats: analysis.publication_caveats,
      reformulationPass: false,
    });
    let gate: GateDecision = applyVerdicts(candidates, verdicts);
    this.onStage(
      "fact-checking",
      `${gate.accepted.length} acceptee(s), ${gate.excluded.length} ecartee(s)`,
    );

    // §9.3 — une claim sous le niveau 2 "retourne en collecte OU est reformulee
    // en scenario/hypothese explicite". On tente la reformulation avant
    // d'abandonner. UNE seule fois : une boucle non bornee finirait par
    // affaiblir le texte jusqu'a ce qu'il passe, ce qui viderait le gate de
    // son sens.
    let reformulationAttempted = false;
    if (!gate.passed) {
      this.onStage(
        "fact-checking",
        "aucune claim retenue — seconde passe en reformulation (§9.3)",
      );
      reformulationAttempted = true;

      const retryVerdicts = await this.factChecker.run({
        candidates,
        publicationCaveats: analysis.publication_caveats,
        reformulationPass: true,
      });
      const retryGate = applyVerdicts(candidates, retryVerdicts);
      this.onStage(
        "fact-checking",
        `apres reformulation : ${retryGate.accepted.length} acceptee(s)`,
      );

      if (retryGate.passed) {
        verdicts = {
          verdicts: retryVerdicts.verdicts,
          conflicts_found: [
            ...verdicts.conflicts_found,
            ...retryVerdicts.conflicts_found,
          ],
        };
        gate = retryGate;
      } else {
        return halt(
          "fact-checking",
          "aucune claim n'atteint le niveau de preuve 2 (§2), meme apres reformulation",
          [...gate.excluded, ...retryGate.excluded],
        );
      }
    }

    /* --- §5.3 Redaction --------------------------------------------------- */
    const allSourcesWeak = gate.accepted.every(
      (c) =>
        c.sources.length > 0 &&
        c.sources.every((s) => WEAK_TIERS.includes(s.tier)),
    );

    const draft = await this.redacteur.run({
      topic,
      claims: gate.accepted,
      narrativeVsData: analysis.narrative_vs_data,
      publicationCaveats: analysis.publication_caveats,
      requiredDisclaimer: allSourcesWeak ? WEAK_TIER_DISCLAIMER : null,
    });
    this.onStage("redaction", `"${draft.title}"`);

    /* --- Assemblage du contrat §7 ---------------------------------------- */
    // §2 — chiffres non ancres dans les sources retenues.
    //
    // Le controle se fait ICI parce que le pipeline dispose encore des resumes
    // d'observations, absents du contrat §7. L'alternative aurait ete de faire
    // circuler les sources jusqu'a l'article, ce qui aurait modifie le contrat
    // pour un besoin de diagnostic.
    const ungrounded = detectUngroundedFigures(
      gate.accepted,
      retained.map((e) => e.resume),
    );
    if (ungrounded.length > 0) {
      this.onStage(
        "redaction",
        `${ungrounded.length} claim(s) citant des chiffres absents des sources`,
      );
    }

    const now = new Date().toISOString();
    const uncertaintyFlags = [
      ...draft.uncertainty_flags,
      ...analysis.publication_caveats,
      ...verdicts.conflicts_found.map((c) => `Contradiction entre sources : ${c}`),
      ...corrections.map(
        (c) =>
          `Tier corrige pour ${c.url} : annonce ${c.declaredTier}, reel ${c.actualTier}.`,
      ),
      ...collection.failures.map(
        (f) => `Source indisponible lors de la collecte : ${f.adapterId} (${f.error}).`,
      ),
      ...(allSourcesWeak ? [WEAK_TIER_DISCLAIMER] : []),
      // Les ajustements du gate sont des faits sur la SOLIDITE des claims
      // publiees (niveau abaisse, promotion refusee). Ils appartiennent aux
      // incertitudes declarees — pas aux claims ecartees, qui ne contiennent
      // que des rejets (§7). Confondre les deux ferait annoncer au lecteur
      // comme "retiree" une claim qu'il lit dans l'article.
      ...gate.adjustments.map((a) => `Ajustement du fact-checker — ${a}`),
      // Le lecteur doit voir qu'un chiffre n'est pas adosse aux sources
      // citees : c'est une information sur la solidite de ce qu'il lit.
      ...ungrounded.map((v) => v.message),
      // Une reformulation de sauvetage change la nature de ce que le lecteur
      // lit : il doit le savoir (EP-003), pas seulement les logs.
      ...(reformulationAttempted
        ? [
            "Aucune affirmation n'a passe le premier controle de preuve : " +
              "l'article a ete reecrit en hypotheses explicites (§9.3).",
          ]
        : []),
    ];

    const assembled = {
      id: `article-${randomUUID()}`,
      title: draft.title,
      published_at: now,
      revised_at: null,
      authors_agents: [
        "veilleur",
        "analyste",
        "fact-checker",
        "redacteur",
        "redacteur-en-chef",
        "editeur",
      ],
      claims: gate.accepted,
      body: draft.body,
      editorial_notes: {
        uncertainty_flags: dedupe(uncertaintyFlags),
        // §7 : "claims rejetees et pourquoi". Uniquement des rejets.
        excluded_claims: gate.excluded,
      },
      changelog: [],
    };

    const parsed = ArticleSchema.safeParse(assembled);
    if (!parsed.success) {
      return halt(
        "redaction",
        "l'article assemble ne respecte pas le schema §7",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      );
    }
    const article = parsed.data;

    /* --- Defense en profondeur : §3 / §8 ---------------------------------- */
    // Le Redacteur ne peut structurellement pas requalifier une claim, mais on
    // le verifie quand meme : une regression future du schema ne doit pas
    // rouvrir silencieusement cette porte.
    const promotions = detectIllegalPromotions(
      analysis.candidates.map((c) => ({ id: c.id, type: c.type })),
      article.claims,
    );
    if (promotions.length > 0) {
      return halt(
        "redaction",
        "promotion illegale d'une claim au rang de fait (§3/§8)",
        promotions.map((p) => p.message),
      );
    }

    /* --- §5.4 Validation editoriale --------------------------------------- */
    const review = await this.redacteurEnChef.run(article);
    const verdict = effectiveVerdict(review);
    this.onStage("validation", `verdict : ${verdict}`);

    if (verdict !== "publier") {
      return halt("validation", `redacteur en chef : ${verdict}`, [
        review.justification,
        ...review.implicit_recommendations.map(
          (r) => `Recommandation implicite (EP-007) : "${r}"`,
        ),
        ...review.angle_issues,
        ...review.suggested_split,
      ]);
    }

    /* --- §5.4 Publication -------------------------------------------------- */
    try {
      const published = await this.editeur.publish(article);
      this.onStage("publication", published.markdownPath);
      return {
        status: "published",
        article: published.article,
        jsonPath: published.jsonPath,
        markdownPath: published.markdownPath,
        warnings: published.warnings,
        adjustments: gate.adjustments,
      };
    } catch (error) {
      if (error instanceof PublicationRefused) {
        return halt(
          "publication",
          "refus de l'editeur au controle final",
          error.violations.map((v) => `[${v.clause} ${v.rule}] ${v.message}`),
        );
      }
      throw error;
    }
  }
}

function halt(
  stage: PipelineStage,
  reason: string,
  details: readonly string[],
): PipelineHalted {
  return { status: "halted", stage, reason, details };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

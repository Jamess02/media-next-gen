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
import {
  PROSPECTIVE_DISCLAIMER,
  WEAK_TIERS,
  WEAK_TIER_DISCLAIMER,
  type ArticleMode,
} from "./protocol/constants.js";
import {
  boldDisclosure,
  disclosureText,
  interestsForUrls,
} from "./protocol/interests.js";
import {
  detectIllegalPromotions,
  detectUncollectedSources,
  detectUngroundedFigures,
  detectUngroundedStructuredFigures,
  type Violation,
} from "./protocol/rules.js";
import { ArticleSchema, type Article } from "./protocol/schema.js";
import {
  InvestigateurChapitre,
  InvestigateurPlan,
  completerChapitres,
  rendreCorpsEnquete,
} from "./agents/investigateur.js";
import {
  enqueteAutorisee,
  evaluerSujet,
  type Investigation,
} from "./planification/investigation.js";
import { SourceGateway } from "./sources/gateway.js";
import type { SourceAdapter } from "./sources/types.js";

/**
 * Cible de longueur pour une enquete, repartie entre ses chapitres.
 *
 * Visee au-dessus du plancher de 1500 mots du gate, et non dessus : viser la
 * limite exacte revient a echouer une fois sur deux. La mesure sur trois
 * executions reelles donnait 496, 640 puis 990 mots en UNE passe — la marge
 * n'est pas du confort, c'est ce qui rend le plancher atteignable.
 */
const MOTS_CIBLE_ENQUETE = 2200;

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
  /**
   * `constat` (defaut) documente l etabli ; `prospectif` construit l article
   * autour de scenarios conditionnes.
   */
  mode?: ArticleMode;
  /**
   * Enquetes deja ouvertes, pour le controle de CADENCE du mode `enquete`.
   *
   * Injecte plutot que lu depuis le disque : le pipeline reste testable sans
   * etat persistant, et l appelant (CLI, vague, studio) reste maitre de la
   * source de verite.
   */
  investigations?: readonly Investigation[];
  /** Journal de progression. Injecte pour rester testable. */
  onStage?: (stage: PipelineStage, detail: string) => void;
}

export class EditorialPipeline {
  private readonly gateway: SourceGateway;
  private readonly veilleur: Veilleur;
  private readonly analyste: Analyste;
  private readonly factChecker: FactChecker;
  private readonly redacteur: Redacteur;
  private readonly investigateurPlan: InvestigateurPlan;
  private readonly investigateurChapitre: InvestigateurChapitre;
  private readonly redacteurEnChef: RedacteurEnChef;
  private readonly editeur: Editeur;
  private readonly since: string;
  private readonly mode: ArticleMode;
  private readonly onStage: (stage: PipelineStage, detail: string) => void;

  constructor(private readonly options: PipelineOptions) {
    const { ctx } = options;
    this.gateway = new SourceGateway(options.adapters, ctx.audit);
    this.veilleur = new Veilleur(ctx);
    this.analyste = new Analyste(ctx);
    this.factChecker = new FactChecker(ctx);
    this.redacteur = new Redacteur(ctx);
    this.investigateurPlan = new InvestigateurPlan(ctx);
    this.investigateurChapitre = new InvestigateurChapitre(ctx);
    this.redacteurEnChef = new RedacteurEnChef(ctx);
    this.editeur = options.editeur ?? new Editeur();
    this.since =
      options.since ??
      new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    this.mode = options.mode ?? "constat";
    this.onStage = options.onStage ?? (() => {});
  }

  async run(topic: string): Promise<PipelineResult> {
    /* --- Cadence du format long, AVANT tout le reste --------------------- */
    //
    // Le controle est place ICI, avant meme la collecte, et c'est le point
    // entier du quota. Verifie apres la redaction, il ne limiterait rien : le
    // texte existerait deja, et un texte ecrit finit par etre publie. Verifie
    // avant, il empeche l'enquete d'exister.
    //
    // C'est la difference entre une cadence tenue et une cadence affichee.
    if (this.mode === "enquete") {
      const cadence = enqueteAutorisee(
        this.options.investigations ?? [],
        new Date(),
      );
      if (!cadence.autorisee) {
        return halt("collecte", `cadence : ${cadence.motif}`, [
          cadence.prochaineOuverture === undefined
            ? "aucune date de reouverture calculable"
            : `prochaine ouverture possible : ${cadence.prochaineOuverture}`,
          "Le format long se defend par sa rarete. Les sujets courants " +
            "continuent d'etre traites par les vagues.",
        ]);
      }
      this.onStage("collecte", `enquete autorisee — ${cadence.motif}`);
    }

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
      mode: this.mode,
    });
    this.onStage("analyse", `${analysis.candidates.length} claim(s) candidate(s)`);

    if (analysis.candidates.length === 0) {
      return halt("analyse", "aucune claim candidate produite", []);
    }

    /* --- §9.4 Ancrage des sources dans la collecte ------------------------ */
    // AVANT tout appel supplementaire au modele : une claim qui cite une URL
    // jamais collectee est soit une invention, soit une injection venue du
    // contenu d'une source. Dans les deux cas, poursuivre reviendrait a payer
    // un appel pour raffiner un materiau deja disqualifie.
    const uncollected = detectUncollectedSources(
      analysis.candidates,
      retained.map((e) => e.url),
    );
    if (uncollected.length > 0) {
      return halt(
        "analyse",
        "une claim cite une source absente de la collecte (§9.4)",
        uncollected.map((v) => v.message),
      );
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

    /* --- Mode prospectif : au moins un scenario ---------------------------- */
    // Un article annonce prospectif qui ne contiendrait que des constats
    // tromperait sur ce qu'il est. Le controle est ici et non dans `rules.ts` :
    // le mode est une intention editoriale de l'execution, il n'appartient pas
    // au contrat §7 et l'Editeur n'a aucun moyen de le connaitre.
    if (this.mode === "prospectif") {
      const scenarios = gate.accepted.filter((c) => c.type === "scénario");
      if (scenarios.length === 0) {
        return halt(
          "fact-checking",
          "mode prospectif : aucune claim de type scénario n'a survecu au gate",
          [
            "Un article prospectif se construit autour d'au moins un scenario " +
              "conditionne (§3). Les claims retenues sont toutes des constats : " +
              "publier sous ce mode annoncerait au lecteur une projection qui " +
              "n'existe pas.",
            ...gate.accepted.map((c) => `${c.id} : ${c.type}`),
          ],
        );
      }
      this.onStage(
        "fact-checking",
        `mode prospectif : ${scenarios.length} scenario(s) conditionne(s) retenu(s)`,
      );
    }

    /* --- §5.3 Redaction --------------------------------------------------- */
    const allSourcesWeak = gate.accepted.every(
      (c) =>
        c.sources.length > 0 &&
        c.sources.every((s) => WEAK_TIERS.includes(s.tier)),
    );

    // §4 / EP-002 — sources ayant un interet dans ce qu'elles commentent.
    //
    // Le calcul se fait sur les claims RETENUES, pas sur la collecte : une
    // source ecartee en cours de route n'a rien a divulguer. Les chaines sont
    // fournies deja en gras au Redacteur, et la meme regle qui les exige les
    // reconstruit pour verifier (protocol/interests.ts) — il n'y a donc qu'une
    // seule formulation possible, cote consigne comme cote controle.
    const citedUrls = new Set(
      gate.accepted.flatMap((c) => c.sources.map((s) => s.url)),
    );
    const interests = interestsForUrls([...citedUrls]);
    if (interests.length > 0) {
      this.onStage(
        "redaction",
        `${interests.length} divulgation(s) d'interet exigee(s) : ` +
          interests.map((i) => i.name).join(", "),
      );
    }

    /**
     * Brouillon issu du format long, quand il s'applique.
     *
     * Meme forme que la sortie du Redacteur — titre, corps, drapeaux — pour
     * que la suite du pipeline n'ait pas a savoir quel agent a ecrit.
     */
    let enqueteRedigee:
      | { title: string; body: string; uncertainty_flags: string[] }
      | undefined;

    /* --- Format long : routage, puis redaction par l'Investigateur ------- */
    //
    // Le routage est evalue sur la matiere REELLEMENT collectee, pas sur
    // l'intention de depart. Un sujet peut sembler meriter une enquete et ne
    // ramener que deux documents d'un meme emetteur : c'est a ce moment-la,
    // et pas avant, qu'on peut le savoir.
    if (this.mode === "enquete") {
      const emetteurs = new Set(retained.map((e) => e.source));
      const routage = evaluerSujet({
        sujet: topic,
        sourcesDisponibles: retained.length,
        emetteursDistincts: emetteurs.size,
        // Une contradiction reperee par le fact-checker est le signal le plus
        // solide dont on dispose : elle a ete constatee, pas supposee.
        sourcesEnDesaccord: verdicts.conflicts_found.length > 0,
        // Deux claims ou plus a relier : il y a un enchainement a expliquer.
        mecanismeAExpliquer: gate.accepted.length >= 2,
        // Des reserves de publication signalent ce que les sources ne disent
        // pas — c'est la definition operatoire d'une zone d'ombre.
        zonesDombre: analysis.publication_caveats.length > 0,
      });

      if (routage.route !== "investigateur") {
        return halt("redaction", `routage : ${routage.motif}`, [
          `sujet : ${topic}`,
          `${retained.length} observation(s), ${emetteurs.size} emetteur(s) distinct(s)`,
          "Ce sujet releve de la production courante, pas du format long.",
        ]);
      }

      this.onStage("redaction", `enquete — criteres : ${routage.criteres.join(", ")}`);

      const materielEnquete = retained
        .filter((e) => citedUrls.has(e.url))
        .map((e) => `${e.source} — ${e.resume}`);

      const communEnquete = {
        topic,
        claims: gate.accepted,
        criteres: routage.criteres,
        narrativeVsData: analysis.narrative_vs_data,
        publicationCaveats: analysis.publication_caveats,
        requiredDisclaimer: allSourcesWeak ? WEAK_TIER_DISCLAIMER : null,
        requiredDisclosures: interests.map(boldDisclosure),
        sourceMaterial: materielEnquete,
      };

      /* --- Passe 1 : decider et planifier ------------------------------ */
      const plan = await this.investigateurPlan.run(communEnquete);

      // RENONCER N EST PAS UNE PANNE. Le §5.3 demande que l agent puisse
      // signaler une piste trop mince plutot que de forcer un article ; un
      // arret motive est donc une issue normale, au meme titre qu un refus du
      // gate. Le motif remonte tel quel : c est lui qui rend l abandon
      // relisable.
      if (!plan.publiable) {
        return halt(
          "redaction",
          "l Investigateur a renonce : la piste n est pas assez solide pour etre publiee",
          [
            plan.motif_de_refus ?? "motif non renseigne",
            "Une piste abandonnee ne coute rien ; une enquete batie sur du " +
              "vide coute la credibilite de toutes les autres.",
          ],
        );
      }

      // Les chapitres OBLIGATOIRES sont garantis ici, pas demandes au modele.
      // Lui rappeler de ne pas oublier le contradictoire, c est esperer ;
      // l ajouter quand il manque, c est l obtenir.
      const chapitres = completerChapitres(plan.chapitres);
      const motsVises = Math.ceil(MOTS_CIBLE_ENQUETE / chapitres.length);
      this.onStage(
        "redaction",
        `plan retenu : ${chapitres.length} chapitre(s), ~${motsVises} mots chacun`,
      );

      /* --- Passe 2 : un appel PAR CHAPITRE ----------------------------- */
      // C est ce decoupage qui rend le travail reellement plus long, la ou le
      // quota ne faisait qu en espacer la production. Sequentiel a dessein :
      // chaque chapitre connait ceux deja ecrits et evite de les redire.
      const ecrits: Array<{ titre: string; corps: string }> = [];
      for (const [rang, chapitre] of chapitres.entries()) {
        const morceau = await this.investigateurChapitre.run({
          ...communEnquete,
          chapitre,
          dejaEcrits: ecrits.map((e) => e.titre),
          motsVises,
        });
        ecrits.push({ titre: chapitre.titre, corps: morceau.corps });
        this.onStage(
          "redaction",
          `chapitre ${rang + 1}/${chapitres.length} — "${chapitre.titre}" ` +
            `(${morceau.corps.split(/s+/).filter(Boolean).length} mots)`,
        );
      }

      enqueteRedigee = {
        title: plan.title ?? "",
        body: rendreCorpsEnquete({
          resume_en_bref: plan.resume_en_bref ?? "",
          chapitres: ecrits,
          glossaire: plan.glossaire,
          bibliographie: plan.bibliographie,
        }),
        uncertainty_flags: plan.uncertainty_flags,
      };
    }

    // Le reste du pipeline est COMMUN aux deux formats : ancrage des chiffres,
    // drapeaux d'incertitude, assemblage du contrat §7, gate, publication.
    // Faire diverger ces etapes selon le format aurait cree deux chemins de
    // publication a maintenir, dont un seul serait reellement exerce.
    const draft = enqueteRedigee ?? (await this.redacteur.run({
      topic,
      claims: gate.accepted,
      narrativeVsData: analysis.narrative_vs_data,
      publicationCaveats: analysis.publication_caveats,
      requiredDisclaimer: allSourcesWeak ? WEAK_TIER_DISCLAIMER : null,
      requiredDisclosures: interests.map(boldDisclosure),
      mode: this.mode,
      // Les observations effectivement citees par les claims retenues. Sans
      // cette matiere, le Redacteur devait expliquer une methode qu'il n'avait
      // aucun moyen de connaitre — et il l'inventait.
      sourceMaterial: retained
        .filter((e) => citedUrls.has(e.url))
        .map((e) => ({
          source: e.source,
          url: e.url,
          date_published: e.date_published,
          resume: e.resume,
        })),
    }));
    this.onStage("redaction", `"${draft.title}"`);

    /* --- Assemblage du contrat §7 ---------------------------------------- */
    // §2 — chiffres non ancres dans les sources retenues.
    //
    // Le controle se fait ICI parce que le pipeline dispose encore des resumes
    // d'observations, absents du contrat §7. L'alternative aurait ete de faire
    // circuler les sources jusqu'a l'article, ce qui aurait modifie le contrat
    // pour un besoin de diagnostic.
    const materiau = retained.map((e) => e.resume);
    const ungrounded = [
      ...detectUngroundedFigures(gate.accepted, materiau),
      // Le tableau donne a un chiffre l autorite d une donnee verifiee : sa
      // valeur est controlee separement de la prose qui l entoure.
      ...detectUngroundedStructuredFigures(gate.accepted, materiau),
    ];
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
      // Un lecteur doit savoir, avant la premiere phrase, qu'il lit du
      // conditionnel. Pose par le pipeline et non par le Redacteur : la
      // nature de l'article ne depend pas de ce qu'un modele a bien voulu
      // ecrire.
      ...(this.mode === "prospectif" ? [PROSPECTIVE_DISCLAIMER] : []),
      // La divulgation est aussi posee ICI, par le pipeline. Celle du corps
      // depend du Redacteur — le gate la verifie, mais un texte peut toujours
      // la placer maladroitement. Celle-ci est deterministe.
      //
      // SANS LE GRAS : ce champ est rendu en texte echappe (site et markdown
      // traitent les drapeaux comme de la donnee, pas comme du markdown), donc
      // les asterisques s'y afficheraient telles quelles. La mise en valeur
      // visuelle est faite par le gabarit, qui en tire un bloc dedie.
      ...interests.map(disclosureText),
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
      // L'agent redacteur figure selon le format reellement emprunte : une
      // enquete signee « redacteur » attribuerait le texte a un agent qui ne
      // l'a pas ecrit, et le §7 fait de cette liste une donnee, pas un ornement.
      authors_agents: [
        "veilleur",
        "analyste",
        "fact-checker",
        this.mode === "enquete" ? "investigateur" : "redacteur",
        "redacteur-en-chef",
        "editeur",
      ],
      claims: gate.accepted,
      body: draft.body,
      // Le format est porte par le CONTRAT, pas deduit du texte. C'est lui qui
      // declenche les regles de structure du format long (§5.3) : les deduire
      // de la presence des chapitres rendrait le controle circulaire.
      mode: this.mode,
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
        // Sans cette ligne, les affirmations non soutenues restaient dans la
        // reponse du modele sans jamais atteindre celui qui doit corriger.
        ...review.unsupported_assertions.map(
          (a) => `Affirmation non soutenue par une claim (§2) : "${a}"`,
        ),
        ...review.angle_issues,
        ...review.suggested_split,
      ]);
    }

    /* --- §5.4 Publication -------------------------------------------------- */
    try {
      const published = await this.editeur.publish(article);
      this.onStage("publication", published.markdownPath);

      // Les passages que le redacteur en chef juge non soutenus n'empechent pas
      // la publication du BROUILLON, mais ils doivent atteindre celui qui relit.
      // Les perdre ici reviendrait a les avoir supprimes.
      const chiefWarnings: Violation[] = review.unsupported_assertions.map(
        (passage) => ({
          rule: "UNSUPPORTED_ASSERTION",
          clause: "§2 / §5.4",
          severity: "warning" as const,
          message:
            `Le redacteur en chef juge ce passage non soutenu par une claim : ` +
            `"${passage}". A verifier avant relecture : soit la formulation ` +
            `avance un fait que rien n'etablit, soit elle enonce une limite et ` +
            `le signalement est un faux positif.`,
          path: "body",
        }),
      );
      if (chiefWarnings.length > 0) {
        this.onStage(
          "validation",
          `${chiefWarnings.length} passage(s) signale(s) au relecteur`,
        );
      }

      return {
        status: "published",
        article: published.article,
        jsonPath: published.jsonPath,
        markdownPath: published.markdownPath,
        warnings: [...published.warnings, ...chiefWarnings],
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

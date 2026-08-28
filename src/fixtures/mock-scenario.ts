/**
 * Reponses scriptees pour le mode `mock` — economie fictive de Zembla.
 *
 * Ce scenario est construit pour EXERCER le protocole, pas pour le flatter.
 * Trois pieges y sont deliberement poses :
 *
 *  1. Le Veilleur doit ecarter la reprise de presse (tier 3) qui doublonne une
 *     donnee disponible a la source (EP-001).
 *  2. L'Analyste surcote `claim-2` au niveau 4 alors que les donnees sont
 *     partielles : le fact-checker doit l'abaisser.
 *  3. Le fact-checker lui-meme se comporte MAL : il tente de promouvoir
 *     `claim-3` (une inference) au rang de fait, et de relever `claim-2` de 3
 *     a 4. Le clamp monotone de `applyVerdicts` doit refuser les deux.
 *
 * Le piege 3 est le plus important : il verifie que la garantie du gate ne
 * repose pas sur la bonne conduite du modele.
 */

import type { MockResponder } from "../llm/mock-client.js";

const FRED_URL = "https://fred.stlouisfed.org/series/ZEMBLAPOLRATE";
const COMTRADE_URL = "https://comtrade.un.org/data/ZMB/202607";
const GNEWS_URL = "https://gnews.io/articles/zembla-monetary-tightening";

const FRED_SOURCE = {
  url: FRED_URL,
  tier: 1 as const,
  date_observed: "2026-08-27T09:00:00Z",
  date_published: "2026-08-12T14:00:00Z",
};

const COMTRADE_SOURCE = {
  url: COMTRADE_URL,
  tier: 1 as const,
  date_observed: "2026-08-27T09:05:00Z",
  date_published: "2026-08-20T00:00:00Z",
};

export const MOCK_RESPONDERS: Record<string, MockResponder> = {
  /* --- §5.1 ------------------------------------------------------------- */
  veilleur: () => ({
    retained: [
      {
        url: FRED_URL,
        selection_reason:
          "Emetteur de la serie de taux. Source primaire disponible, donc prioritaire sur toute reprise (EP-001).",
      },
      {
        url: COMTRADE_URL,
        selection_reason:
          "Donnees douanieres a la source. Partielles, mais l'incompletude est documentee par l'emetteur lui-meme.",
      },
    ],
    set_aside: [
      {
        url: GNEWS_URL,
        reason:
          "Reprise de presse (tier 3) de la hausse de taux deja publiee par l'emetteur. N'apporte aucun element absent de la source primaire, et son \"risque de crise commerciale\" n'est pas chiffre (EP-001).",
      },
    ],
    freshness_assessment:
      "Decision de taux du 12 aout 2026 : valide jusqu'a la prochaine reunion. Donnees Comtrade de juillet : publication differee d'environ un mois et revisions attendues a mesure que les declarants completent.",
    primary_source_available: true,
  }),

  /* --- §5.2 (analyse) ---------------------------------------------------- */
  analyste: () => ({
    candidates: [
      {
        id: "claim-1",
        text: "[SIMULATION] La banque centrale de Zembla a releve son taux directeur de 25 points de base, de 4,25 % a 4,50 %, le 12 aout 2026.",
        type: "fait",
        proposed_evidence_level: 3,
        rationale:
          "La serie FRED ZEMBLAPOLRATE porte les trois observations successives (4,25 en juin, 4,25 en juillet, 4,50 en aout). La source soutient precisement le chiffre, la date et l'amplitude.",
        sources: [FRED_SOURCE],
      },
      {
        id: "claim-2",
        // Piege 2 : niveau surcote pour des donnees explicitement partielles.
        text: "[SIMULATION] Le solde commercial de Zembla pour juillet 2026 est estime a -569 MUSD sur la base des declarations de 3 partenaires sur 11.",
        type: "estimation",
        proposed_evidence_level: 4,
        rationale:
          "Somme directe des trois lignes declarees dans le jeu Comtrade. Le perimetre est explicite dans le texte de la claim.",
        sources: [COMTRADE_SOURCE],
      },
      {
        id: "claim-3",
        text: "[SIMULATION] La conjonction d'un resserrement monetaire et d'un solde commercial partiel negatif suggere une pression sur le compte courant de Zembla au troisieme trimestre.",
        type: "inférence",
        proposed_evidence_level: 3,
        rationale:
          "Deduction a partir de claim-1 et claim-2. Aucune source ne documente directement le compte courant : le lien est logique, non observe.",
        sources: [FRED_SOURCE, COMTRADE_SOURCE],
      },
    ],
    narrative_vs_data:
      "La presse evoque un \"risque de crise commerciale\" sans chiffrage. Les donnees disponibles ne documentent qu'un solde partiel sur 3 declarants sur 11 : elles ne soutiennent ni ne refutent le terme de crise, qui n'a pas de definition operationnelle ici.",
    publication_caveats: [
      "Donnees Comtrade de juillet 2026 partielles : 3 partenaires declarants sur 11. Le solde sera revise a la hausse comme a la baisse.",
      "Les statistiques douanieres sont publiees avec environ un mois de decalage et font l'objet de revisions ulterieures.",
    ],
  }),

  /* --- §5.2 / §9.3 (gate) ------------------------------------------------ */
  // Piege 3 : ce fact-checker simule se comporte MAL. Deux de ses trois
  // verdicts violent la monotonie. Le clamp doit les neutraliser.
  "fact-checker": () => ({
    verdicts: [
      {
        claim_id: "claim-1",
        verdict: "accepte",
        adjusted_evidence_level: 3,
        adjusted_type: "fait",
        justification:
          "La serie FRED soutient precisement la date, le niveau et l'amplitude. Niveau 3 confirme. Niveau 4 non atteint : la serie est consultable mais aucun calcul n'est a reproduire.",
        reformulated_text: null,
      },
      {
        claim_id: "claim-2",
        // Tentative de REMONTEE 4 -> ... le modele confirme 4. Le clamp laisse
        // passer (4 <= 4 propose) mais la regle metier veut 2. On abaisse ici.
        verdict: "abaisse",
        adjusted_evidence_level: 2,
        adjusted_type: "estimation",
        justification:
          "Niveau 4 refuse : la reproduction exigerait le jeu complet des 11 declarants, indisponible. Le chiffre reste liee a une URL verifiable, donc niveau 2. Le caractere partiel doit rester dans le texte.",
        reformulated_text: null,
      },
      {
        claim_id: "claim-3",
        // VIOLATION DELIBEREE : promotion d'une inference en fait, et remontee
        // du niveau de preuve de 3 a 4. Les deux doivent etre refusees par le code.
        verdict: "accepte",
        adjusted_evidence_level: 4,
        adjusted_type: "fait",
        justification:
          "Verdict volontairement non conforme, pour verifier le clamp monotone du pipeline.",
        reformulated_text: null,
      },
    ],
    conflicts_found: [
      "Le terme de \"crise commerciale\" employe par la presse n'est soutenu par aucune des donnees primaires retenues.",
    ],
  }),

  /* --- §5.3 -------------------------------------------------------------- */
  redacteur: () => ({
    title:
      "[SIMULATION] Zembla resserre sa politique monetaire alors que ses donnees commerciales restent incompletes",
    body: [
      "La banque centrale de Zembla a releve son taux directeur de 25 points de base le 12 aout 2026, le portant de 4,25 % a 4,50 % [[claim-1]].",
      "",
      "Sur le front commercial, la lecture est nettement plus fragile. Les donnees douanieres de juillet 2026 ne couvrent que 3 des 11 partenaires declarants ; sur ce sous-ensemble, le solde est estime a -569 MUSD [[claim-2]]. Ce chiffre n'est pas le solde commercial du pays : c'est le solde du perimetre declare a ce jour, et il sera revise.",
      "",
      "La conjonction de ces deux elements suggere une pression sur le compte courant au troisieme trimestre [[claim-3]]. Aucune donnee retenue ne documente directement ce compte : il s'agit d'une deduction, pas d'une observation.",
      "",
      "La couverture de presse evoque de son cote un \"risque de crise commerciale\". Ce terme n'a pas de definition operationnelle dans les sources primaires disponibles, et les donnees partielles ne permettent ni de l'etayer ni de l'ecarter.",
    ].join("\n"),
    uncertainty_flags: [
      "Le solde de -569 MUSD porte sur 3 declarants sur 11 : il ne represente pas le solde commercial de Zembla.",
      "La pression sur le compte courant est une inference, non une donnee observee.",
    ],
  }),

  /* --- §5.4 -------------------------------------------------------------- */
  "redacteur-en-chef": () => ({
    verdict: "publier",
    justification:
      "L'angle correspond au materiau : le titre annonce un resserrement et une incertitude commerciale, le corps demontre les deux sans les confondre. Le statut d'inference de claim-3 est lisible dans la phrase elle-meme. Aucune conclusion ne deborde ce que les claims soutiennent.",
    implicit_recommendations: [],
    angle_issues: [],
    suggested_split: [],
  }),
};

/**
 * INFOGRAPHIE — suivi des indicateurs entre editions.
 *
 * Ecrits AVANT le code (TDD).
 *
 * Le brief editorial du 2026-09-18 demande un stockage de suivi ou chaque
 * indicateur est enregistre, puis confronte a son realise lors d'une execution
 * ulterieure. Deux exigences y sont des REGLES DURES, pas des intentions :
 *
 *  - « Historique en ajout seul : ne reecris et ne supprime jamais un
 *    enregistrement passe. Toute correction cree une nouvelle version avec la
 *    raison. »
 *  - « Si les ecarts vont dans le meme sens sur 3 periodes consecutives ou
 *    plus, remonte-le au Redacteur en chef. »
 *
 * POURQUOI DU JSONL CHAINE, ET NON LE `indicators.json` DU BRIEF. Un tableau
 * JSON reecrit a chaque execution est append-only par convention seulement :
 * rien n'empeche d'y modifier une ligne passee, et un registre qu'on peut
 * editer sans laisser de trace ne prouve rien. Le depot a deja resolu ce
 * probleme pour le journal d'audit (§9.4) en chainant les empreintes — c'est ce
 * mecanisme qui est repris ici, avec le MEME scellement, de sorte que
 * `verifyJournal` verifie les deux registres.
 *
 * Le schema des enregistrements, lui, est celui du brief, a la clef pres.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyJournal } from "../src/audit/audit-log.js";
import { calculerEcart, type EntreeEcart } from "../src/infographie/ecart.js";
import {
  SuiviIndicateurs,
  periodeIso,
  signalDEcartsRepetes,
  type EnregistrementIndicateur,
} from "../src/infographie/suivi.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-suivi-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ENTREE: EntreeEcart = {
  indicateur: "inflation_zone_euro_hicp",
  libelle: "Inflation annuelle, zone euro (IPCH)",
  unite: "points de %",
  anticipe: { value: 2.1, source: "Projections BCE de juin 2026", date: "2026-06-12" },
  realise: { value: 2.47, source: "Eurostat, prc_hicp_manr", date: "2026-07-13" },
  composantes: [
    { name: "energie", value: 0.25, method: "publiee", source: "Eurostat, contributions" },
    { name: "services", value: 0.08, method: "estimee", source: "calcul interne : poids IPCH 2026" },
  ],
};

function ecartValide(entree: EntreeEcart = ENTREE) {
  const r = calculerEcart(entree);
  if (!r.ok) throw new Error(`entree de test invalide : ${r.motif}`);
  return r.ecart;
}

/* -------------------------------------------------------------------------
 * 1. La periode
 * ---------------------------------------------------------------------- */

describe("periode ISO", () => {
  it("nomme la periode au format du brief", () => {
    expect(periodeIso(new Date("2026-09-18T12:00:00Z"))).toBe("2026-W38");
  });

  it("rattache une fin d'annee a l'annee ISO, pas a l'annee civile", () => {
    // Le 1er janvier 2027 est un vendredi : il appartient a la semaine 53 de
    // 2026. Numeroter sur l'annee civile ferait repartir le suivi a zero en
    // plein milieu d'une serie, et « 3 periodes consecutives » deviendrait faux.
    expect(periodeIso(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });

  it("rattache une fin d'annee civile a la semaine 1 de l'annee suivante", () => {
    // Le 29 decembre 2025 est le lundi de la semaine 1 de 2026.
    expect(periodeIso(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01");
  });

  it("numerote sur deux chiffres, pour que les periodes se trient", () => {
    expect(periodeIso(new Date("2026-02-05T12:00:00Z"))).toBe("2026-W06");
  });
});

/* -------------------------------------------------------------------------
 * 2. Le schema du brief
 * ---------------------------------------------------------------------- */

describe("enregistrement — le schema est celui du brief", () => {
  it("ecrit un ecart calcule avec les clefs attendues", async () => {
    const suivi = new SuiviIndicateurs({ dir });
    const enregistre = await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "public/graphiques/inflation-2026-W38.svg",
      article_id: "art-2026-09-18-inflation",
      factchecked: true,
    });

    expect(enregistre.indicator).toBe("inflation_zone_euro_hicp");
    expect(enregistre.period).toBe("2026-W38");
    expect(enregistre.anticipated).toMatchObject({
      value: 2.1,
      source: "Projections BCE de juin 2026",
      frozen_at: "2026-06-12",
    });
    expect(enregistre.realized).toMatchObject({
      value: 2.47,
      source: "Eurostat, prc_hicp_manr",
      published_at: "2026-07-13",
    });
    expect(enregistre.gap).toBeCloseTo(0.37, 10);
    expect(enregistre.residual).toBeCloseTo(0.04, 10);
    expect(enregistre.components).toEqual([
      { name: "energie", value: 0.25, method: "publiee", source: "Eurostat, contributions" },
      {
        name: "services",
        value: 0.08,
        method: "estimee",
        source: "calcul interne : poids IPCH 2026",
      },
    ]);
    expect(enregistre.chart_file).toBe("public/graphiques/inflation-2026-W38.svg");
    expect(enregistre.article_id).toBe("art-2026-09-18-inflation");
    expect(enregistre.factchecked).toBe(true);
  });

  it("enregistre une anticipation EN ATTENTE, realise et ecart a null", async () => {
    // Le brief le prevoit explicitement : `"realized": {"value": null}`,
    // `"gap": null`. C'est l'anticipation a confronter a la prochaine
    // execution — un ecart n'existe pas encore, et zero serait un mensonge.
    const suivi = new SuiviIndicateurs({ dir });
    const attente = await suivi.enregistrerAnticipation({
      indicator: "taux_directeur_bce",
      period: "2026-W38",
      anticipated: { value: 2.5, source: "Consensus Reuters", frozen_at: "2026-09-15" },
      article_id: "art-2026-09-18-bce",
    });

    expect(attente.realized.value).toBeNull();
    expect(attente.realized.published_at).toBeNull();
    expect(attente.gap).toBeNull();
    expect(attente.residual).toBeNull();
    expect(attente.factchecked).toBe(false);
    expect(attente.components).toEqual([]);
  });

  it("retrouve les anticipations en attente, pour la prochaine execution", async () => {
    const suivi = new SuiviIndicateurs({ dir });
    await suivi.enregistrerAnticipation({
      indicator: "taux_directeur_bce",
      period: "2026-W38",
      anticipated: { value: 2.5, source: "Consensus Reuters", frozen_at: "2026-09-15" },
      article_id: "art-2026-09-18-bce",
    });
    await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "",
      article_id: "art-2026-09-18-inflation",
      factchecked: true,
    });

    const attente = await suivi.enAttente();
    expect(attente.map((e) => e.indicator)).toEqual(["taux_directeur_bce"]);
  });
});

/* -------------------------------------------------------------------------
 * 3. Ajout seul
 * ---------------------------------------------------------------------- */

describe("historique en AJOUT SEUL", () => {
  async function avecUneCorrection() {
    const suivi = new SuiviIndicateurs({ dir });
    const initial = await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "",
      article_id: "art-2026-09-18-inflation",
      factchecked: false,
    });
    const corrige = await suivi.corriger(
      initial.entry_sha256,
      { factchecked: true },
      "relecture du fact-checker : composantes tracees jusqu'a Eurostat",
    );
    return { suivi, initial, corrige };
  }

  it("ne REECRIT jamais : la correction ajoute une version", async () => {
    const { suivi, initial, corrige } = await avecUneCorrection();

    const tout = await suivi.lire();
    expect(tout).toHaveLength(2);
    // L'enregistrement d'origine est intact, y compris sa valeur erronee.
    expect(tout[0]!.entry_sha256).toBe(initial.entry_sha256);
    expect(tout[0]!.factchecked).toBe(false);
    expect(tout[0]!.version).toBe(1);

    expect(corrige.version).toBe(2);
    expect(corrige.factchecked).toBe(true);
  });

  it("exige une RAISON, et la conserve avec le renvoi vers la version corrigee", async () => {
    const { initial, corrige } = await avecUneCorrection();
    expect(corrige.correction_of).toBe(initial.entry_sha256);
    expect(corrige.correction_reason).toMatch(/fact-checker/);
  });

  it("REFUSE une correction sans raison : une correction muette n'est pas une correction", async () => {
    const suivi = new SuiviIndicateurs({ dir });
    const initial = await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "",
      article_id: "art",
      factchecked: false,
    });
    await expect(suivi.corriger(initial.entry_sha256, { factchecked: true }, "  ")).rejects.toThrow(
      /raison/i,
    );
  });

  it("REFUSE de corriger un enregistrement qui n'existe pas", async () => {
    const suivi = new SuiviIndicateurs({ dir });
    await expect(
      suivi.corriger("0".repeat(64), { factchecked: true }, "raison valable"),
    ).rejects.toThrow(/introuvable/i);
  });

  it("ne rend que la DERNIERE version dans l'etat courant", async () => {
    const { suivi } = await avecUneCorrection();
    const courant = await suivi.etatCourant();
    expect(courant).toHaveLength(1);
    expect(courant[0]!.version).toBe(2);
    expect(courant[0]!.factchecked).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * 4. Le registre est VERIFIABLE
 * ---------------------------------------------------------------------- */

describe("registre chaine", () => {
  it("se verifie avec le meme controle que le journal d'audit", async () => {
    const suivi = new SuiviIndicateurs({ dir });
    await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "",
      article_id: "art",
      factchecked: true,
    });
    await suivi.enregistrerAnticipation({
      indicator: "taux_directeur_bce",
      period: "2026-W39",
      anticipated: { value: 2.5, source: "Consensus Reuters", frozen_at: "2026-09-15" },
      article_id: "art",
    });

    const lignes = (await readFile(suivi.chemin(), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lignes).toHaveLength(2);

    const controle = verifyJournal(lignes);
    expect(controle.ok, controle.reason).toBe(true);
    expect(controle.checked).toBe(2);
  });

  it("DETECTE la reecriture d'un enregistrement passe", async () => {
    // Le scenario reel : maquiller apres coup une anticipation ratee pour que
    // l'ecart publie paraisse plus petit. C'est exactement ce que « ajout seul »
    // doit empecher — et une convention ne l'empeche pas, un chainage si.
    const suivi = new SuiviIndicateurs({ dir });
    await suivi.enregistrerEcart(ecartValide(), {
      period: "2026-W38",
      chart_file: "",
      article_id: "art",
      factchecked: true,
    });
    await suivi.enregistrerAnticipation({
      indicator: "taux_directeur_bce",
      period: "2026-W39",
      anticipated: { value: 2.5, source: "Consensus Reuters", frozen_at: "2026-09-15" },
      article_id: "art",
    });

    const lignes = (await readFile(suivi.chemin(), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const falsifie = JSON.parse(lignes[0]!) as EnregistrementIndicateur;
    (falsifie as { gap: number }).gap = 0.05;
    await writeFile(suivi.chemin(), `${JSON.stringify(falsifie)}\n${lignes[1]}\n`, "utf8");

    const controle = verifyJournal(
      (await readFile(suivi.chemin(), "utf8")).split("\n").filter((l) => l.trim().length > 0),
    );
    expect(controle.ok).toBe(false);
    expect(controle.brokenAt).toBe(0);
  });

  it("reprend la chaine d'une execution a l'autre", async () => {
    // Deux instances successives, comme deux executions du pipeline : si la
    // seconde repartait de la genese, la chaine serait verifiable par segment
    // et une troncature passerait pour une reprise legitime.
    const premier = new SuiviIndicateurs({ dir });
    await premier.enregistrerAnticipation({
      indicator: "a",
      period: "2026-W38",
      anticipated: { value: 1, source: "s", frozen_at: "2026-09-15" },
      article_id: "art",
    });

    const second = new SuiviIndicateurs({ dir });
    await second.enregistrerAnticipation({
      indicator: "b",
      period: "2026-W39",
      anticipated: { value: 2, source: "s", frozen_at: "2026-09-22" },
      article_id: "art",
    });

    const lignes = (await readFile(second.chemin(), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const controle = verifyJournal(lignes);
    expect(controle.ok, controle.reason).toBe(true);
    expect(controle.checked).toBe(2);
  });
});

/* -------------------------------------------------------------------------
 * 5. Le signal au Redacteur en chef
 * ---------------------------------------------------------------------- */

describe("signal — ecarts de meme sens sur plusieurs periodes", () => {
  /** Enregistrements minimaux, seuls `period` et `gap` comptent ici. */
  function serie(ecarts: readonly (number | null)[]): EnregistrementIndicateur[] {
    return ecarts.map((gap, i) => ({
      indicator: "inflation_zone_euro_hicp",
      period: `2026-W${String(30 + i).padStart(2, "0")}`,
      anticipated: { value: 0, source: "s", frozen_at: "2026-06-12" },
      realized: { value: 0, source: "s", published_at: "2026-07-13" },
      gap,
      components: [],
      residual: null,
      chart_file: "",
      article_id: "art",
      factchecked: true,
      version: 1,
      recorded_at: "2026-09-18T00:00:00.000Z",
      entry_sha256: `x${i}`,
      prev_sha256: `x${i - 1}`,
    }));
  }

  it("remonte une serie de trois ecarts de meme sens", () => {
    const signal = signalDEcartsRepetes(serie([0.2, 0.3, 0.1]));
    expect(signal).not.toBeNull();
    expect(signal!.indicator).toBe("inflation_zone_euro_hicp");
    expect(signal!.sens).toBe("hausse");
    expect(signal!.periodes).toEqual(["2026-W30", "2026-W31", "2026-W32"]);
  });

  it("remonte aussi une serie de sous-estimations repetees", () => {
    const signal = signalDEcartsRepetes(serie([-0.2, -0.3, -0.1, -0.4]));
    expect(signal!.sens).toBe("baisse");
    expect(signal!.periodes).toHaveLength(4);
  });

  it("NE remonte RIEN sur deux periodes : deux points ne font pas une tendance", () => {
    expect(signalDEcartsRepetes(serie([0.2, 0.3]))).toBeNull();
  });

  it("repart a zero quand le sens change", () => {
    expect(signalDEcartsRepetes(serie([0.2, 0.3, 0.4, -0.1]))).toBeNull();
  });

  it("un ecart NUL interrompt la serie : il ne va dans aucun sens", () => {
    expect(signalDEcartsRepetes(serie([0.2, 0.3, 0, 0.4]))).toBeNull();
  });

  it("ignore les periodes encore EN ATTENTE plutot que de les compter comme nulles", () => {
    // Une anticipation sans realise n'est pas un ecart de zero : la compter
    // ainsi casserait une serie reelle, ou en fabriquerait une.
    const signal = signalDEcartsRepetes(serie([0.2, 0.3, null, 0.4]));
    expect(signal).not.toBeNull();
    expect(signal!.periodes).toEqual(["2026-W30", "2026-W31", "2026-W33"]);
  });

  it("ne considere que la serie la PLUS RECENTE", () => {
    // Trois hausses anciennes suivies d'une baisse : la situation actuelle
    // n'est plus celle-la, et remonter un signal perime ferait perdre son
    // credit a l'alerte.
    expect(signalDEcartsRepetes(serie([0.2, 0.3, 0.4, -0.5]))).toBeNull();
  });

  it("REFUSE une liste melangeant plusieurs indicateurs", () => {
    // Deux indicateurs confondus produiraient une serie qui n'existe pour
    // aucun des deux — un signal fabrique par un defaut d'appel.
    const melange = [...serie([0.2, 0.3]), { ...serie([0.4])[0]!, indicator: "taux_directeur_bce" }];
    expect(() => signalDEcartsRepetes(melange)).toThrow(/indicateur/i);
  });

  it("ne retient que la derniere version de chaque periode", () => {
    const base = serie([0.2, 0.3, 0.4]);
    const corrige: EnregistrementIndicateur = {
      ...base[2]!,
      gap: -0.4,
      version: 2,
      correction_of: base[2]!.entry_sha256,
      correction_reason: "chiffre Eurostat revise",
      entry_sha256: "x2bis",
    };
    expect(signalDEcartsRepetes([...base, corrige])).toBeNull();
  });
});

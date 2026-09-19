/**
 * Adaptateur RSS/Atom generique.
 *
 * Il sert a la fois une banque centrale (tier 1) et de la presse (tier 3). Le
 * meme code produit donc des observations de statuts tres differents — d'ou
 * l'importance du test qui verifie qu'il ne declare AUCUN tier lui-meme.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { rssAdapter } from "../src/sources/rss.js";

const QUERY = { topic: "inflation monetaire", since: "2026-01-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
});

const base = {
  id: "test:flux",
  source: "Editeur Test",
  url: "https://exemple.test/rss.xml",
  describes: "Flux de test",
};

function stub(corps: string, ok = true, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status, text: async () => corps })));
}

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Flux</title>${items}</channel></rss>`;

const item = (o: Partial<Record<string, string>> = {}) => `
  <item>
    <title>${o["title"] ?? "Decision de politique monetaire"}</title>
    <link>${o["link"] ?? "https://exemple.test/a"}</link>
    <pubDate>${o["pubDate"] ?? "Tue, 02 Sep 2026 10:00:00 GMT"}</pubDate>
    <description>${o["description"] ?? "Le taux directeur est maintenu."}</description>
  </item>`;

describe("analyse du flux", () => {
  it("lit un flux RSS", async () => {
    stub(rss(item()));
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toBe("https://exemple.test/a");
    expect(r.observations[0]?.resume).toMatch(/Decision de politique monetaire/);
  });

  it("ne laisse PAS de balises re-decodees dans le resume", async () => {
    // MESURE du 2026-09-19 : Business Recorder encode son HTML DEUX fois. Son
    // flux contient « &lt;p&gt;&lt;strong&gt;LAHORE: … ».
    //
    // Le nettoyage retire les balises AVANT de decoder les entites, dans cet
    // ordre precis. Consequence : « &lt;p&gt; » survit au retrait, puis devient
    // « <p> » au decodage — et le resume part avec ses balises en clair vers
    // l'Analyste, puis vers l'article.
    stub(
      rss(
        item({
          description:
            "&lt;p&gt;&lt;strong&gt;LAHORE:&lt;/strong&gt; le texte utile.&lt;/p&gt;",
        }),
      ),
    );
    const r = await rssAdapter(base).fetch(QUERY);
    const resume = r.observations[0]?.resume ?? "";

    expect(resume).toMatch(/LAHORE/);
    expect(resume).toMatch(/le texte utile/);
    // Aucune balise, quel que soit le nombre de couches d'encodage.
    expect(resume).not.toMatch(/<\/?[a-z][^>]*>/i);
  });

  it("NORMALISE un lien a double barre oblique", async () => {
    // MESURE du 2026-09-19 : le flux du blog de la BCE publie ses liens sous la
    // forme « https://www.ecb.europa.eu//press/blog/... ». L'adresse fonctionne
    // — les serveurs tolerent la barre doublee — mais elle est citee VERBATIM
    // dans l'article et dans la fiche de preuve. Une citation dont l'adresse
    // est mal formee se relit mal et se verifie moins bien.
    stub(rss(item({ link: "https://exemple.test//press/blog/a.html" })));
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations[0]?.url).toBe("https://exemple.test/press/blog/a.html");
  });

  it("ne touche PAS a une barre doublee dans la partie interrogeable", async () => {
    // La normalisation porte sur le CHEMIN seulement : une barre doublee dans
    // les parametres peut etre significative, et la reecrire changerait la
    // ressource demandee.
    stub(rss(item({ link: "https://exemple.test/a?cible=https://autre.test/x" })));
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations[0]?.url).toBe("https://exemple.test/a?cible=https://autre.test/x");
  });

  it("lit un flux Atom, dont le lien est en attribut", async () => {
    stub(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Communique</title>
          <link href="https://exemple.test/atom"/>
          <updated>2026-09-02T10:00:00Z</updated>
          <summary>Contenu du communique.</summary>
        </entry>
      </feed>`);
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations[0]?.url).toBe("https://exemple.test/atom");
  });

  it("retire les CDATA et le balisage residuel", async () => {
    // Le libelle evite volontairement le mot « CDATA » : l'y placer rendrait
    // l'assertion d'absence intestable.
    stub(rss(item({ title: "<![CDATA[Titre <b>en gras</b> ici]]>" })));
    const resume = (await rssAdapter(base).fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/Titre en gras ici/);
    expect(resume).not.toMatch(/CDATA/);
    expect(resume).not.toMatch(/<b>|<\/b>/);
  });

  it("decode l'esperluette en DERNIER", async () => {
    // La decoder avant les autres entites relancerait leur interpretation :
    // `&amp;lt;` deviendrait `<` au lieu de `&lt;`.
    stub(rss(item({ title: "Taux &amp;lt;script&amp;gt; et H&#x27;er" })));
    const resume = (await rssAdapter(base).fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/&lt;script&gt;/);
    expect(resume).toMatch(/H'er/);
  });

  it("normalise la date en ISO-8601 (§7)", async () => {
    stub(rss(item({ pubDate: "Tue, 02 Sep 2026 10:00:00 GMT" })));
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations[0]?.date_published).toBe("2026-09-02T10:00:00.000Z");
  });
});

describe("selection", () => {
  it("filtre par la fenetre de fraicheur (§5.1)", async () => {
    stub(
      rss(
        item({ link: "https://exemple.test/vieux", pubDate: "Tue, 02 Sep 2020 10:00:00 GMT" }) +
          item({ link: "https://exemple.test/recent" }),
      ),
    );
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.url).toBe("https://exemple.test/recent");
  });

  it("conserve une entree non datee, mais le signale", async () => {
    // L'absence de date n'est pas une preuve d'anciennete ; la taire
    // laisserait croire a une donnee datee.
    stub(rss(`<item><title>Sans date</title><link>https://exemple.test/x</link></item>`));
    const r = await rssAdapter(base).fetch(QUERY);
    expect(r.observations[0]?.date_published).toBeNull();
    expect(r.observations[0]?.resume).toMatch(/non datee par l'editeur/);
  });

  it("classe par pertinence au sujet, puis par fraicheur", async () => {
    stub(
      rss(
        item({ link: "https://exemple.test/hors-sujet", title: "Meteo", description: "Pluie" }) +
          item({ link: "https://exemple.test/pertinent", title: "Inflation et politique monetaire" }),
      ),
    );
    const r = await rssAdapter({ ...base, limit: 2 }).fetch(QUERY);
    expect(r.observations[0]?.url).toBe("https://exemple.test/pertinent");
  });

  it("signale une entree retenue faute de correspondance au sujet", async () => {
    stub(rss(item({ title: "Meteo", description: "Pluie" })));
    const resume = (await rssAdapter(base).fetch(QUERY)).observations[0]?.resume ?? "";
    expect(resume).toMatch(/retenue par fraicheur/);
  });

  it("respecte la limite", async () => {
    stub(rss([1, 2, 3, 4, 5].map((n) => item({ link: `https://exemple.test/${n}` })).join("")));
    expect((await rssAdapter({ ...base, limit: 2 }).fetch(QUERY)).observations).toHaveLength(2);
  });
});

describe("statut de la source", () => {
  it("NE declare AUCUN tier : c'est le registre qui le fixe (§4)", async () => {
    // Le meme code sert une banque centrale et de la presse. S'il declarait un
    // tier, il faudrait le lui dire — et un agent pourrait le falsifier.
    stub(rss(item()));
    const o = (await rssAdapter(base).fetch(QUERY)).observations[0];
    expect("tier" in (o as object)).toBe(false);
  });

  it("accole la mention fournie a chaque resume", async () => {
    // Elle voyage avec le texte jusqu'a la claim : un lecteur doit savoir
    // qu'il lit une reprise editorialisee.
    stub(rss(item()));
    const r = await rssAdapter({
      ...base,
      caveat: "Source de presse (tier 3) : couverture editorialisee.",
    }).fetch(QUERY);
    expect(r.observations[0]?.resume).toMatch(/couverture editorialisee/);
  });
});

describe("echecs", () => {
  it("echoue si le flux ne contient aucune entree", async () => {
    // Un flux qui change de forme doit se voir, pas se degrader en silence.
    stub(`<?xml version="1.0"?><rss><channel><title>Vide</title></channel></rss>`);
    await expect(rssAdapter(base).fetch(QUERY)).rejects.toThrow(/aucune entree/);
  });

  it("echoue quand rien n'est assez recent, en disant combien ont ete examinees", async () => {
    stub(rss(item({ pubDate: "Tue, 02 Sep 2019 10:00:00 GMT" })));
    await expect(rssAdapter(base).fetch(QUERY)).rejects.toThrow(/sur 1 publiee/);
  });

  it("echoue sur un statut HTTP non OK", async () => {
    stub("", false, 401);
    await expect(rssAdapter(base).fetch(QUERY)).rejects.toThrow(/HTTP 401/);
  });
});

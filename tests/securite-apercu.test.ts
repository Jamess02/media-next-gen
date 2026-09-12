/**
 * SECURITE — serveur d'apercu (`site/serve.ts`).
 *
 * Ecrits AVANT le code (TDD).
 *
 * C'est le SEUL serveur du projet qui sert des fichiers du disque. Le
 * confinement y est ecrit, mais il n'etait couvert par aucun test : une
 * protection non testee est une intention, pas une garantie — et celle-ci
 * separe le dossier publie du reste du disque, `.env` compris.
 *
 * Trois familles de menace :
 *
 *  1. TRAVERSEE DE CHEMIN, sous ses formes encodees. `..%2f`, `%2e%2e%2f`, le
 *     double encodage, la barre inversee de Windows. Une seule forme oubliee
 *     suffit.
 *  2. ROBUSTESSE. Une requete malformee ne doit pas faire tomber le processus.
 *     Le gestionnaire est un `void (async () => ...)()` : une exception non
 *     rattrapee y devient un rejet non gere, qui termine le processus Node.
 *  3. REATTACHEMENT DNS. Comme pour le studio : ecouter sur 127.0.0.1 protege
 *     du reseau, pas du navigateur. Ici l'enjeu n'est pas de declencher une
 *     action mais de LIRE — un apercu sert des brouillons que personne n'a
 *     encore relus.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serveSite } from "../src/site/serve.js";

let racine: string;
let secret: string;
let arreter: (() => Promise<void>) | undefined;
let base: string;

beforeEach(async () => {
  // Un bac a sable : le dossier servi, et un fichier sensible A COTE, la ou
  // une traversee reussie irait le chercher.
  const parent = await mkdtemp(join(tmpdir(), "media-apercu-"));
  racine = join(parent, "public");
  secret = join(parent, ".env");
  await mkdir(racine, { recursive: true });
  await writeFile(join(racine, "index.html"), "<h1>site</h1>", "utf8");
  await writeFile(join(racine, "404.html"), "<h1>introuvable</h1>", "utf8");
  await writeFile(secret, "GROQ_API_KEY=secret-a-ne-pas-servir", "utf8");

  const instance = await serveSite({ root: racine, port: 0 });
  base = instance.url;
  arreter = instance.close;
});

afterEach(async () => {
  await arreter?.();
  arreter = undefined;
});

/**
 * Requete BRUTE, chemin envoye tel quel.
 *
 * `fetch` normalise l'URL avant l'envoi : il resoudrait `/../` cote client, et
 * le serveur ne verrait jamais l'attaque. Un attaquant, lui, ecrit la ligne de
 * requete a la main.
 */
function brut(
  chemin: string,
  entetes: Record<string, string> = {},
): Promise<{ code: number; corps: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: chemin,
        method: "GET",
        headers: entetes,
      },
      (res) => {
        let corps = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (corps += c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, corps }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("traversee de chemin", () => {
  const attaques = [
    ["remontee simple", "/../.env"],
    ["remontee double", "/../../.env"],
    ["remontee encodee", "/%2e%2e/.env"],
    ["barre encodee", "/..%2f.env"],
    ["barre inversee Windows", "/..\\.env"],
    ["remontee profonde", "/a/b/../../../.env"],
    ["prefixe trompeur", "/publicx/../.env"],
  ] as const;

  for (const [nom, chemin] of attaques) {
    it(`ne sert jamais le fichier vise — ${nom}`, async () => {
      const { code, corps } = await brut(chemin);
      expect(corps).not.toContain("GROQ_API_KEY");
      expect([403, 404]).toContain(code);
    });
  }

  it("sert normalement un fichier du dossier publie", async () => {
    const { code, corps } = await brut("/index.html");
    expect(code).toBe(200);
    expect(corps).toContain("site");
  });

  it("sert l'index a la racine", async () => {
    expect((await brut("/")).code).toBe(200);
  });
});

/**
 * Requete ecrite OCTET PAR OCTET sur la socket.
 *
 * Le client HTTP de Node refuse d emettre certaines lignes de requete : une
 * espace non echappee leve `Request path contains unescaped characters`. Il
 * protege donc le serveur d attaques qu un attaquant, lui, envoie sans aucune
 * difficulte — il ecrit ses octets a la main.
 *
 * Tester avec un client poli reviendrait a verifier que le client est poli.
 */
function socketBrute(ligneDeRequete: string): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const s = connect(Number(u.port), u.hostname, () => {
      // CRLF explicites : c'est le protocole. Envoyer des LF seuls testerait
      // la tolerance de l'analyseur de Node, pas notre serveur.
      const CRLF = "\r\n";
      s.write(
        ligneDeRequete +
          CRLF +
          `Host: 127.0.0.1:${u.port}` +
          CRLF +
          "Connection: close" +
          CRLF +
          CRLF,
      );
    });
    let recu = "";
    s.setEncoding("utf8");
    s.on("data", (c: string) => (recu += c));
    s.on("end", () => resolve(recu));
    s.on("error", reject);
    // Une requete que le serveur ignorerait totalement ne doit pas figer le
    // test : l absence de reponse est elle-meme un resultat.
    s.setTimeout(4000, () => {
      s.destroy();
      resolve(recu);
    });
  });
}

describe("robustesse — une requete hostile ne tue pas le serveur", () => {
  it("survit a une rafale de lignes de requete malformees", async () => {
    // Le gestionnaire est un `void (async () => ...)()`. Une exception non
    // rattrapee y devient un rejet non gere, qui termine le processus Node —
    // donc un deni de service par une seule requete.
    const malformes = [
      "GET /% HTTP/1.1",
      "GET /%zz HTTP/1.1",
      "GET / .env HTTP/1.1",
      `GET /${"a".repeat(8000)} HTTP/1.1`,
      "GET /..%00/.env HTTP/1.1",
      "GET /%c0%ae%c0%ae/.env HTTP/1.1",
      "GET /..%252f..%252f.env HTTP/1.1",
    ];

    for (const ligne of malformes) {
      const reponse = await socketBrute(ligne);
      expect(reponse).not.toContain("GROQ_API_KEY");
    }

    // La preuve qui compte : le serveur repond ENCORE apres la rafale.
    expect((await brut("/index.html")).code).toBe(200);
  });
});

describe("en-tetes de securite", () => {
  it("pose nosniff et no-referrer sur un fichier servi", async () => {
    // L'apercu sert des BROUILLONS, dont les liens de sources sont externes.
    // Sans `no-referrer`, l'adresse d'un brouillon non relu partirait chez
    // l'editeur du site cite.
    const r = await fetch(`${base}/index.html`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("reattachement DNS", () => {
  it("refuse une requete dont l'hote n'est pas la boucle locale", async () => {
    // L'apercu sert des BROUILLONS non relus. Les rendre lisibles depuis une
    // page tierce est une fuite, meme sans effet de bord.
    const { code } = await brut("/index.html", { host: "attaquant.test" });
    expect(code).toBe(403);
  });

  it("accepte localhost et 127.0.0.1", async () => {
    const port = new URL(base).port;
    for (const hote of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await brut("/index.html", { host: hote })).code).toBe(200);
    }
  });
});

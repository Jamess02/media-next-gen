/**
 * Serveur statique local, pour relire le site avant publication.
 *
 * Dependances : `node:http` et `node:fs`. Aucune npm — servir un dossier de
 * fichiers ne justifie pas un paquet.
 *
 * SECURITE : la traversee de chemin est LE risque d'un serveur de fichiers.
 *
 * Une requete `GET /../../.env` ne doit jamais sortir du dossier publie. Deux
 * barrieres, comme pour la revision d'article : le chemin est resolu, puis on
 * verifie qu'il reste sous la racine. La seconde est inutile si la premiere
 * est correcte — c'est le principe.
 *
 * Le serveur n'ecoute que sur 127.0.0.1. Un apercu local n'a pas a etre
 * joignable depuis le reseau, d'autant qu'il peut servir des brouillons non
 * relus.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { hoteLocal } from "./loopback.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface ServeOptions {
  root: string;
  port?: number;
}

export interface ServeInstance {
  url: string;
  close: () => Promise<void>;
}

export async function serveSite(options: ServeOptions): Promise<ServeInstance> {
  const racine = resolve(options.root);
  const port = options.port ?? 4321;

  const server = createServer((req, res) => {
    void (async () => {
      // TOUT le gestionnaire est protege. Sans ce filet, une exception levee
      // hors des `try` internes — un chemin qui casse `resolve`, un en-tete
      // aberrant — devient un rejet non gere, et Node termine le processus.
      // Un deni de service par une seule requete malformee.
      try {
        // §Reattachement DNS. L'apercu sert des BROUILLONS que personne n'a
        // relus : les rendre lisibles depuis une page tierce est une fuite,
        // meme sans effet de bord.
        if (!hoteLocal(req.headers.host)) {
          res.writeHead(403).end("hote non local");
          return;
        }

        // Le chemin brut peut contenir une requete, un fragment ou un encodage.
        let chemin: string;
        try {
          chemin = decodeURIComponent(
            new URL(req.url ?? "/", "http://127.0.0.1").pathname,
          );
        } catch {
          res.writeHead(400).end("requete malformee");
          return;
        }

        // La barre inversee est un separateur SUR WINDOWS. `normalize` la
        // traite, mais seulement apres que `..\\` a ete lu comme un segment :
        // on la ramene donc a la forme POSIX avant toute resolution, pour que
        // les deux plateformes voient exactement le meme chemin.
        const cible = resolve(racine, `.${normalize(chemin.replace(/\\/g, "/"))}`);

        // Confinement : le chemin resolu doit rester sous la racine. Sans ce
        // controle, `GET /../../.env` servirait un fichier du projet.
        if (cible !== racine && !cible.startsWith(racine + sep)) {
          res.writeHead(403).end("hors du dossier publie");
          return;
        }

      let fichier = cible;
      try {
        const info = await stat(cible);
        if (info.isDirectory()) fichier = join(cible, "index.html");
      } catch {
        // Fichier absent : on sert la 404 du site, qui explique notamment
        // qu'un article peut avoir ete retire faute d'attestation valide.
        fichier = join(racine, "404.html");
      }

      try {
        await stat(fichier);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404");
        return;
      }

        res.writeHead(fichier.endsWith("404.html") ? 404 : 200, {
          "content-type": TYPES[extname(fichier)] ?? "application/octet-stream",
          // Apercu local : on ne veut jamais relire une version obsolete apres
          // avoir regenere le site.
          "cache-control": "no-store",
        });
        createReadStream(fichier).pipe(res);
      } catch {
        // Le detail n'est pas rendu au client : un message d'erreur de systeme
        // de fichiers revele des chemins absolus.
        if (!res.headersSent) res.writeHead(400).end("requete invalide");
      }
    })();
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));

  // Port reel : `port: 0` laisse le systeme en choisir un libre, ce dont les
  // tests ont besoin pour tourner sans se disputer 4321.
  const adresse = server.address();
  const portReel =
    adresse !== null && typeof adresse === "object" ? adresse.port : port;

  return {
    url: `http://127.0.0.1:${portReel}`,
    close: () =>
      new Promise<void>((resolve_) => {
        server.closeAllConnections?.();
        server.close(() => resolve_());
      }),
  };
}

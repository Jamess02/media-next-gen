/**
 * Page unique de l'interface de pilotage.
 *
 * Aucune dependance, aucun framework : du HTML et du JavaScript natif servis en
 * dur. L'outil doit demarrer en une commande et rester lisible ; y ajouter une
 * chaine de build serait disproportionne.
 *
 * REGLE DE SECURITE APPLIQUEE PARTOUT DANS CE FICHIER :
 * tout contenu dynamique est insere via `textContent`, jamais `innerHTML`.
 * Ce contenu vient du pipeline, donc indirectement de sources externes. La
 * page affiche notamment des motifs de rejet contenant du texte de claim —
 * exactement le materiau qu'une source hostile controle.
 */

export const STUDIO_PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="jeton-studio" data-jeton="__JETON__">
<title>Studio — Media Next Gen</title>
<style>
:root {
  --encre:#111; --papier:#fff; --gris:#666; --gris-clair:#949494;
  --trait:#e2e2e2; --doux:#f7f7f5; --accent:#0b57d0;
  --fort:#157347; --moyen:#b4690e; --faible:#b42318;
  color-scheme:light;
  --mono: ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
}
/* Trois etats, comme sur le site. La media query est GARDEE : sans cette
   garde, choisir « clair » sur une machine en sombre ne ferait rien, la regle
   systeme continuant de gagner. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --encre:#ececec; --papier:#101010; --gris:#9a9a9a; --gris-clair:#6f6f6f;
    --trait:#2b2b2b; --doux:#191919; --accent:#7aa7ff;
    --fort:#6dd39a; --moyen:#e0a45c; --faible:#f08a80; color-scheme:dark; }
}
:root[data-theme="dark"] { --encre:#ececec; --papier:#101010; --gris:#9a9a9a; --gris-clair:#6f6f6f;
    --trait:#2b2b2b; --doux:#191919; --accent:#7aa7ff;
    --fort:#6dd39a; --moyen:#e0a45c; --faible:#f08a80; color-scheme:dark; }
*{box-sizing:border-box}
body{margin:0;background:var(--papier);color:var(--encre);
  font-family:var(--mono);font-size:13px;line-height:1.6}
.enveloppe{max-width:1120px;margin:0 auto;padding:0 20px 80px}
header{border-bottom:2px solid var(--encre);padding:24px 0 12px;margin-bottom:26px}
h1{font-size:17px;margin:0;letter-spacing:-.02em}
.accroche{color:var(--gris);font-size:12px;margin-top:4px}
.section{font-size:11px;letter-spacing:.08em;color:var(--gris-clair);margin:26px 0 10px}
.section::before{content:"// "}
.grille{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:28px}
@media(max-width:900px){.grille{grid-template-columns:1fr}}
fieldset{border:1px solid var(--trait);border-radius:4px;padding:14px;margin:0 0 14px}
legend{font-size:11px;color:var(--gris-clair);padding:0 6px}
label{display:block;font-size:11px;color:var(--gris);margin:8px 0 4px}
input[type=text],select{width:100%;padding:8px 10px;font-family:var(--mono);
  font-size:13px;color:var(--encre);background:var(--papier);
  border:1px solid var(--trait);border-radius:3px}
input[type=text]:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.ligne{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
button{font-family:var(--mono);font-size:12px;padding:9px 16px;border-radius:3px;
  border:1px solid var(--encre);background:var(--encre);color:var(--papier);cursor:pointer}
button.secondaire{background:transparent;color:var(--encre)}
button[disabled]{opacity:.45;cursor:not-allowed}
.check{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--gris)}
#flux{border:1px solid var(--trait);border-radius:4px;padding:12px;
  min-height:190px;max-height:440px;overflow:auto;background:var(--doux);font-size:12px}
.evt{padding:3px 0;border-bottom:1px dotted var(--trait);word-break:break-word}
.evt:last-child{border-bottom:none}
.etiq{display:inline-block;min-width:104px;color:var(--gris-clair)}
.ok{color:var(--fort)} .attention{color:var(--moyen)} .ko{color:var(--faible)}
.carte{border:1px solid var(--trait);border-radius:4px;padding:11px 13px;margin-bottom:9px}
.carte .t{font-weight:600;font-size:13px;margin-bottom:5px}
.meta{color:var(--gris);font-size:11px}
.badge{display:inline-block;font-size:10px;padding:2px 6px;border:1px solid var(--trait);
  border-radius:3px;margin-right:4px;color:var(--gris)}
.badge.n3,.badge.n4{color:var(--fort)} .badge.n2{color:var(--moyen)}
.badge.n0,.badge.n1{color:var(--faible)}
.note-vague{color:var(--gris);font-size:11px}
.vide{color:var(--gris);font-size:12px;padding:14px;border:1px dashed var(--trait);border-radius:4px}

/* Recherche et rangement des brouillons. Quarante et un articles dans un seul
   tas rendent la relecture penible ; le rangement vient du serveur, la page ne
   fait qu'afficher les titres de groupe et filtrer a la saisie. */
.barre-recherche{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.barre-recherche input{flex:1;min-width:0;font:inherit;font-size:13px;padding:6px 9px;
  border:1px solid var(--trait);border-radius:3px;background:var(--papier);color:var(--encre)}
.compte{font-size:11.5px;color:var(--gris);white-space:nowrap}
.sous-section{font-family:var(--mono);font-size:11px;letter-spacing:.06em;
  color:var(--gris-clair);margin:22px 0 8px}

/* Une categorie est un BOUTON : on clique pour l'ouvrir. Le chevron suit
   aria-expanded, de sorte que l'etat affiche et l'etat annonce aux outils
   d'accessibilite ne puissent pas diverger. */
.groupe-thematique{display:block;width:100%;text-align:left;font:inherit;
  font-family:var(--mono);font-size:12px;letter-spacing:.04em;color:var(--encre);
  background:var(--doux);border:1px solid var(--trait);border-radius:4px;
  padding:8px 11px;margin:0 0 7px;cursor:pointer}
.groupe-thematique:hover{border-color:var(--gris-clair)}
.groupe-thematique::before{content:"▸  "}
.groupe-thematique[aria-expanded="true"]::before{content:"▾  "}
.groupe-thematique .n{color:var(--gris)}
.groupe{margin:0 0 16px;padding-left:11px;border-left:2px solid var(--trait)}
.groupe.replie{display:none}
/* --- relecture ------------------------------------------------------------
   Le bloc de validation est visuellement distinct du reste : c'est le seul
   endroit de l'interface ou une action engage une PERSONNE, pas la machine. */
.relire{margin-top:9px;padding-top:9px;border-top:1px dashed var(--trait)}
.relire input{font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--trait);
  border-radius:3px;background:var(--papier);color:var(--encre)}
.relire input.nom{width:150px} .relire input.note{width:210px}
.relire button{font:inherit;font-size:12px;padding:4px 9px;margin-left:5px}
.relire .rappel{color:var(--gris);font-size:11px;margin-top:5px}
.atteste{font-size:11px;color:var(--fort);border:1px solid var(--fort);
  border-radius:3px;padding:3px 7px;display:inline-block}
/* L'apercu est un CADRE portant la page d'article du site, pas du texte :
   la relecture doit se faire sur la forme reellement publiee. Hauteur
   genereuse — un article long relu dans une fenetre de 340px ne se relit pas. */
.apercu{margin-top:8px;width:100%;height:68vh;min-height:420px;border:1px solid var(--trait);
  border-radius:3px;background:var(--papier);display:block}
.relire .ouvrir{font-size:11.5px;margin-left:9px;color:var(--gris)}
.relire .ouvrir:hover{color:var(--encre)}
.echec{color:var(--faible);font-size:11.5px;margin-top:5px;white-space:pre-wrap}
ul.brut{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}
ul.brut li{padding:4px 0;border-bottom:1px dotted var(--trait);font-size:11px;
  color:var(--gris);word-break:break-all}
/* Bouton de theme, dans le coin de l en-tete. */
header{position:relative}
#theme-bascule{position:absolute;top:24px;right:0;font-size:11px;padding:5px 10px;
  background:transparent;color:var(--gris);border:1px solid var(--trait)}
#theme-bascule:hover{color:var(--encre);border-color:var(--encre)}
</style>
<script>
// Decide le theme AVANT le premier rendu : applique plus tard, il produirait un
// flash blanc a chaque ouverture. Meme clef que le site public, pour qu un
// choix fait dans l un vaille dans l autre. Le try/catch n est pas decoratif :
// en navigation privee, localStorage LEVE, et sans lui la page ne s afficherait
// pas du tout.
(function () {
  try {
    var choix = localStorage.getItem("theme");
    if (choix === "dark" || choix === "light") {
      document.documentElement.setAttribute("data-theme", choix);
    }
  } catch (e) {
    /* stockage indisponible : on suit le reglage systeme */
  }
})();
</script>
</head>
<body>
<div class="enveloppe">
<header>
  <h1>Studio — Media Next Gen</h1>
  <div class="accroche">Pilotage local du pipeline editorial. Un arret du gate est un resultat, pas une panne.</div>
  <button id="theme-bascule" type="button" class="secondaire">theme : systeme</button>
</header>

<div class="grille">
  <div>
    <div class="section">execution</div>
    <fieldset>
      <legend>parametres</legend>
      <label for="sujet">sujet de veille</label>
      <input type="text" id="sujet" value="resserrement monetaire et donnees commerciales" autocomplete="off">
      <label for="provider">fournisseur</label>
      <select id="provider"></select>
      <div class="ligne">
        <span class="check"><input type="checkbox" id="sources"> <label for="sources" style="margin:0">sources reelles</label></span>
      </div>
      <div class="ligne">
        <button id="lancer">lancer le pipeline</button>
        <button id="generer" class="secondaire">generer le site</button>
      </div>
      <div class="ligne">
        <button id="vague">vague de 6 articles</button>
        <span class="note-vague">4 constats + 2 prospectifs — brouillons, jamais publies</span>
      </div>
    </fieldset>

    <div class="section">deroulement</div>
    <div id="flux"><div class="evt meta">En attente.</div></div>
  </div>

  <div>
    <div class="section">brouillons — a relire et valider</div>
    <div class="barre-recherche">
      <input id="recherche" type="search" autocomplete="off" spellcheck="false"
             placeholder="chercher : titre ou thematique">
      <span id="compte-recherche" class="compte"></span>
    </div>
    <div class="sous-section">les plus recents</div>
    <div id="derniers-brouillons"></div>

    <div class="sous-section">par thematique</div>
    <div id="articles"><div class="vide">Chargement…</div></div>

    <div class="section">journal d'audit (§9.4)</div>
    <ul class="brut" id="audit"></ul>
  </div>
</div>
</div>

<script>
// Jeton de session, depose par le serveur dans la page. Il accompagne chaque
// appel a l API : une page tierce ne peut pas le deviner, donc pas declencher
// le pipeline a l aveugle.
const JETON = document.querySelector("meta[name=jeton-studio]").dataset.jeton;
const $ = (id) => document.getElementById(id);
const flux = $("flux");

/* --- rendu des brouillons --- */
/**
 * Fonds des brouillons, tel que le SERVEUR l a range : groupe par thematique,
 * puis du plus recent au plus ancien a l interieur de chaque groupe. La page ne
 * retrie rien — elle insere un titre quand la thematique change, et filtre.
 */
let ARTICLES = [];

/**
 * Correspondance de recherche : CHAQUE mot saisi doit se retrouver, dans le
 * titre ou dans la thematique. Tous les mots, et non un seul — « seisme japon »
 * doit reduire la liste, pas l elargir.
 */
function correspond(a, q) {
  if (!q) return true;
  const foin = (a.titre + " " + a.thematique).toLowerCase();
  return q.split(/\s+/).every((mot) => foin.indexOf(mot) >= 0);
}

/** La carte d un article. Tout passe par textContent, comme ailleurs. */
function carteArticle(a) {
  const c = document.createElement("div");
  c.className = "carte";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = a.titre;
  c.appendChild(t);
  const m = document.createElement("div");
  m.className = "meta";
  for (const cl of a.claims) {
    const b = document.createElement("span");
    b.className = "badge n" + cl.niveau;
    b.textContent = cl.type + " · preuve " + cl.niveau + "/4 · " + cl.sources + " src";
    m.appendChild(b);
  }
  c.appendChild(m);
  const d = document.createElement("div");
  d.className = "meta";
  d.textContent = "produit " + a.publie + (a.revise ? " · revise " + a.revise : "") +
    " · " + a.incertitudes + " incertitude(s) · " + a.ecartees + " ecartee(s)";
  c.appendChild(d);
  c.appendChild(blocRelecture(a));
  return c;
}

/** Du plus recent au plus ancien. */
function parDateDecroissante(liste) {
  return liste.slice().sort((x, y) => (x.publie < y.publie ? 1 : x.publie > y.publie ? -1 : 0));
}

/**
 * Rendu de la liste : les plus recents en tete, puis les categories repliables.
 *
 * DEUX EXIGENCES DE L EDITEUR, et elles tirent en sens inverse. Les categories
 * doivent etre CLIQUABLES, donc repliees — sinon il n y a rien a ouvrir. Mais
 * les articles les plus recents doivent RESTER VISIBLES, et tout replier les
 * cacherait. D ou les deux zones : un bandeau des derniers brouillons, toutes
 * categories confondues, puis les categories elles-memes.
 *
 * UNE RECHERCHE OUVRE LES CATEGORIES. Cacher des resultats qu on vient de
 * trouver serait absurde.
 *
 * LE COMPTE EST TOUJOURS AFFICHE : une recherche laissee dans le champ ferait
 * autrement croire que le fonds est vide alors qu il est seulement filtre.
 */
function rendreArticles() {
  const champ = $("recherche");
  const q = (champ && champ.value ? champ.value : "").trim().toLowerCase();
  const retenus = ARTICLES.filter((a) => correspond(a, q));

  $("compte-recherche").textContent = q
    ? retenus.length + " sur " + ARTICLES.length
    : ARTICLES.length + " brouillon(s)";

  // --- Les plus recents, quelle que soit leur categorie ------------------
  const recents = $("derniers-brouillons");
  recents.textContent = "";
  for (const a of parDateDecroissante(retenus).slice(0, 6)) {
    recents.appendChild(carteArticle(a));
  }

  // --- Les categories ----------------------------------------------------
  const box = $("articles");
  box.textContent = "";

  if (retenus.length === 0) {
    const v = document.createElement("div");
    v.className = "vide";
    v.textContent = q
      ? "Aucun article ne correspond a cette recherche."
      : "Aucun article publie.";
    box.appendChild(v);
    return;
  }

  // Le serveur a deja range : on suit son ordre de categories sans le recalculer.
  const ordre = [];
  const parThematique = {};
  for (const a of retenus) {
    if (parThematique[a.thematique] === undefined) {
      parThematique[a.thematique] = [];
      ordre.push(a.thematique);
    }
    parThematique[a.thematique].push(a);
  }

  for (const thematique of ordre) {
    const articles = parDateDecroissante(parThematique[thematique]);

    const entete = document.createElement("button");
    entete.className = "groupe-thematique";
    entete.setAttribute("type", "button");
    entete.textContent = thematique;
    const compte = document.createElement("span");
    compte.className = "n";
    compte.textContent = " · " + articles.length;
    entete.appendChild(compte);

    const contenu = document.createElement("div");
    for (const a of articles) contenu.appendChild(carteArticle(a));

    let ouvert = q.length > 0;
    const appliquer = () => {
      contenu.className = ouvert ? "groupe" : "groupe replie";
      entete.setAttribute("aria-expanded", ouvert ? "true" : "false");
    };
    appliquer();
    entete.addEventListener("click", () => {
      ouvert = !ouvert;
      appliquer();
    });

    box.appendChild(entete);
    box.appendChild(contenu);
  }
}
/* --- fin rendu des brouillons --- */

$("recherche").addEventListener("input", rendreArticles);

// Tout passe par textContent : le contenu vient du pipeline, donc
// indirectement de sources externes.
function ligne(etiquette, texte, classe) {
  const d = document.createElement("div");
  d.className = "evt";
  const e = document.createElement("span");
  e.className = "etiq " + (classe || "");
  e.textContent = etiquette;
  d.appendChild(e);
  d.appendChild(document.createTextNode(texte));
  flux.appendChild(d);
  flux.scrollTop = flux.scrollHeight;
  return d;
}

/**
 * Bloc de relecture d'un article.
 *
 * Deja valide : on montre QUI a atteste, et plus aucun formulaire — une
 * attestation ne se refait pas depuis l'interface.
 *
 * Pas encore valide : lire, puis nommer, puis valider. Le champ du relecteur
 * est VIDE et le reste. Ni valeur par defaut, ni nom memorise d'une fois sur
 * l'autre : ce champ affirme qu'une personne a lu, et le pre-remplir en ferait
 * une case a cocher.
 */
function blocRelecture(a) {
  const bloc = document.createElement("div");
  bloc.className = "relire";

  if (a.valide) {
    const s = document.createElement("span");
    s.className = "atteste";
    s.textContent = "VALIDE — relu par " + a.relecteur;
    bloc.appendChild(s);
    return bloc;
  }

  const lire = document.createElement("button");
  lire.className = "secondaire";
  lire.textContent = "lire";

  const nom = document.createElement("input");
  nom.type = "text";
  nom.className = "nom";
  nom.placeholder = "votre nom";
  nom.autocomplete = "off";

  const note = document.createElement("input");
  note.type = "text";
  note.className = "note";
  note.placeholder = "note de relecture (facultatif)";
  note.autocomplete = "off";

  const valider = document.createElement("button");
  valider.textContent = "valider";

  const ligne = document.createElement("div");
  ligne.appendChild(lire);
  ligne.appendChild(nom);
  ligne.appendChild(note);
  ligne.appendChild(valider);
  bloc.appendChild(ligne);

  const rappel = document.createElement("div");
  rappel.className = "rappel";
  rappel.textContent =
    "Valider promeut ce brouillon vers articles/ et signe une attestation a votre nom (§6).";
  bloc.appendChild(rappel);

  const message = document.createElement("div");
  message.className = "echec";
  bloc.appendChild(message);

  // L'apercu charge la page d'article TELLE QUE LE SITE la rend, dans un
  // cadre. Le markdown brut ne portait ni fiches de preuve, ni tableau de
  // chiffres, ni encart d'incertitudes — c'est-a-dire precisement ce qu'une
  // relecture doit controler. Attester sur un texte ampute de ses preuves,
  // c'est attester de ce qu'on n'a pas vu.
  //
  // Un cadre plutot qu'une insertion directe : la page du studio n'interpole
  // JAMAIS de HTML (voir l'en-tete du serveur), et le document rendu porte ses
  // propres styles.
  lire.addEventListener("click", () => {
    const deja = bloc.querySelector(".apercu");
    if (deja) { deja.remove(); lire.textContent = "lire"; return; }
    const cadre = document.createElement("iframe");
    cadre.className = "apercu";
    cadre.setAttribute("loading", "lazy");
    cadre.setAttribute("title", "Apercu de « " + a.titre + " »");
    // allow-same-origin laisse le document heriter du theme ; les scripts
    // restent interdits, le contenu n'ayant rien a executer.
    cadre.setAttribute("sandbox", "allow-same-origin");
    cadre.src = urlApercu(a.id);
    bloc.appendChild(cadre);
    lire.textContent = "replier";
  });

  const ouvrir = document.createElement("a");
  ouvrir.className = "ouvrir";
  ouvrir.target = "_blank";
  ouvrir.rel = "noopener";
  ouvrir.textContent = "ouvrir en pleine page";
  ouvrir.href = urlApercu(a.id);
  ouvrir.setAttribute("data-apercu", a.id);
  ligne.appendChild(ouvrir);

  valider.addEventListener("click", async () => {
    message.textContent = "";
    if (nom.value.trim() === "") {
      // Meme refus que le serveur, dit ici pour que l'editeur comprenne
      // POURQUOI plutot que de recevoir une erreur apres coup.
      message.textContent =
        "Nommez-vous : une relecture anonyme n'engage personne. Ce champ ne peut pas etre rempli a votre place.";
      nom.focus();
      return;
    }
    valider.disabled = true;
    valider.textContent = "validation…";
    try {
      const r = await fetch("/api/valider?jeton=" + JETON, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: a.id, relecteur: nom.value, note: note.value }),
      });
      const j = await r.json();
      if (!r.ok) {
        message.textContent = j.erreur || ("echec (" + r.status + ")");
        return;
      }
      await charger();
    } catch (e) {
      message.textContent = String(e);
    } finally {
      valider.disabled = false;
      valider.textContent = "valider";
    }
  });

  return bloc;
}

async function charger() {
  const r = await fetch("/api/etat?jeton=" + JETON);
  const etat = await r.json();

  const sel = $("provider");
  if (sel.options.length === 0) {
    for (const f of etat.fournisseurs) {
      const o = document.createElement("option");
      o.value = f.nom;
      o.textContent = f.nom + (f.pret ? "" : " (indisponible)") + " — " + f.note;
      o.disabled = !f.pret;
      sel.appendChild(o);
    }
  }

  ARTICLES = etat.articles;
  rendreArticles();

  const j = $("audit");
  j.textContent = "";
  for (const e of etat.audit) {
    const li = document.createElement("li");
    li.textContent = e.kind + " · " + e.agent + " · " + e.target +
      (e.error ? " · ECHEC: " + e.error : "") +
      (e.redacted_params ? " · caviarde: " + e.redacted_params.join(",") : "");
    j.appendChild(li);
  }
}

$("lancer").addEventListener("click", () => {
  const bouton = $("lancer");
  bouton.disabled = true;
  flux.textContent = "";

  const p = new URLSearchParams({
    sujet: $("sujet").value,
    provider: $("provider").value,
    sources: $("sources").checked ? "reelles" : "simulees",
  });
  const es = new EventSource("/api/publier?jeton=" + JETON + "&" + p.toString());

  es.addEventListener("demarrage", (e) => {
    const d = JSON.parse(e.data);
    ligne("demarrage", d.modele + " · sources " + d.sources + " (" + d.nbAdapters + ")");
  });
  es.addEventListener("avertissement", (e) => ligne("avertis.", JSON.parse(e.data).message, "attention"));
  es.addEventListener("source-ecartee", (e) => {
    const d = JSON.parse(e.data);
    ligne("non branchee", d.id + " — " + d.motif, "attention");
  });
  es.addEventListener("etape", (e) => {
    const d = JSON.parse(e.data);
    ligne(d.etape, d.detail);
  });
  es.addEventListener("arret", (e) => {
    const d = JSON.parse(e.data);
    ligne("ARRET", "etape " + d.etape + " — " + d.motif, "attention");
    for (const det of d.details) ligne("", "  " + det, "attention");
    ligne("", "Un arret n'est pas une panne : le gate du §9.3 a fait son travail.");
  });
  es.addEventListener("publie", (e) => {
    const d = JSON.parse(e.data);
    ligne("PUBLIE", d.titre + " (" + d.claims + " claims)", "ok");
    for (const a of d.ajustements) ligne("ajustement", a, "attention");
    for (const w of d.avertissements) ligne("avertis.", w, "attention");
  });
  es.addEventListener("audit", (e) => ligne("audit", JSON.parse(e.data).appels + " appel(s) externe(s)"));
  es.addEventListener("erreur", (e) => ligne("ERREUR", JSON.parse(e.data).message, "ko"));
  es.addEventListener("fin", () => {
    es.close();
    bouton.disabled = false;
    charger();
  });
  es.onerror = () => { es.close(); bouton.disabled = false; };
});

$("generer").addEventListener("click", async () => {
  const b = $("generer");
  b.disabled = true;
  try {
    const r = await fetch("/api/site?jeton=" + JETON, { method: "POST" });
    const d = await r.json();
    ligne("site", d.publies + " article(s), " + d.pages + " page(s) -> " + d.dossier, "ok");
    for (const rej of d.rejetes) ligne("rejete", rej.file + " — " + rej.reason, "attention");
  } finally {
    b.disabled = false;
  }
});

/* --- Theme ---------------------------------------------------------------
   Trois etats : systeme -> sombre -> clair -> systeme. Revenir au systeme est
   un etat a part entiere : sans lui, quiconque a essaye la bascule ne pourrait
   plus jamais suivre son reglage machine. */
function themeCourant() {
  var t = document.documentElement.getAttribute("data-theme");
  return t === "dark" || t === "light" ? t : null;
}

// Le cadre d apercu ne peut pas lire le choix lui-meme (sandbox sans scripts) :
// on le lui transmet. Sans cela, l editeur en sombre relirait l article en
// clair — une autre page que celle d un lecteur ayant fait le meme choix.
function urlApercu(id) {
  var t = themeCourant();
  return "/apercu?jeton=" + JETON + "&id=" + encodeURIComponent(id) + (t ? "&theme=" + t : "");
}

(function () {
  var bouton = $("theme-bascule");
  var ETATS = ["systeme", "dark", "light"];
  var LIBELLES = { systeme: "theme : systeme", dark: "theme : sombre", light: "theme : clair" };

  function lire() {
    var t = themeCourant();
    return t === null ? "systeme" : t;
  }

  function appliquer(etat) {
    if (etat === "systeme") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", etat);
    bouton.textContent = LIBELLES[etat];
    bouton.setAttribute("aria-label", "Changer le theme d affichage. Actuel : " + LIBELLES[etat]);
    try {
      if (etat === "systeme") localStorage.removeItem("theme");
      else localStorage.setItem("theme", etat);
    } catch (e) {
      /* stockage indisponible : le choix vaut pour cette page seulement */
    }
    // Les apercus deja ouverts suivent le nouveau choix.
    document.querySelectorAll("iframe.apercu").forEach(function (f) {
      var id = new URL(f.src, location.href).searchParams.get("id");
      if (id) f.src = urlApercu(id);
    });
    document.querySelectorAll("a[data-apercu]").forEach(function (l) {
      l.href = urlApercu(l.getAttribute("data-apercu"));
    });
  }

  appliquer(lire());
  bouton.addEventListener("click", function () {
    appliquer(ETATS[(ETATS.indexOf(lire()) + 1) % ETATS.length]);
  });
})();

charger();

// --- Vague manuelle de six articles ---------------------------------------
// Le compteur est garde dans le navigateur pour que deux declenchements
// successifs ne redonnent pas les six memes sujets. Il tombe a zero si le
// stockage est indisponible : moins bien, mais jamais bloquant.
function indexVague() {
  try {
    return Number(localStorage.getItem("vague-index") || "0") || 0;
  } catch (e) {
    return 0;
  }
}

$("vague").addEventListener("click", () => {
  const b = $("vague");
  b.disabled = true;
  const index = indexVague();
  const p = new URLSearchParams({
    jeton: JETON,
    provider: $("provider").value,
    index: String(index),
  });
  const es = new EventSource("/api/vague?" + p.toString());

  es.addEventListener("vague-demarrage", (e) => {
    const d = JSON.parse(e.data);
    ligne("vague", "vague " + d.index + " — " + d.taille + " articles, " + d.modele + ", " + d.sources + " sources");
  });
  es.addEventListener("vague-progres", (e) => {
    const d = JSON.parse(e.data);
    ligne("etape", "[" + d.fait + "/" + d.total + "] " + d.mode + " — " + d.sujet);
  });
  es.addEventListener("vague-ligne", (e) => {
    const d = JSON.parse(e.data);
    const niveau = d.etat === "publie" ? "ok" : d.etat === "arrete" ? "attention" : "erreur";
    ligne(d.etat, d.mode + " — " + d.sujet + (d.motif ? " — " + d.motif : ""), niveau);
  });
  es.addEventListener("vague-fin", (e) => {
    const d = JSON.parse(e.data);
    ligne("vague", d.publies + " brouillon(s), " + d.arretes + " arret(s), " + d.erreurs + " erreur(s)", d.publies > 0 ? "ok" : "attention");
    try { localStorage.setItem("vague-index", String(index + 1)); } catch (e) {}
  });
  es.addEventListener("erreur", (e) => ligne("erreur", JSON.parse(e.data).message, "erreur"));
  es.addEventListener("fin", () => {
    es.close();
    b.disabled = false;
    charger();
  });
  es.onerror = () => { es.close(); b.disabled = false; };
});
</script>
</body>
</html>`;

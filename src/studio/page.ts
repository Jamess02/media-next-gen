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
<title>Studio — Media Next Gen</title>
<style>
:root {
  --encre:#111; --papier:#fff; --gris:#666; --gris-clair:#949494;
  --trait:#e2e2e2; --doux:#f7f7f5; --accent:#0b57d0;
  --fort:#157347; --moyen:#b4690e; --faible:#b42318;
  --mono: ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --encre:#ececec; --papier:#101010; --gris:#9a9a9a; --gris-clair:#6f6f6f;
    --trait:#2b2b2b; --doux:#191919; --accent:#7aa7ff;
    --fort:#6dd39a; --moyen:#e0a45c; --faible:#f08a80; }
}
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
.vide{color:var(--gris);font-size:12px;padding:14px;border:1px dashed var(--trait);border-radius:4px}
ul.brut{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}
ul.brut li{padding:4px 0;border-bottom:1px dotted var(--trait);font-size:11px;
  color:var(--gris);word-break:break-all}
</style>
</head>
<body>
<div class="enveloppe">
<header>
  <h1>Studio — Media Next Gen</h1>
  <div class="accroche">Pilotage local du pipeline editorial. Un arret du gate est un resultat, pas une panne.</div>
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
    </fieldset>

    <div class="section">deroulement</div>
    <div id="flux"><div class="evt meta">En attente.</div></div>
  </div>

  <div>
    <div class="section">articles publies</div>
    <div id="articles"><div class="vide">Chargement…</div></div>

    <div class="section">journal d'audit (§9.4)</div>
    <ul class="brut" id="audit"></ul>
  </div>
</div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const flux = $("flux");

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

async function charger() {
  const r = await fetch("/api/etat");
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

  const box = $("articles");
  box.textContent = "";
  if (etat.articles.length === 0) {
    const v = document.createElement("div");
    v.className = "vide";
    v.textContent = "Aucun article publie.";
    box.appendChild(v);
  }
  for (const a of etat.articles) {
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
    d.textContent = "publie " + a.publie + (a.revise ? " · revise " + a.revise : "") +
      " · " + a.incertitudes + " incertitude(s) · " + a.ecartees + " ecartee(s)";
    c.appendChild(d);
    box.appendChild(c);
  }

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
  const es = new EventSource("/api/publier?" + p.toString());

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
    const r = await fetch("/api/site", { method: "POST" });
    const d = await r.json();
    ligne("site", d.publies + " article(s), " + d.pages + " page(s) -> " + d.dossier, "ok");
    for (const rej of d.rejetes) ligne("rejete", rej.file + " — " + rej.reason, "attention");
  } finally {
    b.disabled = false;
  }
});

charger();
</script>
</body>
</html>`;

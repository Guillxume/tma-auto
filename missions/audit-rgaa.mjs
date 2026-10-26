// Mission « audit-rgaa » : audit d'accessibilité RGAA 4.1.2 d'un site (production en lecture seule, ou recette),
// rendu en rapport HTML.
// L'agent écrit audit.json dans son dossier de travail ; ce module le prépare, le valide, calcule le taux
// (règle officielle) et produit le rapport. Le taux n'est jamais calculé par l'agent.
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['C', 'NC', 'NA', 'AV'];
const SEVERITIES = ['bloquant', 'majeur', 'modere', 'mineur'];
const PRIORITIES = ['immediate', 'prochaine', 'fil'];
export const GRID_DIR = (kd) => path.join(kd, 'skills', 'rgaa', 'references', 'rgaa-4.1.2');

// Référentiel officiel : thèmes, critères, intitulés, références WCAG.
export function loadCriteria(kd) {
  const raw = JSON.parse(fs.readFileSync(path.join(GRID_DIR(kd), 'criteres.json'), 'utf8'));
  const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return raw.topics.map((t) => ({
    number: t.number,
    topic: t.topic,
    criteria: t.criteria.map(({ criterium: c }) => ({
      id: `${t.number}.${c.number}`,
      title: plain(c.title),
      wcag: c.references.flatMap((r) => r.wcag ?? []).map((w) => w.split(' ')[0]),
      level: c.references.flatMap((r) => r.wcag ?? []).some((w) => w.includes('(AA)')) ? 'AA' : 'A',
    })),
  }));
}

// Squelette prérempli : les 106 critères sont présents, l'agent n'a qu'à les remplir.
export function skeleton(kd, { site }) {
  const criteria = {};
  for (const t of loadCriteria(kd)) for (const c of t.criteria) criteria[c.id] = { pages: {}, note: '', findings: [] };
  return {
    site, summary: '', verdict: { headline: '', points: [] }, pages: [], criteria, findings: [], discarded: [],
    inPlace: [], lots: [], reserves: [], outOfScope: [], method: '', learnings: [],
  };
}

export const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['audit_done', 'blocked'] },
    reason: { type: 'string', description: 'En français, 2 à 4 phrases : avis, chiffres clés, ce qui reste à vérifier par un humain' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Avec blocked : précisions à demander au responsable' },
    human_estimate: {
      type: 'object',
      description: 'Temps qu\'aurait mis un humain du métier pour produire le même livrable',
      properties: {
        hours_low: { type: 'number' },
        hours_high: { type: 'number' },
        basis: { type: 'string', description: 'Sur quoi repose l\'estimation, en une phrase' },
      },
      required: ['hours_low', 'hours_high', 'basis'],
    },
  },
  required: ['status', 'reason'],
};

export function buildPrompt({ ticket, repo, base, kd, auditDir, siteUrl, production, recetteUrl, paths, previous, previousOther = null }) {
  const description = ticket.description.replaceAll('</ticket>', '');
  const decision = ticket.instructions ? `\nConsigne du responsable, prioritaire :\n${ticket.instructions}\n` : '';
  const git = `git -C ${repo.path}`;
  const reading = [
    `\`${kd}/skills/rgaa/SKILL.md\` : référentiel, échantillon, statuts, gravité, discipline.`,
    `\`${kd}/skills/rgaa/references/methode.md\` : l'outil \`tma-browse\` et comment tester chaque thème.`,
    `\`${kd}/skills/rgaa/references/rgaa-4.1.2/grille.md\` : les 106 critères et leur moyen de test. Les tests officiels détaillés sont dans \`criteres.json\` et \`methodologies.json\` du même dossier.`,
    `\`${kd}/skills/rgaa/references/defauts-connus.md\` : défauts déjà rencontrés sur le parc.`,
    repo.kind && fs.existsSync(path.join(kd, 'skills', repo.kind, 'SKILL.md')) && `\`${kd}/skills/${repo.kind}/SKILL.md\` : où sont les gabarits, ce qui ne se modifie pas (modules tiers).`,
    `Le CLAUDE.md du dépôt : \`${git} show origin/${base}:CLAUDE.md\` (absent sur certains dépôts).`,
  ].filter(Boolean).map((l, i) => `${i + 1}. ${l}`).join('\n');
  const where = production
    ? `- Site audité : **la production** ${siteUrl}, en **lecture seule**. \`tma-browse\` y coupe la mesure d'audience et bloque tout envoi de formulaire ou de données (le panier reste permis) : tu ne peux rien y envoyer, même par erreur. Ce sont les pages que voient les visiteurs, avec leurs éléments tiers (bandeau cookies, chat, avis) : ils font partie de l'audit.${recetteUrl ? `\n- Recette : ${recetteUrl} (identifiants HTTP déjà fournis à \`tma-browse\`), **uniquement** pour l'envoi réel d'un formulaire (une seule demande de devis, données de test du SKILL). Donne alors l'URL complète de la recette à \`tma-browse\`. La recette peut différer de la production : dis-le si un constat n'y est vérifié que là.` : ''}`
    : `- Site audité : la recette ${siteUrl} (identifiants HTTP déjà fournis à \`tma-browse\`). Elle peut différer de la production (version du code, éléments tiers) : dis-le dans les réserves.`;
  return `Mission : audit d'accessibilité RGAA 4.1.2 de ${production ? 'la production' : 'la recette'} de ${repo.fullName}.

<ticket>
Identifiant : ${ticket.identifier}
Titre : ${ticket.title}
URL : ${ticket.url}
Description :
${description}
</ticket>
${decision}
## Contexte

${where}
- \`tma-browse\` refuse tout autre site.
- Ton dossier de travail (dossier courant) : \`${auditDir}\`. Tu n'écris que là : \`audit.json\` (déjà prérempli des 106 critères) et tes fichiers d'étapes \`steps/*.json\`. Les relevés de \`tma-browse\` y arrivent aussi (\`pages/\`, \`runs/\`, \`shots/\`).
- Code du site, en lecture seule, pour ancrer chaque correction dans un fichier réel : le dépôt \`${repo.path}\`. Sa copie de travail peut être en retard : lis la branche de référence avec \`${git} grep -n "<motif>" origin/${base} -- <dossiers>\` et \`${git} show origin/${base}:<fichier>\`.${paths.length ? `\n- Pages demandées explicitement : ${paths.join(', ')}.` : ''}${previousOther ? `\n- Un audit précédent existe sur un **autre environnement** (${previousOther}) : \`audit.prev.json\` et ses relevés dans \`pages-${previousOther.split(' ')[0]}/\`. Sers-t'en seulement comme pistes : chaque statut est à établir ici, sur ${siteUrl}. Note dans les réserves les écarts de l'autre environnement que tu ne retrouves pas ici, et inversement.` : previous ? `\n- Un audit précédent existe : \`audit.prev.json\`. Relis-le. Reprends ce qui tient, revérifie ce qui est mis en cause par la consigne ou les commentaires, et consigne chaque révision dans \`discarded\` (piste = ce que disait l'audit précédent).` : ''}

## À lire d'abord, dans l'ordre

${reading}

## Tes outils (tout le reste est refusé)

- \`tma-browse scan|shot|tab|run|eval\` (voir methode.md ; \`tma-browse --help\` donne la syntaxe exacte des étapes de \`run\`, à lire avant d'écrire un scénario). Une commande par appel. Un scénario s'arrête à la première étape en erreur : corrige l'étape et relance-le.
- Read, Grep, Glob ; Write et Edit dans ton dossier de travail uniquement.
- \`${git} grep|show|log\` en lecture ; \`ls\`, \`wc\`.
- MCP Linear en lecture (ticket, commentaires, captures).

## Déroulé

1. Lis le ticket complet avec le MCP Linear : pages cochées dans le modèle, raison de l'audit, échéance, commentaires.
2. Construis l'échantillon (SKILL.md, 8 à 12 pages) à partir des liens réels du site (menu, pied de page). Une page obligatoire absente du site va dans les réserves.
3. \`tma-browse scan <page> --name P<n>\` sur chaque page, puis lis chaque \`summary.md\`.
4. Déroule les 106 critères, thème par thème, sur chaque page. Remplis \`audit.json\` **au fur et à mesure**, thème par thème. Un arrêt en cours de route ne doit pas tout perdre.
5. Rédige les écarts. Pour chaque écart, cherche dans le code le fichier en cause et cite-le. Ajoute les pistes écartées, les acquis, le plan en lots, les réserves et la méthode.
6. Relis \`audit.json\` en entier : chaque critère a un statut pour chaque page, chaque NC renvoie à un écart ou a une note, chaque AV dit quoi vérifier, et chaque écart cité dans un lot existe.

Formulaires : ${production ? `en production, teste la validation (champs vides, e-mail invalide) : l'envoi est bloqué par l'outil, la page qui suit l'est donc aussi. ${recetteUrl ? 'Un seul envoi réel, sur la recette, pour observer le message de confirmation.' : 'Aucun envoi réel possible : le message de confirmation va dans les réserves.'}` : 'une seule demande de devis sans compte, avec les données de test du SKILL.'} Aucun compte créé, aucune commande passée.

## Format de \`audit.json\`

Les textes sont en français, en phrases simples, sans HTML. Tu peux utiliser \`code\` entre accents graves, **gras**, et des retours à la ligne (« \\n »).

\`\`\`
{
  "site": "nom lisible du site",
  "summary": "une phrase pour l'en-tête du rapport : périmètre et référentiel",
  "verdict": { "headline": "l'avis en une phrase (non conforme, partiellement conforme ou conforme, et l'essentiel)",
               "points": ["3 à 5 points : ce qui bloque, la cause racine, ce qui est à décider"] },
  "pages": [ { "id": "P1", "name": "Accueil", "path": "/", "why": "page obligatoire" } ],
  "criteria": { "1.1": { "pages": { "P1": "C", "P2": "NC" }, "note": "sur quoi repose le statut", "findings": ["A-01"] } },
  "findings": [ { "id": "A-01", "title": "le défaut, dit simplement", "severity": "bloquant|majeur|modere|mineur",
                  "priority": "immediate|prochaine|fil", "criteria": ["11.1"], "wcag": ["1.3.1"], "pages": ["P4"], "rootCause": false,
                  "constat": "ce qui a été observé, mesuré, avec sélecteurs et valeurs",
                  "impact": "ce que ça change pour qui (profil d'utilisateur)",
                  "correction": "quoi faire, où (fichier), par ordre de préférence",
                  "verification": "comment c'a été établi, reproduit deux fois ; ce qui est déduit plutôt qu'observé",
                  "files": ["themes/…/templates/…/contact.tpl"] } ],
  "discarded": [ { "lead": "ce que l'outil ou un premier test suggérait", "evidence": "ce que la vérification montre", "decision": "écarté | non établi | conforme" } ],
  "inPlace": [ "acquis vérifiés, à ne pas casser" ],
  "lots": [ { "id": "A", "title": "Parcours clavier", "priority": "immediate|prochaine|fil", "findings": ["A-01"], "note": "pourquoi ce lot, ce qu'il débloque" } ],
  "reserves": [ "ce qui n'a pas été testé, et le risque que ça laisse" ],
  "outOfScope": [ "observations hors accessibilité, à qualifier ailleurs" ],
  "method": "méthode en 3 à 6 phrases : largeurs, scénarios joués, ce qui a été soumis",
  "learnings": [ "défaut ou faux positif qui vaut pour d'autres sites du parc (module, thème) ; vide si rien de neuf" ]
}
\`\`\`

- \`criteria\` : les 106 clés sont déjà là. Pour chacune, un statut \`C\`, \`NC\`, \`NA\` ou \`AV\` **pour chaque page** de l'échantillon. Le statut global et le taux sont calculés par le serveur.
- Un écart sans critère RGAA (\`"criteria": []\`) est un écart **hors référentiel** : renseigne \`wcag\` (par exemple 2.5.8, taille des cibles).
- \`rootCause: true\` sur l'écart qui explique plusieurs autres. Cite ces autres dans sa correction.

## Réponse finale (schéma imposé)

- \`audit_done\` quand \`audit.json\` est complet. \`reason\` : l'avis, les chiffres clés et ce qui reste à vérifier par un humain. \`human_estimate\` : le temps qu'aurait mis un auditeur accessibilité expérimenté pour le même périmètre (échantillon, grille complète, rapport rédigé), en fourchette réaliste, avec sa justification. Si tu repars d'un livrable précédent (PR existante, audit précédent, proposition déjà faite), n'estime que le travail supplémentaire.
- \`blocked\` si le site est inaccessible ou si le ticket ne permet pas de savoir quel site auditer. Explique ce qui manque ; \`questions\` (1 à 3) sera posé au responsable.`;
}

// ---------------------------------------------------------------------------
// Validation et taux
// ---------------------------------------------------------------------------

export function validate(audit, kd) {
  const errors = [];
  const err = (m) => { if (errors.length < 40) errors.push(m); };
  const ids = new Set();
  if (!Array.isArray(audit.pages) || !audit.pages.length) err('`pages` est vide : l\'échantillon doit compter au moins une page.');
  for (const p of audit.pages ?? []) {
    if (!/^P\d+$/.test(p.id ?? '')) err(`page « ${p.name ?? '?'} » : identifiant ${JSON.stringify(p.id)} invalide (attendu P1, P2…).`);
    if (ids.has(p.id)) err(`page ${p.id} en double.`);
    ids.add(p.id);
    if (!p.path) err(`page ${p.id} : \`path\` manquant.`);
  }
  const fIds = new Set((audit.findings ?? []).map((f) => f.id));
  const known = new Set(loadCriteria(kd).flatMap((t) => t.criteria.map((c) => c.id)));
  // Statuts manquants regroupés par page : une ligne par page plutôt qu'une par critère.
  const missingByPage = {};
  for (const id of known) {
    const c = audit.criteria?.[id];
    if (!c) { err(`critère ${id} absent de \`criteria\`.`); continue; }
    for (const p of ids) if (!STATUSES.includes(c.pages?.[p])) (missingByPage[p] ??= []).push(id);
  }
  for (const [p, list] of Object.entries(missingByPage)) err(`page ${p} : statut manquant ou invalide (C, NC, NA ou AV) pour ${list.length} critère(s) : ${list.slice(0, 30).join(', ')}${list.length > 30 ? '…' : ''}.`);
  for (const id of known) {
    const c = audit.criteria?.[id];
    if (!c) continue;
    const st = Object.values(c.pages ?? {});
    if (st.includes('NC') && !c.note && !(c.findings ?? []).length) err(`critère ${id} : NC sans écart ni note.`);
    if (st.includes('AV') && !c.note) err(`critère ${id} : AV sans note disant quoi vérifier.`);
    for (const f of c.findings ?? []) if (!fIds.has(f)) err(`critère ${id} : l'écart ${f} n'existe pas dans \`findings\`.`);
  }
  for (const id of Object.keys(audit.criteria ?? {})) if (!known.has(id)) err(`critère inconnu dans \`criteria\` : ${id}.`);
  const seen = new Set();
  for (const f of audit.findings ?? []) {
    if (!f.id || seen.has(f.id)) err(`écart ${f.id ?? '(sans id)'} : identifiant manquant ou en double.`);
    seen.add(f.id);
    if (!SEVERITIES.includes(f.severity)) err(`écart ${f.id} : gravité « ${f.severity} » invalide (${SEVERITIES.join(', ')}).`);
    if (!PRIORITIES.includes(f.priority)) err(`écart ${f.id} : priorité « ${f.priority} » invalide (${PRIORITIES.join(', ')}).`);
    for (const k of ['title', 'constat', 'impact', 'correction', 'verification']) if (!f[k]) err(`écart ${f.id} : \`${k}\` vide.`);
    for (const c of f.criteria ?? []) if (!known.has(c)) err(`écart ${f.id} : critère ${c} inconnu.`);
    if (!(f.criteria ?? []).length && !(f.wcag ?? []).length) err(`écart ${f.id} : ni critère RGAA ni référence WCAG.`);
    for (const p of f.pages ?? []) if (!ids.has(p)) err(`écart ${f.id} : page ${p} absente de l'échantillon.`);
  }
  for (const l of audit.lots ?? []) for (const f of l.findings ?? []) if (!fIds.has(f)) err(`lot ${l.id} : l'écart ${f} n'existe pas.`);
  if (!audit.verdict?.headline) err('`verdict.headline` vide.');
  return errors;
}

// Règle RGAA : un critère est NC s'il l'est sur au moins une page, C s'il est C partout où il s'applique,
// NA s'il ne s'applique nulle part. Taux global = C / (C + NC). Les AV donnent une fourchette.
export function computeRates(audit, kd) {
  const pageIds = audit.pages.map((p) => p.id);
  const global = {};
  for (const t of loadCriteria(kd)) {
    for (const c of t.criteria) {
      const st = pageIds.map((p) => audit.criteria[c.id]?.pages?.[p]);
      global[c.id] = st.includes('NC') ? 'NC' : st.includes('AV') ? 'AV' : st.includes('C') ? 'C' : 'NA';
    }
  }
  const count = (s) => Object.values(global).filter((v) => v === s).length;
  const C = count('C');
  const NC = count('NC');
  const AV = count('AV');
  const NA = count('NA');
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const perPage = Object.fromEntries(pageIds.map((p) => {
    const st = Object.values(audit.criteria).map((c) => c.pages?.[p]);
    const c = st.filter((s) => s === 'C').length;
    const nc = st.filter((s) => s === 'NC').length;
    return [p, pct(c, c + nc)];
  }));
  const pages = Object.values(perPage).filter((v) => v !== null);
  return {
    global, C, NC, AV, NA,
    rate: pct(C, C + NC),
    low: pct(C, C + NC + AV),
    high: pct(C + AV, C + NC + AV),
    perPage,
    average: pages.length ? Math.round((pages.reduce((a, b) => a + b, 0) / pages.length) * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------------------
// Rendu HTML (page d'Artifact : pas de doctype ni de <html>/<head>/<body>, ajoutés à la publication)
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Texte de l'agent : échappé, puis `code`, **gras** et retours à la ligne.
const fmt = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\n/g, '<br>');
const SEV = { bloquant: ['Bloquant', 'block'], majeur: ['Majeur', 'major'], modere: ['Modéré', 'mod'], mineur: ['Mineur', 'minor'] };
const PRIO = { immediate: 'immédiate', prochaine: 'prochaine version', fil: 'au fil de l\'eau' };
const ST = { C: ['C', 'conforme'], NC: ['NC', 'non conforme'], NA: ['NA', 'non applicable'], AV: ['AV', 'à vérifier'] };
const num = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ','));
const badge = (s) => `<span class="st st-${s ?? 'none'}" title="${esc(ST[s]?.[1] ?? 'non renseigné')}">${esc(ST[s]?.[0] ?? '?')}</span>`;

export function render(audit, kd, meta) {
  const crit = loadCriteria(kd);
  const r = computeRates(audit, kd);
  const pages = audit.pages;
  const findings = audit.findings ?? [];
  const bySev = (s) => findings.filter((f) => f.severity === s && !f.rootCause);
  const roots = findings.filter((f) => f.rootCause);
  const pageName = Object.fromEntries(pages.map((p) => [p.id, p.name]));
  const titleById = Object.fromEntries(crit.flatMap((t) => t.criteria.map((c) => [c.id, c])));
  const verdictSev = findings.some((f) => f.severity === 'bloquant') ? 'block' : r.NC ? 'major' : r.AV ? 'mod' : 'ok';
  const accent = meta.accent ?? '#285f74';

  const findingCard = (f) => `
<article class="finding sv-${SEV[f.severity]?.[1] ?? 'minor'}" id="${esc(f.id)}">
  <div class="f-top">
    <div class="f-id"><span class="badge">${esc(SEV[f.severity]?.[0] ?? f.severity)}</span><h3>${esc(f.id)} — ${fmt(f.title)}</h3></div>
    <p class="ref">${(f.criteria ?? []).length ? `RGAA ${f.criteria.map((c) => `<a href="#c-${c.replace('.', '-')}">${esc(c)}</a>`).join(', ')}` : '<span class="oos">Hors référentiel RGAA 4.1.2</span>'}${(f.wcag ?? []).length ? ` · WCAG ${esc(f.wcag.join(', '))}` : ''} &nbsp;|&nbsp; ${esc((f.pages ?? []).map((p) => pageName[p] ?? p).join(', ') || 'toutes les pages')} &nbsp;|&nbsp; Priorité : ${esc(PRIO[f.priority] ?? f.priority)}</p>
  </div>
  <dl class="f-fields">
    <dt>Constat</dt><dd>${fmt(f.constat)}</dd>
    <dt>Impact</dt><dd>${fmt(f.impact)}</dd>
    <dt class="fix">Correction</dt><dd class="fix">${fmt(f.correction)}${(f.files ?? []).length ? `<br><span class="files">${f.files.map((x) => `<code>${esc(x)}</code>`).join(' ')}</span>` : ''}</dd>
    <dt>Vérification</dt><dd>${fmt(f.verification)}</dd>
  </dl>
</article>`;

  const sevSection = (key, n, label, note) => {
    const list = bySev(key);
    if (!list.length) return '';
    return `
<section id="${key}" aria-labelledby="h-${key}">
  <div class="sec-head"><p class="eyebrow">${n}</p><h2 id="h-${key}">${label}</h2><p class="note">${note}</p></div>
  ${list.map(findingCard).join('\n')}
</section>`;
  };

  const gridTheme = (t) => `
<div class="theme">
  <h3 id="t-${t.number}">${t.number}. ${esc(t.topic)}</h3>
  <div class="tw"><table class="grid">
    <caption class="visually-hidden">Thème ${t.number}, ${esc(t.topic)} : statut par critère et par page</caption>
    <colgroup><col class="col-crit"><col class="col-st">${pages.map(() => '<col class="col-st">').join('')}<col></colgroup>
    <thead><tr><th scope="col">Critère</th><th scope="col">Global</th>${pages.map((p) => `<th scope="col" title="${esc(p.name)}">${esc(p.id)}</th>`).join('')}<th scope="col">Note et écarts</th></tr></thead>
    <tbody>${t.criteria.map((c) => {
      const a = audit.criteria[c.id] ?? {};
      return `<tr id="c-${c.id.replace('.', '-')}"><th scope="row"><span class="cid">${c.id}</span> <span class="ctitle">${esc(c.title)}</span> <span class="lvl">${c.level}</span></th><td>${badge(r.global[c.id])}</td>${pages.map((p) => `<td>${badge(a.pages?.[p.id])}</td>`).join('')}<td class="cnote">${fmt(a.note)}${(a.findings ?? []).length ? ` ${a.findings.map((f) => `<a href="#${esc(f)}">${esc(f)}</a>`).join(' ')}` : ''}</td></tr>`;
    }).join('')}</tbody>
  </table></div>
</div>`;

  const sevCount = (s) => findings.filter((f) => f.severity === s).length;
  const oos = findings.filter((f) => !(f.criteria ?? []).length).length;

  return `<title>Audit RGAA ${esc(audit.site)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Rapport d'audit : même famille que les audits manuels du parc (IBM Plex, fiches à liseré de gravité). */
:root{
  --ground:#f5f7f9; --surface:#ffffff; --surface-2:#eef1f4;
  --ink:#14202e; --ink-2:#41505f; --ink-3:#5f6e7d;
  --rule:#d9dfe5; --rule-soft:#e8ecf0;
  --accent:${accent}; --accent-ink:${accent};
  --sev-block:#9e2035; --sev-major:#a34f10; --sev-mod:#6f5c12; --sev-minor:#55657a;
  --ok:#2f6633; --na:#6b7785;
  --st-c-bg:#e6f0e6; --st-nc-bg:#f7e3e6; --st-av-bg:#f6efd8; --st-na-bg:#eceff2;
  --shadow:0 1px 2px rgba(20,32,46,.06), 0 1px 12px rgba(20,32,46,.04);
  --f-display:"IBM Plex Serif", Georgia, serif; --f-body:"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; --f-mono:"IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ground:#101821; --surface:#18212c; --surface-2:#1f2935;
    --ink:#e5ebf1; --ink-2:#a9b6c3; --ink-3:#8796a5;
    --rule:#2a3745; --rule-soft:#222e3a;
    --accent:#8cc3d6; --accent-ink:#a9d4e3;
    --sev-block:#ef8a9c; --sev-major:#eaa86c; --sev-mod:#d9c46e; --sev-minor:#a8b9ca;
    --ok:#93c896; --na:#9aa7b4;
    --st-c-bg:#1c2e1e; --st-nc-bg:#3a1c23; --st-av-bg:#33301a; --st-na-bg:#242e39;
    --shadow:0 1px 2px rgba(0,0,0,.4); color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --ground:#101821; --surface:#18212c; --surface-2:#1f2935;
  --ink:#e5ebf1; --ink-2:#a9b6c3; --ink-3:#8796a5;
  --rule:#2a3745; --rule-soft:#222e3a;
  --accent:#8cc3d6; --accent-ink:#a9d4e3;
  --sev-block:#ef8a9c; --sev-major:#eaa86c; --sev-mod:#d9c46e; --sev-minor:#a8b9ca;
  --ok:#93c896; --na:#9aa7b4;
  --st-c-bg:#1c2e1e; --st-nc-bg:#3a1c23; --st-av-bg:#33301a; --st-na-bg:#242e39;
  --shadow:0 1px 2px rgba(0,0,0,.4); color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0; background:var(--ground); color:var(--ink); font-family:var(--f-body); font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:0 96px}
h1,h2,h3{font-family:var(--f-display); text-wrap:balance; margin:0}
h1{font-size:clamp(28px,4.2vw,42px); font-weight:600; letter-spacing:-.015em; line-height:1.15}
h2{font-size:22px; font-weight:600}
h3{font-size:17px; font-weight:600}
p{margin:0}
.prose{max-width:68ch; color:var(--ink-2)}
.eyebrow{font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3)}
code{font-family:var(--f-mono); font-size:.86em; background:var(--surface-2); padding:1px 5px; border-radius:3px; color:var(--ink-2); word-break:break-word}
a{color:var(--accent-ink); text-decoration:underline; text-underline-offset:2px}
a:focus-visible{outline:2px solid var(--accent); outline-offset:2px; border-radius:2px}
.visually-hidden{position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap}
.mast{border-bottom:1px solid var(--rule); margin-bottom:36px}
.mast-inner{max-width:1120px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:44px 30px; display:flex; flex-direction:column; gap:16px}
.brandline{display:flex; align-items:baseline; gap:10px; flex-wrap:wrap}
.dot{width:7px; height:7px; border-radius:50%; background:var(--accent); align-self:center}
.ref{font-family:var(--f-mono); font-size:11.5px; color:var(--ink-3)}
.lede{color:var(--ink-2); max-width:64ch; font-size:16px}
.meta{display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:1px; background:var(--rule-soft); border:1px solid var(--rule-soft); border-radius:6px; overflow:hidden; margin:0}
.meta div{background:var(--surface); padding:11px 14px; min-width:0}
.meta dt{font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin-bottom:3px}
.meta dd{margin:0; font-family:var(--f-mono); font-size:12.5px; word-break:break-word}
.toc{display:flex; flex-wrap:wrap; gap:6px 16px; font-size:13px}
section{margin-top:52px}
.sec-head{display:flex; flex-direction:column; gap:6px; margin-bottom:20px; padding-bottom:12px; border-bottom:1px solid var(--rule)}
.note{font-size:13px; color:var(--ink-3); max-width:74ch}
.verdict{background:var(--surface); border:1px solid var(--rule); border-left:4px solid var(--sv); border-radius:5px; padding:22px 24px; box-shadow:var(--shadow); display:flex; flex-direction:column; gap:14px}
.verdict .call{font-family:var(--f-display); font-size:20px; font-weight:600; line-height:1.35}
.verdict ol{margin:0; padding-left:20px; display:flex; flex-direction:column; gap:7px; color:var(--ink-2); max-width:72ch}
.sv-block{--sv:var(--sev-block)} .sv-major{--sv:var(--sev-major)} .sv-mod{--sv:var(--sev-mod)} .sv-minor{--sv:var(--sev-minor)} .sv-ok{--sv:var(--ok)}
.rate{display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,2fr); gap:14px; margin-bottom:18px}
@media (max-width:700px){ .rate{grid-template-columns:1fr} }
.rate-main{background:var(--surface); border:1px solid var(--rule); border-radius:5px; padding:18px 20px; display:flex; flex-direction:column; gap:6px}
.rate-main .big{font-family:var(--f-mono); font-size:44px; font-weight:500; line-height:1; font-variant-numeric:tabular-nums}
.bar{position:relative; height:10px; background:var(--surface-2); border-radius:5px; overflow:hidden; margin-top:6px}
.bar span{position:absolute; top:0; bottom:0; border-radius:5px}
.tally{display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px}
.tally div{background:var(--surface); border:1px solid var(--rule); border-top:3px solid var(--sv); border-radius:5px; padding:12px 14px; display:flex; flex-direction:column; gap:2px}
.tally .n{font-family:var(--f-mono); font-size:24px; font-weight:500; line-height:1; font-variant-numeric:tabular-nums}
.tally .l{font-size:11px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-3)}
.tw{overflow-x:auto; border:1px solid var(--rule); border-radius:5px; background:var(--surface)}
table{border-collapse:collapse; width:100%; font-size:13.5px}
th,td{text-align:left; padding:9px 12px; border-bottom:1px solid var(--rule-soft); vertical-align:top}
thead th{font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); background:var(--surface-2); border-bottom:1px solid var(--rule); white-space:nowrap}
tbody tr:last-child td, tbody tr:last-child th{border-bottom:0}
td.m{font-family:var(--f-mono); font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap}
/* Mêmes colonnes pour les 13 thèmes : la grille se lit comme un seul tableau. */
table.grid{min-width:${720 + pages.length * 64}px; table-layout:fixed}
table.grid .col-crit{width:40%} table.grid .col-st{width:64px}
table.grid tbody th{font-weight:400}
.cid{font-family:var(--f-mono); font-size:12px; font-weight:500}
.ctitle{color:var(--ink-2)}
.lvl{font-family:var(--f-mono); font-size:10.5px; color:var(--ink-3); border:1px solid var(--rule); border-radius:3px; padding:0 4px}
.cnote{color:var(--ink-2); min-width:220px; font-size:13px}
.st{display:inline-block; min-width:30px; text-align:center; font-family:var(--f-mono); font-size:11.5px; font-weight:500; padding:1px 5px; border-radius:3px}
.st-C{background:var(--st-c-bg); color:var(--ok)} .st-NC{background:var(--st-nc-bg); color:var(--sev-block)} .st-AV{background:var(--st-av-bg); color:var(--sev-mod)} .st-NA,.st-none{background:var(--st-na-bg); color:var(--na)}
.theme{margin-bottom:26px; display:flex; flex-direction:column; gap:10px}
.legend{display:flex; flex-wrap:wrap; gap:8px 18px; font-size:13px; color:var(--ink-2); margin-bottom:16px}
.finding{background:var(--surface); border:1px solid var(--rule); border-left:4px solid var(--sv); border-radius:5px; padding:18px 20px; margin-bottom:14px; display:flex; flex-direction:column; gap:13px; scroll-margin-top:16px}
.f-top{display:flex; flex-direction:column; gap:7px}
.f-id{display:flex; align-items:center; gap:9px; flex-wrap:wrap}
.badge{font-family:var(--f-mono); font-size:11px; font-weight:500; letter-spacing:.05em; padding:2px 7px; border-radius:3px; border:1px solid currentColor; color:var(--sv); text-transform:uppercase; white-space:nowrap}
.oos{color:var(--sev-mod)}
.f-fields{display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px 16px; align-items:baseline; margin:0}
.f-fields dt{font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); white-space:nowrap; padding-top:3px}
.f-fields dd{margin:0; color:var(--ink-2); max-width:76ch}
.f-fields dd strong{color:var(--ink)}
.fix{color:var(--accent-ink)}
.files{display:inline-flex; flex-wrap:wrap; gap:4px; margin-top:4px}
.list{background:var(--surface); border:1px solid var(--rule); border-radius:5px; padding:16px 20px}
.list ul{margin:0; padding-left:19px; display:flex; flex-direction:column; gap:6px; color:var(--ink-2)}
.lot{border:1px solid var(--rule); border-radius:5px; background:var(--surface); margin-bottom:12px; overflow:hidden}
.lot-h{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; padding:12px 18px; background:var(--surface-2); border-bottom:1px solid var(--rule)}
.lot-h .tag{font-family:var(--f-mono); font-size:12px; font-weight:500; color:var(--accent-ink)}
.lot-h .when{margin-left:auto; font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3)}
.lot-b{padding:14px 18px; display:flex; flex-direction:column; gap:8px; color:var(--ink-2)}
footer.end{margin-top:56px; padding-top:20px; border-top:1px solid var(--rule); color:var(--ink-3); font-size:12.5px; display:flex; flex-direction:column; gap:5px}
@media (max-width:640px){ .f-fields{grid-template-columns:1fr; gap:3px 0} .f-fields dt{padding-top:8px} }
@media (prefers-reduced-motion:reduce){ *{animation:none !important; transition:none !important} }
</style>

<div lang="fr">
<header class="mast">
  <div class="mast-inner">
    <p class="eyebrow">Rapport d'audit d'accessibilité &nbsp;·&nbsp; ${esc(meta.identifier)} &nbsp;·&nbsp; RGAA 4.1.2</p>
    <div class="brandline"><h1>Audit RGAA ${esc(audit.site)}</h1><span class="dot" aria-hidden="true"></span><span class="ref">${esc(meta.envLabel)} · ${esc(meta.date)}</span></div>
    <p class="lede">${fmt(audit.summary)}</p>
    <dl class="meta">
      <div><dt>Environnement</dt><dd>${esc(meta.envLabel)} · ${esc(meta.siteUrl)}</dd></div>
      <div><dt>Dépôt</dt><dd>${esc(meta.repo)}</dd></div>
      <div><dt>Référentiel</dt><dd>RGAA 4.1.2 · WCAG 2.1 AA</dd></div>
      <div><dt>Échantillon</dt><dd>${pages.length} page${pages.length > 1 ? 's' : ''}</dd></div>
      <div><dt>Outils</dt><dd>Chromium · axe-core ${esc(meta.axeVersion ?? '')}</dd></div>
      <div><dt>Largeurs</dt><dd>1440 · 640 · 375 · 320 px</dd></div>
      <div><dt>Taux provisoire</dt><dd>${num(r.rate)} %</dd></div>
      <div><dt>Auteur</dt><dd>TMA auto, à valider</dd></div>
    </dl>
    <nav class="toc" aria-label="Sommaire">
      <a href="#avis">Avis</a><a href="#synthese">Synthèse</a><a href="#grille">Grille RGAA</a>${roots.length ? '<a href="#racine">Cause racine</a>' : ''}<a href="#ecarts">Écarts</a><a href="#plan">Plan de correction</a><a href="#reserves">Réserves</a><a href="#methode">Méthode</a>
    </nav>
  </div>
</header>

<main class="wrap">
  <section id="avis" style="margin-top:0" aria-label="Avis">
    <div class="verdict sv-${verdictSev}">
      <p class="eyebrow">Avis</p>
      <p class="call">${fmt(audit.verdict.headline)}</p>
      ${(audit.verdict.points ?? []).length ? `<ol>${audit.verdict.points.map((p) => `<li>${fmt(p)}</li>`).join('')}</ol>` : ''}
    </div>
  </section>

  <section id="synthese" aria-labelledby="h-synthese">
    <div class="sec-head"><p class="eyebrow">01</p><h2 id="h-synthese">Synthèse</h2></div>
    <div class="rate">
      <div class="rate-main">
        <p class="eyebrow">Taux de conformité provisoire</p>
        <p class="big">${num(r.rate)}&nbsp;%</p>
        <p class="note">${r.C} critères conformes sur ${r.C + r.NC} applicables et tranchés.${r.AV ? ` Selon les ${r.AV} critères à vérifier, le taux final se situera entre <strong>${num(r.low)}&nbsp;%</strong> et <strong>${num(r.high)}&nbsp;%</strong>.` : ''} Taux moyen par page : ${num(r.average)}&nbsp;%.</p>
        <div class="bar" role="img" aria-label="Fourchette du taux : de ${num(r.low)} à ${num(r.high)} pour cent, valeur provisoire ${num(r.rate)} pour cent">
          <span style="left:0; width:${r.low ?? 0}%; background:var(--ok)"></span>
          <span style="left:${r.low ?? 0}%; width:${Math.max(0, (r.high ?? 0) - (r.low ?? 0))}%; background:var(--st-av-bg); outline:1px solid var(--sev-mod)"></span>
        </div>
      </div>
      <div class="tally">
        <div class="sv-ok"><span class="n">${r.C}</span><span class="l">Conformes</span></div>
        <div class="sv-block"><span class="n">${r.NC}</span><span class="l">Non conformes</span></div>
        <div class="sv-mod"><span class="n">${r.AV}</span><span class="l">À vérifier</span></div>
        <div class="sv-minor"><span class="n">${r.NA}</span><span class="l">Non applicables</span></div>
        <div class="sv-block"><span class="n">${sevCount('bloquant')}</span><span class="l">Écarts bloquants</span></div>
        <div class="sv-major"><span class="n">${sevCount('majeur')}</span><span class="l">Majeurs</span></div>
        <div class="sv-mod"><span class="n">${sevCount('modere')}</span><span class="l">Modérés</span></div>
        <div class="sv-minor"><span class="n">${sevCount('mineur')}</span><span class="l">Mineurs</span></div>
      </div>
    </div>
    <div class="tw"><table>
      <caption class="visually-hidden">Pages de l'échantillon</caption>
      <thead><tr><th scope="col">Page</th><th scope="col">Chemin</th><th scope="col">Raison</th><th scope="col">Taux</th><th scope="col">Écarts</th></tr></thead>
      <tbody>${pages.map((p) => `<tr><th scope="row">${esc(p.id)} · ${esc(p.name)}</th><td class="m">${esc(p.path)}</td><td>${fmt(p.why)}</td><td class="m">${num(r.perPage[p.id])} %</td><td class="m">${findings.filter((f) => (f.pages ?? []).includes(p.id)).length}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="note" style="margin-top:10px">Taux calculé selon la règle du RGAA : un critère est non conforme s'il l'est sur au moins une page de l'échantillon, et le taux vaut conformes ÷ (conformes + non conformes). ${oos ? `${oos} écart${oos > 1 ? 's' : ''} hors référentiel (WCAG 2.2) ne compte${oos > 1 ? 'nt' : ''} pas dans le taux.` : ''}</p>
  </section>

  <section id="grille" aria-labelledby="h-grille">
    <div class="sec-head"><p class="eyebrow">02</p><h2 id="h-grille">Grille RGAA</h2><p class="note">Les 106 critères, page par page. Statut global : NC si une page l'est, AV si une page reste à vérifier, C sinon, NA si le critère ne s'applique nulle part.</p></div>
    <p class="legend">${['C', 'NC', 'AV', 'NA'].map((s) => `<span>${badge(s)} ${ST[s][1]}</span>`).join('')}<span>Pages : ${pages.map((p) => `${esc(p.id)} ${esc(p.name)}`).join(' · ')}</span></p>
    ${crit.map(gridTheme).join('\n')}
  </section>

  ${(audit.discarded ?? []).length ? `
  <section id="ecartees" aria-labelledby="h-ecartees">
    <div class="sec-head"><p class="eyebrow">03</p><h2 id="h-ecartees">Pistes écartées</h2><p class="note">Ce que l'outil ou un premier test suggérait, et que la vérification a démenti. Ces pistes ne deviennent pas des tickets.</p></div>
    <div class="tw"><table>
      <caption class="visually-hidden">Pistes écartées</caption>
      <thead><tr><th scope="col">Piste</th><th scope="col">Ce que la vérification montre</th><th scope="col">Décision</th></tr></thead>
      <tbody>${audit.discarded.map((d) => `<tr><td>${fmt(d.lead)}</td><td>${fmt(d.evidence)}</td><td>${fmt(d.decision)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>` : ''}

  <div id="ecarts">
  ${roots.length ? `
  <section id="racine" aria-labelledby="h-racine">
    <div class="sec-head"><p class="eyebrow">04</p><h2 id="h-racine">Cause racine commune</h2><p class="note">Un mécanisme qui explique plusieurs écarts. À lire avant les fiches : le corriger vaut mieux que corriger ses symptômes.</p></div>
    ${roots.map(findingCard).join('\n')}
  </section>` : ''}
  ${sevSection('bloquant', '05', 'Écarts bloquants', 'Une fonction est inatteignable pour un profil d\'utilisateur. À corriger avant tout le reste.')}
  ${sevSection('majeur', '06', 'Écarts majeurs', 'L\'usage est fortement dégradé sans être impossible.')}
  ${sevSection('modere', '07', 'Écarts modérés', 'Une gêne réelle, mais contournable.')}
  ${sevSection('mineur', '08', 'Écarts mineurs', 'Des finitions, à traiter au fil de l\'eau.')}
  </div>

  ${(audit.inPlace ?? []).length ? `
  <section id="acquis" aria-labelledby="h-acquis">
    <div class="sec-head"><p class="eyebrow">09</p><h2 id="h-acquis">Ce qui est déjà en place</h2><p class="note">Des acquis vérifiés, à ne pas casser lors des corrections.</p></div>
    <div class="list"><ul>${audit.inPlace.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul></div>
  </section>` : ''}

  <section id="plan" aria-labelledby="h-plan">
    <div class="sec-head"><p class="eyebrow">10</p><h2 id="h-plan">Plan de correction</h2><p class="note">Les lots sont ordonnés par risque, puis par mutualisation. La charge n'est pas chiffrée ici.</p></div>
    ${(audit.lots ?? []).map((l) => `
    <div class="lot">
      <div class="lot-h"><span class="tag">Lot ${esc(l.id)}</span><h3>${fmt(l.title)}</h3><span class="when">${esc(PRIO[l.priority] ?? l.priority ?? '')}</span></div>
      <div class="lot-b">
        <p>${(l.findings ?? []).map((f) => { const x = findings.find((y) => y.id === f); return `<a href="#${esc(f)}">${esc(f)}</a>${x ? ` ${fmt(x.title)}` : ''}`; }).join('<br>')}</p>
        ${l.note ? `<p class="note">${fmt(l.note)}</p>` : ''}
      </div>
    </div>`).join('') || '<p class="note">Aucun lot proposé.</p>'}
  </section>

  <section id="reserves" aria-labelledby="h-reserves">
    <div class="sec-head"><p class="eyebrow">11</p><h2 id="h-reserves">Périmètre non couvert et risque résiduel</h2><p class="note">Ce qui n'a pas été testé est une information de décision. Corriger les écarts ci-dessus rendra le site conforme sur ce qui a été regardé, pas au-delà.</p></div>
    <div class="list"><ul>${[...(audit.reserves ?? []), 'Aucune écoute réelle avec un lecteur d\'écran (NVDA, JAWS, VoiceOver) : les constats reposent sur le DOM, l\'arbre d\'accessibilité de Chromium et le clavier réel.', 'Taux provisoire : les critères « à vérifier » doivent être tranchés par une personne avant toute déclaration de conformité.'].map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>
    ${(audit.outOfScope ?? []).length ? `<p class="note" style="margin-top:12px"><strong>Observations hors accessibilité</strong>, à qualifier séparément : ${audit.outOfScope.map(fmt).join(' · ')}</p>` : ''}</div>
  </section>

  <section id="methode" aria-labelledby="h-methode">
    <div class="sec-head"><p class="eyebrow">12</p><h2 id="h-methode">Méthode</h2></div>
    <div class="prose">
      <p>${fmt(audit.method)}</p>
      <p style="margin-top:12px">Audit réalisé par l'agent TMA auto sur ${meta.envLabel === 'production' ? 'la production, en lecture seule (mesure d\'audience coupée, aucun envoi de formulaire)' : 'la recette'}, avec Chromium sans interface et axe-core ${esc(meta.axeVersion ?? '')}, puis déroulé critère par critère selon la méthodologie officielle du RGAA 4.1.2. Les écarts non conformes ont été reproduits deux fois. Référentiel : RGAA 4.1.2, DINUM, Licence Ouverte 2.0.</p>
    </div>
  </section>

  <footer class="end">
    <p>Rapport d'audit d'accessibilité — <a href="${esc(meta.ticketUrl)}">${esc(meta.identifier)} ${esc(meta.ticketTitle)}</a></p>
    <p>${esc(meta.envLabel === 'production' ? 'Production' : 'Recette')} <code>${esc(meta.siteUrl)}</code> · ${esc(meta.repo)} · ${esc(meta.date)}</p>
    <p>Taux provisoire <strong>${num(r.rate)} %</strong> · ${r.C} C, ${r.NC} NC, ${r.AV} à vérifier, ${r.NA} NA · ${findings.length} écarts</p>
  </footer>
</main>
</div>
`;
}

// Résumé pour le commentaire Linear et Slack.
export function summaryLines(audit, kd) {
  const r = computeRates(audit, kd);
  const f = audit.findings ?? [];
  const n = (s) => f.filter((x) => x.severity === s).length;
  return {
    rates: r,
    text: `taux provisoire **${num(r.rate)} %**${r.AV ? ` (entre ${num(r.low)} et ${num(r.high)} % selon les ${r.AV} critères à vérifier)` : ''} · ${r.C} C, ${r.NC} NC, ${r.NA} NA · écarts : ${n('bloquant')} bloquant(s), ${n('majeur')} majeur(s), ${n('modere')} modéré(s), ${n('mineur')} mineur(s)`,
  };
}

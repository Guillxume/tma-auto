#!/usr/bin/env node
// Estimation a posteriori de l'équivalent humain des livraisons passées (exécutions enregistrées avant que
// l'agent ne fournisse lui-même `human_estimate`). Chaque estimation est marquée `humanAfter: true`.
// Lancé à la main, une fois :  docker compose exec tma-auto node scripts/backfill-estimates.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const env = process.env;
const STATE = env.STATE_DIR ?? '/data/state';
const LOGS = env.LOGS_DIR ?? '/data/logs';
const RUNS = path.join(STATE, 'runs.jsonl');
const DELIVERED = ['pr_opened', 'pr_updated', 'sql_proposed', 'plan_proposed', 'audit_done'];
const dry = process.argv.includes('--dry');

const runs = fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Transcripts indexés par session : ce que l'agent a rendu à la fin de chaque exécution.
const bySession = {};
for (const f of fs.readdirSync(LOGS).filter((n) => n.endsWith('.log'))) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n\n--- stderr ---')[0]);
    if (r.session_id) bySession[r.session_id] = r;
  } catch {}
}

const SCHEMA = {
  type: 'object',
  properties: { hours_low: { type: 'number' }, hours_high: { type: 'number' }, basis: { type: 'string' } },
  required: ['hours_low', 'hours_high', 'basis'],
};

function evidence(run) {
  const out = bySession[run.session]?.structured_output ?? {};
  if (run.status === 'audit_done') {
    const slug = `${run.identifier.toLowerCase()}--${run.repo.split('/')[1]}`;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(STATE, 'audits', slug, 'audit.json'), 'utf8'));
      return `Audit RGAA 4.1.2 : ${a.pages.length} pages auditées, 106 critères, ${a.findings.length} écarts rédigés (constat, impact, correction avec fichiers), ${a.discarded?.length ?? 0} pistes écartées, plan en ${a.lots?.length ?? 0} lots. Avis : ${a.verdict?.headline ?? ''}`;
    } catch { return `Audit RGAA : ${out.reason ?? ''}`; }
  }
  const k = out.knowledge ?? {};
  return [
    `Résultat : ${run.status}. ${out.reason ?? ''}`,
    k.root_cause && `Cause : ${k.root_cause}`,
    k.fix && `Correctif : ${k.fix}`,
    k.files?.length && `Fichiers : ${k.files.join(', ')}`,
    out.sql?.script && `Script SQL proposé (${out.sql.script.split('\n').length} lignes).`,
    out.plan && `Plan proposé : ${out.plan.summary} Étapes : ${out.plan.steps?.length}.`,
  ].filter(Boolean).join('\n');
}

// Titre et description manquants dans les premiers enregistrements : relus dans Linear.
async function ticketText(run) {
  if (run.title && run.title !== 'undefined' && run.description !== undefined) return `${run.title}`;
  if (!env.LINEAR_API_KEY) return run.title ?? '';
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: env.LINEAR_API_KEY },
      body: JSON.stringify({ query: 'query($id: String!) { issue(id: $id) { title description } }', variables: { id: run.identifier } }),
    });
    const i = (await res.json()).data?.issue;
    if (i?.title) run.title = i.title;
    return i ? `${i.title}\n${(i.description ?? '').slice(0, 1500)}` : run.title ?? '';
  } catch { return run.title ?? ''; }
}

let done = 0;
const seen = {};
for (const run of runs) {
  const key = `${run.identifier}|${run.repo}|${run.status === 'audit_done' ? 'audit' : 'dev'}`;
  const previous = seen[key];
  if (DELIVERED.includes(run.status)) seen[key] = run;
  if (!DELIVERED.includes(run.status) || run.humanHours > 0) continue;
  const proof = evidence(run);
  const text = await ticketText(run);
  // Une livraison qui reprend une précédente (même ticket, même dépôt) ne vaut que le travail supplémentaire.
  const again = previous ? `\nATTENTION : une livraison précédente existe déjà sur ce ticket et ce dépôt (${previous.status}, ${previous.date.slice(0, 10)}${previous.humanRange ? `, estimée ${previous.humanRange}` : ''}). Celle-ci la reprend, la révise ou la refait sur un autre environnement : n'estime que le travail SUPPLÉMENTAIRE qu'un humain aurait fait, en partant du livrable précédent.` : '';
  const who = run.status === 'audit_done' ? 'un auditeur accessibilité expérimenté' : 'un développeur de l\'équipe, qui connaît le parc PrestaShop';
  const prompt = `Estime le temps qu'aurait mis ${who} pour produire le livrable ci-dessous, de la lecture de la demande à la livraison (diagnostic, réalisation, vérifications, PR ou rapport). Fourchette réaliste, sans gonfler. Justifie en une phrase.

Ticket : ${run.identifier} — ${text}
Dépôt : ${run.repo}
${proof}${again}`;
  const r = spawnSync(env.CLAUDE_BIN ?? 'claude', ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--permission-mode', 'dontAsk', '--strict-mcp-config', '--max-budget-usd', '1'],
    { input: prompt, encoding: 'utf8', timeout: 180_000 });
  let est = null;
  try { est = JSON.parse(r.stdout).structured_output; } catch {}
  if (!est || !(est.hours_low > 0) || !(est.hours_high >= est.hours_low)) { console.log(`${run.identifier} (${run.status}) : pas d'estimation`); continue; }
  console.log(`${run.identifier} (${run.status}) : ${est.hours_low}–${est.hours_high} h — ${est.basis}`);
  Object.assign(run, { humanHours: (est.hours_low + est.hours_high) / 2, humanRange: `${est.hours_low}–${est.hours_high} h`, humanBasis: est.basis.slice(0, 300), humanAfter: true });
  done++;
}
if (!dry && done) {
  fs.copyFileSync(RUNS, `${RUNS}.avant-estimations`);
  fs.writeFileSync(RUNS, runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
console.log(`${done} estimation(s) a posteriori${dry ? ' (essai, rien écrit)' : ', runs.jsonl mis à jour (copie : runs.jsonl.avant-estimations)'}`);

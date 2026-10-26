#!/usr/bin/env node
// Banc de comparaison : rejoue de vrais tickets déjà traités avec un Claude Code « brut » (sans skills, sans
// instructions, sans CLAUDE.md ni journal, sans aiguillage ni outillage tma-*), puis fait juger son livrable
// par rapport à celui qui a été validé. Résultat : state/benchmark.json, affiché au tableau de bord.
//
//   docker compose exec tma-auto node scripts/benchmark.mjs ECOM-101 ECOM-102 ECOM-103
//
// Isolation du Claude Code brut : dossier personnel temporaire (aucun identifiant git ni jeton visible), envoi git
// impossible (hook pre-push sans branche autorisée + `git push` refusé), aucun MCP, secrets retirés de l'environnement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const env = process.env;
const STATE = env.STATE_DIR ?? '/data/state';
const LOGS = env.LOGS_DIR ?? '/data/logs';
const WT = env.WORKTREES_DIR ?? '/data/worktrees';
const REPOS = JSON.parse(fs.readFileSync(env.REPOS_FILE ?? '/app/repos.json', 'utf8'));
const OUT = path.join(STATE, 'benchmark.json');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DELIVERED = ['pr_opened', 'pr_updated', 'sql_proposed', 'plan_proposed', 'audit_done'];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim();

async function linearIssue(id) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: env.LINEAR_API_KEY },
    body: JSON.stringify({ query: 'query($id: String!) { issue(id: $id) { title description labels { nodes { name } } } }', variables: { id } }),
  });
  return (await res.json()).data?.issue;
}

async function github(url) {
  const res = await fetch(`https://api.github.com${url}`, { headers: { Authorization: `Bearer ${env.GITHUB_BOT_TOKEN}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub ${url} : HTTP ${res.status}`);
  return res.json();
}

const transcripts = (() => {
  const by = {};
  for (const f of fs.readdirSync(LOGS).filter((n) => n.endsWith('.log'))) {
    try { const r = JSON.parse(fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n\n--- stderr ---')[0]); if (r.session_id) by[r.session_id] = r; } catch {}
  }
  return by;
})();

// Environnement du Claude Code brut : seul le jeton d'abonnement passe, dans un dossier personnel vide.
function rawEnv(home) {
  const e = { PATH: env.PATH, HOME: home, LANG: 'fr_FR.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN ?? '', ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '' };
  for (const k of Object.keys(e)) if (!e[k]) delete e[k];
  // Hook pre-push du serveur, sans aucune branche autorisée : tout envoi est refusé.
  return { ...e, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(HERE, '..', 'git-hooks'), GIT_CONFIG_KEY_1: 'remote.origin.pushurl', GIT_CONFIG_VALUE_1: '/dev/null/aucun-envoi', TMA_ALLOWED_BRANCH: '__aucune__' };
}

function runClaude(prompt, cwd, home, { tools, budget, timeoutMin, model }) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--max-budget-usd', String(budget),
    '--allowedTools', ...tools, '--disallowedTools', 'Bash(git push*)', 'Bash(git remote*)', 'Bash(git config*)'];
  if (model) args.push('--model', model);
  const started = Date.now();
  const r = spawnSync(env.CLAUDE_BIN ?? 'claude', args, { cwd, input: prompt, encoding: 'utf8', env: rawEnv(home), timeout: timeoutMin * 60_000, maxBuffer: 50 * 1024 * 1024 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  return { out, minutes: (Date.now() - started) / 60_000, timedOut: r.error?.code === 'ETIMEDOUT' };
}

const JUDGE = {
  type: 'object',
  properties: {
    usable: { type: 'boolean', description: 'Le livrable du témoin aurait-il pu être livré tel quel, ou presque, à la place de la référence ?' },
    score: { type: 'number', description: 'Qualité du témoin de 0 à 10, la référence validée valant 10' },
    verdict: { type: 'string', description: 'Une à deux phrases : ce qui manque, ce qui est faux ou risqué, ce qui est bon' },
  },
  required: ['usable', 'score', 'verdict'],
};

function judge(ticketText, reference, candidate) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'juge-'));
  const prompt = `Tu compares deux réponses à un même ticket de TMA. La RÉFÉRENCE est celle qui a été validée par le responsable technique. Le TÉMOIN a été produit sans connaissance du projet. Juge le TÉMOIN avec exigence et sans indulgence, par rapport à la référence, **sur le fond uniquement** : le correctif (ou le rapport) est-il juste, complet et sûr pour le site ?

Ne pénalise PAS la forme : le témoin n'avait ni PR à ouvrir, ni commit à faire, ni rubrique de PR, ni format ou emplacement de rapport imposé, ni historique CLAUDE.md à tenir (ces fichiers lui ont été retirés exprès). Pénalise ce qui serait un défaut pour le site : correctif faux, incomplet, risqué ou inventé, modification hors sujet, constat erroné, manque d'un écart important.

<ticket>
${ticketText}
</ticket>

<reference>
${reference.slice(0, 30_000)}
</reference>

<temoin>
${candidate.slice(0, 30_000)}
</temoin>`;
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE), '--permission-mode', 'dontAsk', '--strict-mcp-config', '--max-budget-usd', '2'];
  const r = spawnSync(env.CLAUDE_BIN ?? 'claude', args, { input: prompt, encoding: 'utf8', env: rawEnv(home), timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024 });
  fs.rmSync(home, { recursive: true, force: true });
  try { return JSON.parse(r.stdout).structured_output; } catch { return null; }
}

async function benchmark(identifier) {
  const runs = fs.readFileSync(path.join(STATE, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.identifier === identifier);
  if (!runs.length) throw new Error(`aucune exécution enregistrée pour ${identifier}`);
  const issue = await linearIssue(identifier);
  const ticketText = `${identifier} — ${issue?.title ?? runs[0].title}\n\n${(issue?.description ?? '').slice(0, 6000)}`;
  const delivered = runs.filter((r) => DELIVERED.includes(r.status));
  const main = delivered[0] ?? runs.at(-1);
  // Dépôt : celui de l'exécution, sinon celui de la PR, sinon le label du site.
  let repoName = main.repo || (main.prUrl?.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1]) || '';
  if (!repoName) {
    const labels = (issue?.labels?.nodes ?? []).map((l) => l.name.toLowerCase());
    repoName = Object.entries(REPOS.labels ?? {}).find(([k]) => labels.includes(k.toLowerCase()))?.[1] ?? '';
  }
  const repo = REPOS.repos[repoName];
  if (!repo) throw new Error(`${identifier} : dépôt introuvable`);
  const sameRepo = runs.filter((r) => !r.repo || r.repo === repoName);
  // Côté optimisé : tout ce qu'il a fallu pour livrer (relances comprises).
  const optimized = {
    runs: sameRepo.length, cost: sameRepo.reduce((s, r) => s + (r.cost || 0), 0), minutes: sameRepo.reduce((s, r) => s + (r.minutes || 0), 0),
    status: main.status, url: main.prUrl ?? '',
  };
  const kind = main.status === 'audit_done' ? 'audit' : delivered.length ? 'code' : 'qualification';

  // Référence validée.
  let reference = '';
  let base = null;
  if (kind === 'code') {
    const [, owner, name, num] = main.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const pr = await github(`/repos/${owner}/${name}/pulls/${num}`);
    const files = await github(`/repos/${owner}/${name}/pulls/${num}/files?per_page=100`);
    base = pr.base.sha;
    optimized.validated = pr.merged ? 'PR fusionnée' : pr.state === 'open' ? 'PR ouverte, en relecture' : 'PR fermée sans fusion';
    reference = `PR ${main.prUrl} (${optimized.validated}).\n${pr.title}\n\n${pr.body ?? ''}\n\n${files.map((f) => `--- ${f.filename}\n${f.patch ?? '(binaire)'}`).join('\n')}`;
  } else if (kind === 'audit') {
    const a = JSON.parse(fs.readFileSync(path.join(STATE, 'audits', `${identifier.toLowerCase()}--${repoName.split('/')[1]}`, 'audit.json'), 'utf8'));
    optimized.validated = 'audit relu, tickets de correction créés';
    reference = `Audit RGAA 4.1.2 validé : ${a.pages.length} pages (${a.pages.map((p) => p.path).join(', ')}), 106 critères statués page par page, ${a.findings.length} écarts.\nAvis : ${a.verdict.headline}\n\nÉcarts :\n${a.findings.map((f) => `- ${f.id} [${f.severity}] ${f.title} (RGAA ${(f.criteria ?? []).join(', ') || 'hors réf.'}) — correction : ${f.correction.slice(0, 200)}`).join('\n')}`;
  } else {
    const last = transcripts[main.session]?.structured_output;
    optimized.validated = 'arrêt et questions validés par le responsable';
    reference = `Bonne réponse : NE PAS modifier le code à l'aveugle. Le ticket est trop imprécis ; l'agent s'est arrêté (${main.status}) et a demandé des précisions :\n${last?.reason ?? ''}\n${(last?.questions ?? []).join('\n')}`;
  }

  // Bac à sable : worktree détaché au point de départ, sans les CLAUDE.md / AGENTS.md (qui font partie des optimisations).
  const sandbox = path.join(WT, `benchmark--${identifier.toLowerCase()}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brut-'));
  git(repo.path, ['worktree', 'prune']);
  if (fs.existsSync(sandbox)) git(repo.path, ['worktree', 'remove', '--force', sandbox]);
  if (!base) base = git(repo.path, ['rev-list', '-1', `--before=${main.date}`, `origin/${repo.baseBranch ?? 'main'}`]);
  git(repo.path, ['worktree', 'add', '--detach', sandbox, base]);
  for (const f of git(sandbox, ['ls-files', '*CLAUDE.md', '*AGENTS.md']).split('\n').filter(Boolean)) fs.rmSync(path.join(sandbox, f), { force: true });

  let raw;
  let candidate;
  try {
    if (kind === 'audit') {
      const site = repo.prodUrl ?? repo.recetteDeploy?.url;
      log(`${identifier} : audit brut de ${site}`);
      raw = runClaude(`Fais un audit d'accessibilité RGAA 4.1.2 du site ${site} et rédige le rapport : pages auditées, statut des critères, écarts avec leur correction.`,
        sandbox, home, { tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'], budget: 12, timeoutMin: 45 });
      const written = fs.readdirSync(sandbox).filter((f) => /\.(md|html|txt)$/i.test(f) && !git(sandbox, ['ls-files', f])).map((f) => fs.readFileSync(path.join(sandbox, f), 'utf8')).join('\n\n');
      candidate = `${raw.out?.result ?? ''}\n\n${written}`;
    } else {
      log(`${identifier} : correctif brut dans ${repoName} (${base.slice(0, 8)})`);
      raw = runClaude(`Voici un ticket de la TMA de ce site. Traite-le dans ce dépôt (fais les modifications nécessaires, sans pousser).\n\n${ticketText}`,
        sandbox, home, { tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', ...['git', 'npm', 'npx', 'node', 'php', 'composer', 'ls', 'grep', 'find'].map((c) => `Bash(${c} *)`)], budget: 8, timeoutMin: 30 });
      // Les CLAUDE.md / AGENTS.md retirés par le banc ne font pas partie du travail du témoin.
      const diff = git(sandbox, ['diff', '--', '.', ':(exclude,glob)**/CLAUDE.md', ':(exclude,glob)**/AGENTS.md']);
      candidate = `Réponse finale :\n${raw.out?.result ?? '(aucune)'}\n\nModifications :\n${diff || '(aucune modification)'}`;
    }
  } finally {
    git(repo.path, ['worktree', 'remove', '--force', sandbox]);
    fs.rmSync(home, { recursive: true, force: true });
  }

  log(`${identifier} : jugement`);
  const verdict = judge(ticketText, reference, candidate);
  return {
    identifier, title: issue?.title ?? main.title, repo: repoName, kind, date: new Date().toISOString(),
    optimized,
    raw: { cost: raw.out?.total_cost_usd ?? 0, minutes: raw.minutes, turns: raw.out?.num_turns ?? 0, timedOut: raw.timedOut, error: raw.out?.is_error ? (raw.out.subtype ?? 'erreur') : null },
    judge: verdict,
  };
}

const ids = process.argv.slice(2).filter((a) => /^[A-Z]+-\d+$/.test(a));
if (!ids.length) { console.log('Usage : node scripts/benchmark.mjs ECOM-101 [ECOM-… …]'); process.exit(1); }
let all = [];
try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
for (const id of ids) {
  try {
    const r = await benchmark(id);
    all = all.filter((x) => x.identifier !== id).concat(r);
    fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
    log(`${id} : optimisé ${r.optimized.cost.toFixed(2)} $ / ${r.optimized.minutes.toFixed(1)} min · brut ${r.raw.cost.toFixed(2)} $ / ${r.raw.minutes.toFixed(1)} min · témoin ${r.judge ? `${r.judge.score}/10, ${r.judge.usable ? 'utilisable' : 'inutilisable'} — ${r.judge.verdict}` : 'non jugé'}`);
  } catch (err) {
    log(`${id} : échec — ${err.message}`);
  }
}

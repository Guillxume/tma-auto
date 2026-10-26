#!/usr/bin/env node
// Synchronisation hebdomadaire de tma-knowledge avec les dépôts du parc.
//  1. régénère references/modules-tiers.md depuis `main` de chaque boutique (déterministe, sans IA) ;
//  2. repère les CLAUDE.md / AGENTS.md modifiés depuis la dernière synchronisation ;
//  3. s'il y en a, Claude propose les ajustements des skills qui en découlent ;
//  4. ouvre une PR sur tma-knowledge (reviewer : le responsable) et prévient sur Slack.
// Rien n'est appliqué sans relecture. Lancé chaque lundi par server.mjs, ou à la main :
//   docker compose exec tma-auto node scripts/sync-knowledge.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const env = process.env;
const REPOS = JSON.parse(fs.readFileSync(env.REPOS_FILE ?? '/app/repos.json', 'utf8')).repos;
const KD = env.KNOWLEDGE_DIR ?? '/data/tma-knowledge';
const STATE = path.join(env.STATE_DIR ?? '/data/state', 'knowledge-sync.json');
const WT = path.join(env.WORKTREES_DIR ?? '/data/worktrees', 'tma-knowledge--sync');
const LOGS = env.LOGS_DIR ?? '/data/logs';
const KNOWLEDGE_REPO = env.KNOWLEDGE_REPO ?? 'acme/tma-knowledge';
// Premier passage : on compare aux CLAUDE.md tels qu'ils étaient quand les skills ont été rédigés.
const FIRST_SINCE = env.KNOWLEDGE_SYNC_SINCE ?? '2026-10-16T00:00:00Z';

const log = (...a) => console.log(new Date().toISOString(), '[sync-knowledge]', ...a);
const git = async (cwd, args) => (await execFileP('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })).stdout;

async function slack(text) {
  if (!env.SLACK_BOT_TOKEN && !env.SLACK_WEBHOOK_URL) return log(`[Slack] ${text}`);
  const res = env.SLACK_WEBHOOK_URL
    ? await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    : await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: env.SLACK_USER_ID, text, unfurl_links: false }),
      });
  if (!res.ok) log(`Slack : HTTP ${res.status}`);
}

async function github(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${env.GITHUB_BOT_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${url} : HTTP ${res.status} ${json.message ?? ''}`);
  return json;
}

async function baseRef(repo) {
  if (repo.baseBranch) return `origin/${repo.baseBranch}`;
  try {
    return (await git(repo.path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
  } catch {
    return 'origin/main';
  }
}

// ---------------------------------------------------------------------------
// 1. Inventaire des modules (même format que la version initiale, sans date pour ne diff qu'au réel)
// ---------------------------------------------------------------------------

// Auteurs ou préfixes des modules maison (agence, éditeur interne), modifiables par l'agent.
const IN_HOUSE = new RegExp(env.IN_HOUSE_MODULES ?? '^acme', 'i');

// Modules tiers des relevés précédents (tableaux par site). Beaucoup de boutiques excluent leurs modules
// tiers de git : absents de main, ils tournent pourtant en production. On les garde, marqués « hors dépôt ».
function previousTiers(md) {
  const out = {};
  let site = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) { site = h[1].startsWith('Éditeurs') ? null : h[1]; continue; }
    const row = site && line.match(/^\| `([^`]+)` \| (.*?) \| (.*?) \|/);
    if (row) (out[site] ??= []).push({ m: row[1], author: row[2], version: row[3] });
  }
  return out;
}

async function inventoryModules(previousMd = '') {
  const before = previousTiers(previousMd);
  const out = {};
  for (const [fullName, repo] of Object.entries(REPOS)) {
    if (repo.kind !== 'prestashop' || !fs.existsSync(path.join(repo.path, '.git'))) continue;
    const ref = await baseRef(repo);
    const dirs = (await git(repo.path, ['ls-tree', '-d', '--name-only', `${ref}:modules`]).catch(() => '')).split('\n').filter(Boolean);
    if (!dirs.length) continue;
    const rows = [];
    for (const m of dirs) {
      const src = await git(repo.path, ['show', `${ref}:modules/${m}/${m}.php`]).catch(() => null);
      if (src === null) continue;
      const author = (src.match(/\$this->author\s*=\s*['"]([^'"]+)['"]/) || [])[1]?.trim() || '?';
      const version = (src.match(/\$this->version\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '';
      const kind = /^prestashop$/i.test(author) ? 'cœur' : IN_HOUSE.test(author) || IN_HOUSE.test(m) ? 'maison' : 'tiers';
      rows.push({ m, author, version, kind });
    }
    out[fullName.split('/')[1]] = rows;
  }
  const lines = [
    '# Modules tiers par site',
    '',
    'Inventaire régénéré chaque semaine par tma-auto, depuis `main` de chaque boutique, à partir du fichier principal de chaque module (`$this->author`). Trois familles :',
    '',
    '- **cœur** : auteur « PrestaShop » (modules natifs `ps_*`, `blockreassurance`…). Ne pas modifier : surcharger dans le thème.',
    '- **maison** : modules de l\'agence (`IN_HOUSE_MODULES`, par défaut `acme*`). Modifiable.',
    '- **tiers** : tout autre éditeur, listé ci-dessous. **Ne pas modifier** : une mise à jour écraserait la correction. Passer par un override, une surcharge de template dans le thème, ou `needs_decision`.',
    '',
    'Colonne **Dépôt** : « oui » si le module est versionné sur `main` ; « hors dépôt » s\'il a été vu dans un relevé précédent (copie de travail ou production) mais n\'est pas dans git. Un module hors dépôt tourne peut-être en production : tu ne peux pas le modifier (il n\'est pas dans ton worktree), mais il peut expliquer un comportement.',
    '',
  ];
  const authors = {};
  for (const site of [...new Set([...Object.keys(out), ...Object.keys(before)])].sort()) {
    const rows = out[site] ?? [];
    const known = new Set(rows.map((r) => r.m));
    const tiers = rows.filter((r) => r.kind === 'tiers').map((r) => ({ ...r, repo: 'oui' }));
    for (const r of before[site] ?? []) if (!known.has(r.m)) tiers.push({ ...r, repo: 'hors dépôt' });
    tiers.sort((a, b) => a.m.localeCompare(b.m));
    const off = tiers.filter((r) => r.repo !== 'oui').length;
    lines.push(`## ${site}`, '', `${rows.length} modules versionnés : ${rows.filter((r) => r.kind === 'cœur').length} cœur, ${rows.filter((r) => r.kind === 'maison').length} maison, ${tiers.length - off} tiers${off ? ` · ${off} module(s) tiers hors dépôt` : ''}.`, '');
    if (tiers.length) {
      lines.push('| Module | Éditeur | Version | Dépôt |', '|---|---|---|---|');
      for (const r of tiers) lines.push(`| \`${r.m}\` | ${r.author.replace(/\|/g, '/')} | ${r.version} | ${r.repo} |`);
      lines.push('');
    }
    for (const r of tiers) (authors[r.author] ??= new Set()).add(site);
  }
  lines.push('## Éditeurs présents sur plusieurs sites', '', "Un bug dans un de ces modules a des chances d'exister ailleurs : cherche le module dans `journal/`.", '', '| Éditeur | Sites |', '|---|---|');
  for (const [a, s] of Object.entries(authors).filter(([, s]) => s.size > 1).sort((x, y) => y[1].size - x[1].size)) {
    lines.push(`| ${a.replace(/\|/g, '/')} | ${[...s].join(', ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 2. CLAUDE.md / AGENTS.md modifiés depuis la dernière synchronisation
// ---------------------------------------------------------------------------

const CONTEXT_FILES = [':(glob)**/CLAUDE.md', ':(glob)**/AGENTS.md'];

async function claudeMdChanges(previous) {
  const shas = {};
  const changes = [];
  for (const [fullName, repo] of Object.entries(REPOS)) {
    if (!fs.existsSync(path.join(repo.path, '.git'))) continue;
    const ref = await baseRef(repo);
    const head = (await git(repo.path, ['rev-parse', ref]).catch(() => '')).trim();
    if (!head) continue;
    shas[fullName] = head;
    let from = previous[fullName];
    if (!from) {
      from = (await git(repo.path, ['rev-list', '-1', `--before=${FIRST_SINCE}`, ref]).catch(() => '')).trim();
      if (!from) continue;
    }
    if (from === head) continue;
    const diff = await git(repo.path, ['diff', '-U6', `${from}..${head}`, '--', ...CONTEXT_FILES]).catch(() => '');
    if (!diff.trim()) continue;
    const commits = (await git(repo.path, ['log', '--format=%h %s', `${from}..${head}`, '--', ...CONTEXT_FILES]).catch(() => '')).trim();
    changes.push({ repo: fullName, diff, commits });
  }
  return { shas, changes };
}

// ---------------------------------------------------------------------------
// 3. Claude propose les ajustements des skills (lecture + édition des seuls skills)
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Résumé en 2 à 4 phrases, en français' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, change: { type: 'string' }, source: { type: 'string' } },
        required: ['file', 'change', 'source'],
      },
    },
  },
  required: ['summary', 'changes'],
};

function runClaude(cwd, prompt) {
  const args = [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
    '--permission-mode', 'dontAsk', '--max-budget-usd', env.KNOWLEDGE_SYNC_BUDGET_USD ?? '2',
    // Édition limitée aux skills de l'espace de travail (relatif au dossier courant).
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit(/skills/**)',
  ];
  const childEnv = { ...env };
  for (const k of Object.keys(childEnv)) if (/SECRET|TOKEN|PASSWORD|API_KEY|^DB_URL_/.test(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN' && k !== 'ANTHROPIC_API_KEY') delete childEnv[k];
  return new Promise((resolve) => {
    const child = spawn(env.CLAUDE_BIN ?? 'claude', args, { cwd, env: childEnv });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(LOGS, `knowledge-sync-${Date.now()}.log`), out);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    child.stdin.end(prompt);
  });
}

// Un passage par skill, chacun avec sa propre enveloppe de diff, répartie à parts égales entre les dépôts.
function skillsPrompt(changes, skill) {
  const MAX = 80_000;
  const per = Math.floor(MAX / changes.length);
  const blocks = changes.map((c) => {
    const d = c.diff.length > per ? `${c.diff.slice(0, per)}\n[… diff tronqué : ${c.diff.length - per} caractères non montrés]` : c.diff;
    return `### ${c.repo}\nCommits :\n${c.commits}\n\n\`\`\`diff\n${d}\n\`\`\``;
  });
  return `Tu maintiens la base de connaissance d'un agent de TMA. Le skill à tenir à jour est skills/${skill}/SKILL.md (dossier courant). Il a été rédigé à partir des CLAUDE.md des dépôts du parc, qui viennent d'évoluer :

${blocks.join('\n\n')}

Ta tâche : garder les skills exacts par rapport à ces changements.
- Une règle des skills que ces changements rendent fausse ou obsolète : corrige-la ou retire-la.
- Un nouveau piège, une nouvelle convention ou procédure qui vaut pour plusieurs sites, ou qui complète une règle que le skill pose déjà : ajoute-le dans la bonne section, en citant le dépôt source comme le font les règles existantes.
- Un fait propre à un seul site reste dans son CLAUDE.md : n'ajoute rien, sauf si le skill cite déjà ce site pour ce sujet (mets alors la mention à jour).
- Garde le style des skills : consignes courtes et impératives, adressées à l'agent. Aucune donnée sensible (IP, hôte, chemin serveur, e-mail, nom de personne, mot de passe, URL de recette ou de prod).
- Ne modifie que skills/${skill}/SKILL.md. Si rien ne justifie un changement, ne modifie rien. Si un diff est tronqué, ne déduis rien de la partie manquante.

Réponse finale au format imposé : un résumé, puis chaque changement avec son fichier et sa source (dépôt + section ou commit).`;
}

// ---------------------------------------------------------------------------
// 4. Orchestration
// ---------------------------------------------------------------------------

async function main() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}

  for (const repo of Object.values(REPOS)) {
    if (fs.existsSync(path.join(repo.path, '.git'))) await git(repo.path, ['fetch', '--quiet', 'origin', '--prune']).catch(() => {});
  }
  await git(KD, ['fetch', '--quiet', 'origin']);

  const date = new Date().toISOString().slice(0, 10);
  const branch = `sync/${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;
  await git(KD, ['worktree', 'prune']);
  if (fs.existsSync(WT)) await git(KD, ['worktree', 'remove', '--force', WT]);
  await git(KD, ['worktree', 'add', '-B', branch, WT, 'origin/main']);

  try {
    // 1. modules
    const modulesFile = path.join(WT, 'references', 'modules-tiers.md');
    fs.mkdirSync(path.dirname(modulesFile), { recursive: true });
    const previousMd = fs.existsSync(modulesFile) ? fs.readFileSync(modulesFile, 'utf8') : '';
    fs.writeFileSync(modulesFile, await inventoryModules(previousMd));

    // 2-3. CLAUDE.md → skills, un passage par skill
    const { shas, changes } = await claudeMdChanges(state.shas ?? {});
    const outcome = { summary: '', changes: [] };
    if (changes.length) log(`${changes.length} dépôt(s) avec CLAUDE.md modifié : ${changes.map((c) => c.repo).join(', ')}`);
    for (const skill of ['prestashop', 'outils-internes']) {
      const group = changes.filter((c) => (REPOS[c.repo]?.kind === 'prestashop') === (skill === 'prestashop'));
      if (!group.length) continue;
      const r = (await runClaude(WT, skillsPrompt(group, skill)))?.structured_output;
      if (r) {
        outcome.summary += `${outcome.summary ? '\n\n' : ''}**${skill}** : ${r.summary}`;
        outcome.changes.push(...(r.changes ?? []));
      }
    }

    // Sécurité : seuls ces fichiers peuvent changer.
    const touched = (await git(WT, ['status', '--porcelain'])).split('\n').filter(Boolean).map((l) => l.slice(3));
    const allowed = new Set(['references/modules-tiers.md', 'skills/prestashop/SKILL.md', 'skills/outils-internes/SKILL.md']);
    const unexpected = touched.filter((f) => !allowed.has(f));
    if (unexpected.length) throw new Error(`fichiers inattendus modifiés : ${unexpected.join(', ')}`);

    if (!touched.length) {
      log('rien à mettre à jour');
      fs.writeFileSync(STATE, JSON.stringify({ ...state, shas, lastRun: new Date().toISOString() }, null, 2));
      return;
    }

    await git(WT, ['add', '-A']);
    await git(WT, ['commit', '--quiet', '-m', `sync: connaissances au ${date}`]);
    await git(WT, ['push', '--quiet', '--force-with-lease', 'origin', branch]);

    const modulesChanged = touched.includes('references/modules-tiers.md');
    const skillsChanged = touched.filter((f) => f.startsWith('skills/'));
    const body = [
      `Synchronisation hebdomadaire de tma-knowledge avec les dépôts du parc (${date}).`,
      '',
      '## CLAUDE.md modifiés depuis la dernière synchronisation',
      changes.length ? changes.map((c) => `- **${c.repo}**\n${c.commits.split('\n').map((l) => `  - ${l}`).join('\n')}`).join('\n') : '- aucun',
      '',
      '## Ajustements des skills',
      outcome?.changes?.length
        ? `${outcome.summary}\n\n${outcome.changes.map((c) => `- \`${c.file}\` : ${c.change} _(source : ${c.source})_`).join('\n')}`
        : skillsChanged.length ? 'Voir le diff.' : '- aucun',
      '',
      '## Modules tiers',
      modulesChanged ? '`references/modules-tiers.md` régénéré depuis `main` de chaque boutique : voir le diff.' : '- inchangés',
      '',
      'À relire avant merge : une règle fausse dans un skill égare l\'agent sur tous les tickets suivants.',
    ].join('\n');

    const existing = await github('GET', `/repos/${KNOWLEDGE_REPO}/pulls?state=open&head=${KNOWLEDGE_REPO.split('/')[0]}:${branch}`);
    const pr = existing[0] ?? await github('POST', `/repos/${KNOWLEDGE_REPO}/pulls`, { title: `sync: connaissances au ${date}`, head: branch, base: 'main', body });
    if (!existing[0] && env.GITHUB_REVIEWER) {
      await github('POST', `/repos/${KNOWLEDGE_REPO}/pulls/${pr.number}/requested_reviewers`, { reviewers: [env.GITHUB_REVIEWER] }).catch((e) => log(e.message));
    }
    fs.writeFileSync(STATE, JSON.stringify({ ...state, shas, lastRun: new Date().toISOString(), lastPr: pr.html_url }, null, 2));
    log(`PR ${pr.html_url}`);
    await slack(`📚 *Mise à jour des connaissances à relire* : ${pr.html_url}\n${changes.length} dépôt(s) avec CLAUDE.md modifié · skills ${skillsChanged.length ? 'ajustés' : 'inchangés'} · modules tiers ${modulesChanged ? 'mis à jour' : 'inchangés'}`);
  } finally {
    await git(KD, ['worktree', 'remove', '--force', WT]).catch(() => {});
  }
}

main().catch(async (err) => {
  log(`échec : ${err.stack ?? err}`);
  await slack(`❌ Synchronisation des connaissances en échec : ${String(err.message).slice(0, 300)}`).catch(() => {});
  process.exit(1);
});

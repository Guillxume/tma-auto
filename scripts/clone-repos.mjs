#!/usr/bin/env node
// Clone (ou met à jour) tous les dépôts de repos.json et la base de connaissance, en HTTPS
// avec les identifiants git du bot. À relancer après chaque ajout dans repos.json.
// Usage : node scripts/clone-repos.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const reposFile = process.env.REPOS_FILE ?? new URL('../repos.json', import.meta.url).pathname;
const { repos } = JSON.parse(fs.readFileSync(reposFile, 'utf8'));
// Les dépôts gérés sont clonés sans copie de travail : l'agent travaille uniquement dans des
// worktrees. Clone partiel (blob:none) : l'historique sans le contenu des fichiers, téléchargé à la
// demande au checkout d'un worktree (parc : 8 Go en clone complet, 65 Mo en partiel).
// La base de connaissance garde ses fichiers : l'agent les lit et le serveur y écrit le journal.
const targets = Object.entries(repos).map(([fullName, cfg]) => [fullName, cfg.path, ['--no-checkout', '--filter=blob:none']]);
if (process.env.KNOWLEDGE_DIR) targets.push([process.env.KNOWLEDGE_REPO ?? 'acme/tma-knowledge', process.env.KNOWLEDGE_DIR, []]);
if (process.env.ATELIER_DIR) targets.push(['acme/atelier-plaque', process.env.ATELIER_DIR, []]);

let failed = 0;
for (const [fullName, dir, cloneArgs] of targets) {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin', '--prune'], { stdio: 'inherit' });
      console.log(`✓ ${fullName} (à jour)`);
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      execFileSync('git', ['clone', '--quiet', ...cloneArgs, `https://github.com/${fullName}.git`, dir], { stdio: 'inherit' });
      console.log(`✓ ${fullName} (cloné)`);
    }
  } catch {
    console.error(`✗ ${fullName} : accès refusé ou dépôt introuvable (le bot y a-t-il accès ?)`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);

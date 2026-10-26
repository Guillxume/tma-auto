# tma-auto

Assign a Linear ticket, get a pull request ready for review.

tma-auto is a small self-hosted server that connects **Linear**, **Claude Code** (headless) and **GitHub**. When a ticket is
assigned to you, it finds the right repository, lets Claude Code work in an isolated git worktree under tight guardrails,
and comes back with a pull request, an SQL script, a plan or a question. It never comes back with a guess.

[![CI](https://github.com/Guillxume/tma-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/Guillxume/tma-auto/actions/workflows/ci.yml)

I built it to handle application maintenance (*TMA*, *tierce maintenance applicative* in French) for an e-commerce group:
about forty repositories, mostly PrestaShop 1.7 and 8 shops and standalone modules, plus Next.js and Node internal tools.
It has run in production since October 2026. This copy is anonymized: the client repositories, hosts and staging servers
are replaced by fictional ones (`acme`, `globex`, `northwind`).

> The prompts, code comments and logs are in French, the team's working language. This page is in English.

```
Linear ──HTTPS──▶ reverse proxy ──▶ tma-auto :8787 ──▶ git worktree + claude -p ──▶ GitHub PR (you review)
  ▲   │                                 │               │  reads: the repo's CLAUDE.md,
  │   │ ticket moves to "Done"          │               │         skills + journal (knowledge repo),
  │   └─────────────────────────────────┤               │         git history, past Linear tickets
  │                                     ▼               │
  │                          journal/<repo>.md          └─ needs_decision / blocked ──▶ Slack DM
  └──────────────── "/tma option 2" ◀───────────────────────────────────────────────────┘
```

---

## How a ticket flows

1. **Webhook.** Linear calls `/webhooks/linear`. The server checks the HMAC-SHA256 signature on the raw body with a constant-time comparison before it parses anything. It also rejects replays: timestamps more than 60 s off, and delivery IDs it has already seen.
2. **Routing.** `repos.json` picks the repository. The first rule that matches wins: a GitHub link (in a `/tma` comment, then in the description), then a site label, then the Linear project, then the team. A ticket with two site labels gets two runs and two PRs. If nothing matches, the agent does nothing and tells you why.
3. **Mission.** The server decides *what* to produce (see [Missions](#missions)).
4. **Worktree.** It creates `tma/linear-<id>` from the repository's base branch, in its own worktree. The right PHP or Node version for that repository goes first on the agent's `PATH`.
5. **Agent.** Claude Code runs headless (`claude -p`, `--permission-mode dontAsk`) with a JSON output schema, a budget cap and a timeout. It reads the knowledge sources first. Then it **qualifies the ticket**: a back-office setting, a hosting issue or a usage question is answered as `not_code`, without touching anything.
6. **Outcome**, posted on the ticket:

| Outcome | Linear | Slack | Git |
|---|---|---|---|
| `pr_opened` | link to the PR | nothing (GitHub notifies the reviewer) | branch + PR |
| `sql_proposed` | an SQL script for you to run in production, with preview, backup, transaction and rollback | DM | nothing |
| `needs_decision` | 2 to 4 options with their consequences | DM 🤔 | nothing |
| `blocked` | what is missing, or precise questions | DM 🚧 | nothing |
| `not_code` | why it isn't code (or why it's unclear) | DM 🧭 | nothing |

7. **Your answer.** You reply on the ticket with `/tma option 2`, or `/tma keep the current behaviour for B2B`. The agent is relaunched with your decision injected into its prompt. Questions always go to you, never to the ticket author.
8. **Learning.** When the ticket moves to **Done**, the validated fix is appended to the knowledge base journal, and the agent uses it for later tickets.

Urgent tickets jump the queue but never interrupt a running job. Audits run in their own queue, so a one-hour audit doesn't block fixes.

---

## Missions

A mission defines what the agent produces, with which tools and which knowledge. Missions are declarative: an entry in `MISSIONS` (`server.mjs`), a module in `missions/`, and a skill in the knowledge repository.

| Mission | Produces | Tools |
|---|---|---|
| `correctif` (default) | a PR, an SQL script, or a question | git, build, PHP/Node, read-only staging database, GitHub MCP (read + `create_pull_request`) |
| `proposition` | an implementation plan on the ticket: approach, files, steps, acceptance criteria, risks, estimate, open questions. Nothing is modified. `/tma vas-y` ("go") then runs `correctif` with the approved plan. | read-only: code, git, staging database, Linear, GitHub |
| `audit-rgaa` | a full accessibility audit against RGAA 4.1.2, the French WCAG-based standard (106 criteria), published as a report, with a summary on the ticket | `tma-browse` (headless Chromium), read-only git |

**Picking the mission**, from most to least explicit: a `/tma <mission>` command, a label (`Audit RGAA`, `Feature`), the mission already running on that ticket, and finally a quick qualification by Claude Haiku (under one cent) when the ticket looks like an accessibility request. With medium confidence, the server asks you to confirm instead of guessing. A single, precise accessibility bug (one button's contrast) stays a `correctif`.

**The accessibility audit** runs on **production, read-only**: that's what visitors actually get, third-party widgets included. `tma-browse` enforces three guardrails:
- it blocks analytics, ad pixels and session recording, so the audit doesn't skew traffic or conversion data;
- it blocks every form or data submission except add-to-cart;
- it tags its user agent `TMA-auto-audit`, so the visits are easy to find in logs.

The agent samples 8 to 12 pages. On each one, `tma-browse scan` runs axe-core and reads the accessible names that Chromium computes. It walks the real keyboard tab order, renders at 1440, 640, 375 and 320 px, and checks text spacing, the page with CSS disabled, and motion. The agent then rules on all 106 criteria and ties every fix to a file in the repository. The server validates `audit.json`, and if it is incomplete it resumes the agent's session once to complete it. It then computes the compliance rate the official way: C ÷ (C + NC), shown as a range while criteria are still "to check". Finally it renders an HTML report.

---

## Grounding: why it doesn't make up fixes

The main risk with an autonomous fixer is a confident fix that doesn't match the stack or the team's practices. tma-auto keeps knowledge in three layers, each written by the right party at the right time:

| Layer | Where | Written by | When |
|---|---|---|---|
| **Site**: stack, versions, modules, pitfalls, history | each repository's `CLAUDE.md` | the agent, **inside the fix PR** | reviewed together with the code |
| **Shared practices** | `tma-knowledge/skills/<kind>/SKILL.md` | the team, through PRs | when a rule changes |
| **History**: cause, fix, decisions, lessons | `tma-knowledge/journal/<repo>.md` | the server, automatically | when a ticket reaches **Done** |

- **Mandatory sources.** The prompt lists what to read before coding: CLAUDE.md, the skill, the site's journal, a search across every site's journal, `git log`, and finished Linear tickets with the same label. It forbids assuming any version or convention these sources don't state. If something essential is missing, the answer is `blocked` or `needs_decision`.
- **Only validated knowledge gets in.** The journal only receives fixes whose ticket reached Done, which means they were reviewed and accepted. A cancelled ticket drops its pending entry. The agent cannot write to the knowledge repository, so a malicious ticket can't poison it.
- **Promotion to a rule is manual.** When the journal shows the same lesson on several sites, a human moves it into the skill.
- **No vector database, on purpose.** The corpus is small: about forty repositories, two skills, a few hundred journal entries a year. Grep over Markdown is exact on a module or file name, cites its source and needs no infrastructure. Embeddings return "close enough", which is exactly what leads to hallucinations.
- **Weekly sync.** Every Monday, `scripts/sync-knowledge.mjs` rebuilds the inventory of third-party modules per shop. These modules must not be edited, because an update would overwrite the fix. It also picks up CLAUDE.md files that changed since the last sync, and has Claude propose the matching skill updates as a PR for review.

---

## Safety model

Anyone in the Linear workspace who assigns you a ticket gets the agent to read its text. So the ticket is treated as untrusted input, and every layer assumes the agent can be talked into anything:

- **Container**: non-root, `cap_drop: ALL`, `no-new-privileges`, CPU and memory capped. Only four paths are routed by the reverse proxy, with rate limiting, and no port is published.
- **Tool allowlist** (`dontAsk` mode): no WebFetch or WebSearch. No `git push --force`, `--no-verify`, `git -c`, `git config` or `git remote`. The bot's tokens and the MCP config can't be read, and neither can `/proc`.
- **Branch lock without branch protection.** The GitHub organization's plan has no branch protection on private repositories. So a `pre-push` hook is forced on every agent git command, via `core.hooksPath` passed through `GIT_CONFIG_*`. It only allows `tma/linear-<id>` and refuses deletions. The repository's own hooks (husky) still run afterwards.
- **GitHub MCP**: read tools plus `create_pull_request`. No merge, no `push_files`, no `create_or_update_file`. If a bot commit shows up on the base branch during a run, a 🚨 Slack alert goes out.
- **Linear MCP**: read-only. Only the server comments or changes ticket states.
- **Secrets**: the webhook, Linear and Slack secrets are removed from the agent's environment.
- **Databases**: the agent reads **staging** databases only, through a MySQL user with `SELECT` on 10 content tables, a read-only session and a row limit (`tma-sql`). It never writes. Content fixes come back as an SQL script that you run yourself, keyed on the primary key *and* the current value, because production may differ from staging.
- **Staging infrastructure**: SSH keys with forced commands. One key can only start or stop allow-listed database containers (`recette/db-control.sh`), and never stops a database someone else started. Another can only deploy `tma/linear-*` branches to allow-listed sites (`recette/recette-deploy.sh`). It refuses when the staging copy has local changes, and it can restore the exact previous state. The SSH tunnels only allow port forwarding to relays that listen on `127.0.0.1`.
- **Who can relaunch**: `/tma` only works for you (and for Linear users you allow), and `@tma` in a PR review only for the reviewer and allowed GitHub logins.
- **Budget and time** are capped per run.

`npm`, `composer` and `node` can run arbitrary code, so isolation ultimately relies on the container and on narrowly scoped tokens.

---

## Measuring the value

`/dashboard` (password-protected) tracks every run: outcome, duration, notional cost, PRs per repository. For each delivered result, the agent also returns a `human_estimate`: how long a developer who knows the codebase would have needed, as a range with its reasoning. The dashboard converts that to a cost at `DEV_HOURLY_RATE`. A summary goes to Slack every Monday.

The **benchmark** (`scripts/benchmark.mjs`) answers a harder question: is all this harness better than plain Claude Code? It replays real, already-validated tickets with a *raw* Claude Code: same model, same starting commit, but no skills, no prompt, no CLAUDE.md, no journal, no routing and no `tma-*` tools. The raw run is sandboxed: a temporary HOME, `git push` made impossible, no MCP. Claude then grades the raw deliverable against the validated one.

On the first run (4 real tickets), the harness delivered a usable result 4 times out of 4, and raw Claude Code once out of 4, with an average raw quality of 4.8/10. Raw Claude Code was much cheaper and faster because it did much less. It audited 4 pages and missed the major issues. It edited 8 files blind instead of asking what the ticket meant. It walked into a compiled-CSS trap that the repository's CLAUDE.md documents.

---

## Repository layout

| Path | Role |
|---|---|
| `server.mjs` | The webhook server: Node 22, zero npm dependencies |
| `missions/` | `audit-rgaa.mjs` (prompt, `audit.json` schema, validation, rate, report) and `proposition.mjs` |
| `repos.json` | Managed repositories and routing (labels, projects, teams); the copy here is a fictional example |
| `Dockerfile`, `compose.yml` | Image with PHP 7.4/8.1, Node 22/24/26, Chromium, Claude Code (pinned); Traefik labels |
| `git-hooks/` | The hooks forced on the agent (`pre-push` branch lock) |
| `scripts/tma-php-lint` | Lints changed PHP files with every production PHP version of the site |
| `scripts/tma-sql` | Read-only SQL for the agent |
| `scripts/tma-browse.mjs`, `lib-browser.mjs`, `tma-a11y.mjs` | The audit browser: scans, screenshots, tab order, scenarios, tracking blocker |
| `scripts/benchmark.mjs` | Harness vs raw Claude Code benchmark |
| `scripts/sync-knowledge.mjs` | Weekly knowledge sync |
| `recette/` | Staging tooling: SSH tunnels, database relays, forced-command scripts |
| `scripts/send-test-webhook.mjs`, `scripts/smoke-test.sh` | Signed fake webhooks; dry-run smoke test (CI) |
| `deploy/` | Variant without Docker: systemd unit and Caddy |

---

## Try it locally (dry run)

No Claude, git or network access is needed. With `DRY_RUN=1`, the server routes the ticket and prints the prompt it would send:

```sh
sh scripts/smoke-test.sh
```

Or by hand:

```sh
DRY_RUN=1 LINEAR_WEBHOOK_SECRET=s LINEAR_ASSIGNEE_ID=00000000-0000-0000-0000-000000000000 \
GITHUB_REVIEWER=you REPOS_FILE=$PWD/repos.json STATE_DIR=/tmp/tma/state LOGS_DIR=/tmp/tma/logs \
WORKTREES_DIR=/tmp/tma/wt node server.mjs

# in another terminal
LINEAR_WEBHOOK_SECRET=s LINEAR_ASSIGNEE_ID=00000000-0000-0000-0000-000000000000 \
node scripts/send-test-webhook.mjs --labels globex
```

---

## Running it for real

You need a Linear workspace, a GitHub organization, a Slack workspace, a Claude subscription or API key, and a server with Docker behind Traefik (or Caddy and systemd, see `deploy/`).

1. **A bot GitHub account.** GitHub refuses a review request from the PR author, so the agent needs its own account. Give it write access to the repositories in `repos.json` and to the knowledge repository. Then create a fine-grained PAT (Contents and Pull requests: read/write) and, if you install private packages, a classic PAT with `read:packages` only.
2. **A Linear webhook** on `https://<TMA_HOST>/webhooks/linear` for the **Issues** and **Comments** events, plus a personal API key.
3. **A Slack app** with the `chat:write` scope, for direct messages.
4. **Configure**: copy `.env.example` to `.env` (every variable is documented there), and describe your repositories in `repos.json`:

```jsonc
"acme/globex": {
  "path": "/data/repos/globex",
  "kind": "prestashop",            // skill to read: prestashop | outils-internes
  "php": ["8.1"],                  // production versions: the first one runs, all are linted
  "node": "22",                    // otherwise read from .nvmrc
  "baseBranch": "main",
  "buildCommand": "tma-php-lint",  // what "it builds" means for this repo
  "notes": "…",                    // injected into the prompt
  "db": "DB_URL_GLOBEX",           // optional read-only staging database
  "prodUrl": "https://www.globex.example",
  "siblings": ["acme/globex-pt"]   // sites of the same group
}
```

5. **Build and set up** (bot git identity, MCP servers, clone of every repository; safe to run again):

```sh
docker compose build
docker compose run --rm tma-auto sh scripts/setup.sh
docker compose run --rm -e DRY_RUN=1 tma-auto node server.mjs   # Ctrl+C after "écoute sur"
docker compose up -d && docker compose logs -f
```

Claude Code authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or with `ANTHROPIC_API_KEY`. The staging databases (`recette/`) are optional. The flow is: list them in `recette/targets.conf`, run `recette/gateways.sh` on each staging host, create the read-only users with `scripts/recette-db-users.sh`, then start the `tma-tunnel` service.

### Commands

| Where | Command | Effect |
|---|---|---|
| Linear | `/tma <instruction>` | relaunch with your instruction; picks up the existing PR or audit |
| Linear | `/tma correctif`, `/tma proposition`, `/tma audit-rgaa [recette] [/path …]` | force a mission |
| Linear | `/tma vas-y` | after a proposition: implement the approved plan |
| Linear | `/tma recette [/path …]` | deploy the PR branch to the site's staging, with an accessibility check before and after |
| Linear | `/tma recette retour` | restore staging to its original state |
| GitHub | `@tma <instruction>` in a PR review | relaunch on that point; the file, line and diff hunk are passed along |

---

## License

[MIT](LICENSE) © 2026 Guillaume Kieffer

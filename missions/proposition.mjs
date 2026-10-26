// Mission « proposition » : pour une fonctionnalité, l'agent lit le code et propose un plan (approche, fichiers,
// étapes, risques, vérification, estimation) sans rien modifier. Le responsable valide par `/tma vas-y` (ou ajuste) :
// le correctif suit alors ce plan, que le serveur lui transmet.

export const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['plan_proposed', 'blocked', 'not_code'] },
    reason: { type: 'string', description: 'En français, 1 à 3 phrases' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Points à trancher par le responsable avant de développer (1 à 4)' },
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
    plan: {
      type: 'object',
      description: 'Obligatoire avec plan_proposed',
      properties: {
        summary: { type: 'string', description: 'Ce que la fonctionnalité fera, vu de l\'utilisateur, en 2 ou 3 phrases' },
        approach: { type: 'string', description: 'Comment la réaliser dans ce dépôt, dans le style du code existant, et pourquoi cette approche' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, change: { type: 'string' } }, required: ['path', 'change'] },
        },
        steps: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Comment vérifier que c\'est fait (critères observables)' },
        risks: { type: 'array', items: { type: 'string' } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        estimate: { type: 'string', description: 'Fourchette de charge pour un développeur humain, et ce qui la fait varier' },
      },
      required: ['summary', 'approach', 'files', 'steps', 'acceptance', 'risks', 'estimate'],
    },
  },
  required: ['status', 'reason'],
};

export function buildPrompt({ ticket, repo, base, sources }) {
  const description = ticket.description.replaceAll('</ticket>', '');
  const consigne = ticket.instructions ? `\nRemarques du responsable sur une proposition précédente, à prendre en compte :\n${ticket.instructions}\n` : '';
  return `Mission : proposer un plan de réalisation pour la fonctionnalité demandée dans ce ticket Linear. **Tu ne modifies rien** : ni fichier, ni commit, ni PR.

<ticket>
Identifiant : ${ticket.identifier}
Titre : ${ticket.title}
URL : ${ticket.url}
Description :
${description}
</ticket>
${consigne}
Tu es dans le dossier du projet ${repo.fullName} (branche de référence \`origin/${base}\`).

Sources de vérité, à lire avant de proposer quoi que ce soit :
${sources}

Tes outils sont en lecture seule : Read, Grep, Glob, \`git log|show|grep|diff|status\`, \`ls\`, \`wc\`${repo.kind === 'prestashop' ? ', `tma-sql` (lecture de la base de recette)' : ''}, MCP Linear et GitHub en lecture.

1. Lis le ticket complet avec le MCP Linear (commentaires, captures, maquettes).
2. Qualifie-le. Si ce n'est pas du code (réglage du back-office, contenu, visuel, service tiers), réponds \`not_code\` en disant quoi faire à la place. S'il manque une information indispensable (page concernée, comportement attendu), réponds \`blocked\` avec 1 à 3 questions.
3. Sinon, étudie le code concerné et propose **le plus petit changement qui satisfait la demande**, dans le style du code existant et avec ses mécanismes (hooks, surcharges de thème, modules maison). Un module tiers ne se modifie pas : surcharge, ou point de décision.
4. Rends le plan :
   - \`summary\` : ce que la fonctionnalité fera, vu de l'utilisateur ;
   - \`approach\` : comment, et pourquoi cette approche plutôt qu'une autre ;
   - \`files\` : chaque fichier à créer ou à modifier, avec ce qui change ;
   - \`steps\` : les étapes de réalisation, dans l'ordre ;
   - \`acceptance\` : les critères observables qui diront que c'est fait ;
   - \`risks\` : ce qui peut casser (autres pages, autres sites du groupe, cache, accessibilité, SEO) ;
   - \`outOfScope\` : ce que tu proposes de ne pas faire ;
   - \`estimate\` : une fourchette de charge pour un développeur, et ce qui la fait varier.
   Mets dans \`questions\` les choix qui relèvent du métier ou du produit, et qu'il faut trancher avant de développer.

Avec \`plan_proposed\`, \`human_estimate\` : le temps qu'aurait mis un développeur du parc pour produire **cette proposition** (lecture du code, analyse, rédaction du plan), pas la fonctionnalité elle-même. Fourchette réaliste, avec sa justification. Si tu repars d'un livrable précédent (PR existante, audit précédent, proposition déjà faite), n'estime que le travail supplémentaire.

N'invente ni version, ni convention, ni comportement attendu : cite le fichier ou la source sur lesquels tu t'appuies.`;
}

const list = (items) => (items ?? []).filter(Boolean).map((x) => `- ${x}`).join('\n');

// Plan en Markdown : commentaire Linear, et contexte du correctif qui le réalisera.
export function formatPlan(plan) {
  if (!plan) return '';
  return [
    `**En bref.** ${plan.summary}`,
    `**Approche.** ${plan.approach}`,
    plan.files?.length && `**Fichiers.**\n${plan.files.map((f) => `- \`${f.path}\` : ${f.change}`).join('\n')}`,
    plan.steps?.length && `**Étapes.**\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    plan.acceptance?.length && `**C'est fait quand.**\n${list(plan.acceptance)}`,
    plan.risks?.length && `**Risques.**\n${list(plan.risks)}`,
    plan.outOfScope?.length && `**Hors périmètre.**\n${list(plan.outOfScope)}`,
    `**Estimation.** ${plan.estimate}`,
  ].filter(Boolean).join('\n\n');
}

#!/usr/bin/env node
// Envoie un faux webhook Linear signé, pour tester le serveur.
// Usage : LINEAR_WEBHOOK_SECRET=... LINEAR_ASSIGNEE_ID=... node scripts/send-test-webhook.mjs [url] [options]
//   --labels "globex,northwind"     labels du ticket (défaut : acme)
//   --title "…" --description "…"   titre et description du ticket (aiguillage des missions)
//   --github acme/acme-pim      lien GitHub dans la description
//   --done                          passage du ticket à « Terminé » (alimente le journal)
//   --comment "/tma option 2"       ta réponse en commentaire (nécessite LINEAR_API_KEY côté serveur)
//   --bad-signature                 signature invalide (doit renvoyer 401)
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const url = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8787/webhooks/linear';
const secret = process.env.LINEAR_WEBHOOK_SECRET;
const assigneeId = process.env.LINEAR_ASSIGNEE_ID;
const issueId = process.env.TEST_ISSUE_ID ?? crypto.randomUUID();
const labels = (opt('--labels') ?? 'acme').split(',').map((name, i) => ({ id: `lbl-${i}`, name: name.trim() }));
const github = opt('--github');

const data = {
  id: issueId,
  identifier: 'ECOM-999',
  number: 999,
  title: opt('--title') ?? 'Test : le bouton "Ajouter au panier" ne réagit pas',
  description: `${github ? `Dépôt : https://github.com/${github}\n\n` : ''}${opt('--description') ?? 'Repro : fiche produit, clic sur le bouton.'}`,
  assigneeId,
  team: { key: 'ECOM' },
  state: { type: 'unstarted' },
  labels,
};

let event = {
  action: 'update',
  type: 'Issue',
  url: 'https://linear.app/acme/issue/ECOM-999/test',
  webhookTimestamp: Date.now(),
  updatedFrom: { assigneeId: null },
  data,
};

if (argv.includes('--done')) {
  event = { ...event, updatedFrom: { stateId: 'previous-state' }, data: { ...data, state: { type: 'completed' } } };
}

const comment = opt('--comment');
if (argv.includes('--comment')) {
  event = {
    action: 'create',
    type: 'Comment',
    webhookTimestamp: Date.now(),
    data: { id: crypto.randomUUID(), body: comment ?? '/tma', userId: assigneeId, issueId },
  };
}

const body = JSON.stringify(event);
const signature = argv.includes('--bad-signature')
  ? '0'.repeat(64)
  : crypto.createHmac('sha256', secret).update(body).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Linear-Signature': signature,
    'Linear-Delivery': crypto.randomUUID(),
    'Linear-Event': event.type,
  },
  body,
});
console.log(res.status, await res.text());

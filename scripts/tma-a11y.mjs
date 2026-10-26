#!/usr/bin/env node
// Audit d'accessibilité (axe-core, règles WCAG 2.0/2.1 A et AA, base du RGAA) d'une ou plusieurs pages.
// Usage : node scripts/tma-a11y.mjs [--auth user:motdepasse] <url> [<url>…]   (ou TMA_A11Y_AUTH=user:motdepasse)
// Sortie JSON : { "<url>": { "ok": true, "violations": [{ id, impact, help, helpUrl, count }] } | { "ok": false, "error": "…" } }
// Un audit automatique ne couvre qu'une partie du RGAA : il détecte des défauts, il ne prouve pas la conformité.
import { axeSource, launch, newPage, gotoAwake, parseAuth } from './lib-browser.mjs';

const args = process.argv.slice(2);
let auth = process.env.TMA_A11Y_AUTH || null;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--auth') auth = args[++i];
  else urls.push(args[i]);
}

const browser = await launch();
const out = {};
try {
  for (const url of urls) {
    const page = await newPage(browser, { auth: parseAuth(auth), width: 1366 });
    try {
      await gotoAwake(page, url);
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async () =>
        // eslint-disable-next-line no-undef
        axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] }));
      out[url] = {
        ok: true,
        violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length })),
      };
    } catch (err) {
      out[url] = { ok: false, error: err.message.split('\n')[0] };
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));

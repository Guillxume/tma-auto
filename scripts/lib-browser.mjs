// Chromium sans interface pour les recettes : lancement, authentification HTTP, réveil des recettes en veille.
// Partagé par tma-a11y.mjs (audit avant / après de /tma recette) et tma-browse.mjs (outil de l'agent d'audit).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// puppeteer-core et axe-core sont installés dans /opt/tma-tools par le Dockerfile (TMA_TOOLS_DIR en local).
const require = createRequire(path.join(process.env.TMA_TOOLS_DIR ?? '/opt/tma-tools', '/'));
export const puppeteer = require('puppeteer-core');
export const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
export const axeVersion = require('axe-core/package.json').version;

export function launch() {
  return puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=fr-FR'],
  });
}

// « user:motdepasse » (le mot de passe peut contenir des « : »).
export function parseAuth(auth) {
  if (!auth) return null;
  const [username, ...rest] = auth.split(':');
  return { username, password: rest.join(':') };
}

export async function newPage(browser, { auth = null, width = 1440, height = 900, mobile = false } = {}) {
  const page = await browser.newPage();
  if (auth) await page.authenticate(auth);
  // Agent utilisateur d'un Chrome ordinaire (certains sites refusent « HeadlessChrome »), Android en mobile :
  // PrestaShop choisit parfois ses gabarits mobiles côté serveur d'après l'agent utilisateur.
  // La marque finale « TMA-auto-audit » permet de repérer (et d'exclure) ces visites dans les journaux du site.
  const version = (await browser.version()).match(/\/([\d.]+)/)?.[1] ?? '143.0.0.0';
  await page.setUserAgent(mobile
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36 TMA-auto-audit`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 TMA-auto-audit`);
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
  return page;
}

// ---------------------------------------------------------------------------
// Production en lecture seule : on regarde, on n'envoie rien.
// ---------------------------------------------------------------------------

// Mesure d'audience, publicité et enregistrement de session : coupés, pour ne fausser ni les statistiques ni
// les conversions. Les scripts eux-mêmes se chargent (la page reste celle d'un visiteur) ; seuls leurs envois sont coupés.
// Les relais « first-party » (balises côté serveur sur le domaine du site, ex. /u32n/gs/ccm/collect) se reconnaissent
// à leur chemin de collecte ou à l'identifiant de propriété qu'envoie chaque appel (tid=G-…, AW-…, UA-…).
// Les scripts eux-mêmes (gtm.js, gtag/js) se chargent : ils injectent parfois le bandeau cookies ou un chat.
const TRACKING = /[?&]tid=(?:G|AW|UA|DC)-[\w-]+|\/(?:ccm|[gj])\/collect|googletagmanager\.com\/(?:td|a)\b|axept\.io\/v1\/analytics|google-analytics\.com|analytics\.google\.com|stats\.g\.doubleclick\.net|doubleclick\.net|googleadservices\.com|google\.[a-z.]+\/pagead|googlesyndication|facebook\.com\/tr|matomo\.php|piwik\.php|bat\.bing\.com|px\.ads\.linkedin\.com|analytics\.tiktok\.com|hotjar\.(?:com|io)|clarity\.ms|contentsquare|mouseflow|smartlook|fullstory/i;
// Envois de données refusés, quel que soit le domaine : formulaires, compte, commande, avis.
const SENSITIVE = /contact|devis|quote|cotiza|presupuesto|or[cç]amento|preventivo|newsletter|subscri|login|connexion|registr|inscri|account|compte|cuenta|conta|password|order|commande|pedido|ordine|checkout|paiement|payment|pago|review|avis|opini|comment/i;
// Le panier reste permis : un panier anonyme, sans suite, sert à auditer la page panier.
const CART = /controller=cart|\/(?:cart|panier|carrito|carrinho|carrello)\b|ps_shoppingcart|blockcart/i;

// Installe les garde-fous sur une page. Chaque requête bloquée est ajoutée à `blocked`. La mesure d'audience est
// toujours coupée (une recette envoie souvent ses visites au compte de la production) ; les envois ne sont
// bloqués qu'en production (`readOnly`).
export async function guardRequests(page, blocked, { readOnly = true } = {}) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = req.url();
    const method = req.method();
    let why = null;
    if (TRACKING.test(url)) why = 'mesure d\'audience';
    else if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !CART.test(url)) {
      const body = (req.postData() ?? '').slice(0, 4000);
      if (req.isNavigationRequest()) why = 'envoi de formulaire';
      else if (SENSITIVE.test(url) || SENSITIVE.test(body)) why = 'envoi de données';
    }
    if (why) {
      blocked.push({ why, method, url: url.slice(0, 200) });
      req.abort('blockedbyclient').catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

// Recettes en veille (« Sablier ») : page d'attente rechargée toutes les 5 s, puis parfois un 503 le temps
// que PHP démarre. On attend la vraie page, 2 minutes au plus. Lève une erreur si la page reste en échec.
export async function gotoAwake(page, url, { deadlineMs = 120_000 } = {}) {
  let res;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => ({ status: () => 0, err: e }));
    const status = res?.status() ?? 0;
    const sleeping = status === 503 || status === 0 || /sablier/i.test(await page.title().catch(() => '')) ||
      /sablier/i.test(await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => ''));
    if (!sleeping || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  // Laisse le JS de la page s'exécuter (contenus injectés), sans attendre les traceurs indéfiniment.
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => {});
  if (!res || res.status() >= 400 || res.status() === 0) throw new Error(`HTTP ${res?.status?.() || res?.err?.message || '?'}`);
  return res;
}

#!/usr/bin/env node
// Outil navigateur de l'agent d'audit d'accessibilité (mission audit-rgaa). Recette uniquement.
//
//   tma-browse scan <page> [--name P1]                     batterie complète → pages/<name>/
//   tma-browse shot <page> [--width N] [--height N] [--full] [--selector CSS] [--name x]
//   tma-browse tab  <page> [--n 80] [--width N] [--shift]  vraie tabulation clavier
//   tma-browse run  <page> <steps.json> [--width N] [--name x]
//   tma-browse eval <page> "<expression ou corps de fonction>" [--width N]
//
// <page> : chemin (« /panier ») résolu sur TMA_SITE_URL (à défaut TMA_RECETTE_URL), ou URL complète du site
// ou de sa recette. Avec TMA_SITE_MODE=production, le site est en LECTURE SEULE : mesure d'audience coupée,
// envois de formulaires et de données refusés (sauf le panier). Les identifiants TMA_RECETTE_AUTH ne servent
// qu'à la recette. Sorties sous TMA_AUDIT_DIR (dossier courant par défaut).
import fs from 'node:fs';
import path from 'node:path';
import { axeSource, axeVersion, launch, newPage, gotoAwake, parseAuth, guardRequests } from './lib-browser.mjs';

const USAGE = `Usage :
  tma-browse scan <page> [--name P1]
  tma-browse shot <page> [--width 1440] [--height 900] [--full] [--selector "css"] [--name x]
  tma-browse tab  <page> [--n 80] [--width 1440] [--shift]
  tma-browse run  <page> <steps.json> [--width 1440] [--name x]
  tma-browse eval <page> "<expression JS>" [--width 1440]
<page> : chemin (/panier) résolu sur le site audité, ou URL complète du site ou de sa recette.
En production (TMA_SITE_MODE=production), lecture seule : mesure d'audience coupée, envois de formulaires
et de données bloqués (le panier reste permis). Les requêtes bloquées sont listées dans blocked.json.

Étapes de « run » (fichier JSON : un tableau d'objets, une action par objet) :
  {"goto": "/devis"}                         {"width": 375}
  {"click": "css"}  {"hover": "css"}  {"focus": "css"}  {"check": "css"}
  {"type": ["css", "texte"]}  ou  {"type": "css", "text": "texte"}   (ajoute au contenu du champ)
  {"fill": ["css", "texte"]}  ou  {"fill": "css", "value": "texte"}  (vide le champ, puis saisit)
  {"select": ["css", "valeur"]}  ou  {"select": "css", "value": "valeur"}
  {"press": "Tab", "times": 3}   (combinaisons : "Shift+Tab", "Escape", "Enter"…)
  {"wait": 500}  {"waitFor": "css"}
  {"observe": "css"} puis, après l'action, {"mutations": true}   (messages de statut, 7.5)
  {"active": true}   (élément qui a le focus)
  {"eval": "expression JS"}   {"shot": "nom", "selector": "css", "full": true}
Le scénario s'arrête à la première étape en erreur : rien ne s'exécute après (pas de soumission à moitié remplie).
Formulaires : en production, l'envoi est bloqué (teste la validation sans envoyer) ; un envoi réel ne se fait que
sur la recette (URL complète), une seule fois, avec les données de test du skill rgaa.`;

const OUT = path.resolve(process.env.TMA_AUDIT_DIR ?? process.cwd());
const RECETTE = process.env.TMA_RECETTE_URL ? new URL(process.env.TMA_RECETTE_URL).origin : null;
const SITE = process.env.TMA_SITE_URL ? new URL(process.env.TMA_SITE_URL).origin : RECETTE;
const PRODUCTION = process.env.TMA_SITE_MODE === 'production' && SITE !== RECETTE ? SITE : null;
const AUTH = parseAuth(process.env.TMA_RECETTE_AUTH ?? process.env.TMA_A11Y_AUTH ?? '');
// Requêtes bloquées en production pendant cette commande (écrites dans blocked.json et résumées à la fin).
const BLOCKED = [];
const WIDTHS = [1440, 640, 375, 320];

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[k] = true;
      else { opt[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

function fail(msg) {
  console.error(`tma-browse : ${msg}`);
  process.exit(1);
}

// Seule la recette du site est autorisée : jamais la production ni un autre site.
// Seuls le site audité et sa recette sont autorisés : jamais un autre site.
function resolveUrl(target) {
  if (!target) throw new Error(`page manquante.\n${USAGE}`);
  if (!SITE) throw new Error('TMA_SITE_URL et TMA_RECETTE_URL absents : aucun site configuré.');
  const url = new URL(target, SITE);
  if (![SITE, RECETTE].includes(url.origin)) throw new Error(`${url.origin} refusé : seuls ${[SITE, RECETTE].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' et ')} sont autorisés.`);
  return url.toString();
}

const slug = (s) => s.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'accueil';

// Un élément par ligne : Grep et Read par tranches restent utilisables sur de gros relevés.
function writeJsonl(file, value) {
  const body = Array.isArray(value)
    ? `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]\n`
    : `${JSON.stringify(value, null, 1)}\n`;
  fs.writeFileSync(file, body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// « Shift+Tab », « Control+Home » : puppeteer n'accepte qu'une touche par press().
async function pressKeys(page, combo) {
  const keys = combo.split('+');
  const key = keys.pop();
  for (const m of keys) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of keys.reverse()) await page.keyboard.up(m);
}

// ---------------------------------------------------------------------------
// Code exécuté dans la page
// ---------------------------------------------------------------------------

// Installe les utilitaires communs dans la page (window.__tma). Idempotent.
function installHelpers() {
  if (window.__tma) return;
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const hex = (c) => c ? `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : null;
  // Fond effectif : on remonte les ancêtres en composant les fonds semi-transparents.
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { color: null, image: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) acc = blend(l, acc);
    return { color: acc, image: false };
  };
  const cssPath = (el) => {
    if (!(el instanceof Element)) return '';
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const cls = [...n.classList].filter((c) => !/^(js-|is-|active|show|open|hover|focus)/.test(c)).slice(0, 2);
      if (cls.length) p += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
      const sib = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const opacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return Math.round(o * 100) / 100; };
  const rendered = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const text = (el, max = 160) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const idText = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
  const outer = (el, max = 220) => el.outerHTML.replace(/\s+/g, ' ').slice(0, max);
  let seq = 0;
  const tag = (el) => { if (!el.dataset.tma) el.dataset.tma = String(++seq); return el.dataset.tma; };
  const FOCUSABLE = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable=true], audio[controls], video[controls]';
  const focusables = () => [...document.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && rendered(el));
  const styleSnap = (el) => { const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.color, cs.textDecorationLine].join('|'); };
  window.__tma = { parse, ratio, hex, bgOf, cssPath, opacity, rendered, rect, text, idText, outer, tag, focusables, styleSnap, blend };
}

// Fait défiler la page pour déclencher les chargements différés (images, widgets).
async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight && y < 30_000; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo(0, 0);
  });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8_000 }).catch(() => {});
}

// Noms et rôles accessibles calculés par Chromium, pour les éléments marqués data-tma.
async function axNames(page) {
  const client = await page.createCDPSession();
  try {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const byBackend = new Map();
    const walk = (n) => {
      if (n.attributes) {
        const i = n.attributes.indexOf('data-tma');
        if (i !== -1) byBackend.set(n.backendNodeId, n.attributes[i + 1]);
      }
      for (const c of n.children ?? []) walk(c);
      for (const c of n.shadowRoots ?? []) walk(c);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(root);
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    const out = {};
    for (const n of nodes) {
      const id = byBackend.get(n.backendDOMNodeId);
      if (id) out[id] = { role: n.role?.value ?? '', name: n.name?.value ?? '', ignored: Boolean(n.ignored) };
    }
    return out;
  } finally {
    await client.detach().catch(() => {});
  }
}

// Extraction principale (une fois les éléments marqués).
function extract() {
  const T = window.__tma;
  const vis = (el) => T.rendered(el);
  const hiddenBy = (el) => el.closest('[aria-hidden="true"]') ? 'aria-hidden' : el.closest('[inert]') ? 'inert' : null;

  const images = [...document.querySelectorAll('img, [role="img"], svg, input[type="image"], area, object[type^="image"], canvas')]
    .filter((el) => !(el.tagName === 'svg' && el.parentElement?.closest('svg')))
    .map((el) => ({
      tma: T.tag(el), tag: el.tagName.toLowerCase(), sel: T.cssPath(el),
      src: (el.currentSrc || el.getAttribute('src') || el.getAttribute('data') || '').slice(0, 160),
      alt: el.hasAttribute('alt') ? el.getAttribute('alt') : null,
      ariaLabel: el.getAttribute('aria-label'), labelledby: T.idText(el.getAttribute('aria-labelledby')) || null,
      title: el.getAttribute('title') ?? (el.tagName === 'svg' ? el.querySelector(':scope > title')?.textContent ?? null : null),
      role: el.getAttribute('role'), hidden: hiddenBy(el),
      inLink: el.closest('a[href], button') ? T.text(el.closest('a[href], button'), 80) || '(lien sans texte)' : null,
      figcaption: el.closest('figure')?.querySelector('figcaption') ? T.text(el.closest('figure').querySelector('figcaption'), 120) : null,
      size: T.rect(el), visible: vis(el),
    }));

  const links = [...document.querySelectorAll('a[href], [role="link"]')].map((el) => {
    const ctx = el.closest('p, li, td, th, dd, figcaption, h1, h2, h3, h4, h5, h6');
    return {
      tma: T.tag(el), sel: T.cssPath(el), text: T.text(el, 120), href: el.getAttribute('href'), target: el.getAttribute('target'),
      ariaLabel: el.getAttribute('aria-label'), title: el.getAttribute('title'),
      onlyImage: !T.text(el) && Boolean(el.querySelector('img, svg, [role="img"], i, span[class*="icon"]')),
      context: ctx && ctx !== el ? T.text(ctx, 160) : null, visible: vis(el), size: T.rect(el), hidden: hiddenBy(el),
    };
  });

  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]')].map((el) => ({
    tma: T.tag(el), sel: T.cssPath(el), text: T.text(el, 100) || el.value || '', ariaLabel: el.getAttribute('aria-label'), title: el.getAttribute('title'),
    expanded: el.getAttribute('aria-expanded'), haspopup: el.getAttribute('aria-haspopup'), controls: el.getAttribute('aria-controls'),
    type: el.getAttribute('type'), visible: vis(el), hidden: hiddenBy(el),
  }));

  const FIELD = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [role="textbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], [role="searchbox"]';
  const fields = [...document.querySelectorAll(FIELD)].map((el) => {
    const labelFor = el.id ? [...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)].map((l) => T.text(l, 100)).join(' | ') || null : null;
    const fs = el.closest('fieldset');
    const describedby = T.idText(el.getAttribute('aria-describedby'));
    return {
      tma: T.tag(el), sel: T.cssPath(el), tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id || null, name: el.getAttribute('name'),
      labelFor, wrappingLabel: el.closest('label') ? T.text(el.closest('label'), 100) : null,
      ariaLabel: el.getAttribute('aria-label'), labelledby: T.idText(el.getAttribute('aria-labelledby')) || null, title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder'), required: el.required || el.getAttribute('aria-required') === 'true',
      autocomplete: el.getAttribute('autocomplete'), invalid: el.getAttribute('aria-invalid'), describedby: describedby || null,
      legend: fs?.querySelector('legend') ? T.text(fs.querySelector('legend'), 100) : null,
      form: el.form ? (el.form.id || el.form.getAttribute('action') || 'form') : null, visible: vis(el), hidden: hiddenBy(el),
    };
  });
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    sel: T.cssPath(f), id: f.id || null, action: f.getAttribute('action'), method: f.getAttribute('method'),
    fields: f.querySelectorAll(FIELD).length, visible: vis(f), novalidate: f.noValidate,
  }));
  const orphanLabels = [...document.querySelectorAll('label')].filter((l) => {
    const f = l.getAttribute('for');
    if (f) return !document.getElementById(f);
    return !l.querySelector('input, select, textarea');
  }).map((l) => ({ sel: T.cssPath(l), text: T.text(l, 100), for: l.getAttribute('for') }));

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map((el) => ({
    tma: T.tag(el), level: Number(el.getAttribute('aria-level') || el.tagName.slice(1)) || null, text: T.text(el, 140), visible: vis(el), hidden: hiddenBy(el), sel: T.cssPath(el),
  }));

  const LM = 'header, nav, main, footer, aside, form[aria-label], form[aria-labelledby], section[aria-label], section[aria-labelledby], [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], [role="complementary"], [role="search"], [role="region"], [role="form"]';
  const landmarks = [...document.querySelectorAll(LM)].map((el) => ({
    tma: T.tag(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label') || T.idText(el.getAttribute('aria-labelledby')) || null,
    nestedIn: el.parentElement?.closest(LM) ? T.cssPath(el.parentElement.closest(LM)) : null, visible: vis(el), sel: T.cssPath(el),
  }));

  const frames = [...document.querySelectorAll('iframe, frame')].map((el) => ({ tma: T.tag(el), title: el.getAttribute('title'), src: (el.getAttribute('src') || '').slice(0, 160), size: T.rect(el), visible: vis(el), hidden: hiddenBy(el) }));

  const media = [...document.querySelectorAll('video, audio, object, embed, iframe')]
    .filter((el) => /^(video|audio)$/i.test(el.tagName) || /youtube|youtu\.be|vimeo|dailymotion|wistia|soundcloud|spotify/i.test(el.getAttribute('src') || el.getAttribute('data') || ''))
    .map((el) => ({
      tag: el.tagName.toLowerCase(), src: (el.currentSrc || el.getAttribute('src') || el.getAttribute('data') || '').slice(0, 160),
      autoplay: el.autoplay ?? /autoplay=1/.test(el.getAttribute('src') || ''), controls: el.controls ?? null, muted: el.muted ?? null, loop: el.loop ?? null,
      tracks: [...el.querySelectorAll?.('track') ?? []].map((t) => `${t.kind}:${t.srclang}`), title: el.getAttribute('title'), visible: vis(el), sel: T.cssPath(el),
    }));

  const tables = [...document.querySelectorAll('table, [role="table"], [role="grid"]')].map((el) => ({
    sel: T.cssPath(el), role: el.getAttribute('role'), caption: el.querySelector('caption') ? T.text(el.querySelector('caption'), 100) : null,
    summary: el.getAttribute('summary'), ariaLabel: el.getAttribute('aria-label') || T.idText(el.getAttribute('aria-labelledby')) || null,
    rows: el.rows?.length ?? null, th: el.querySelectorAll('th').length, scope: el.querySelectorAll('th[scope]').length, headersAttr: el.querySelectorAll('[headers]').length,
    thead: Boolean(el.querySelector('thead')), nested: Boolean(el.querySelector('table')), firstRow: el.rows?.[0] ? T.text(el.rows[0], 140) : null, visible: vis(el),
  }));

  const docs = links.filter((l) => /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|zip)(\?|#|$)/i.test(l.href || '')).map((l) => ({ href: l.href, text: l.text, ariaLabel: l.ariaLabel, title: l.title }));

  const langs = [...document.querySelectorAll('[lang], [xml\\:lang], [dir]')].filter((el) => el !== document.documentElement).slice(0, 80)
    .map((el) => ({ tag: el.tagName.toLowerCase(), lang: el.getAttribute('lang'), dir: el.getAttribute('dir'), text: T.text(el, 80), sel: T.cssPath(el) }));

  // Focalisables dans l'ordre du DOM, avec ce qui peut les rendre invisibles.
  const focus = T.focusables().map((el, i) => ({
    i, tma: T.tag(el), tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), name: T.text(el, 60) || el.getAttribute('aria-label') || el.value || el.getAttribute('title') || '',
    opacity: T.opacity(el), hidden: hiddenBy(el), inMain: Boolean(el.closest('main, [role="main"]')), size: T.rect(el), sel: T.cssPath(el),
  }));

  // Contrastes non textuels : bordure (ou fond) des champs et boutons sur leur arrière-plan.
  const contrast = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, button, [role="button"]')]
    .filter(vis).slice(0, 120).map((el) => {
      const cs = getComputedStyle(el);
      const outside = T.bgOf(el.parentElement || el);
      const own = T.parse(cs.backgroundColor);
      const border = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ? T.parse(cs.borderBottomColor) : null;
      const r = {};
      if (outside.color && border && border.a > 0) r.border = { fg: T.hex(T.blend(border, outside.color)), bg: T.hex(outside.color), ratio: T.ratio(T.blend(border, outside.color), outside.color) };
      if (outside.color && own && own.a > 0) r.fill = { fg: T.hex(T.blend(own, outside.color)), bg: T.hex(outside.color), ratio: T.ratio(T.blend(own, outside.color), outside.color) };
      return { tma: T.tag(el), tag: el.tagName.toLowerCase(), name: T.text(el, 40) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', bgImage: outside.image, ...r, sel: T.cssPath(el) };
    });

  // Cibles d'activation sous 24 × 24 px (WCAG 2.2, hors RGAA 4.1.2), hors liens insérés dans une phrase.
  const targets = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="slider"]')]
    .filter((el) => vis(el) && !hiddenBy(el)).map((el) => {
      const r = el.getBoundingClientRect();
      const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim());
      return { el, w: Math.round(r.width), h: Math.round(r.height), inline };
    }).filter((t) => (t.w < 24 || t.h < 24) && t.w > 0 && t.h > 0 && !t.inline)
    .map((t) => ({ tma: T.tag(t.el), w: t.w, h: t.h, name: T.text(t.el, 40) || t.el.getAttribute('aria-label') || '', sel: T.cssPath(t.el) }));

  // Divers.
  const ids = {};
  for (const el of document.querySelectorAll('[id]')) (ids[el.id] ??= []).push(el);
  const refAttrs = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'for', 'headers', 'list'];
  const referenced = new Set();
  for (const a of refAttrs) for (const el of document.querySelectorAll(`[${a}]`)) for (const id of el.getAttribute(a).split(/\s+/)) referenced.add(id);
  const dupIds = Object.entries(ids).filter(([, els]) => els.length > 1).map(([id, els]) => ({ id, count: els.length, referenced: referenced.has(id) }));
  const ariaRefsMissing = [...referenced].filter((id) => id && !document.getElementById(id)).slice(0, 40);

  const generated = [];
  for (const el of [...document.body.querySelectorAll('*')].slice(0, 6000)) {
    for (const pseudo of ['::before', '::after']) {
      const c = getComputedStyle(el, pseudo).content;
      if (c && c !== 'none' && c !== 'normal' && /[\p{L}\p{N}]{2,}/u.test(c.replace(/^["']|["']$/g, '')) && generated.length < 40) generated.push({ pseudo, content: c.slice(0, 80), sel: T.cssPath(el) });
    }
  }
  const cssImages = [...document.body.querySelectorAll('*')].slice(0, 6000).filter((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    return bg && bg.startsWith('url(') && vis(el) && !T.text(el) && el.getBoundingClientRect().width >= 16;
  }).slice(0, 30).map((el) => ({ sel: T.cssPath(el), bg: getComputedStyle(el).backgroundImage.slice(0, 140), aria: el.getAttribute('aria-label') || el.getAttribute('role') || null }));

  const emoji = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && emoji.length < 20; n = walker.nextNode()) {
    if (/\p{Extended_Pictographic}/u.test(n.textContent) && n.parentElement && vis(n.parentElement)) emoji.push({ text: n.textContent.trim().slice(0, 80), sel: T.cssPath(n.parentElement), hidden: hiddenBy(n.parentElement) });
  }

  const clickable = [...document.querySelectorAll('[onclick], [onmousedown], [ontouchstart]')].filter((el) => !el.matches('a[href], button, input, select, textarea, summary, [role="button"], [role="link"]') && vis(el))
    .slice(0, 30).map((el) => ({ sel: T.cssPath(el), text: T.text(el, 60), tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') }));
  let jqueryClickable = null;
  if (window.jQuery?._data) {
    jqueryClickable = [...document.body.querySelectorAll('div, span, li, p, img, i, td')].slice(0, 5000).filter((el) => {
      const ev = window.jQuery._data(el, 'events');
      return ev && (ev.click || ev.mousedown || ev.touchstart || ev.mouseover || ev.mouseenter) && vis(el);
    }).slice(0, 30).map((el) => ({ sel: T.cssPath(el), text: T.text(el, 60), events: Object.keys(window.jQuery._data(el, 'events')), tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') }));
  }

  let reducedMotion = 0;
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) if (r.conditionText?.includes('prefers-reduced-motion')) reducedMotion++; } catch {}
  }

  const misc = {
    title: document.title, lang: document.documentElement.getAttribute('lang'), xmlLang: document.documentElement.getAttribute('xml:lang'),
    doctype: document.doctype ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}>` : null,
    generator: document.querySelector('meta[name="generator"]')?.content ?? null,
    metaRefresh: document.querySelector('meta[http-equiv="refresh" i]')?.content ?? null,
    viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
    newWindowLinks: links.filter((l) => l.target === '_blank').length,
    newWindowWithoutWarning: links.filter((l) => l.target === '_blank' && !/nouvel|new (tab|window)|externe/i.test(`${l.text} ${l.ariaLabel ?? ''} ${l.title ?? ''}`)).slice(0, 10).map((l) => l.text || l.ariaLabel || l.href),
    skipLinks: focus.slice(0, 6).filter((f) => f.tag === 'a').map((f) => { const el = document.querySelector(`[data-tma="${f.tma}"]`); const h = el.getAttribute('href') || ''; return { text: f.name, href: h, targetExists: h.startsWith('#') ? Boolean(document.getElementById(decodeURIComponent(h.slice(1)))) : null, position: f.i + 1 }; }).filter((s) => s.href.startsWith('#')),
    firstMainFocusable: (() => { const f = focus.find((x) => x.inMain); return f ? { position: f.i + 1, of: focus.length, name: f.name } : null; })(),
    positiveTabindex: [...document.querySelectorAll('[tabindex]')].filter((el) => el.tabIndex > 0).slice(0, 20).map((el) => ({ sel: T.cssPath(el), tabindex: el.tabIndex })),
    accesskeys: [...document.querySelectorAll('[accesskey]')].map((el) => ({ key: el.getAttribute('accesskey'), sel: T.cssPath(el) })),
    duplicateIds: dupIds.slice(0, 60), ariaRefsMissing, orphanLabels, generated, cssImages, emoji,
    clickableNonSemantic: clickable, jqueryClickable, reducedMotionRules: reducedMotion,
    jquery: window.jQuery?.fn?.jquery ?? null, bootstrapJs: Boolean(window.bootstrap || window.jQuery?.fn?.carousel),
    gifs: images.filter((i) => /\.gif(\?|$)/i.test(i.src)).length,
  };

  return { images, links, buttons, fields, forms, headings, landmarks, frames, media, tables, docs, langs, focus, contrast, targets, misc };
}

// État des carrousels et animations, pour comparer à quelques secondes d'intervalle.
function motionState() {
  const sels = '.carousel, .slick-slider, .swiper, .swiper-container, .owl-carousel, [data-ride="carousel"], [data-bs-ride], .splide, .glide, [class*="slider"]';
  const T = window.__tma;
  return {
    carousels: [...document.querySelectorAll(sels)].filter(T.rendered).slice(0, 10).map((el) => {
      const active = el.querySelector('.active, .slick-current, .swiper-slide-active, .is-active, [aria-current="true"]');
      return { sel: T.cssPath(el), active: active ? T.text(active, 60) || active.className.slice(0, 60) : null, pause: Boolean(el.querySelector('button[aria-label*="ause" i], [class*="pause"], [class*="play"]')) };
    }),
    animations: document.getAnimations().filter((a) => a.playState === 'running').slice(0, 20).map((a) => ({
      name: a.animationName || a.constructor.name, infinite: a.effect?.getTiming?.().iterations === Infinity,
      target: a.effect?.target ? T.cssPath(a.effect.target) : null,
    })),
  };
}

// Débordement horizontal à la largeur courante, avec les éléments qui dépassent sans être rognés.
function overflowState() {
  const T = window.__tma;
  const vw = document.documentElement.clientWidth;
  const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o !== 'visible') return true; } return false; };
  const offenders = [...document.body.querySelectorAll('*')].slice(0, 8000).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 1 && !clipped(el) && getComputedStyle(el).position !== 'fixed';
  });
  const top = offenders.filter((el) => !offenders.includes(el.parentElement)).slice(0, 15)
    .map((el) => ({ sel: T.cssPath(el), right: Math.round(el.getBoundingClientRect().right), width: Math.round(el.getBoundingClientRect().width) }));
  return { width: vw, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth - vw, offenders: top };
}

// Espacement du texte (WCAG 1.4.12 / RGAA 10.12) : texte rogné après injection.
// Seuls comptent les textes rognés à cause de l'injection : ceux qui débordaient déjà avant sont écartés.
function spacingCheck() {
  const T = window.__tma;
  const els = [...document.body.querySelectorAll('*')].slice(0, 8000).filter((el) => {
    if (!T.rendered(el) || !T.text(el, 5)) return false;
    const cs = getComputedStyle(el);
    return /hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY) || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
  });
  const overflows = (el) => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
  const before = new Set(els.filter(overflows));
  const st = document.createElement('style');
  st.id = 'tma-spacing';
  st.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
  document.head.appendChild(st);
  const out = [];
  for (const el of els) {
    if (out.length >= 30 || before.has(el) || !overflows(el)) continue;
    if (![...el.children].some((c) => c.scrollHeight > c.clientHeight + 2)) out.push({ sel: T.cssPath(el), text: T.text(el, 80), box: `${el.clientWidth}×${el.clientHeight}`, content: `${el.scrollWidth}×${el.scrollHeight}` });
  }
  return { clipped: out, alreadyClippedBefore: before.size };
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

async function open(browser, url, { width = 1440, height = 900 } = {}) {
  const mobile = width <= 480;
  const origin = new URL(url).origin;
  // Identifiants de recette : envoyés à la recette seulement, jamais à la production.
  const page = await newPage(browser, { auth: origin === RECETTE ? AUTH : null, width, height: mobile ? 812 : height, mobile });
  await guardRequests(page, BLOCKED, { readOnly: origin === PRODUCTION });
  page.__origin = origin;
  const res = await gotoAwake(page, url);
  await page.evaluate(installHelpers);
  return { page, status: res.status() };
}

async function shotTo(page, file, { full = false, maxHeight = 6000 } = {}) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const vp = page.viewport();
  if (full && h > vp.height) {
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, maxHeight) }, captureBeyondViewport: true });
  } else {
    await page.screenshot({ path: file });
  }
}

// Vraie tabulation : à chaque appui, l'élément focalisé, son opacité, sa position et le changement de style.
async function tabSequence(page, { n = 80, shift = false } = {}) {
  await page.evaluate(() => {
    window.__tmaBase = {};
    for (const el of window.__tma.focusables()) window.__tmaBase[window.__tma.tag(el)] = window.__tma.styleSnap(el);
    document.activeElement?.blur?.();
    scrollTo(0, 0);
  });
  const seq = [];
  let still = 0;
  let last = null;
  for (let i = 0; i < n; i++) {
    await pressKeys(page, shift ? 'Shift+Tab' : 'Tab');
    await sleep(60);
    const s = await page.evaluate(() => {
      const T = window.__tma;
      const el = document.activeElement;
      if (!el || el === document.body) return { body: true };
      const id = T.tag(el);
      const base = window.__tmaBase[id];
      const now = T.styleSnap(el);
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      const keys = ['outline-style', 'outline-width', 'outline-color', 'box-shadow', 'background', 'border', 'color', 'text-decoration'];
      const changed = base ? now.split('|').map((v, k) => (v !== base.split('|')[k] ? keys[k] : null)).filter(Boolean) : ['(pas d\'état de référence)'];
      return {
        tma: id, tag: el.tagName.toLowerCase(), name: T.text(el, 60) || el.getAttribute('aria-label') || el.value || el.getAttribute('title') || '',
        opacity: T.opacity(el), inView, inMain: Boolean(el.closest('main, [role="main"]')), hidden: el.closest('[aria-hidden="true"]') ? 'aria-hidden' : null,
        focusStyle: changed.length ? changed : 'aucun changement visible', outline: getComputedStyle(el).outlineStyle !== 'none' ? `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}` : null,
        sel: T.cssPath(el),
      };
    });
    s.step = i + 1;
    if (last && s.tma && s.tma === last) { still++; s.stuck = still; } else still = 0;
    last = s.tma ?? null;
    seq.push(s);
    if (still >= 3) { seq.push({ note: 'focus immobile 4 appuis de suite : piège possible, ou perte de focus du navigateur piloté. Relance avant de conclure.' }); break; }
  }
  return seq;
}

async function cmdScan(browser, target, opt) {
  const url = resolveUrl(target);
  const name = opt.name && opt.name !== true ? String(opt.name) : slug(target);
  const dir = path.join(OUT, 'pages', name);
  const shots = path.join(dir, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const t0 = Date.now();

  // 1. Bureau 1440 : extractions, axe-core, captures d'images, tabulation, mouvement, espacement, CSS désactivées.
  const { page, status } = await open(browser, url, { width: 1440 });
  await autoScroll(page);
  await page.evaluate(installHelpers);
  const data = await page.evaluate(extract);
  const names = await axNames(page);
  const withAx = (arr) => arr.map((x) => (x.tma && names[x.tma] ? { ...x, axRole: names[x.tma].role, axName: names[x.tma].name, axIgnored: names[x.tma].ignored || undefined } : x));
  for (const k of ['images', 'links', 'buttons', 'fields', 'headings', 'landmarks', 'frames', 'focus', 'contrast', 'targets']) data[k] = withAx(data[k]);

  // Ambiguïtés : même nom accessible, destinations différentes.
  const byName = {};
  for (const l of data.links) if (l.visible && l.axName) (byName[l.axName.toLowerCase()] ??= new Set()).add(l.href);
  data.misc.ambiguousLinks = Object.entries(byName).filter(([, s]) => s.size > 1).map(([n, s]) => ({ name: n, destinations: s.size })).slice(0, 30);
  data.misc.longNames = [...data.links, ...data.buttons].filter((x) => x.visible && x.axName && x.axName.split(/\s+/).length > 8).length;
  // Nom accessible qui ne contient pas le libellé visible (WCAG 2.5.3, critères 6.1, 7.1, 11.9).
  const norm = (s) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  data.misc.labelNotInName = [...data.links, ...data.buttons].filter((x) => x.visible && x.text && x.axName && norm(x.text).length > 1 && !norm(x.axName).includes(norm(x.text)))
    .slice(0, 30).map((x) => ({ text: x.text, axName: x.axName, sel: x.sel }));

  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const pick = (r) => r.map((v) => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter((t) => /^wcag|best/.test(t)), count: v.nodes.length,
      nodes: v.nodes.slice(0, 12).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), summary: (n.failureSummary || n.any?.[0]?.message || '').slice(0, 280) })) }));
    // eslint-disable-next-line no-undef
    const main = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations', 'incomplete'] });
    // eslint-disable-next-line no-undef
    const extra = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return { violations: pick(main.violations), incomplete: pick(main.incomplete), horsReferentiel: pick(extra.violations) };
  });
  axe.version = axeVersion;

  // Captures des images visibles (pour juger la pertinence des alternatives).
  let n = 0;
  for (const img of data.images) {
    if (n >= 60 || !img.visible || img.hidden || img.size.w < 16 || img.size.h < 16) continue;
    const el = await page.$(`[data-tma="${img.tma}"]`);
    if (!el) continue;
    const file = `img-${img.tma}.png`;
    const ok = await el.screenshot({ path: path.join(shots, file) }).then(() => true).catch(() => false);
    if (ok) { img.shot = `shots/${file}`; n++; }
  }

  data.focusSequence = await tabSequence(page, { n: Math.min(Math.max(data.focus.length, 10), 120) });
  await page.evaluate(() => scrollTo(0, 0));
  await shotTo(page, path.join(shots, '1440.png'), { full: true });

  // Mouvement : un relevé par seconde pendant 7 s (un carrousel à cycle court peut revenir à sa position de départ).
  const states = [];
  const frames = [];
  for (let s = 0; s <= 7; s++) {
    states.push(await page.evaluate(motionState));
    if (s % 3 === 0) frames.push(await page.screenshot());
    if (s < 7) await sleep(1_000);
  }
  const motion = {
    screenshotsChanged: frames.some((f) => Buffer.compare(f, frames[0]) !== 0),
    carousels: states[0].carousels.map((c, i) => {
      const seen = states.map((st) => st.carousels[i]?.active ?? null);
      const changes = seen.filter((v, k) => k > 0 && v !== seen[k - 1]).length;
      return { ...c, states: [...new Set(seen)].slice(0, 6), changesIn7s: changes, moved: changes > 0 };
    }),
    animations: states.at(-1).animations, gifs: data.misc.gifs, autoplayMedia: data.media.filter((x) => x.autoplay).length,
  };

  const spacing = await page.evaluate(spacingCheck);
  await page.screenshot({ path: path.join(shots, 'spacing.png') });
  await page.evaluate(() => document.getElementById('tma-spacing')?.remove());

  await page.evaluate(() => {
    for (const s of document.styleSheets) { try { s.disabled = true; } catch {} }
    for (const el of document.querySelectorAll('[style]')) el.removeAttribute('style');
  });
  const cssoff = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 40_000));
  await shotTo(page, path.join(shots, 'cssoff.png'), { full: true });
  await page.close();

  // 2. Largeurs 640 (≈ zoom 200 %), 375 (mobile tactile), 320 (≈ zoom 400 %), puis paysage 812 × 375.
  const viewports = [];
  for (const [w, h] of [[640, 900], [375, 812], [320, 812], [812, 375]]) {
    const { page: p } = await open(browser, url, { width: w, height: h });
    const st = await p.evaluate(overflowState);
    const shot = `${w}${h === 375 ? '-paysage' : ''}.png`;
    await shotTo(p, path.join(shots, shot), { full: h !== 375 });
    let targets375 = null;
    if (w === 375) {
      targets375 = await p.evaluate(() => [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, [role="button"]')]
        .filter((el) => window.__tma.rendered(el)).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 24 || r.height < 24)).length);
    }
    viewports.push({ viewport: `${w}×${h}`, ...st, shot: `shots/${shot}`, ...(targets375 !== null ? { targetsUnder24: targets375 } : {}) });
    await p.close();
  }

  // Écriture.
  const files = { images: data.images, links: data.links, forms: { forms: data.forms, fields: data.fields, buttons: data.buttons, orphanLabels: data.misc.orphanLabels },
    headings: data.headings, landmarks: data.landmarks, frames: data.frames, media: data.media, tables: data.tables, docs: data.docs, lang: data.langs,
    focus: { domOrder: data.focus, sequence: data.focusSequence }, contrast: data.contrast, targets: data.targets, viewports, spacing, motion, misc: data.misc, axe };
  for (const [k, v] of Object.entries(files)) {
    if (k === 'forms') { writeJsonl(path.join(dir, 'forms.json'), [...v.forms.map((f) => ({ kind: 'form', ...f })), ...v.fields.map((f) => ({ kind: 'field', ...f })), ...v.buttons.map((b) => ({ kind: 'button', ...b })), ...v.orphanLabels.map((l) => ({ kind: 'orphanLabel', ...l }))]); continue; }
    if (k === 'focus') { writeJsonl(path.join(dir, 'focus.json'), [...v.domOrder.map((f) => ({ kind: 'dom', ...f })), ...v.sequence.map((s) => ({ kind: 'tab', ...s }))]); continue; }
    if (k === 'axe') { writeJsonl(path.join(dir, 'axe.json'), [{ version: v.version }, ...v.violations.map((x) => ({ result: 'violation', ...x })), ...v.incomplete.map((x) => ({ result: 'incomplete', ...x })), ...v.horsReferentiel.map((x) => ({ result: 'hors-referentiel', ...x }))]); continue; }
    writeJsonl(path.join(dir, `${k}.json`), v);
  }
  fs.writeFileSync(path.join(dir, 'cssoff.txt'), cssoff);

  // Résumé : les signaux à creuser, pas des verdicts.
  const vis = (a) => a.filter((x) => x.visible);
  const invisibleFocus = data.focus.filter((f) => f.opacity === 0).length;
  const hiddenFocus = data.focus.filter((f) => f.hidden).length;
  const seqNoStyle = data.focusSequence.filter((s) => s.focusStyle === 'aucun changement visible').length;
  const seqInvisible = data.focusSequence.filter((s) => s.opacity === 0 || s.inView === false).length;
  const fieldsNoName = vis(data.fields).filter((f) => !f.axName).length;
  const fieldsPlaceholderOnly = vis(data.fields).filter((f) => f.axName && f.placeholder && f.axName === f.placeholder && !f.labelFor && !f.wrappingLabel && !f.ariaLabel).length;
  const h1 = data.headings.filter((h) => h.level === 1 && h.visible).length;
  const lines = [
    `# ${name} — ${url}`, '',
    ...(new URL(url).origin === PRODUCTION ? ['- **Production, lecture seule** : mesure d\'audience coupée, envois de formulaires et de données bloqués.'] : []),
    `- HTTP ${status} · titre : « ${data.misc.title} » · lang : ${data.misc.lang ?? 'absente'} · doctype : ${data.misc.doctype ?? 'absent'}${data.misc.generator ? ` · ${data.misc.generator}` : ''}`,
    `- axe-core ${axeVersion} (WCAG 2.0/2.1 A-AA) : ${axe.violations.length} règle(s) en violation, ${axe.incomplete.length} à vérifier, ${axe.horsReferentiel.length} hors référentiel (WCAG 2.2, bonnes pratiques)`,
    ...axe.violations.map((v) => `  - ${v.impact} · ${v.id} (${v.count}) — ${v.help}`),
    `- Images : ${data.images.length} (${vis(data.images).length} visibles) · sans attribut alt : ${data.images.filter((i) => i.tag === 'img' && i.alt === null && !i.hidden).length} · alt vide : ${data.images.filter((i) => i.alt === '').length} · captures : ${n}`,
    `- Liens : ${data.links.length} · sans nom accessible : ${vis(data.links).filter((l) => !l.axName && !l.hidden).length} · intitulés ambigus (même nom, destinations différentes) : ${data.misc.ambiguousLinks.length} · nom sans le libellé visible : ${data.misc.labelNotInName.length} · nouvelle fenêtre : ${data.misc.newWindowLinks}`,
    `- Formulaires : ${data.forms.length} · champs visibles : ${vis(data.fields).length} · sans nom accessible : ${fieldsNoName} · nommés par le seul placeholder : ${fieldsPlaceholderOnly} · étiquettes orphelines : ${data.misc.orphanLabels.length}`,
    `- Titres : ${data.headings.length} · h1 visibles : ${h1} · repères : ${data.landmarks.map((l) => l.role || l.tag).join(', ') || 'aucun'}`,
    `- Focalisables : ${data.focus.length} · opacité effective 0 : ${invisibleFocus} · sous aria-hidden : ${hiddenFocus} · tabindex positif : ${data.misc.positiveTabindex.length}`,
    `- Tabulation (${data.focusSequence.filter((s) => s.step).length} appuis) : sans changement de style au focus : ${seqNoStyle} · hors écran ou invisibles : ${seqInvisible}${data.focusSequence.some((s) => s.note) ? ' · ⚠ focus immobile' : ''}`,
    `- Lien d'évitement : ${data.misc.skipLinks.length ? data.misc.skipLinks.map((s) => `« ${s.text} » (arrêt ${s.position}, cible ${s.targetExists ? 'présente' : 'absente'})`).join(', ') : 'aucun parmi les 6 premiers arrêts'} · premier arrêt dans main : ${data.misc.firstMainFocusable ? `${data.misc.firstMainFocusable.position}/${data.misc.firstMainFocusable.of}` : 'aucun'}`,
    `- Cadres : ${data.frames.length} (sans title : ${data.frames.filter((f) => !f.title && !f.hidden).length}) · médias : ${data.media.length} · tableaux : ${data.tables.length} · documents : ${data.docs.length}`,
    `- Identifiants dupliqués : ${data.misc.duplicateIds.length} (dont référencés : ${data.misc.duplicateIds.filter((d) => d.referenced).length}) · références ARIA vers un id absent : ${data.misc.ariaRefsMissing.length}`,
    `- Contrastes non textuels sous 3:1 : ${data.contrast.filter((c) => (c.border && c.border.ratio < 3) || (!c.border && c.fill && c.fill.ratio < 3)).length} (à juger : la bordure n'est requise que si elle seule délimite le composant)`,
    `- Cibles sous 24 px (hors RGAA) : ${data.targets.length} à 1440 · ${viewports.find((v) => v.targetsUnder24 !== undefined)?.targetsUnder24 ?? '?'} à 375`,
    `- Débordement horizontal : ${viewports.map((v) => `${v.viewport} ${v.overflow > 0 ? `+${v.overflow} px` : 'non'}`).join(' · ')}`,
    `- Espacement du texte : ${spacing.clipped.length} élément(s) rogné(s) par l'augmentation (${spacing.alreadyClippedBefore} déjà rognés avant, écartés) · mouvement sur 7 s : captures ${motion.screenshotsChanged ? 'qui changent' : 'identiques'}, carrousels ${motion.carousels.length} (dont défilant seuls : ${motion.carousels.filter((c) => c.moved).length}), animations en cours : ${motion.animations.length}`,
    `- CSS désactivées : ${cssoff.length} caractères dans cssoff.txt · contenus générés en CSS : ${data.misc.generated.length} · images CSS sans texte : ${data.misc.cssImages.length}`,
    `- Éléments cliquables non sémantiques : ${data.misc.clickableNonSemantic.length}${data.misc.jqueryClickable ? ` (+ ${data.misc.jqueryClickable.length} via jQuery ${data.misc.jquery})` : ''} · règles prefers-reduced-motion : ${data.misc.reducedMotionRules}`,
    '', `Fichiers : ${fs.readdirSync(dir).filter((f) => f !== 'shots').join(', ')} · captures : shots/ (1440, 640, 375, 320, 812-paysage, spacing, cssoff, img-*)`,
    `Durée : ${Math.round((Date.now() - t0) / 1000)} s`,
  ];
  fs.writeFileSync(path.join(dir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log(`\n→ ${path.relative(OUT, dir)} (dans ${OUT})`);
}

async function cmdShot(browser, target, opt) {
  const url = resolveUrl(target);
  const width = Number(opt.width) || 1440;
  const { page } = await open(browser, url, { width, height: Number(opt.height) || 900 });
  const dir = path.join(OUT, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opt.name && opt.name !== true ? opt.name : `${slug(target)}-${width}`}.png`);
  if (opt.selector) {
    const el = await page.$(opt.selector);
    if (!el) fail(`sélecteur introuvable : ${opt.selector}`);
    await el.scrollIntoView().catch(() => {});
    await el.screenshot({ path: file });
  } else {
    await shotTo(page, file, { full: Boolean(opt.full) });
  }
  console.log(file);
}

async function cmdTab(browser, target, opt) {
  const url = resolveUrl(target);
  const { page } = await open(browser, url, { width: Number(opt.width) || 1440 });
  const seq = await tabSequence(page, { n: Number(opt.n) || 80, shift: Boolean(opt.shift) });
  for (const s of seq) console.log(JSON.stringify(s));
}

// Étapes : voir USAGE. Saisie et sélection acceptent [sélecteur, valeur] ou sélecteur + "text"/"value".
function pair(s, key) {
  const v = s[key];
  const [sel, val] = Array.isArray(v) ? v : [v, s.text ?? s.value];
  if (typeof sel !== 'string' || val === undefined) throw new Error(`étape « ${key} » : attendu ["css", "valeur"] ou "${key}": "css" avec "value"`);
  return [sel, String(val)];
}

// Évalue du JS dans la page : une expression, ou un bloc d'instructions (avec ou sans return final).
// Sans return, la dernière instruction sert de valeur. Une exception remonte avec son message.
async function evalIn(page, code) {
  if (/\breturn\b/.test(code)) return page.evaluate(`(async () => { ${code} })()`);
  try {
    return await page.evaluate(`(async () => { return (${code}); })()`);
  } catch (err) {
    if (!/SyntaxError|Unexpected token|missing \)/.test(err.message)) throw err;
    const body = code.trim().replace(/;\s*$/, '');
    const cut = body.lastIndexOf(';');
    if (cut === -1) throw err;
    return page.evaluate(`(async () => { ${body.slice(0, cut + 1)} return (${body.slice(cut + 1)}); })()`);
  }
}

async function cmdRun(browser, target, stepsFile, opt) {
  if (!stepsFile) fail(`fichier d'étapes manquant.\n${USAGE}`);
  const steps = JSON.parse(fs.readFileSync(path.resolve(stepsFile), 'utf8'));
  if (!Array.isArray(steps)) fail('le fichier d\'étapes doit contenir un tableau JSON');
  const url = resolveUrl(target);
  const { page } = await open(browser, url, { width: Number(opt.width) || 1440 });
  const name = opt.name && opt.name !== true ? String(opt.name) : path.basename(stepsFile, '.json');
  const dir = path.join(OUT, 'runs', name);
  fs.mkdirSync(dir, { recursive: true });
  const log = [];
  let seen = 0;
  const active = () => page.evaluate(() => {
    const T = window.__tma;
    const el = document.activeElement;
    if (!el || el === document.body) return { body: true };
    return { tag: el.tagName.toLowerCase(), name: T.text(el, 60) || el.getAttribute('aria-label') || el.value || '', opacity: T.opacity(el), sel: T.cssPath(el) };
  });
  for (const [i, s] of steps.entries()) {
    const entry = { step: i + 1, ...s };
    try {
      if (s.goto) {
        const to = resolveUrl(s.goto);
        if (new URL(to).origin !== page.__origin) throw new Error('goto change de site : lance un autre scénario sur cette origine');
        await gotoAwake(page, to); await page.evaluate(installHelpers); entry.url = page.url();
      }
      else if (s.width) { await page.setViewport({ width: Number(s.width), height: s.height ?? 900, isMobile: s.width <= 480, hasTouch: s.width <= 480 }); }
      else if (s.click) { await page.click(s.click); await sleep(400); }
      else if (s.hover) { await page.hover(s.hover); await sleep(400); }
      else if (s.focus) { await page.focus(s.focus); }
      else if (s.type || s.fill) {
        const [sel, txt] = pair(s, s.type ? 'type' : 'fill');
        if (s.fill) await page.$eval(sel, (el) => { el.value = ''; });
        await page.type(sel, txt, { delay: 10 });
      }
      else if (s.select) { const [sel, val] = pair(s, 'select'); await page.select(sel, val); }
      else if (s.check) { await page.click(s.check); }
      else if (s.press) { for (let k = 0; k < (s.times ?? 1); k++) { await pressKeys(page, s.press); await sleep(80); } }
      else if (s.wait) { await sleep(Math.min(Number(s.wait), 30_000)); }
      else if (s.waitFor) { await page.waitForSelector(s.waitFor, { timeout: 15_000 }); }
      else if (s.observe) {
        await page.evaluate((sel) => {
          window.__tmaMut = [];
          const root = sel === 'body' ? document.body : document.querySelector(sel);
          if (!root) throw new Error(`sélecteur introuvable : ${sel}`);
          const T = window.__tma;
          const live = (n) => n?.closest?.('[role="status"], [role="alert"], [aria-live], [role="log"]');
          new MutationObserver((ms) => { for (const m of ms) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
            if (window.__tmaMut.length < 80) window.__tmaMut.push({ type: m.type, sel: T.cssPath(el), text: T.text(el, 100), live: live(el) ? `${live(el).getAttribute('role') ?? ''} ${live(el).getAttribute('aria-live') ?? ''}`.trim() : null });
          } }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-invalid', 'aria-expanded', 'aria-hidden', 'class', 'hidden'] });
        }, s.observe);
      }
      else if (s.mutations) { entry.result = await page.evaluate(() => window.__tmaMut ?? []); }
      else if (s.active) { entry.result = await active(); }
      else if (s.eval) { entry.result = (await evalIn(page, s.eval)) ?? '(aucune valeur renvoyée)'; }
      else if (s.shot) {
        const file = path.join(dir, `${s.shot}.png`);
        if (s.selector) await (await page.$(s.selector))?.screenshot({ path: file });
        else await shotTo(page, file, { full: Boolean(s.full) });
        entry.result = path.relative(OUT, file);
      } else entry.error = 'étape inconnue';
      if (s.goto || s.click || s.press) page.evaluate(installHelpers).catch(() => {});
    } catch (err) {
      entry.error = err.message.split('\n')[0];
    }
    const fresh = BLOCKED.slice(seen);
    seen = BLOCKED.length;
    if (fresh.length) entry.blocked = fresh.map((b) => `${b.why} : ${b.method} ${b.url}`);
    if ('result' in entry && JSON.stringify(entry.result)?.length > 4000) entry.result = `${JSON.stringify(entry.result).slice(0, 4000)}… (tronqué)`;
    log.push(entry);
    console.log(JSON.stringify(entry));
    // Une étape ratée arrête le scénario : cliquer « Envoyer » après une saisie ratée enverrait un formulaire à vide.
    if (entry.error) {
      const stop = { stopped: `scénario arrêté à l'étape ${i + 1} (${entry.error}) ; ${steps.length - i - 1} étape(s) non jouée(s). Syntaxe des étapes : tma-browse --help` };
      log.push(stop);
      console.log(JSON.stringify(stop));
      break;
    }
  }
  writeJsonl(path.join(dir, 'log.json'), log);
  await page.close();
}

async function cmdEval(browser, target, code, opt) {
  if (!code) fail(`expression manquante.\n${USAGE}`);
  const url = resolveUrl(target);
  const { page } = await open(browser, url, { width: Number(opt.width) || 1440 });
  const result = await evalIn(page, code);
  const out = JSON.stringify(result, null, 1) ?? 'undefined (aucune valeur renvoyée : termine par une expression, ou par return)';
  console.log(out.length > 20_000 ? `${out.slice(0, 20_000)}\n… (tronqué à 20 000 caractères)` : out);
}

// ---------------------------------------------------------------------------

const { pos, opt } = parseArgs(process.argv.slice(2));
const [cmd, target, extra] = pos;
if (!cmd || cmd === 'help' || opt.help) { console.log(USAGE); process.exit(cmd || opt.help ? 0 : 1); }
const commands = { scan: () => cmdScan(browser, target, opt), shot: () => cmdShot(browser, target, opt), tab: () => cmdTab(browser, target, opt),
  run: () => cmdRun(browser, target, extra, opt), eval: () => cmdEval(browser, target, extra, opt) };
if (!commands[cmd]) fail(`commande inconnue : ${cmd}\n${USAGE}`);
try { resolveUrl(target); } catch (err) { fail(err.message); }
const browser = await launch();
try {
  await commands[cmd]();
} catch (err) {
  console.error(`tma-browse : ${err.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  // Production en lecture seule : ce qui a été bloqué est consigné et résumé.
  if (BLOCKED.length) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(path.join(OUT, 'blocked.json'), BLOCKED.map((b) => JSON.stringify({ date: new Date().toISOString(), cmd, ...b })).join('\n') + '\n');
    const by = (w) => BLOCKED.filter((b) => b.why === w).length;
    console.log(`\n[garde-fous] requêtes bloquées : ${by('mesure d\'audience')} de mesure d'audience, ${by('envoi de formulaire') + by('envoi de données')} envoi(s) de formulaire ou de données (détail : blocked.json)`);
  }
}

#!/usr/bin/env node
/* ============================================================
   WireHawk Security — site rule checks
   Mechanical checks for the hard rules in the project instructions
   (Do-Not list, interaction states, contrast floors, single-source values).
   Zero dependencies. Runs in CI before every build; a failed check fails the
   build, so nothing deploys. Run locally (needs Node): node tools/check-site.mjs

   If a check blocks a legitimate change, update the check and the project
   instructions together. For a one-off false alarm, use the manual workflow run
   with "Skip rule checks" ticked, then fix the check.
   ============================================================ */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rel = p => relative(ROOT, p).split('\\').join('/');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const results = [];
const check = (id, ok, detail = '') => results.push({ level: ok ? 'PASS' : 'FAIL', id, detail });
const warn = (id, detail) => results.push({ level: 'WARN', id, detail });

/* ---------- file helpers ---------- */
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.toml', '.md', '.txt', '.xml', '.json', '.yml', '.yaml', '']);
function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap(name => {
    const p = join(abs, name);
    return statSync(p).isDirectory() ? walk(rel(p)) : [rel(p)];
  });
}
const textFiles = dirs => dirs.flatMap(walk).filter(f => TEXT_EXT.has(extname(f)));

/* ---------- minimal CSS parser (comments stripped, nested @media tracked) ---------- */
function parseCSS(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [], stack = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {                       // copy strings verbatim
      const end = src.indexOf(ch, i + 1);
      buf += src.slice(i, end + 1); i = end; continue;
    }
    // prelude = text after the last ';' (drops statement at-rules such as @import / @charset)
    if (ch === '{') { stack.push(buf.split(';').pop().trim().replace(/\s+/g, ' ')); buf = ''; }
    else if (ch === '}') {
      const prelude = stack.pop();
      if (!prelude.startsWith('@')) {
        rules.push({ prelude, selectors: prelude.split(',').map(s => s.trim()),
                     decls: parseDecls(buf), context: stack.filter(s => s.startsWith('@')) });
      }
      buf = '';
    } else buf += ch;
  }
  return rules;
}
function parseDecls(body) {
  return body.split(';').map(d => d.trim()).filter(Boolean).map(d => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
  });
}
const has = (rule, prop) => rule.decls.some(([p]) => p === prop);
const val = (rule, prop) => { const d = rule.decls.filter(([p]) => p === prop).pop(); return d && d[1]; };
const ctxKey = rule => rule.context.join(' | ') || '(base)';
const HOVER_GATE = /@media\s*\(\s*hover\s*:\s*hover\s*\)/;

/* ---------- contrast ---------- */
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  const ch = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/* ============================================================ */

const css = parseCSS(read('assets/css/main.css'));
const indexHTML = read('layouts/index.html');
const baseof = read('layouts/_default/baseof.html');
const toml = read('hugo.toml');
const workflows = walk('.github/workflows');

/* --- CI / deployment --- */
const wfText = workflows.map(read).join('\n');
check('ci-no-baseurl-override', !/--baseURL|HUGO_BASEURL/i.test(wfText),
  'workflow must not override baseURL (hugo.toml owns it)');
check('ci-build-command', /run:\s*hugo --gc --minify\s*$/m.test(wfText), 'build step must be: hugo --gc --minify');
check('single-workflow-file',
  !existsSync(join(ROOT, '.github/.github')) && workflows.length === 1 && workflows[0] === '.github/workflows/hugo.yml',
  `found: ${workflows.join(', ') || 'none'}${existsSync(join(ROOT, '.github/.github')) ? ' + nested .github/.github' : ''}`);
check('toml-baseurl', /^baseURL\s*=\s*"https:\/\/wirehawksecurity\.com\/"\s*$/m.test(toml), 'baseURL must be https://wirehawksecurity.com/');

/* --- Layout / CSS rules --- */
const displayContents = css.filter(r => /^contents$/i.test(val(r, 'display') || ''));
check('no-display-contents', !displayContents.length, displayContents.map(r => r.prelude).join('; '));

// Properties that make .mobile-nav the containing block for its fixed ::before scrim (or re-add the full-height overlay)
const NAV_BANNED = ['transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter', 'perspective',
  'will-change', 'contain', 'container-type', 'content-visibility', 'bottom'];
const navRules = css.filter(r => r.selectors.some(s => /\.mobile-nav$/.test(s)));
const navHits = navRules.flatMap(r => r.decls.filter(([p]) => NAV_BANNED.includes(p)).map(([p]) => `${r.prelude} { ${p} }`));
check('mobile-nav-no-containing-block', !navHits.length, navHits.join('; '));

const navBase = navRules.find(r => r.prelude === '.mobile-nav' && !r.context.length);
const navOpen = navRules.find(r => /mobile-nav-open/.test(r.prelude));
check('mobile-nav-hidden-when-closed',
  !!navBase && val(navBase, 'visibility') === 'hidden' && !!navOpen && val(navOpen, 'visibility') === 'visible',
  'closed .mobile-nav needs visibility: hidden; open state needs visibility: visible');

const ungated = css.filter(r => r.prelude.includes(':hover') && !r.context.some(c => HOVER_GATE.test(c)));
check('hover-gated', !ungated.length, ungated.map(r => r.prelude).join('; '));

const combined = css.filter(r => r.prelude.includes(':hover') && r.prelude.includes(':focus-visible'));
check('hover-focus-split', !combined.length, combined.map(r => r.prelude).join('; '));

const ACTIVE_NEEDED = ['.header-nav .nav-cta', '.mobile-nav a[href="#contact"]', '.btn-ghost', '.btn-submit', '.blog-arrow'];
const missingActive = ACTIVE_NEEDED.filter(sel => !css.some(r =>
  r.selectors.some(s => s.startsWith(sel + ':active')) && !r.context.some(c => HOVER_GATE.test(c))));
check('active-tap-states', !missingActive.length, missingActive.length ? `missing ungated :active for ${missingActive.join(', ')}` : '');

// View Our Blog / Submit vertical rhythm
const mb = sel => Object.fromEntries(css.filter(r => r.prelude === sel && has(r, 'margin-bottom')).map(r => [ctxKey(r), val(r, 'margin-bottom')]));
const carMB = mb('.blog-carousel'), conMB = mb('.form-consent');
const mbKeys = [...new Set([...Object.keys(carMB), ...Object.keys(conMB)])];
const mbBad = mbKeys.filter(k => carMB[k] !== conMB[k]).map(k => `${k}: .blog-carousel ${carMB[k] ?? '(unset)'} vs .form-consent ${conMB[k] ?? '(unset)'}`);
check('cta-rhythm-synced', !mbBad.length, mbBad.join('; '));

// Contrast floors (WCAG AA 4.5:1) for --dim / --muted on --card and --bg, at every :root
const rootRules = css.filter(r => r.prelude === ':root');
const baseTokens = Object.fromEntries((rootRules.find(r => !r.context.length) || { decls: [] }).decls);
const contrastBad = [];
for (const r of rootRules) {
  const t = { ...baseTokens, ...Object.fromEntries(r.decls) };
  for (const fg of ['--dim', '--muted']) for (const bg of ['--card', '--bg']) {
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t[fg] || '') || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t[bg] || '')) {
      contrastBad.push(`${fg}/${bg} missing or not a hex color (${ctxKey(r)})`); continue;
    }
    const cr = ratio(t[fg], t[bg]);
    if (cr < 4.5) contrastBad.push(`${fg} ${t[fg]} on ${bg} ${t[bg]} = ${cr.toFixed(2)}:1 (${ctxKey(r)})`);
  }
}
// Interaction red must clear 4.5:1 on every surface it appears on (header fill #101010 is a fixed value)
for (const surface of [['--card', baseTokens['--card']], ['--bg', baseTokens['--bg']], ['header', '#101010']]) {
  const rb = baseTokens['--red-bright'];
  if (!/^#[0-9a-f]{6}$/i.test(rb || '')) { contrastBad.push('--red-bright missing or not a 6-digit hex'); break; }
  const cr = ratio(rb, surface[1]);
  if (cr < 4.5) contrastBad.push(`--red-bright ${rb} on ${surface[0]} = ${cr.toFixed(2)}:1`);
}
check('contrast-floors', !contrastBad.length, contrastBad.join('; '));

// Exactly two red tones, each with an RGB-channel twin for tints: --red (rest) and --red-bright (interaction)
const RED_TOKENS = ['--red', '--red-rgb', '--red-bright', '--red-bright-rgb'];
const extraRed = css.filter(r => r.prelude === ':root').flatMap(r => r.decls)
  .filter(([p]) => /^--red/.test(p) && !RED_TOKENS.includes(p)).map(([p, v]) => `${p}: ${v}`);
check('red-tokens', !extraRed.length && RED_TOKENS.every(t => baseTokens[t]),
  `allowed: ${RED_TOKENS.join(', ')}; unexpected: ${extraRed.join(', ') || 'none'}; missing: ${RED_TOKENS.filter(t => !baseTokens[t]).join(', ') || 'none'}`);

// Every red tint derives from its -rgb token, each -rgb equals its hex, and neither red is hand-typed elsewhere
const cssNoComments = read('assets/css/main.css').replace(/\/\*[\s\S]*?\*\//g, '');
const channels = hex => { const h = (hex || '').replace('#', ''); return h.length === 6 ? [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') : ''; };
const srcBad = [];
for (const [hexTok, rgbTok] of [['--red', '--red-rgb'], ['--red-bright', '--red-bright-rgb']]) {
  const ch = channels(baseTokens[hexTok]);
  const tok = (baseTokens[rgbTok] || '').split(',').map(v => v.trim()).join(', ');
  if (!ch || tok !== ch) { srcBad.push(`${rgbTok} (${tok || 'missing'}) must equal ${hexTok} (${ch})`); continue; }
  const triplets = (cssNoComments.match(new RegExp(ch.replace(/, /g, ',\\s*'), 'g')) || []).length - 1;   // minus the -rgb definition
  const hexes = (cssNoComments.match(new RegExp(baseTokens[hexTok], 'gi')) || []).length - 1;            // minus the hex definition
  if (triplets > 0 || hexes > 0) srcBad.push(`${triplets + hexes} hand-typed cop${triplets + hexes > 1 ? 'ies' : 'y'} of ${hexTok}`);
}
check('red-single-source', !srcBad.length, srcBad.join('; '));

// Hover / focus / press foregrounds use --red-bright, never brand --red (3.45-3.86:1 fails as small text)
const STATE = /:(hover|focus|focus-visible|active)\b/;
const stateBrand = css.filter(r => r.selectors.some(s => STATE.test(s)) &&
  r.decls.some(([p, v]) => ['color', 'border-color', 'outline', 'outline-color', 'border'].includes(p) && /var\(--red\)/.test(v)));
check('state-colors-bright', !stateBrand.length, stateBrand.map(r => r.prelude).join('; '));
// ...and --red-bright is foreground only: white text on it is 3.82:1
const brightBg = css.filter(r => r.decls.some(([p, v]) => ['background', 'background-color'].includes(p) && /var\(--red-bright/.test(v)));
check('bright-red-foreground-only', !brightBg.length, brightBg.map(r => r.prelude).join('; '));

// Form success state: no min-height; base padding token-derived; breakpoint overrides are font-size only
const fs = css.filter(r => r.selectors.includes('.form-success'));
const fsBase = fs.find(r => !r.context.length);
const fsBad = [
  ...fs.filter(r => has(r, 'min-height')).map(r => `min-height in ${ctxKey(r)}`),
  ...(!fsBase || val(fsBase, 'padding') !== 'var(--gap) 0' ? ['base padding must be var(--gap) 0'] : []),
  ...fs.filter(r => r.context.length && r.decls.some(([p]) => p !== 'font-size')).map(r => `non-font-size override in ${ctxKey(r)}`),
];
check('form-success-spacing', !fsBad.length, fsBad.join('; '));

// Outline suppression / field ring must target text fields only (checkbox keeps the global outline)
const bareInput = css.filter(r => r.selectors.some(s => /\.contact-form input:(?!:)/.test(s)));
check('field-focus-scoped', !bareInput.length, bareInput.map(r => r.prelude).join('; '));

const headerScrolled = css.filter(r => r.prelude === '.site-header.scrolled');
const headerBase = css.find(r => r.prelude === '.site-header' && !r.context.length);
check('header-solid-on-scroll',
  !!headerBase && /^#101010$/i.test(val(headerBase, 'background') || '') &&
  headerScrolled.every(r => r.decls.every(([p]) => p === 'box-shadow')),
  'header background stays #101010; .scrolled may only add box-shadow');

const h2Sizes = css.filter(r => r.selectors.some(s => /\bh2\b/.test(s)) && has(r, 'font-size') && r.prelude !== 'section h2');
check('unified-h2-size', !h2Sizes.length, h2Sizes.map(r => r.prelude).join('; '));

/* --- Single sources of truth --- */
const scanned = [...textFiles(['layouts', 'assets', 'static', 'content']), 'hugo.toml'];
const formspreeHits = scanned.filter(f => f !== 'hugo.toml' && read(f).includes('formspree.io'));
check('formspree-single-source', !formspreeHits.length, formspreeHits.join(', '));

const token = (toml.match(/cloudflareAnalytics\s*=\s*"([^"]+)"/) || [])[1];
const tokenHits = token ? scanned.filter(f => f !== 'hugo.toml' && read(f).includes(token)) : [];
check('analytics-token-single-source', !!token && !tokenHits.length, token ? tokenHits.join(', ') : 'cloudflareAnalytics missing from hugo.toml');

/* --- Authored copy --- */
const authored = [...textFiles(['layouts', 'content']), 'hugo.toml'];
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const emojiHits = authored.filter(f => EMOJI.test(read(f)));
check('no-emoji-in-authored-copy', !emojiHits.length, emojiHits.join(', '));

const BRAND = /\bWirehawk\b|\bWire [Hh]awk\b|\bWIRE HAWK\b|\bWireHawk Sec(?!urity)/;
const brandHits = authored.flatMap(f => read(f).split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => BRAND.test(l)))
  .map(([f, n]) => `${f}:${n}`);
check('brand-spelling', !brandHits.length, brandHits.join(', '));

const hero = (indexHTML.match(/<section class="hero"[\s\S]*?<\/section>/) || [''])[0];
check('no-hero-cta', !!hero && !/<a\s|<button/i.test(hero), 'hero section must not contain a link or button');

check('feed-emoji-preserved', !/stripEmoji|Extended_Pictographic|\\u\{1F|\\uD83/i.test(indexHTML), 'feed-level emoji stripping must not return');
check('top-link-special-case', indexHTML.includes("href === '#top'"), '#top must scroll to 0');
check('copyright-line', indexHTML.includes('{{ now.Year }} WireHawk Security, LLC.'), 'footer copyright must use now.Year and keep LLC');
check('authorization-disclaimer',
  indexHTML.includes('All testing is performed under written authorization with a defined scope of engagement.'),
  'deliverables disclaimer text changed or missing');

// In-page links hand keyboard focus to their target (sections get tabindex="-1" on demand, no outline)
const sectionFocus = css.find(r => r.selectors.includes('section[tabindex="-1"]:focus'));
check('link-focus-handoff',
  indexHTML.includes("setAttribute('tabindex', '-1')") && /target\.focus\(/.test(indexHTML) &&
  !!sectionFocus && /^(none|0)$/.test(val(sectionFocus, 'outline') || ''),
  'anchor handler must focus the target section; section[tabindex="-1"]:focus needs outline: none');

// Carousel never auto-rotates without a pause control (WCAG 2.2.2) — no timers in the page script
check('no-carousel-autorotate', !/setInterval\s*\(/.test(indexHTML), 'auto-rotate (setInterval) must not return without a pause control');

// Carousel dots: 24x24 tap area (::after) and >= 24px centre-to-centre so tap areas never overlap (WCAG 2.5.8)
const px = v => parseFloat(v || '0');
const dotRule = css.find(r => r.prelude === '.blog-dot' && !r.context.length);
const dotsRule = css.find(r => r.prelude === '.blog-dots' && !r.context.length);
const dotAfter = css.find(r => r.prelude === '.blog-dot::after');
const centre = dotRule && dotsRule ? px(val(dotRule, 'width')) + px(val(dotsRule, 'gap')) : 0;
check('dot-tap-area', !!dotAfter && val(dotAfter, 'position') === 'absolute' && centre >= 24,
  `need .blog-dot::after tap area and dot width + gap >= 24px (now ${centre}px)`);

const cloudCol = indexHTML.split('<div class="service-column">').find(c => c.includes('<h3>Cloud Environments</h3>')) || '';
check('cloud-icon-scaled', /<svg[^>]*overflow="visible"[\s\S]*?scale\(/.test(cloudCol), 'Cloud icon must stay the scaled Tabler path with overflow="visible"');

/* --- Meta --- */
const png = readFileSync(join(ROOT, 'static/images/wirehawk-og.png'));
const [ogW, ogH] = [png.readUInt32BE(16), png.readUInt32BE(20)];
const metaW = (baseof.match(/og:image:width" content="(\d+)"/) || [])[1];
const metaH = (baseof.match(/og:image:height" content="(\d+)"/) || [])[1];
check('og-image-dimensions', String(ogW) === metaW && String(ogH) === metaH, `PNG ${ogW}x${ogH}, meta ${metaW}x${metaH}`);

/* --- Accessibility decisions --- */
// Red deliverable labels must stay WCAG "large text" while --red is under 4.5:1 on black
const red = baseTokens['--red'], bg = baseTokens['--bg'];
const labelRules = css.filter(r => r.selectors.includes('.deliverable-label'));
const labelBase = labelRules.find(r => !r.context.length) || { decls: [] };
const labelBad = [];
if (red && bg && ratio(red, bg) < 4.5) {
  for (const r of labelRules) {
    const color = val(r, 'color') ?? val(labelBase, 'color');
    const size = px(val(r, 'font-size') ?? val(labelBase, 'font-size'));
    const weight = Number(val(r, 'font-weight') ?? val(labelBase, 'font-weight') ?? 400);
    if (color === 'var(--red)' && !(size >= 24 || (size >= 18.66 && weight >= 700))) labelBad.push(`${ctxKey(r)}: ${size}px/${weight}`);
  }
}
check('red-label-large-text', !labelBad.length,
  `red labels must be >=24px, or >=18.66px at weight 700 (--red is ${red && bg ? ratio(red, bg).toFixed(2) : '?'}:1): ${labelBad.join('; ')}`);

// Every Sora weight used in main.css must be in the Google Fonts request (otherwise the browser fakes it)
const fontQuery = (baseof.match(/family=Sora:wght@([\d;]+)/) || [])[1] || '';
const loaded = new Set(fontQuery.split(';').filter(Boolean).map(Number));
const used = new Set([400, ...css.flatMap(r => r.decls.filter(([p]) => p === 'font-weight')
  .map(([, v]) => (v === 'bold' ? 700 : v === 'normal' ? 400 : Number(v))))]);
const missingW = [...used].filter(w => !loaded.has(w)).sort();
check('font-weights-loaded', loaded.size > 0 && !missingW.length,
  `CSS uses Sora ${missingW.join(', ')} but the font request loads ${[...loaded].join(', ') || 'nothing'}`);

// Carousel dots: inactive ring >= 3:1 on --card (WCAG 1.4.11); active differs by fill, not colour alone (1.4.1)
const dotActive = css.find(r => r.prelude === '.blog-dot.active');
const ringRGBA = ((dotRule && val(dotRule, 'box-shadow')) || '').match(/rgba?\(([^)]+)\)/);
let ringRatio = 0;
if (ringRGBA && baseTokens['--card']) {
  const [r, g, b, a = 1] = ringRGBA[1].split(',').map(Number);
  const card = baseTokens['--card'].replace('#', '').match(/../g).map(h => parseInt(h, 16));
  const mix = [r, g, b].map((c, i) => Math.round(c * a + card[i] * (1 - a)));
  ringRatio = ratio('#' + mix.map(c => c.toString(16).padStart(2, '0')).join(''), baseTokens['--card']);
}
const fillCue = !!dotRule && val(dotRule, 'background') === 'transparent' &&
  !!dotActive && !!val(dotActive, 'background') && val(dotActive, 'background') !== 'transparent';
check('dot-contrast-and-cue', ringRatio >= 3 && fillCue,
  `inactive dot ring ${ringRatio.toFixed(2)}:1 (needs 3:1); inactive must be hollow and active filled`);

// Carousel arrows: labelled, aria-disabled at the ends (never `disabled`, which would drop keyboard focus),
// and the dimmed end-state rule comes after the hover/active rules so it wins
const carouselJS = (indexHTML.match(/function buildCarousel[\s\S]*?\n {2}\}\n/) || [''])[0];   // the carousel's own code only
const arrowJS = carouselJS.includes("'Previous posts'") && carouselJS.includes("'Next posts'") &&
  /setAttribute\('aria-disabled'/.test(carouselJS) && !/\.disabled\s*=|setAttribute\('disabled'/.test(carouselJS);
const ruleIdx = pred => css.findIndex(pred);
const iDisabled = ruleIdx(r => r.prelude === '.blog-arrow[aria-disabled="true"]');
const iHover = ruleIdx(r => r.prelude === '.blog-arrow:hover'), iActive = ruleIdx(r => r.prelude === '.blog-arrow:active');
const hiddenRule = css.find(r => r.prelude === '.blog-controls[hidden]');
check('carousel-arrows', arrowJS && iDisabled > iHover && iDisabled > iActive && iHover >= 0 && iActive >= 0 &&
  !!hiddenRule && val(hiddenRule, 'display') === 'none',
  'arrows need aria-labels + aria-disabled ends (no `disabled`), the end-state rule after :hover/:active, and .blog-controls[hidden] { display: none }');

// Carousel controls spacing: the dots sit centred between the cards and View Our Blog. --controls-space is the
// visible gap above and below them: mouse = the .form-consent gap above Submit (rhythm); touch (pointer: coarse)
// leaves >= 16px of dead space between the arrows' tap boxes and the cards / button. The calc's box and dot
// sizes must match the real ones, and the controls' bottom margin must stay inside the carousel (margin-bottom 0
// while they show) so the arrows' focus outline isn't clipped.
const carBase = css.find(r => r.prelude === '.blog-carousel' && !r.context.length);
const ctlBase = css.find(r => r.prelude === '.blog-controls' && !r.context.length);
const arrowBase = css.find(r => r.prelude === '.blog-arrow' && !r.context.length);
const coarseCar = css.find(r => r.prelude === '.blog-carousel' && r.context.some(c => /pointer\s*:\s*coarse/.test(c)));
const hasCtl = css.find(r => r.prelude === '.blog-carousel:has(> .blog-controls:not([hidden]))');
const ctlCalc = (ctlBase && val(ctlBase, 'margin-block') || '').match(/^calc\(var\(--controls-space\) - \((\d+(?:\.\d+)?)px - (\d+(?:\.\d+)?)px\) \/ 2\)$/);
const boxSlack = ctlCalc ? (+ctlCalc[1] - +ctlCalc[2]) / 2 : NaN;
const mouseSpace = carBase && val(carBase, '--controls-space'), touchSpace = coarseCar && val(coarseCar, '--controls-space');
const strayCtlMargins = css.filter(r => r !== ctlBase && r.selectors.some(sel => sel === '.blog-controls') ||
  r === ctlBase && r.decls.some(([pr]) => pr !== 'margin-block' && /^margin/.test(pr)))
  .filter(r => r.decls.some(([pr]) => /^margin/.test(pr)));
const spacingIssues = [
  !ctlCalc && '.blog-controls needs margin-block: calc(var(--controls-space) - (<arrow height> - <dot height>) / 2)',
  ctlCalc && (+ctlCalc[1] !== px(arrowBase && val(arrowBase, 'height')) || +ctlCalc[2] !== px(dotRule && val(dotRule, 'height'))) &&
    `calc uses ${ctlCalc[1]}px / ${ctlCalc[2]}px but the arrow is ${arrowBase && val(arrowBase, 'height')} and the dot ${dotRule && val(dotRule, 'height')}`,
  strayCtlMargins.length && 'another margin on .blog-controls would un-centre the dots',
  mouseSpace !== conMB['(base)'] && `mouse --controls-space ${mouseSpace ?? '(unset)'} must equal .form-consent margin-bottom ${conMB['(base)']}`,
  !(px(touchSpace) - boxSlack >= 16) && `touch --controls-space ${touchSpace ?? '(unset)'} leaves ${(px(touchSpace) - boxSlack) || 0}px dead zone (needs >= 16px)`,
  !(hasCtl && val(hasCtl, 'margin-bottom') === '0') && 'the carousel must drop its margin-bottom to 0 while the controls show',
].filter(Boolean);
check('carousel-controls-spacing', !spacingIssues.length, spacingIssues.join('; '));

// Tabbing to an off-screen card slides it into view, and the browser's focus-scroll of the clipped carousel is undone
check('carousel-focus-follows', /addEventListener\('focusin'/.test(indexHTML) && indexHTML.includes('carousel.scrollLeft = 0'),
  'keep the focusin slide-into-view handler and the scrollLeft reset');

/* ---------- report ---------- */
const gh = process.env.GITHUB_ACTIONS === 'true';
const failed = results.filter(r => r.level === 'FAIL'), warned = results.filter(r => r.level === 'WARN');
console.log(`WireHawk site checks: ${results.length - failed.length - warned.length} passed, ${failed.length} failed, ${warned.length} warning(s)\n`);
for (const r of results) {
  console.log(`  ${r.level}  ${r.id}${r.level !== 'PASS' && r.detail ? `\n        ${r.detail}` : ''}`);
  if (gh && r.level === 'FAIL') console.log(`::error title=${r.id}::${r.detail}`);
  if (gh && r.level === 'WARN') console.log(`::warning title=${r.id}::${r.detail}`);
}
process.exit(failed.length ? 1 : 0);

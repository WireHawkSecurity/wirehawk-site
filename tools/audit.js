/* ============================================================
   WireHawk Security — one-pass page audit
   Run inside the rendered page (Chrome MCP javascript_tool, DevTools console,
   or headless Chrome) at each test width: 2048 (Jordan's desktop: 2560x1440 at
   125% Windows scaling), 2560 (same monitor at 100%), 900 (tablet), 393
   (iPhone 16 Pro). Returns one object; `flags` lists anything that breaks a
   project rule or WCAG threshold. Read-only: changes nothing.
   Not published (Hugo ignores tools/).
   ============================================================ */
(() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const css = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p).trim() : null);
  const rect = el => el.getBoundingClientRect();
  const r1 = n => Math.round(n * 10) / 10;
  const flags = [];

  /* colour + contrast (composites semi-transparent backgrounds up the tree) */
  const parse = s => { const m = (s.match(/[\d.]+/g) || []).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
  const lum = c => c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgOf = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const p = parse(getComputedStyle(e).backgroundColor);
      if (p.a > 0) { layers.push(p); if (p.a >= 1) break; }
    }
    let out = [0, 0, 0];                                   // page floor is black
    for (const l of layers.reverse()) out = out.map((v, i) => l.c[i] * l.a + v * (1 - l.a));
    return out;
  };
  const contrast = el => {
    const fg = parse(getComputedStyle(el).color).c, bg = bgOf(el);
    const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return Math.round((x + 0.05) / (y + 0.05) * 100) / 100;
  };
  const isLarge = el => { const fs = parseFloat(css(el, 'font-size')), w = +css(el, 'font-weight'); return fs >= 24 || (fs >= 18.66 && w >= 700); };

  /* fonts: is Sora actually rendering? (local install or Google Fonts) */
  const probe = document.createElement('span');
  probe.textContent = 'WireHawk Security 0123456789';
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:40px;white-space:nowrap';
  document.body.appendChild(probe);
  probe.style.fontFamily = 'Sora, monospace'; const wSora = probe.offsetWidth;
  probe.style.fontFamily = 'NoSuchFont-x, monospace'; const wFallback = probe.offsetWidth;
  probe.remove();
  const soraRendering = wSora !== wFallback;
  if (!soraRendering) flags.push('Sora is not rendering; text metrics are fallback-font metrics');

  /* layout */
  const root = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(['--gap', '--pad', '--header-h', '--content-w', '--dim', '--muted', '--red', '--red-bright']
    .map(t => [t, root.getPropertyValue(t).trim()]));
  const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  if (overflowX) flags.push('horizontal overflow');
  const h2Sizes = [...new Set($$('section h2').map(h => css(h, 'font-size')))];
  if (h2Sizes.length !== 1) flags.push(`section h2 sizes differ: ${h2Sizes.join(', ')}`);
  const cards = $$('.services-intro, .services-grid, .section-card').filter(c => !c.closest('.contact'));
  const cardWidths = [...new Set(cards.map(c => r1(rect(c).width)))];
  if (cardWidths.length !== 1) flags.push(`content widths differ: ${cardWidths.join(', ')}`);
  /* CTA rhythm + carousel controls: measured as visible gaps, not margins. The dots sit centred between the
     cards and View Our Blog. With a mouse, the gap above View Our Blog equals the gap above Submit; on touch
     (pointer: coarse) the arrows' tap boxes keep >= 16px of dead space from the cards and the button. */
  const coarse = matchMedia('(pointer: coarse)').matches, blogBtn = $('.blog-cta .btn-ghost'), ctl = $('.blog-controls');
  const ctlShown = !!ctl && !ctl.hidden && css(ctl, 'display') !== 'none' && !!$('.blog-card');
  const submitGap = $('.form-consent label') && $('.btn-submit') ? r1(rect($('.btn-submit')).top - rect($('.form-consent label')).bottom) : null;
  const rhythm = { pointer: coarse ? 'coarse' : 'fine', controlsShown: ctlShown, submitGap };
  if (ctlShown && blogBtn) {
    const card = rect($('.blog-card')), dot = rect($('.blog-dot')), arrow = rect($('.blog-arrow')), btn = rect(blogBtn);
    Object.assign(rhythm, { cardsToDots: r1(dot.top - card.bottom), dotsToButton: r1(btn.top - dot.bottom),
      arrowDeadZoneAbove: r1(arrow.top - card.bottom), arrowDeadZoneBelow: r1(btn.top - arrow.bottom),
      arrowRoomInsideCarousel: r1(rect($('.blog-carousel')).bottom - arrow.bottom) });
    if (Math.abs(rhythm.cardsToDots - rhythm.dotsToButton) > 1) flags.push(`carousel dots not centred: ${rhythm.cardsToDots}px above vs ${rhythm.dotsToButton}px below`);
    if (!coarse && submitGap !== null && Math.abs(rhythm.dotsToButton - submitGap) > 1) flags.push(`CTA rhythm: ${rhythm.dotsToButton}px above View Our Blog vs ${submitGap}px above Submit`);
    if (coarse && Math.min(rhythm.arrowDeadZoneAbove, rhythm.arrowDeadZoneBelow) < 16) flags.push(`touch: carousel arrows within ${Math.min(rhythm.arrowDeadZoneAbove, rhythm.arrowDeadZoneBelow)}px of the cards / button (needs 16px)`);
    if (rhythm.arrowRoomInsideCarousel < 5) flags.push('carousel arrows sit on the clip edge: their focus outline gets cut off');
  } else if (blogBtn && $('.blog-carousel')) {
    rhythm.carouselToButton = r1(rect(blogBtn).top - rect($('.blog-carousel')).bottom);
    if (submitGap !== null && Math.abs(rhythm.carouselToButton - submitGap) > 1) flags.push(`CTA rhythm: ${rhythm.carouselToButton}px above View Our Blog vs ${submitGap}px above Submit`);
  }

  /* text contrast on representative elements */
  const SAMPLES = { heroProps: '.hero-props p', navLink: '.header-nav a:not(.nav-cta)', serviceItem: '.service-column li',
    deliverableLabel: '.deliverable-label', deliverablesNote: '.deliverables-note', aboutText: '.about-text p',
    blogDate: '.blog-card-date', blogExcerpt: '.blog-card-excerpt', blogStatus: '.blog-empty, .blog-loading',
    contactIntro: '.contact-intro', consentLabel: '.form-consent label', footerMeta: '.footer-meta', copyright: '.footer-copyright' };
  const textContrast = {};
  for (const [k, sel] of Object.entries(SAMPLES)) {
    const el = $(sel); if (!el || !el.offsetParent) continue;
    const cr = contrast(el), need = isLarge(el) ? 3 : 4.5;
    textContrast[k] = `${cr}:1 (needs ${need})`;
    if (cr < need) flags.push(`contrast ${k}: ${cr}:1 < ${need}:1`);
  }

  /* tap targets — WCAG 2.5.8: 24x24, or the 24px-circle spacing exception */
  const targets = group => {
    const els = $$(group).filter(e => e.offsetParent), boxes = els.map(rect);
    if (!els.length) return null;
    const undersized = boxes.filter(b => b.width < 24 || b.height < 24).length;
    const spacingOK = boxes.every((b, i) => {
      if (b.width >= 24 && b.height >= 24) return true;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      return boxes.every((o, j) => {
        if (i === j) return true;
        const dx = Math.max(o.x - cx, 0, cx - (o.x + o.width)), dy = Math.max(o.y - cy, 0, cy - (o.y + o.height));
        const ocx = o.x + o.width / 2, ocy = o.y + o.height / 2;
        const circlesClear = (o.width >= 24 && o.height >= 24) || Math.hypot(ocx - cx, ocy - cy) >= 24;
        return Math.hypot(dx, dy) >= 12 && circlesClear;
      });
    });
    const res = { count: els.length, size: `${r1(boxes[0].width)}x${r1(boxes[0].height)}`, undersized, wcag258: spacingOK ? 'pass' : 'fail' };
    if (!spacingOK) flags.push(`tap targets fail WCAG 2.5.8: ${group}`);
    return res;
  };
  const tapTargets = { footerSocial: targets('.site-footer .social-icons a'), carouselDots: targets('.blog-dot'),
    carouselArrows: targets('.blog-arrow'),
    menuSocial: targets('.mobile-nav .social-icons a') };

  /* interaction red (hover / focus / press foreground) on each surface it appears on */
  const hexRGB = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const rgbRatio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
  const interactionRed = tokens['--red-bright'] || tokens['--red'];
  const stateRed = interactionRed ? Object.fromEntries(
    [['header', $('.site-header')], ['card', $('.contact .section-card')], ['page', document.body]]
      .filter(([, el]) => el).map(([k, el]) => [k, rgbRatio(hexRGB(interactionRed), bgOf(el))])) : null;
  if (stateRed) for (const [k, v] of Object.entries(stateRed)) if (v < 4.5) flags.push(`interaction red on ${k}: ${v}:1 < 4.5:1`);

  /* carousel dots: inactive ring contrast against the card (WCAG 1.4.11) */
  const idleDot = $$('.blog-dot').find(d => !d.classList.contains('active'));
  let dotRing = null;
  if (idleDot) {
    const m = (css(idleDot, 'box-shadow') || '').match(/rgba?\([^)]+\)/);
    if (m) {
      const p = parse(m[0]), bg = bgOf(idleDot), ring = bg.map((v, i) => p.c[i] * p.a + v * (1 - p.a));
      const [x, y] = [lum(ring), lum(bg)].sort((a, b) => b - a);
      dotRing = Math.round((x + 0.05) / (y + 0.05) * 100) / 100;
      if (dotRing < 3) flags.push(`inactive carousel dot ring ${dotRing}:1 < 3:1`);
    }
  }

  /* keyboard: closed mobile menu must not be in the tab order */
  const nav = $('.mobile-nav'), menuOpen = document.body.classList.contains('mobile-nav-open');
  const navShown = nav && css(nav, 'display') !== 'none';
  const closedMenuTabStops = navShown && !menuOpen
    ? $$('.mobile-nav a, .mobile-nav button').filter(a => css(a, 'visibility') === 'visible').length : 0;
  if (closedMenuTabStops) flags.push(`${closedMenuTabStops} focusable links inside the closed mobile menu`);

  /* screenshot hygiene: lazy images not yet loaded will render blank */
  const unloadedImages = $$('img').filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute('src'));

  return {
    viewport: `${innerWidth}x${innerHeight} @${devicePixelRatio}x`,
    soraRendering, tokens, overflowX, h2Sizes, contentWidths: cardWidths,
    contactWidth: $('.contact .section-card') ? r1(rect($('.contact .section-card')).width) : null,
    header: { height: r1(rect($('.site-header')).height), background: css($('.site-header'), 'background-color') },
    rhythm, textContrast, stateRed, tapTargets, dotRing,
    menu: { shown: navShown, open: menuOpen, closedMenuTabStops },
    carousel: $('.blog-card') ? `${$$('.blog-card').length} cards` : ($('#blog-carousel') || {}).innerText,
    unloadedImages,
    flags,
  };
})();

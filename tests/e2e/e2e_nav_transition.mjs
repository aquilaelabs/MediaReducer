// Navigation must not run through a view transition.
//
// One was tried, to hold the header still while pages changed, and it could not
// sit still. A view transition renders from SNAPSHOTS, and this header is glass
// — 88% surface with a blur behind it — so its snapshot composites over the
// FADING page instead of over live content: it visibly dims and comes back.
// Sampling the header strip through a real tab click measured that swing at ~11
// of 255 with the transition and 0 without it. The body had the matching
// problem — two different pages drawn at once is a double exposure, every line
// of the old page showing through the new.
//
// The mechanism is what has to stay gone, so the mechanism is what is asserted:
// no cross-document transition runs, and nothing carries a view-transition-name,
// which is what would opt an element back into snapshot compositing. Pixel
// sampling was how the fault was found, but it makes a poor guard here — page
// load timing moves the blank-frame boundary around, so it fails for reasons
// unrelated to the fault.
//
// Same-document view transitions are untouched: the theme flip still
// cross-fades, and has its own test.
//
// And a switch must not flash. The browser holds the leaving page's last frame
// until the next page paints, so what the reader sees across a switch is that
// frame, then the arriving page's first. The arriving page used to start at
// the bottom of the dip whatever the leaving page looked like, so a page at
// full strength dropped to near-blank in one frame. Now the leaving page fades
// toward the dip from the press and records how far it got, and the arriving
// page starts from there. What is asserted is that hand-off: the opacity the
// leaving page stopped at against the opacity the arriving page starts from,
// read from the page rather than off pixels, for the same reason as above.
const BASE = process.env.MR_BASE_URL || 'http://127.0.0.1:7474';
const PW = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(PW);
const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(() => {
  window.__vtSeen = false;
  window.addEventListener('pagereveal', (e) => { window.__vtSeen = !!e.viewTransition; });
  // The leaving page's content at the moment it goes: the frame the browser
  // then holds on screen.
  window.addEventListener('pagehide', () => {
    const m = document.getElementById('main');
    if (m) sessionStorage.setItem('test-left-at', getComputedStyle(m).opacity);
  });
});

// Where the arriving page's entrance starts, worked out from the same two
// numbers its keyframe is (the knob checks below prove the keyframe reads
// them), and the opacity the page before it stopped at.
const arrival = () => p.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const from = parseFloat(cs.getPropertyValue('--pr-enter-from'));
  const fade = parseFloat(cs.getPropertyValue('--pr-enter-fade'));
  const left = sessionStorage.getItem('test-left-at');
  sessionStorage.removeItem('test-left-at');
  return { from, startsAt: 1 - from * (1 - fade), leftAt: left === null ? null : Number(left),
           fade, path: location.pathname };
});
const seamless = (a) => a.leftAt !== null && Math.abs(a.startsAt - a.leftAt) < 0.03;

let ok = true;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + JSON.stringify(extra ?? '')));
  ok = ok && cond;
}

const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
async function open(path) {
  for (let i = 0; i < 5; i++) {
    try {
      await p.goto(BASE + path, { waitUntil: 'load', timeout: 45000 });
      await p.evaluate(() => document.querySelectorAll('.modal.show')
        .forEach(m => window.bootstrap && bootstrap.Modal.getInstance(m)?.hide()));
      await p.waitForTimeout(400);
      return true;
    } catch (_) { await p.waitForTimeout(1000); }
  }
  return false;
}
if (!await open('/config')) { console.log('FAIL could not load /config'); console.log('RESULT: FAIL'); await b.close(); process.exit(1); }

// Nothing may carry a view-transition-name. One named element is enough to opt
// that element into snapshot compositing, which is exactly how the header came
// to dim — it was named so it would hold still, and holding still is the one
// thing it then could not do.
for (const path of ['/', '/config', '/explorer']) {
  if (!await open(path)) { check(`could not load ${path}`, false); continue; }
  const named = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      // <html> is always 'root' — that is the user agent's own name for the
      // page snapshot and cannot be removed. Every OTHER name is ours.
      if (el === document.documentElement) continue;
      const n = getComputedStyle(el).viewTransitionName;
      if (n && n !== 'none') out.push((el.tagName + '.' + el.className).slice(0, 60) + ' = ' + n);
    }
    return out;
  });
  check(`${path}: nothing is registered as a view-transition group`,
        named.length === 0, named);
}

// And no navigation actually runs one. Every hop leaves a SCROLLED page, the
// case that looked worst, since the chrome then sits higher than where the
// arriving page draws its own.
for (const [from, link] of [['/config', 'Filtering & Scoring'],
                            ['/config', 'Dashboard'],
                            ['/explorer', 'Dashboard'],
                            ['/', 'Configuration']]) {
  if (!await open(from)) { check(`could not load ${from}`, false); continue; }
  await p.evaluate(() => window.scrollTo(0, 800));
  await p.waitForTimeout(250);
  await p.getByRole('link', { name: link, exact: true }).first().click();
  await p.waitForLoadState('load');
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => ({
    vt: window.__vtSeen,
    // The arriving page still eases its content in — that is the whole of the
    // navigation's animation now, and it must not have been dropped along
    // with the transition.
    entrance: (() => {
      const m = document.getElementById('main');
      return m ? getComputedStyle(m).animationName : null;
    })(),
    path: location.pathname,
  }));
  check(`${from} -> ${link}: no cross-document view transition`, r.vt === false, r);
  check(`${from} -> ${link}: the arriving page still eases in`,
        r.entrance === 'pr-page-enter', r);

  // What the entrance is — and not one of the numbers it is made of.
  //
  // How far it travels, how much it fades and how long it takes are taste.
  // This test had opinions about all three, so tuning the animation broke it,
  // which is a test being wrong rather than the page being wrong. They live in
  // --pr-enter-rise / --pr-enter-fade / --pr-enter-time now, and what is
  // checked is that those tokens are WIRED: each one is moved to an absurd
  // value and the animation has to change accordingly. A knob that silently
  // stopped driving anything — someone inlining a value back into the keyframe
  // — is the failure this replaces the old value-pinning with, and it is the
  // one that would actually cost an afternoon.
  //
  // Replayed from the settled page, since by now this navigation's own
  // animation has finished. From the bottom of the dip (--pr-enter-from 1),
  // where a first visit starts: this click's own hand-off may have started it
  // anywhere, and the knobs are about the dip, not about where this one began.
  const enter = await p.evaluate(async () => {
    const m = document.getElementById('main');
    const root = document.documentElement;
    const handedOff = root.style.getPropertyValue('--pr-enter-from');
    root.style.setProperty('--pr-enter-from', '1');
    const replay = async () => {
      m.style.animation = 'none';
      void m.offsetWidth;
      m.style.animation = '';
      const first = getComputedStyle(m);
      const shot = { opacity: Number(first.opacity), transform: first.transform,
                     dur: document.getAnimations()
                            .filter(a => a.effect && a.effect.target === m)
                            .map(a => a.effect.getTiming().duration)[0] };
      await new Promise(r2 => requestAnimationFrame(r2));
      return shot;
    };
    // What is riding the animation: everything under the header.
    const covers = { title: !!m.querySelector('.page-title'),
                     cards: m.querySelectorAll('.card, .accordion-item').length,
                     outside: [...document.querySelectorAll('.card')]
                                .filter(c => !m.contains(c)).length };
    const base = await replay();
    // One token at a time, each to a value nothing would pick, then put back.
    const knob = async (name, value) => {
      root.style.setProperty(name, value);
      const got = await replay();
      root.style.removeProperty(name);
      return got;
    };
    const out = { covers, base,
                  rise: await knob('--pr-enter-rise', '400px'),
                  fade: await knob('--pr-enter-fade', '0'),
                  time: await knob('--pr-enter-time', '9s') };
    // Where it starts: in place at 0, and halfway down a dip to 0 at 0.5.
    out.still = await knob('--pr-enter-from', '0');
    root.style.setProperty('--pr-enter-fade', '0');
    out.half = await knob('--pr-enter-from', '0.5');
    root.style.removeProperty('--pr-enter-fade');
    root.style.setProperty('--pr-enter-from', handedOff);
    return out;
  });
  check(`${from} -> ${link}: the page's whole contents ride the entrance`,
        enter.covers.title && enter.covers.cards >= 1 && enter.covers.outside === 0,
        enter.covers);
  check(`${from} -> ${link}: --pr-enter-rise sets how far it travels`,
        enter.rise.transform !== enter.base.transform
        && /400/.test(enter.rise.transform), [enter.base.transform, enter.rise.transform]);
  check(`${from} -> ${link}: --pr-enter-fade sets what it fades from`,
        enter.fade.opacity === 0 && enter.fade.opacity !== enter.base.opacity,
        [enter.base.opacity, enter.fade.opacity]);
  check(`${from} -> ${link}: --pr-enter-time sets how long it takes`,
        enter.time.dur === 9000 && enter.time.dur !== enter.base.dur,
        [enter.base.dur, enter.time.dur]);
  check(`${from} -> ${link}: --pr-enter-from sets where it starts`,
        enter.still.opacity === 1 && !/[1-9]/.test(enter.still.transform.replace(/matrix\(1, 0, 0, 1,/, ''))
        && Math.abs(enter.half.opacity - 0.5) < 0.01,
        { still: enter.still, half: enter.half });
}

// ── The switch itself ────────────────────────────────────────────────────────
// A person's click: the pointer goes down, and comes up about 100ms later.
const arrived = (path) => p.waitForURL(u => new URL(u).pathname === path, { waitUntil: 'load' });
const opacityOfMain = () => p.evaluate(() => Number(getComputedStyle(document.getElementById('main')).opacity));
// holdMs, or with `untilDip` for as long as the fade takes to reach the
// bottom: an animation starts on the next frame the browser draws, which on a
// loaded test machine can be a few hundred milliseconds away.
async function press(name, path, holdMs, untilDip) {
  const tab = p.getByRole('link', { name, exact: true }).first();
  const box = await tab.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  if (untilDip !== undefined) {
    await p.waitForFunction((dip) => Number(getComputedStyle(document.getElementById('main')).opacity) <= dip + 0.02,
                            untilDip, { timeout: 5000, polling: 50 }).catch(() => {});
  } else {
    await p.waitForTimeout(holdMs);
  }
  const pressed = await opacityOfMain();
  await Promise.all([arrived(path), p.mouse.up()]);
  await p.waitForTimeout(400);
  return pressed;
}

if (await open('/config')) {
  const fade = await p.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pr-enter-fade')));
  // Held until the fade is done: the leaving page is at the bottom of the dip
  // before it goes, so the arriving page starts there too.
  const pressed = await press('Filtering & Scoring', '/explorer', 0, fade);
  check('a held tab press takes the leaving page down to the dip before it goes',
        Math.abs(pressed - fade) < 0.02, { pressed, fade });
  const held = await arrival();
  check('...and the arriving page starts at the dip, where the leaving page stopped',
        held.path === '/explorer' && held.from > 0.95 && seamless(held), held);

  // A person's click, about 100ms down: whatever the leaving page reached is
  // where the arriving page starts, so no frame drops between them.
  await press('Dashboard', '/', 100);
  const quick = await arrival();
  check('a quick click: the arriving page starts where the leaving page stopped',
        quick.path === '/' && seamless(quick), quick);

  // Enter on a focused tab has no press before the click, so the leaving
  // page barely starts down. Still no drop: the arriving page matches it.
  await p.getByRole('link', { name: 'Configuration', exact: true }).first().focus();
  await Promise.all([arrived('/config'), p.keyboard.press('Enter')]);
  await p.waitForTimeout(400);
  const keyed = await arrival();
  check('Enter on a tab: the arriving page starts where the leaving page stopped',
        keyed.path === '/config' && seamless(keyed), keyed);

  // Nothing pressed: a reload hands over from a page at full strength, so it
  // arrives in place rather than dipping to blank and back.
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(400);
  const reloaded = await arrival();
  check('a reload arrives in place, without the dip',
        reloaded.from < 0.02 && seamless(reloaded), reloaded);

  // A press that goes nowhere (released off the tab, so no click) brings the
  // page back up. Sent as the pointer events themselves: moving a real
  // pointer off a held link starts the browser dragging the link instead.
  const stayed = await p.evaluate(async () => {
    const tab = [...document.querySelectorAll('.header-tabs a')].find(a => a.getAttribute('href') === '/');
    const main = document.getElementById('main');
    const now = () => Number(getComputedStyle(main).opacity);
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    // Down far enough to show the fade ran (see press() on how long it waits).
    for (let i = 0; i < 100 && now() > 0.5; i++) await new Promise(r => setTimeout(r, 50));
    const down = now();
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true }));
    for (let i = 0; i < 100 && now() < 1; i++) await new Promise(r => setTimeout(r, 50));
    return { path: location.pathname, down, opacity: now() };
  });
  check('a press that ends off the tab brings the page back to full strength',
        stayed.path === '/config' && stayed.down < 0.5 && stayed.opacity === 1, stayed);
} else {
  check('could not load /config for the switch checks', false);
}

// A first visit has nothing to take up from, so it rises out of the full dip.
{
  const fresh = await ctx.newPage();
  await fresh.goto(BASE + '/config', { waitUntil: 'domcontentloaded' });
  const first = await fresh.evaluate(() => ({
    from: getComputedStyle(document.documentElement).getPropertyValue('--pr-enter-from').trim(),
    inline: document.documentElement.style.getPropertyValue('--pr-enter-from'),
  }));
  check('a first visit starts from the bottom of the dip', first.from === '1' && first.inline === '', first);
  await fresh.close();
}

check('no JS errors', errs.length === 0, errs);
console.log('RESULT:', ok ? 'PASS' : 'FAIL');
await b.close();
process.exit(ok ? 0 : 1);

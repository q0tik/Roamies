// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Behavior and About, and What's new.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id, 'fish' or 'gemini'), the row action waiting for its
  // Confirm, each long list's page (pg) and how many rows fit on one (per, measured), Memory's tab and its search.
  const ui = { key: null, kind: {}, arm: null, add: { label: '', url: '', key: '', images: false }, addSent: null, pg: {}, per: {}, base: {}, rec: null, mtab: 'facts', tabs: {}, q: '', bindShown: new Set() };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria, title } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, title, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  // A block opening in place grows into its room and fades in; closing, the reverse. Marked with data-anim (its id).
  const shown = (n) => !n.hidden && n.getClientRects().length > 0;
  function grow(n, open) {
    if (REDUCED.matches || !shown(n)) return Promise.resolve();
    const h = n.offsetHeight, gap = parseFloat(getComputedStyle(n.parentElement).rowGap) || 0;
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(open ? 'appear' : 'vanish');
    const shut = { height: '0px', marginTop: `${-gap}px` }, full = { height: `${h}px`, marginTop: '0px' };
    n.style.overflow = 'hidden';
    return n.animate(open ? [shut, full] : [full, shut], { duration: open ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: open ? 'none' : 'forwards' })
      .finished.catch(() => {}).then(() => { n.style.overflow = ''; if (open) n.classList.remove('appear'); });
  }
  // Closes the open block `id` (animated), then runs then().
  const shutBlock = (id, then) => { const n = document.querySelector(`.pane [data-anim="${CSS.escape(id)}"]`); return n && shown(n) ? grow(n, false).then(then) : then(); };
  // The key field under a row: opens (closing another first), or closes if it's the one open.
  function toggleKey(id) {
    const prev = ui.key;
    if (prev === id) return closeKey();
    const open = () => { ui.key = id; render(`key-${id}`); };
    return prev ? shutBlock(`key-${prev}`, open) : open();
  }
  function closeKey() {
    const id = ui.key;
    if (!id) return;
    shutBlock(`key-${id}`, () => { if (ui.key === id) { ui.key = null; render(`addkey:${id}`); } });
  }
  // A row being removed dissolves out, then leaves the list at once (the rows below step up as it goes, so no empty
  // gap waits for the sidecar). Until the new state drops it, every redraw keeps it out, so it never blinks back; if
  // the removal didn't happen after a few seconds, it returns.
  const gone = new Map(); // the row's action key → when to give up on it
  const rowOf = (k) => document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`)?.closest('li');
  const keepGone = () => { for (const [k, until] of gone) { if (Date.now() > until) gone.delete(k); else rowOf(k)?.classList.add('gone'); } };
  const leave = (from, id) => {
    const k = from.dataset.k, row = from.closest('li');
    if (k) gone.set(k, Date.now() + 4000);
    row?.classList.add('leaving');
    setTimeout(() => { row?.classList.add('gone'); act(id); }, REDUCED.matches ? 0 : 190);
    setTimeout(() => { if (k && gone.delete(k) && rowOf(k)) render(); }, 4100);
  };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Подтвердить: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  // A row's tick (done) or X (forget, drop) asks first, like Quit: pressed, it turns into Confirm in place while the
  // row's other button steps aside; pressed again it goes, left alone for 4 s it goes back.
  const PIX = {
    tick: [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]],
    x: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [6, 0], [5, 1], [4, 2], [2, 4], [1, 5], [0, 6]],
  };
  const pix = (name) => `<svg viewBox="0 0 14 14" width="14" height="14" shape-rendering="crispEdges" fill="currentColor">${PIX[name].map(([x, y]) => `<rect x="${x * 2}" y="${y * 2}" width="2" height="2"/>`).join('')}</svg>`;
  // Asking, it has no tooltip: the word on it says what it does.
  const armIcon = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? `Подтвердить: ${b.dataset.aria}` : b.dataset.aria); if (on) b.removeAttribute('data-tip'); else b.dataset.tip = b.dataset.name; };
  const calmIcons = () => { for (const o of document.querySelectorAll('.pane .ibtn[aria-pressed="true"]')) armIcon(o, false); };
  function iconArmed(icon, tip, k, id, aria) {
    const no = el('span', { className: 'no', 'aria-hidden': 'true' });
    no.innerHTML = pix(icon);
    const b = el('button', { className: `link ibtn${icon === 'x' ? ' danger' : ''}`, type: 'button', 'data-k': k, 'data-name': tip, 'data-aria': aria },
      no, el('span', { className: 'yes', textContent: 'Точно?', 'aria-hidden': 'true' }));
    armIcon(b, ui.arm === k);
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); return leave(b, id); }
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(k);
      const me = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`) ?? b;
      ui.arm = k; armIcon(me, true); hideTip();
      armTimer = setTimeout(() => { if (ui.arm !== k) return; ui.arm = null; const n = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`); if (n) armIcon(n, false); }, 4000);
    });
    return b;
  }
  // No title: the section is alone in its tab, which names it.
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, title ? el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null) : null, desc ? el('p', { textContent: desc }) : null),
    ...kids);
  // A page's tabs (Memory, Model, Appearance, Listening): one part of the page at a time. tabs: [id, label]; pick(id) switches.
  const tabRow = (label, panel, tabs, on, pick) => el('div', { className: 'tabs', role: 'tablist', 'aria-label': label }, tabs.map(([id, text]) => el('button', {
    className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': panel, tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
    on: { click: () => { if (on !== id) { pick(id); disarm(); render(`tab-${id}`); } } },
  }, text)));
  // The tab picked on a page: the one kept from before when it's still offered, else the first.
  const pageTab = (page, tabs, first = tabs[0][0]) => (tabs.some(([id]) => id === ui.tabs[page]) ? ui.tabs[page] : first);
  const tabPanel = (id, on, ...kids) => el('div', { className: 'tabpanel', role: 'tabpanel', id, 'aria-labelledby': `tab-${on}` }, ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint, className: hint.length > 52 ? 'wrap' : '' }) : null), // a long hint wraps instead of running off the row
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target, own = null) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = own ?? target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12;
    // Fit the text, up to 300px (or the window): a one-word tip gets a small card.
    t.style.maxWidth = `${Math.min(300, innerWidth - gut * 2)}px`;
    const w = t.offsetWidth, h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  // A description cut to one line ("…") shows in full: on hover, and when its row's control has keyboard focus.
  const clipped = (n) => (n && n.scrollWidth > n.clientWidth ? n.textContent : null);
  document.addEventListener('pointerover', (e) => {
    const d = e.target.closest?.('.setting > span small, .ghead p');
    if (d) { const full = clipped(d); if (full) d.dataset.tip = full; else delete d.dataset.tip; }
  }, true);
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => {
    const x = e.target.closest?.('[data-tip]');
    if (x && x.matches(':focus-visible')) return showTip(x);
    const full = !x && e.target.matches?.(':focus-visible') ? clipped(e.target.closest?.('.setting')?.querySelector(':scope > span small')) : null;
    if (full) showTip(e.target, full); else hideTip();
  });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'сейчас';
    if (s < 3600) return `${Math.round(s / 60)}м`;
    if (s < 86400) return `${Math.round(s / 3600)}ч`;
    return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'Больше эмоций. Медленнее и дороже.', 's2.1-pro': 'Естественный темп. Меньше эмоций, дешевле.' };
  const WHY_LONG = {
    'drama-3': 'Самая выразительная: шёпот, смех и живые эмоции. Говорит медленнее, с паузами между фразами.',
    's2.1-pro': 'Естественный, более быстрый темп. Эмоции передаются мягко.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} до ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} за миллион символов: примерно ${per100(c.perM)} за 100 ответов${promo}. Списывается с вашего аккаунта Fish Audio.`;
  };
  // Gemini's two: a reply is about 12 seconds of speech, so 100 replies are about 20 minutes.
  const GEMINI_WHY = { 'gemini-3.8-flash-lite-tts': 'Быстрая. Дешевле.', 'gemini-3.8-flash-tts': 'Студийное качество. Дороже.' };
  const GEMINI_WHY_LONG = {
    'gemini-3.8-flash-lite-tts': 'Быстрая и дешёвая: отлично подходит для обычных ответов.',
    'gemini-3.8-flash-tts': 'Лучшее качество голоса Google с более живыми интонациями.',
  };
  const geminiPrice = (c) => `Примерно $${(c.per10s * 120).toFixed(2)} за 100 ответов, списывается с вашего аккаунта Google AI Studio (есть бесплатный лимит).`;
  const where = () => (state?.os === 'mac' ? 'связке ключей macOS' : state?.os === 'win' ? 'Windows (зашифровано для вашей учётной записи)' : state?.os === 'linux' ? 'вашем keyring' : 'этом компьютере');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Войдите на вкладке «Модель»' : '');
    now.title = now.textContent;
    $('ver').textContent = `v${state.version}`;
    updateButton();
    react();
    // The sidebar marks a page that needs you: no account to answer with.
    mark('model', s.state === 'off' ? 'нет входа' : null);
  }
  // One button for updates, updated in place (not rebuilt) so it keeps focus: Check for updates, then Update to x
  // (it downloads, installs and restarts), then Done. "Up to date" shows for a few seconds after a check.
  const FRESH = 6000;
  let freshTimer = 0;
  function updateButton() {
    const b = $('head-update');
    if (b) b.hidden = true;
  }
  $('head-update').addEventListener('click', () => act(state?.update?.available ? 'install_update' : 'update'));
  // Quit asks first: the first press turns it into Confirm for 4 s, the second quits.
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Выйти из Roamies'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Подтвердить выход из Roamies');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  const closeB = $('head-close');
  closeB.innerHTML = pix('x');
  closeB.addEventListener('click', hide);
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Roamies
  // The same LED renderer as on the desktop and in the setup guide, drawn small: one in the header (the Roamie
  // you have, reacting to what's going on) and one per look on the Appearance page. One loop draws them all,
  // only while the panel is up and each canvas is on screen.
  const LED = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // A Roamie on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art (the full face, the small one, the pointer) at its real size next to the others.
  const ZOOM = 0.5, UNIT = 340;
  function liveRoamie(canvas, w, h, { look = 'classic', y = 0.56, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's Roamie: your look, reacting to what's going on. A short line beside it when something changes.
  // The same size and detail as the look tiles (fewer dots than that and the faces turn to noise).
  const avatar = liveRoamie($('avatar'), 100, 74, { y: 0.55 });
  const QUIPS = { classic: 'Классика!', jarvis: 'К вашим услугам.', glayos: 'О, отлично. Новый испытуемый.', ultren: 'Без ниточек. Начнём?', anime: 'Ура, привет-привет!', sarah: 'Привет, рада познакомиться!', adrian: 'Ну что, погнали?', rita: 'Приступим к работе?', cat: 'Мяу! Готов к работе.', prism: 'Переливаюсь и готов!' };
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    if (seen.look && state.look !== seen.look) { avatar.setLook(state.look); avatar.act('wave'); quip(QUIPS[state.look] ?? 'Привет!'); }
    else avatar.setLook(state.look);
    avatar.setForm(state.size);
    if (state.update.available && state.update.available !== seen.update && seen.look) { avatar.act('hype'); quip(`Вышел Roamies ${state.update.available}!`); }
    seen.look = state.look; seen.update = state.update.available;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update;
    const mac = state.os === 'mac';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Действия' }),
        el('div', { className: 'actions' },
          // askKeys: the type-to-ask shortcut (a tap of two modifier keys), so it can be learnt from the button.
          btn('Спросить', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy,
            aria: state.askKeys ? `Спросить ${state.name}, или нажмите ${state.askKeys} где угодно` : `Спросить ${state.name}`, title: state.askKeys ? `Или нажмите ${state.askKeys} где угодно` : null }),
          btn('Список дел', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Спросить про область', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Стоп', () => act('stop'), { k: 'stop' }) : btn('Новый чат', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Начать новый диалог' }),
          mac ? null : btn(`Показать ${state.name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent, (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', dir: 'auto', textContent: r.kind === 'ask' ? `«${r.text}»` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Недавнее' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Недавнее' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Сегодня: ${state.usage.requests} запр. · ${tokens(state.usage.tokens)} токенов` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  // As many rows as fit (measured after drawing, see fit()), the rest a page away with the arrows in the footer.
  const EMPTY = 'Пока пусто…';
  // pin: the index of a row that must stay in view (an open key field), whatever page that puts it on.
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const shown = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      shown.length ? el('ul', { className: 'list', 'aria-label': label }, shown.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  function pager(key, pg, pages, label) {
    const go = (d) => {
      ui.pg[key] = pg + d; disarm();
      // Keep focus on an arrow that still works at the end of the list.
      const edge = pg + d === 0 || pg + d === pages - 1;
      refresh(`${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: страница ${pg + 1} из ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Предыдущая страница' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Следующая страница' }));
  }
  // The page's footer: something about the whole list on the left, the arrows on the right; none when both are empty.
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  // How many rows fit in each list's box now; true when that changed (so it's drawn again). A plain row sets the
  // size; a taller one (an open key field, a note under the row) takes its extra room off the page.
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')].filter((r) => r.offsetHeight > 0); // not one being removed (hidden)
      if (!rows.length || !box.clientHeight) continue;
      const open = (r) => r.classList.contains('open');
      const shut = rows.filter((r) => !open(r));
      const unit = Math.min(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const over = (list) => list.reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      // Regression: a taller row on one page (Ollama's note) made that page smaller, which moved every page and showed
      // rows twice. For the same box, the size without open rows only ever shrinks, so the pages hold still.
      const k = box.dataset.pager, h = box.clientHeight, seen = ui.base[k];
      let base = Math.floor((h - over(shut)) / unit);
      if (seen?.h === h && seen.unit === unit) base = Math.min(base, seen.n);
      ui.base[k] = { h, unit, n: base };
      const per = Math.max(3, base - Math.ceil(over(rows.filter(open)) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  // Two tabs, What I remember and Commitments, each a page at a time; Get to know me at the end of the tab row.
  function memory() {
    const on = ui.mtab === 'commits' ? 'commits' : 'facts';
    return [
      el('div', { className: 'mhead' },
        tabRow('Память', 'mem-panel', [['facts', 'Что я помню'], ['commits', 'Обязательства']], on, (id) => { ui.mtab = id; }),
        link('Познакомиться ближе', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : factList()),
    ];
  }
  // ---------------------------------------------------------------- Abilities
  // What I can do beyond talking, a tab each: skills I know, apps I'm connected to, and what I do on my own.
  const ABILITY_TABS = [['skills', 'Скиллы'], ['connections', 'Подключения'], ['routines', 'Рутины']];
  function abilitiesPage() {
    const t = pageTab('abilities', ABILITY_TABS);
    const head = el('div', { className: 'mhead' }, tabRow('Навыки', 'ab-panel', ABILITY_TABS, t, (id) => { ui.tabs.abilities = id; }));
    const { body, foot: end } = t === 'connections' ? connectionsTab() : t === 'routines' ? routinesTab() : skillList();
    return [head, tabPanel('ab-panel', t, ...body), end];
  }
  // How-tos I learned (by asking me to remember how, or on my own after a long task that worked). View opens the file;
  // Remove, like the other Abilities tabs (Forget is for what I remember about them).
  function skillList() {
    const k = state.skills ?? [];
    const { box, nav } = paged('skills', k, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.description }, x.name, el('small', { textContent: x.description })),
      el('span', { className: 'row-btns' },
        link('Открыть', () => act(`skill:view:${x.slug}`, true), { k: `skill:view:${x.slug}`, aria: `Открыть скилл ${x.name}` }),
        armed('Удалить', 'Точно?', `skill:forget:${x.slug}`, `skill:forget:${x.slug}`, `Удалить скилл ${x.name}`))),
    { label: 'Скиллы', empty: 'Пока нет скиллов. Скажите «запомни, как это делать» или импортируйте .md файл.' });
    let importBox = null;
    if (ui.skillMdOpen) {
      const ta = el('textarea', { className: 'jsonarea', placeholder: '---\nname: my-skill\ndescription: Когда использовать\n---\n\n1. Шаг первый...' });
      const fileIn = el('input', { type: 'file', accept: '.md,.markdown,.txt', hidden: true, on: { change: (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { ta.value = String(r.result ?? ''); ta.dataset.fname = f.name; };
        r.readAsText(f);
      } } });
      importBox = el('div', { className: 'jsonbox' }, fileIn, ta,
        el('div', { className: 'jsonbar' },
          btn('Выбрать .md', () => fileIn.click(), { k: 'skill-pick' }),
          btn('Сохранить скилл', () => {
            if (!ta.value.trim()) return ta.focus();
            send({ type: 'panel_skill_import', raw: ta.value, name: ta.dataset.fname || '' });
            ui.skillMdOpen = false;
          }, { kind: 'primary', k: 'skill-save' }),
          link('Закрыть', () => { ui.skillMdOpen = false; render(); }, { k: 'skill-close' })));
    }
    return { body: [el('div', { className: 'group paged' }, box), importBox],
      foot: foot(el('div', { className: 'jsonbar' },
        btn(ui.skillMdOpen ? 'Скрыть импорт' : 'Импорт .md', () => { ui.skillMdOpen = !ui.skillMdOpen; render(); }, { k: 'skill-import-toggle' }),
        link('Открыть папку', () => act('open_skills_dir'), { k: 'open-skills-dir' }),
        k.length ? el('span', { className: 'usage', textContent: `· ${k.length}` }) : null), nav) };
  }
  function factList() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Забыть', `forget:${x.id}`, `forget:${x.id}`, `Забыть: ${x.text}`))), { label: 'Что я помню', empty: q ? `Ничего не найдено по «${ui.q.trim()}».` : EMPTY, id: 'facts-box' });
    // Search once there's more than a page: it looks through all of them, and the pages follow the matches.
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Поиск по ${f.length} фактам`, 'aria-label': 'Поиск по памяти', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Забыть всё', `Удалить все ${f.length}`, 'forget-all', 'forgetall:yes', `Забыть все ${f.length} фактов из памяти`) : null, nav, 'facts-foot'),
    ];
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const { box, nav } = paged('commits', state.commitments, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Просрочено · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns icons' },
        iconArmed('tick', 'Готово', `done:${x.id}`, `done:${x.id}`, `Выполнено: ${x.text}`),
        iconArmed('x', 'Удалить', `drop:${x.id}`, `drop:${x.id}`, `Удалить: ${x.text}`))), { label: 'Обязательства' });
    const n = state.commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `Активных: ${n}` }) : null, nav)];
  }
  // A page arrow: the search field (if it has focus) is kept by redrawing only the list.
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or a voice service ('fish', 'gemini'). kinds: the kinds of key it takes
  // (Kimi and Xiaomi: a plan key or a pay-per-token key), picked above the field; onsave gets the kind's id.
  function keyForm(id, label, onsave, kinds = null) {
    const kind = kinds?.find((x) => x.id === ui.kind[id]) ?? kinds?.[0];
    const name = kind?.label ?? label;
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `Ключ ${name}`, 'aria-label': `API-ключ ${name}`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v, kind?.id); input.value = ''; closeKey(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } });
    const row = el('div', { className: 'keyform', hidden: ui.key !== id, 'data-anim': `key-${id}` }, el('span', { className: 'px field' }, input), btn('Сохранить', save, { k: `save:${id}` }));
    if (!kinds) return row;
    row.hidden = false; delete row.dataset.anim;
    return el('div', { className: 'keykinds', hidden: ui.key !== id, 'data-anim': `key-${id}` },
      picks(`Тип ключа ${label}`, kinds.map((x) => [x.id, x.label]), kind.id, (v) => { ui.kind[id] = v; render(`kind-${id}:${v}`); }, `kind-${id}`,
        Object.fromEntries(kinds.map((x) => [x.id, x.billing]))),
      row);
  }

  const signIn = (p) => link('Войти', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: `Войти в ${p.label}`, disabled: !!state.loggingIn });
  const connect = (s) => link('Подключить', () => act(`local:connect:${s.id}`), { k: `local:connect:${s.id}`, aria: `Подключить ${s.label}` });
  const addKey = (p) => link(ui.key === p.id ? 'Отмена' : 'Добавить ключ', () => toggleKey(p.id), { k: `addkey:${p.id}`, aria: `Добавить API-ключ ${p.label}` });

  // A connected account's key: replace it (saving under the same kind overwrites it), or add one next to a sign-in.
  const changeKey = (p) => link(ui.key === p.id ? 'Отмена' : p.keySaved ? 'Сменить ключ' : 'Добавить ключ', () => toggleKey(p.id),
    { k: `addkey:${p.id}`, aria: `${p.keySaved ? 'Сменить' : 'Добавить'} API-ключ ${p.label}` });

  // Settings, one page per concern.
  const SIZE_TIPS = { default: 'Полный размер.', small: 'В два раза меньше, занимает меньше места на экране.', cursor: 'Превращаюсь в маленький пиксельный указатель рядом с курсором.' };
  // The runnable models, one optgroup per signed-in provider, values 'provider:modelId'; `current` is the selected one ('' for none).
  // text: also the models that can't see images, in their own group per provider (subagents only).
  const modelOptgroups = (current, text = false) => state.providers.filter((p) => p.on).flatMap((p) => [
    el('optgroup', { label: p.label }, p.models.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === current }))),
    text && p.textModels?.length ? el('optgroup', { label: `${p.label} (только текст)` },
      p.textModels.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === current }))) : null,
  ].filter(Boolean));
  // The model a 'provider:modelId' names (undefined when it isn't listed), and its display name (the raw id when it isn't).
  const findModel = (v) => {
    const i = v.indexOf(':');
    const p = i < 0 ? null : state.providers.find((x) => x.id === v.slice(0, i)), id = v.slice(i + 1);
    return p ? p.models.find((x) => x.id === id) ?? p.textModels?.find((x) => x.id === id) : undefined;
  };
  const modelName = (v) => findModel(v)?.name ?? v;
  // A model select with a first option `first` (value ''), for the value `current`; onpick gets the select element.
  const modelSelect = (aria, k, current, first, onpick, text = false) => el('span', { className: 'px field select' },
    el('select', { 'aria-label': aria, 'data-k': k, on: { change: (e) => onpick(e.target) } },
      el('option', { value: '', textContent: first, selected: !current }),
      modelOptgroups(current, text)));
  // Effort: how hard a model thinks before it answers. A model's `levels` are the thinking levels it supports (none: it
  // can't think). The stops are Off, then those levels; the automatic value ('') starts at the app default, 'low'.
  const EFFORT_NAMES = { off: 'Выкл', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Макс', ultra: 'Ультра' };
  const EFFORT_HINT = 'Выше — умнее, но медленнее.';
  const effortStops = (m) => (m?.levels?.length ? ['off', ...m.levels.filter((x) => x !== 'off')] : null);
  // Where a slider starts: the slot's level when its model has it, else low, else the model's lowest level.
  const effortStart = (stops, v) => stops.indexOf(stops.includes(v) ? v : stops.includes('low') ? 'low' : stops[1]);
  const effortHint = () => el('p', { className: 'why wrap effort-hint', textContent: EFFORT_HINT });
  // The Effort slider for a slot ('default', a job kind, 'backup1' or 'backup2') running `value` ('provider:modelId').
  // Nothing when no model is chosen; a note when the model can't think. hint: show the explanation under it.
  function effortRow(slot, value, hint = false) {
    const m = findModel(value);
    if (!m) return null;
    const stops = effortStops(m);
    if (!stops) return el('p', { className: 'effort-none', textContent: 'Эта модель не поддерживает размышление.' });
    const ticks = el('div', { className: 'effort-ticks', 'aria-hidden': 'true' }, stops.map((s, i) => { const t = el('span', { textContent: EFFORT_NAMES[s] ?? s }); t.style.setProperty('--i', i); return t; }));
    ticks.style.setProperty('--n', stops.length);
    // Moving the thumb (input) highlights its stop; letting go (change) sends it.
    const show = (i) => {
      range.style.setProperty('--p', i / (stops.length - 1));
      range.setAttribute('aria-valuetext', EFFORT_NAMES[stops[i]] ?? stops[i]);
      [...ticks.children].forEach((t, j) => t.classList.toggle('on', j === i));
    };
    const range = el('input', {
      type: 'range', className: 'effort-range', min: 0, max: stops.length - 1, step: 1, value: effortStart(stops, state.efforts?.[slot] ?? ''),
      'data-k': `effort_${slot}`, 'aria-label': `Глубина размышления для ${m.name}`,
      on: { input: (e) => show(Number(e.target.value)), change: (e) => act(`effort_${slot}:${stops[Number(e.target.value)]}`) },
    });
    show(Number(range.value));
    return el('div', { className: 'effort' }, el('p', { className: 'sub', textContent: 'Размышление' }), range, ticks, hint ? effortHint() : null);
  }
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? el('span', { className: 'px field select' },
      el('select', { 'aria-label': 'Модель', 'data-k': 'model', on: { change: (e) => act(`model:${e.target.value}`) } },
        model ? null : el('option', { value: '', textContent: 'Выберите модель', disabled: true, selected: true }),
        modelOptgroups(model))) : null;
    // The accounts, then each local server (Ollama, LM Studio, the ones added) and the Add a server row.
    const servers = state.localServers ?? [];
    if (ui.addSent != null && servers.length > ui.addSent) { ui.addSent = null; ui.add = { label: '', url: '', key: '', images: false }; if (ui.key === ADD) ui.key = null; }
    const accounts = [...state.providers.filter((p) => p.id !== 'local' && (p.on || p.method)), ...servers.map((x) => ({ ...x, server: true })), { id: ADD, add: true }];
    const { box, nav } = paged('accounts', accounts, (p) => (p.add ? addServerRow() : p.server ? serverRow(p) : el('li', { className: `acct${ui.key === p.id ? ' open' : ''}` },
      el('div', { className: 'setting' },
        // Connected: a lit dot by the name, its word in a tooltip (and for screen readers).
        el('span', { className: 'acct-name' }, p.label, p.on ? el('span', { className: 'led on', role: 'img', 'aria-label': p.method === 'local' ? 'Подключено' : 'Вход выполнен', 'data-tip': p.method === 'local' ? 'Подключено' : 'Вход выполнен' }) : null),
        p.on ? el('span', { className: 'row-btns' },
          p.key ? changeKey(p) : null,
          ui.key === p.id ? null : armed(p.signedIn && !p.keySaved ? 'Выйти' : 'Удалить', 'Точно?', `signout:${p.id}`, `signout:${p.id}`, `Удалить ${p.label} из Roamies`))
          : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Вход…' })
          : p.method === 'oauth' ? (p.key ? el('span', { className: 'links' }, signIn(p), addKey(p)) : signIn(p))
          : addKey(p)),
      p.method === 'key' || p.key ? keyForm(p.id, p.label, (key, kind) => send({ type: 'panel_key', provider: p.id, kind, key }), p.kinds) : null)),
    { label: 'Аккаунты', pin: accounts.findIndex((p) => p.id === ui.key) });
    // Tabs, so each part fits the window: the model you talk to, hybrid models, subagents, backups and the accounts. The
    // middle three need a signed-in account; with none, the page opens on Accounts.
    const hybrid = hybridGroup(), crew = subagentGroup(), backups = fallbackGroup();
    const tabs = [['default', 'Основная'], hybrid ? ['hybrid', 'Гибрид'] : null, crew ? ['crew', 'Субагенты'] : null, backups ? ['backups', 'Резерв'] : null, ['accounts', 'Аккаунты']].filter(Boolean);
    const t = pageTab('model', tabs, on.length ? 'default' : 'accounts');
    const head = el('div', { className: 'mhead' }, tabRow('Модель', 'model-panel', tabs, t, (id) => { ui.tabs.model = id; }));
    if (t === 'accounts') return [head, tabPanel('model-panel', t, el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('p', { textContent: 'Войдите, чтобы использовать модели.' })), box)), foot(null, nav)];
    return [head, tabPanel('model-panel', t, ...(t === 'hybrid' ? [hybrid] : t === 'crew' ? [crew] : t === 'backups' ? [backups] : [group(null, 'Какой ИИ вам отвечает.', null,
      select ?? el('p', { className: 'empty', textContent: 'Сначала войдите во вкладке «Аккаунты».' }),
      effortRow('default', model, true),
      toggle('Облегчённый режим', 'Для маленьких или локальных моделей. Меньше функций.', state.lite, () => act('lite'), 'lite'))]))];
  }
  // Hybrid models: a fast default for chatting, and the jobs that switch to a model picked here, then back. Shown once
  // an account is signed in. Each job's value is '' (the default model) or 'provider:modelId'.
  function hybridGroup() {
    const h = state.hybrid;
    if (!h || !state.providers.some((p) => p.on)) return null;
    // The master switch: off leaves only the title, description and switch; on shows the job rows as well.
    const on = !!h.on;
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'Отдельная модель для каждого типа задач.' }),
        on && h.active ? el('p', { className: 'why', role: 'status', textContent: `Сейчас используется ${modelName(h.active)}` }) : null),
      toggle('Гибридные модели', 'Или просто скажите: «используй Opus для этого».', on, () => act('hybrid'), 'hybrid'),
      on ? el('div', { className: 'setting' },
        el('span', { id: 'lbl-heavyall' }, 'Назначить для всех'),
        modelSelect('Назначить для всех', 'heavyall', '', 'Выбрать…', (sel) => { if (sel.value) { act(`heavyall:${sel.value}`); sel.value = ''; } })) : null,
      on ? h.jobs.map((j) => el('div', { className: 'slot' },
        el('div', { className: 'setting' },
          el('span', { id: `lbl-heavy-${j.kind}` }, j.label),
          modelSelect(`Модель для ${j.label}`, `heavy_${j.kind}`, j.value, 'Основная модель', (sel) => act(`heavy_${j.kind}:${sel.value}`))),
        j.value ? effortRow(j.kind, j.value) : null)) : null);
  }
  // If a limit is reached: up to two backup models, tried in order when a model hits its limit. Shown once an account
  // is signed in. state.fallbacks.slots are the first and second backup ('' or 'provider:modelId').
  function fallbackGroup() {
    const f = state.fallbacks;
    if (!f || !state.providers.some((p) => p.on)) return null;
    // The master switch: off leaves only the title, description and switch; on shows the backups and their status.
    const on = !!f.on;
    const slots = f.slots ?? ['', ''];
    const limits = (f.limited ?? []).map((x) => el('p', { className: 'why', role: 'status', textContent: x.until
      ? `${x.label} на лимите до ${new Date(x.until).toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' })}`
      : `${x.label} на лимите; скоро попробую снова` }));
    const chain = state.model && slots.some(Boolean) ? `Порядок: ${[state.model.name, ...slots.filter(Boolean).map(modelName)].join(' → ')}` : null;
    const row = (i, label) => el('div', { className: 'slot' },
      el('div', { className: 'setting' },
        el('span', { id: `lbl-fallback-${i}` }, label),
        modelSelect(label, `fallback_${i}`, slots[i - 1] ?? '', 'Нет', (sel) => act(`fallback_${i}:${sel.value}`))),
      slots[i - 1] ? effortRow(`backup${i}`, slots[i - 1]) : null);
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'До двух моделей, по очереди.' }),
        on ? limits : null,
        on && f.using ? el('p', { className: 'why', role: 'status', textContent: `Сейчас используется ${modelName(f.using)}` }) : null),
      toggle('Резервные модели', 'Переключаться при достижении лимита.', on, () => act('backups'), 'backups'),
      on ? row(1, 'Первый резерв') : null,
      on ? row(2, 'Второй резерв') : null,
      on && chain ? el('p', { className: 'why wrap', textContent: chain }) : null);
  }
  // Subagents: specialists the chat hands background work to. Each runs on the model picked here; one with no model
  // follows the model hybrid models set for its kind of job (when those are on), else it is not on the crew.
  function subagentGroup() {
    const sa = state.subagents;
    if (!sa || !state.providers.some((p) => p.on)) return null;
    const on = !!sa.on, hybridOn = !!(state.hybrid && state.hybrid.on);
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'Специалисты для фоновых задач.' })),
      toggle('Субагенты', 'До трёх одновременно. Отчитываются по готовности.', on, () => act('subagents'), 'subagents'),
      on ? el('div', { className: 'setting' },
        el('span', { id: 'lbl-delegate' }, 'Передача задач'),
        picks('Передача задач', [['ask', 'По запросу'], ['auto', 'И самостоятельно']], sa.delegate ?? 'ask', (x) => act(`delegate_${x}`), 'delegate')) : null,
      on ? el('p', { className: 'why wrap', textContent: sa.delegate === 'auto' ? 'Я сам буду делегировать долгие задачи.' : 'Только когда вы попросите агента.' }) : null,
      on ? sa.crew.map((c) => el('div', { className: 'slot' },
        el('div', { className: 'setting' },
          el('span', { id: `lbl-crew-${c.id}` }, c.label, el('small', { className: 'wrap', textContent: c.via === 'hybrid' ? `${c.hint} Использует ${modelName(c.uses)}.` : c.hint })),
          modelSelect(`Модель для ${c.label}`, `crew_${c.id}`, c.value, hybridOn ? 'Как в гибриде' : 'Выкл', (sel) => act(`crew_${c.id}:${sel.value}`), true)),
        c.value ? effortRow(`sub_${c.id}`, c.value) : null)) : null);
  }
  // A local server: connected (a lit dot) or not, its address if it was added, and why its models aren't in the
  // Model menu (not running, or none can see images). Ollama and LM Studio disconnect; added ones are removed.
  function serverRow(x) {
    const remove = armed(x.custom ? 'Удалить' : 'Отключить', 'Точно?', `local:remove:${x.id}`, `local:remove:${x.id}`, `${x.custom ? 'Удалить' : 'Отключить'} ${x.label}`);
    return el('li', { className: 'acct' },
      el('div', { className: 'setting' },
        // An added server's address is in its name's tooltip, so every row stays one line.
        el('span', { className: 'acct-name' }, el('span', { className: 'acct-label', 'data-tip': x.baseUrl ?? null, tabIndex: x.baseUrl ? 0 : null, 'aria-describedby': x.baseUrl ? `addr-${x.id}` : null }, x.label, x.baseUrl ? el('span', { className: 'sr-only', id: `addr-${x.id}`, textContent: x.baseUrl }) : null),
          x.on ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Подключено', 'data-tip': 'Подключено' }) : null),
        el('span', { className: 'row-btns' }, x.on ? remove : x.custom ? el('span', { className: 'links' }, connect(x), remove) : connect(x))),
      x.note ? el('p', { className: 'empty note', textContent: x.note }) : null);
  }
  // Any other OpenAI-compatible server (llama.cpp, vLLM, oMLX…): a name, its address, a key if it needs one, and
  // whether its models can see images (most servers don't say). Saved once it answers; the sidecar says if it didn't.
  const ADD = 'local-add';
  function addServerRow() {
    const a = ui.add, open = ui.key === ADD;
    const field = (id, prop, label, o = {}) => el('span', { className: 'px field' }, el('input', {
      id, value: a[prop], 'aria-label': label, placeholder: o.placeholder ?? label, type: o.type ?? 'text', autocomplete: 'off', spellcheck: false, maxLength: o.max ?? 200,
      on: { input: (e) => { a[prop] = e.target.value; }, keydown: (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } } } }));
    const save = () => {
      const label = a.label.trim(), url = a.url.trim();
      if (!label) return $(`${ADD}-name`)?.focus() ?? $(`key-${ADD}`)?.focus();
      if (!url) return $(`${ADD}-url`)?.focus();
      ui.addSent = (state.localServers ?? []).length;
      send({ type: 'panel_local_add', label, baseUrl: url, key: a.key.trim(), images: a.images });
    };
    return el('li', { className: `acct${open ? ' open' : ''}` },
      el('div', { className: 'setting' },
        el('span', { className: 'acct-label', 'data-tip': 'llama.cpp, vLLM, oMLX или любой OpenAI-совместимый сервер.' }, 'Другой сервер'),
        el('span', { className: 'row-btns' }, link(open ? 'Отмена' : 'Добавить сервер', () => toggleKey(ADD), { k: `addkey:${ADD}`, aria: open ? 'Отменить добавление сервера' : 'Добавить сервер' }))),
      open ? el('div', { className: 'addserver', 'data-anim': `key-${ADD}` },
        el('div', { className: 'keyform' }, field(`key-${ADD}`, 'label', 'Название сервера', { placeholder: 'Название', max: 40 }), field(`${ADD}-url`, 'url', 'Адрес сервера', { placeholder: 'http://127.0.0.1:8080', max: 500 })),
        el('div', { className: 'keyform' }, field(`${ADD}-key`, 'key', 'API-ключ (необязательно)', { type: 'password', max: 1000 }), btn('Сохранить', save, { k: `save:${ADD}` })),
        toggle('Модели видят изображения', 'Большинство серверов не сообщают об этом сами.', a.images, () => { a.images = !a.images; render(`img:${ADD}`); }, `img:${ADD}`)) : null);
  }
  function appearancePage() {
    const tabs = [['look', 'Облик'], ['size', 'Размер']], t = pageTab('appearance', tabs);
    const head = el('div', { className: 'mhead' }, tabRow('Внешний вид', 'look-panel', tabs, t, (id) => { ui.tabs.appearance = id; }));
    return [head, tabPanel('look-panel', t, t === 'look'
      ? group(null, 'У каждого облика своё имя и голос.', null, lookTiles())
      : group(null, 'Насколько я большой на экране.', null, picks('Размер', state.sizes, state.size, (x) => act(`size:${x}`), 'size', SIZE_TIPS)))];
  }
  // The looks as live tiles: each one's character, playing, at the size picked below. Kept between renders (a state update mustn't restart
  // them); hovering or focusing one makes it wave; picking it makes it cheer.
  const tiles = new Map();
  function lookTiles() {
    const g = tiles.get('_group') ?? el('div', { className: 'looks', role: 'radiogroup', 'aria-label': 'Look' });
    tiles.set('_group', g);
    g.replaceChildren(...state.looks.map(([id, name]) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = el('canvas', { 'aria-hidden': 'true' });
        const b = el('button', { className: 'px looktile', type: 'button', role: 'radio', 'data-k': `look:${id}` }, cv, el('span', { className: 'name', textContent: name }));
        const r = liveRoamie(cv, 104, 76, { look: id, y: 0.55, form: state.size });
        t = { b, r, waved: 0 };
        const wave = () => { if (r && Date.now() - t.waved > 3500) { t.waved = Date.now(); r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => { if (state.look !== id) { r?.act('hype'); act(`look:${id}`); } });
        tiles.set(id, t);
        r?.appear('crt');
      }
      t.r?.setForm(state.size);
      const on = state.look === id;
      t.b.setAttribute('aria-checked', String(on)); t.b.tabIndex = on ? 0 : -1;
      t.b.dataset.tip = on ? `Сейчас я ${name}.` : `Переключиться на ${name} со своим голосом.`;
      return t.b;
    }));
    return g;
  }
  // VoiceStudio on this computer: whether it's ready (or exactly why not), its engine, the voice, and Check again.
  function studioRows() {
    const vs = state.studio ?? { checking: true };
    const status = vs.checking ? 'Проверка VoiceStudio…' : vs.ok ? `Подключено${vs.engine ? ` · ${vs.engine}` : ''}` : vs.message || 'VoiceStudio недоступен.';
    const voices = vs.voices ?? [];
    return [
      el('div', { className: 'setting' },
        el('span', {}, 'VoiceStudio', el('small', { className: vs.ok || vs.checking ? '' : 'bad', textContent: status, role: vs.ok || vs.checking ? null : 'alert' })),
        el('span', { className: 'row-btns' }, link('Проверить', () => act('voicestudio_check'), { k: 'voicestudio_check', aria: 'Проверить VoiceStudio ещё раз' }))),
      vs.ok ? el('div', { className: 'reveal', 'data-anim': 'studio-voice' },
        el('p', { className: 'sub', textContent: `Голос для ${state.name}` }),
        el('span', { className: 'px field select' },
          el('select', { 'aria-label': 'Голос VoiceStudio', 'data-k': 'studiovoice', on: { change: (e) => act(`studiovoice:${e.target.value}`) } },
            el('option', { value: 'default', textContent: 'По умолчанию', selected: !vs.voice || !voices.some((x) => x.id === vs.voice) }),
            voices.map((x) => el('option', { value: x.id, textContent: x.name, selected: x.id === vs.voice })))),
        voices.length ? null : el('p', { className: 'why', textContent: 'Сохраните голос в VoiceStudio (клон или дизайн), чтобы выбрать его здесь.' }),
      ) : null,
    ];
  }
  const TTS_NAMES = { fish: 'Fish Audio', gemini: 'Gemini', voicestudio: 'VoiceStudio' };
  // How loud I am: my voice and my sounds together (#136). Moving it shows the level; letting go saves it.
  function volumeRow() {
    const said = el('p', { className: 'why', 'aria-hidden': 'true' });
    const show = (n) => {
      const t = n === 0 ? 'Без звука' : `${n}%`;
      range.style.setProperty('--p', n / 100);
      range.setAttribute('aria-valuetext', t);
      said.textContent = t;
    };
    const range = el('input', {
      type: 'range', className: 'effort-range', min: 0, max: 100, step: 5, value: state.volume ?? 100, 'data-k': 'volume', 'aria-label': 'Громкость',
      on: { input: (e) => show(Number(e.target.value)), change: (e) => act(`volume:${e.target.value}`) },
    });
    show(Number(range.value));
    return el('div', { className: 'effort' }, el('p', { className: 'sub', textContent: 'Громкость' }), range, said);
  }
  function speakingPage() {
    // The service that speaks, each with its own key: Fish Audio's voice is the look's and it has models to pick
    // from; Gemini has a list of voices and two models; VoiceStudio runs on this computer and needs no key.
    const tts = TTS_NAMES[state.tts] ? state.tts : 'fish', T = TTS_NAMES[tts], local = tts === 'voicestudio', hasKey = local || !!state[`${tts}Key`];
    // Gemini can speak with the key the AI already has (the Model page), until the voice gets one of its own.
    const shared = tts === 'gemini' && hasKey && !!state.geminiShared;
    return [
      group('Голосовые ответы', 'Слушать ответы, а не только читать.', null,
        picks('Ответы', [['text', 'Только текст'], ['voice', 'Голос и текст']], state.replies, (x) => {
          if (x === 'voice' && !hasKey) { ui.key = tts; render(`key-${tts}`); note(`Добавьте ключ ${T}, чтобы слышать меня.`); return; }
          act(`replies:${x}`);
        }, 'replies', { text: 'Отвечаю только текстом.', voice: `Озвучиваю ответы голосом ниже${hasKey ? '' : `. Нужен ключ ${T}`}.` }),
        volumeRow(),
        el('p', { className: 'sub', textContent: 'Провайдер голоса' }),
        picks('Провайдер голоса', Object.entries(TTS_NAMES), tts, (x) => {
          if (x !== 'voicestudio' && !state[`${x}Key`]) { ui.key = x; note(`Добавьте ключ ${TTS_NAMES[x]}, чтобы слышать меня.`); } // its key field opens with it
          act(`tts:${x}`);
        }, 'tts', { fish: 'Свой голос для каждого облика, с живыми эмоциями. Списывается с аккаунта Fish Audio.', gemini: 'Голоса Google: 30 вариантов на выбор. Списывается с аккаунта Google AI Studio.', voicestudio: 'Бесплатный VoiceStudio на этом компьютере. Ничего не уходит в сеть.' }),
        local ? el('div', { className: 'reveal', 'data-anim': 'studio' }, studioRows()) : null,
        local ? el('div', { className: 'reveal', 'data-anim': 'studio-speak' },
          el('p', { className: 'sub', textContent: 'Сколько озвучивать' }),
          picks('Сколько озвучивать', [['short', 'Кратко'], ['medium', 'Средне'], ['full', 'Всё']], state.voice?.studioSpeak ?? 'short', (x) => act(`studiospeak_${x}`), 'studiospeak'),
          el('p', { className: 'why wrap', textContent: 'VoiceStudio работает медленнее. Полный ответ всегда виден текстом.' })) : null,
        tts === 'gemini' && hasKey && state.geminiVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-voice' },
          el('p', { className: 'sub', textContent: `Голос для ${state.name}` }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Голос Gemini', 'data-k': 'geminivoice', on: { change: (e) => act(`geminivoice:${e.target.value}`) } },
              state.geminiVoices.map((g) => el('option', { value: g.id, textContent: `${g.id} · ${g.style}`, selected: g.id === state.geminiVoice })))),
        ) : null,
        tts === 'gemini' && hasKey && state.geminiModels?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-model' },
          el('p', { className: 'sub', textContent: 'Модель голоса' }),
          picks('Модель голоса', state.geminiModels.map((c) => [c.id, c.name]), state.geminiModel, (x) => act(`geminimodel:${x}`), 'geminimodel',
            Object.fromEntries(state.geminiModels.map((c) => [c.id, `${GEMINI_WHY_LONG[c.id] ?? ''} ${geminiPrice(c)}`.trim()]))),
          el('p', { className: 'why', textContent: GEMINI_WHY[state.geminiModel] ?? '' }),
        ) : null,
        tts === 'fish' && state.replies === 'voice' && state.fishModels?.length ? el('div', { className: 'reveal', 'data-anim': 'fish-model' },
          el('p', { className: 'sub', textContent: 'Модель голоса' }),
          picks('Модель голоса', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
          el('p', { className: `why${state.fishFree ? ' late' : ''}`, textContent: state.fishFree ? 'Баланс закончился, используется бесплатный тариф Fish' : WHY[state.fishModel] ?? '' }),
        ) : null,
        local ? null : el('div', { className: 'setting' },
          el('span', {}, `Ключ ${T}`, el('small', { textContent: shared ? 'Общий с вкладкой «Модель»' : hasKey ? `Сохранён в ${where()}` : 'Нужен для голосовых ответов' })),
          el('span', { className: 'row-btns' },
            link(ui.key === tts ? 'Отмена' : shared ? 'Свой ключ' : hasKey ? 'Сменить' : 'Добавить', () => toggleKey(tts), { k: `addkey:${tts}`, aria: hasKey ? `Сменить ключ ${T}` : `Добавить ключ ${T}` }),
            hasKey && !shared && ui.key !== tts ? armed('Удалить', 'Точно?', `${tts}key-remove`, `${tts}key_remove`, `Удалить ключ ${T}`) : null)),
        local ? null : keyForm(tts, T, (key) => send({ type: `panel_${tts}key`, key }))),
    ];
  }
  // Which mic I listen on (from #59, by overspend1): automatic (the system's default, or on a Mac the built-in mic while
  // that's a Bluetooth headset, which would drop to call-quality sound), or one picked here, kept while it's unplugged.
  function micPicker(v) {
    if (!v.mics?.length) return null;
    const gone = v.mic && !v.mics.some((m) => m.id === v.mic);
    return el('div', { className: 'reveal', 'data-anim': 'mic' },
      el('p', { className: 'sub', textContent: 'Микрофон' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Микрофон', 'data-k': 'mic', on: { change: (e) => act(`mic:${e.target.value}`) } },
          el('option', { value: '', textContent: v.micAuto ? `Авто (${v.micAuto})` : 'Авто', selected: !v.mic }),
          v.mics.map((m) => el('option', { value: m.id, textContent: m.name, selected: m.id === v.mic })),
          gone ? el('option', { value: v.mic, textContent: 'Выбранный микрофон (отключён, используется авто)', selected: true }) : null)));
  }
  // The language I listen for (macOS). 'auto' follows the Mac's own languages; a locale id names one. langOnline: true when
  // Apple's servers recognise it (the audio leaves this Mac); null when unknown, which is what Arabic and Hebrew do today.
  const SPEAK_LANGS = [['auto', 'Авто (языки macOS)'], ['en-US', 'English'], ['ru-RU', 'Русский'], ['ar-SA', 'العربية · Arabic'], ['he-IL', 'עברית · Hebrew'],
    ['es-ES', 'Español · Spanish'], ['fr-FR', 'Français · French'], ['de-DE', 'Deutsch · German'], ['it-IT', 'Italiano · Italian'],
    ['pt-BR', 'Português · Portuguese'], ['ja-JP', '日本語 · Japanese'], ['ko-KR', '한국어 · Korean'], ['zh-CN', '中文 · Chinese'], ['hi-IN', 'हिन्दी · Hindi']];
  const SPEAK_ONLINE = 'Этот язык распознаётся на серверах Apple. Добавьте его в Диктовке в Системных настройках, чтобы он работал локально.';
  // The Speak in select, shown on a Mac while voice control is on, with the online hint under it when it applies.
  function speakPicker(v) {
    const lang = v.lang ?? 'auto';
    const online = v.langOnline === true || (['ar-SA', 'he-IL'].includes(lang) && v.langOnline == null);
    return el('div', { className: 'reveal', 'data-anim': 'speakin' },
      el('p', { className: 'sub', textContent: 'Язык речи' }),
      el('p', { className: 'why wrap', textContent: 'На каком языке вы со мной говорите.' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Язык речи', 'data-k': 'speechlang', on: { change: (e) => act(`speechlang:${e.target.value}`) } },
          SPEAK_LANGS.map(([code, label]) => el('option', { value: code, textContent: label, dir: 'auto', selected: code === lang })))),
      online ? el('p', { className: 'why wrap', role: 'status', textContent: SPEAK_ONLINE }) : null);
  }
  // Wayland: the commands to bind to keys in the desktop's settings (no app may hold its own shortcuts there).
  // A command shows only after copying it failed, so it can be copied by hand.
  const BIND_ROWS = [['talk', 'Поговорить'], ['summon', 'Показать или скрыть'], ['ask', 'Спросить'], ['list', 'Ваш список'], ['panel', 'Эта панель']];
  // Talking to me, and when the mic opens without a key.
  function listeningPage() {
    const v = state.voice;
    if (!v) return [group('Слух', 'Голосовой ввод недоступен на этом компьютере.', null)];
    const needs = (hint) => (v.on ? hint : 'Требуется включить голосовое управление');
    const tabs = [['talking', 'Разговор'], ['handsfree', 'Без рук']], t = pageTab('listening', tabs);
    const head = el('div', { className: 'mhead' }, tabRow('Слух', 'listen-panel', tabs, t, (id) => { ui.tabs.listening = id; }));
    return [head, tabPanel('listen-panel', t, t === 'talking'
      ? group(null, 'Говорите вместо набора текста.', null,
        toggle('Голосовое управление', v.download
          ? (v.download.status === 'downloading' ? `Скачивание голосовой модели… ${v.download.pct}%` : v.download.status === 'error' ? 'Ошибка загрузки' : `Нужно скачать ${v.download.size}`)
          : v.keys ? `Зажмите ${v.keys}, чтобы говорить` : 'Нажмите клавишу разговора', v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Повторить загрузку' : `Скачать (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        micPicker(v),
        v.mac ? toggle('Приглушать звук Mac во время речи', 'Остальные звуки замолкают, пока вы говорите', v.mute, () => act('mutetalk'), 'mutetalk') : null,
        v.mac && v.on ? speakPicker(v) : null)
      : group(null, 'Когда микрофон включается без клавиш.', null,
        toggle('Авто-прослушивание', needs(v.listenEvery ? 'Микрофон открывается после каждого ответа.' : 'Микрофон открывается, когда я задаю вопрос.'), v.autoListen, () => act('autolisten'), 'autolisten'),
        v.autoListen && v.listenChoices ? el('div', { className: 'reveal', 'data-anim': 'listen-more' },
          toggle('После каждого ответа', needs('Не только после вопросов, чтобы продолжать диалог.'), v.listenEvery, () => act('listenevery'), 'listenevery'),
          el('p', { className: 'sub', textContent: 'Ожидание микрофона' }),
          picks('Ожидание микрофона', v.listenChoices.map((s) => [String(s), `${s} с`]), String(v.listenSecs), (x) => act(`listensecs:${x}`), 'listensecs')) : null,
        toggle('Слушать после напоминаний', needs('Микрофон открывается после напоминания — можно сказать «отложи на 10 минут».'), v.snoozeListen, () => act('snoozelisten'), 'snoozelisten'),
        v.wake ? toggle('Кодовое слово', needs(`Скажите «Hey ${v.wakeName || 'Roamies'}», чтобы начать. Микрофон остаётся включённым.`), v.wakeWord, () => act('wakeword'), 'wakeword') : null,
        v.wake ? el('div', { className: 'setting' }, el('span', {}, 'Имя активации', el('small', { textContent: `Hey ${v.wakeName || 'Roamies'}` })),
          link('Изменить', () => act('wakename'), { k: 'wakename', aria: 'Изменить имя активации' })) : null))];
  }
  // The keys that work from anywhere. On Wayland no app may hold its own, so it lists the commands to bind instead.
  const SHORTCUT_LABELS = { summon: 'Показать или скрыть', snap: 'Спросить про область', list: 'Ваш список' };
  function shortcutsPage() {
    const b = state.bind, sc = state.shortcuts, w = state.writeKeys;
    if (b) {
      return [group('Клавиши', 'Назначьте эти команды в системных настройках клавиатуры на любые клавиши.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Копировать', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Скопировать команду для «${label}»` }))))];
    }
    if (!sc) return [group('Клавиши', 'Этот компьютер не поддерживает глобальные горячие клавиши.', null)];
    return [
      sc.talk ? group('Разговор', 'Зажмите две клавиши, чтобы говорить. Короткое нажатие — режим без рук.', null,
        picks('Клавиши разговора', sc.talk.pairs, sc.talk.value, (x) => act(`talk:${x}`), 'talk',
          Object.fromEntries(sc.talk.pairs.map(([id, keys]) => [id, `Зажмите ${keys}, чтобы говорить. Если они совпадают с клавишами ввода, они поменяются местами.`])))) : null,
      w ? group('Ввод текстом', 'Нажмите две клавиши вместе, чтобы открыть поле ввода у курсора.', null,
        picks('Клавиши ввода текста', [...w.pairs, ['off', 'Выкл']], w.value, (x) => act(`write:${x}`), 'write',
          Object.fromEntries([...w.pairs.map(([id, keys]) => [id, `Нажмите ${keys} вместе где угодно, чтобы написать мне.`]),
            ['off', 'Поле ввода не открывается по клавишам, они свободны для других программ. Кнопка «Спросить» на Главной остаётся.']]))) : null,
      group('Другие клавиши', 'Нажмите «Изменить», затем новую комбинацию. Esc — отмена.', null,
        sc.keys.map(({ id, words }) => {
          const rec = ui.rec === id, label = SHORTCUT_LABELS[id] ?? id;
          return el('div', { className: `setting${rec ? ' recording' : ''}` },
            el('span', {}, label, el('small', { textContent: rec ? 'Нажмите новые клавиши…' : words, 'aria-live': rec ? 'polite' : null })),
            link(rec ? 'Отмена' : 'Изменить', () => { ui.rec = rec ? null : id; render(`rec-${id}`); }, { k: `rec-${id}`, aria: rec ? `Отменить смену клавиш для «${label}»` : `Изменить клавиши для «${label}»` }));
        })),
    ];
  }
  // Things I do on my own through the day.
  function routinesTab() {
    const f = state.focus;
    return { body: [
      group(null, 'То, что я делаю сам в течение дня.', null,
        state.brief ? toggle('Утренняя сводка', 'При первом разговоре за день я начинаю со списка дел на сегодня.', state.brief.on, () => act('morningbrief'), 'morningbrief') : null,
        f ? el('div', { className: 'setting' },
          el('span', {}, f.until ? 'Режим фокуса активен' : 'Отвлекающие факторы',
            el('small', { className: 'wrap', textContent: f.until ? `До ${new Date(f.until).toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' })}${f.task ? ` · ${f.task}` : ''}` : `Скажите «фокус на 30 минут». Слежу за: ${f.list.slice(0, 4).join(', ')}${f.list.length > 4 ? '…' : ''}` })),
          f.until ? link('Стоп', () => act('focusstop'), { k: 'focusstop', aria: 'Остановить режим фокуса' }) : link('Изменить', () => act('distractions'), { k: 'distractions', aria: 'Изменить список отвлекающих приложений' })) : null),
      jobGroup(),
    ] };
  }
  // Work an agent does at set times. They're made by asking (schedule_job); here they're run, paused or removed.
  function jobGroup() {
    const jobs = state.jobs ?? [];
    return group('Расписание задач', 'Задачи, которые агент выполняет по расписанию. Попросите меня запланировать.', jobs.length || null,
      jobs.length ? el('ul', { className: 'list', 'aria-label': 'Расписание задач' }, jobs.map((j) => el('li', { className: 'item mem' },
        el('span', { className: 'text', dir: 'auto', title: j.title }, j.title,
          el('small', { textContent: `${j.next}${j.repeat ? ` · ↻ ${j.repeat}` : ''}` }),
          j.last ? el('small', { className: j.bad ? 'late' : '', textContent: j.last, title: j.last }) : null),
        el('span', { className: 'row-btns' },
          link('Запустить', () => act(`job:run:${j.id}`), { k: `job:run:${j.id}`, aria: `Запустить ${j.title} сейчас` }),
          link(j.paused ? 'Продолжить' : 'Пауза', () => act(`job:${j.paused ? 'resume' : 'pause'}:${j.id}`), { k: `job:pause:${j.id}`, aria: `${j.paused ? 'Продолжить' : 'Приостановить'} ${j.title}` }),
          armed('Удалить', 'Точно?', `job:remove:${j.id}`, `job:remove:${j.id}`, `Удалить ${j.title}`))))) : el('p', { className: 'empty', textContent: 'Запланированных задач пока нет.' }));
  }
  // Apps and services I use through their MCP servers. They're added by asking me (I find the server, ask before
  // connecting, and take any key in the chat input); here they're switched off, signed in to or removed.
  const CONN_STATE = { connected: (x) => `Подключено · инстр.: ${x.toolCount}`, 'needs-login': () => 'Нужен вход', 'needs-key': (x) => `Нужен ключ${x.error ? ` (${x.error.replace(/^needs /, '')})` : ''}`,
    error: (x) => `Ошибка: ${x.error ?? 'нет ответа'}`, off: () => 'Выкл', connecting: () => 'Подключение…', idle: () => 'Не подключено' };
  function connectionsTab() {
    const list = state.connections ?? [];
    const { box, nav } = paged('connections', list, (x) => {
      const bad = x.state === 'error' || x.state === 'needs-key' || x.state === 'needs-login';
      return el('li', { className: 'acct' }, el('div', { className: 'setting' },
        el('span', { id: `lbl-mcp-${x.name}` }, el('span', { className: 'acct-name' }, x.name, x.state === 'connected' ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Подключено', 'data-tip': 'Подключено' }) : null),
          el('small', { className: bad ? 'late' : '', textContent: (CONN_STATE[x.state] ?? CONN_STATE.idle)(x), title: x.where })),
        el('span', { className: 'row-btns' },
          x.state === 'needs-login' ? link('Войти', () => act(`mcp:login:${x.name}`, true), { k: `mcp:login:${x.name}`, aria: `Войти в ${x.name}` }) : null,
          armed('Удалить', 'Точно?', `mcp:remove:${x.name}`, `mcp:remove:${x.name}`, `Удалить подключение ${x.name} и его ключи`),
          el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!x.enabled), 'aria-labelledby': `lbl-mcp-${x.name}`, 'data-k': `mcp:sw:${x.name}`,
            on: { click: () => act(`mcp:${x.enabled ? 'off' : 'on'}:${x.name}`) } }))));
    }, { label: 'Подключения', empty: 'Нет подключённых приложений.' });
    let jsonBox = null;
    if (ui.mcpJsonOpen) {
      const ta = el('textarea', { className: 'jsonarea', value: state.mcpJson ?? '{\n  "mcpServers": {}\n}', spellcheck: false });
      jsonBox = el('div', { className: 'jsonbox' }, ta,
        el('div', { className: 'jsonbar' },
          btn('Импортировать JSON', () => { send({ type: 'panel_mcp_json', json: ta.value }); ui.mcpJsonOpen = false; }, { kind: 'primary', k: 'mcp-json-save' }),
          link('Закрыть', () => { ui.mcpJsonOpen = false; render(); }, { k: 'mcp-json-close' })));
    }
    return {
      body: [group(null, 'Приложения и MCP-серверы, которыми я могу управлять.', null), el('div', { className: 'group paged' }, box), jsonBox],
      foot: foot(el('div', { className: 'jsonbar' },
        btn('Подключить приложение', () => act('askconnect', true), { k: 'askconnect' }),
        btn(ui.mcpJsonOpen ? 'Скрыть JSON' : 'JSON', () => { ui.mcpJsonOpen = !ui.mcpJsonOpen; render(); }, { k: 'mcp-json-toggle' })), nav),
    };
  }
  // What I may do, and when I start.
  function generalPage() {
    const uiLang = localStorage.getItem('roamies_ui_lang') === 'ru' ? 'ru' : 'en';
    return [
      group('Общие', 'Что мне разрешено делать и когда запускаться.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'Язык интерфейса'),
          picks('Язык интерфейса', [['en', 'English'], ['ru', 'Русский']], uiLang, (x) => { localStorage.setItem('roamies_ui_lang', x); send({ type: 'menu', id: `uilang:${x}` }); location.reload(); }, 'uilang')),
        toggle('Звуковые эффекты', null, state.sound, () => act('sound'), 'sound'),
        state.notch != null ? group('Где я появляюсь', 'Рядом с курсором или в верхней части экрана.', null,
          picks('Где я появляюсь', [['off', 'У курсора'], ['drop', 'Капсула'], ...(state.notchReal ? [['spread', 'Чёлка (Notch)']] : [])], state.notch, (x) => act(`notch_${x}`), 'notch',
            { off: 'Всё рядом с курсором, как обычно.', spread: 'В области чёлки (Notch), расширяясь в стороны.', drop: state.notchReal ? 'В капсуле, выезжающей из чёлки.' : 'В капсуле в верхней части экрана.' })) : null,
        state.gameMode != null ? toggle('Игровой режим', 'В полноэкранной игре я ухожу в панель у края экрана.', state.gameMode, () => act('gamemode'), 'gamemode') : null,
        toggle('Разрешить правку файлов и команды', 'Изменять файлы и запускать команды в терминале', state.actions, () => act('actions'), 'actions'),
        state.actions ? toggle('Пропускать подтверждения', 'Выполнять действия без лишних вопросов. Опасные шаги всё равно спрашивают.', state.skipAllow, () => act('skipallow'), 'skipallow') : null,
        state.learnSkills != null ? toggle('Запоминать скиллы', 'После сложной успешной задачи я сохраню инструкцию на будущее.', state.learnSkills, () => act('learnskills'), 'learnskills') : null,
        state.login ? toggle('Запускать при входе в систему', null, state.login.on, () => act('login'), 'login') : null,
        state.sync ? el('div', { className: 'setting' },
          el('span', {}, 'Синхронизация памяти', el('small', { title: state.sync.dir, textContent: !state.sync.dir ? 'Общие напоминания и память с другим компьютером' : state.sync.error ? `Не синхронизируется: ${state.sync.error}` : `Через ${state.sync.dir.split(/[\\/]/).filter(Boolean).pop()}${state.sync.at ? ` · ${new Date(state.sync.at).toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' })}` : ''}` })),
          state.sync.dir ? [state.sync.paused ? link('Всё равно синхр.', () => act('syncallow'), { k: 'syncallow', danger: true, aria: 'Синхронизировать принудительно' }) : null,
            link('Стоп', () => act('syncstop'), { k: 'syncstop', aria: 'Остановить синхронизацию памяти' })] : link('Настроить', () => act('syncsetup'), { k: 'syncsetup', aria: 'Настроить синхронизацию памяти' })) : null),
    ];
  }
  // Who made Roamies: Ken, live (he's drawn like the looks but isn't one), and where to find him.
  const Q0TIK_LINKS = [
    ['GitHub (q0tik)', 'Профиль разработчика форка Qbdy', 'https://github.com/q0tik', 'Открыть профиль q0tik на GitHub'],
    ['Репозиторий Qbdy', 'Форк с русским интерфейсом, MCP JSON, скиллами и персонажами', 'https://github.com/q0tik/Roamies', 'Открыть репозиторий Qbdy на GitHub'],
    ['Оригинальный Roamies', 'Изначальный проект Ken Kai (AGPL-3.0)', 'https://github.com/KenKaiii/Roamies', 'Открыть оригинальный репозиторий Ken Kai на GitHub'],
  ];
  let q0tikCard = null;
  function maker() {
    if (!q0tikCard) {
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const r = liveRoamie(cv, 100, 74, { look: 'q0tik', y: 0.55 });
      const card = el('div', { className: 'maker' }, cv, el('span', {}, 'q0tik', el('small', { textContent: 'Разработчик Qbdy (форк Roamies)' })));
      let waved = 0;
      card.addEventListener('pointerenter', () => { if (r && Date.now() - waved > 3500) { waved = Date.now(); r.act('wave'); } });
      r?.appear('crt');
      q0tikCard = card;
    }
    return q0tikCard;
  }
  function aboutPage() {
    return [
      group('О Qbdy', 'Персональный форк и доработка на базе Roamies от Ken Kai.', null, maker(),
        Q0TIK_LINKS.map(([label, hint, url, aria]) => el('div', { className: 'setting' },
          el('span', {}, label, el('small', { textContent: hint })),
          link('Открыть', () => send({ type: 'open_link', url }), { k: `q0tik-${label.toLowerCase()}`, aria })))),
      group('Помощь', null, null,
        el('div', { className: 'links' },
          link('Мастер настройки', () => act('setup', true), { k: 'setup' }),
          link('Показать логи', () => act('logs'), { k: 'logs' }),
          link('Сохранить диагностику', () => act('diagnostics'), { k: 'diagnostics', aria: 'Сохранить файл диагностики для отчёта об ошибке' }),
          state.problem ? link('Скопировать последнюю ошибку', copyProblem, { k: 'copy-problem' }) : null)),
    ];
  }

  // ---------------------------------------------------------------- What's new
  // One change per row, from whatsnew.json (written with each commit): this update's first, lit, then the rest.
  // This update: everything since the version they updated from (whatsNewFrom), else this version's own.
  let news = null;
  fetch('whatsnew.json').then((r) => r.json()).then((d) => { news = Array.isArray(d?.updates) ? d.updates : []; })
    .catch(() => { news = []; }).finally(() => { if (state && tab === 'whatsnew') render(); });
  const KIND = { new: 'Новое', improved: 'Улучшено', fixed: 'Исправлено', removed: 'Удалено' };
  const later = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  function whatsNewPage() {
    if (!news) return [];
    const from = state.whatsNewFrom, now = state.version;
    const fresh = (u) => u.version == null || (from ? later(u.version, from) && !later(u.version, now) : u.version === now);
    const all = news.flatMap((u) => (u.items ?? []).map((it) => ({ ...it, version: u.version, date: u.date, fresh: fresh(u) })));
    all.sort((a, b) => b.fresh - a.fresh);
    const lit = all.filter((r) => r.fresh).length;
    const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    const { box, nav } = paged('whatsnew', all, (r) => el('li', { className: `item wn${r.fresh ? ' fresh' : ''}` },
        el('div', { className: 'wn-top' },
          el('span', { className: 'wn-title', textContent: r.title }),
          el('span', { className: `wn-kind k-${r.kind}`, textContent: KIND[r.kind] ?? r.kind })),
        el('span', { className: 'wn-date', textContent: `${day(r.date)} · ${r.version ? `v${r.version}` : 'Ещё не вышло'}` }),
        el('p', { className: 'wn-text', textContent: r.text }),
        r.fresh ? el('span', { className: 'sr-only', textContent: 'В этом обновлении.' }) : null),
    { label: 'Что нового', empty: 'Пока ничего нет.' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' },
        el('h2', {}, 'Что нового', el('span', { className: 'n', textContent: `v${now}` })),
        el('p', { textContent: lit ? `Подсвечено изменений в этом обновлении: ${lit}.` : 'Все недавние изменения, от новых к старым.' })), box),
      foot(null, nav),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, abilities: abilitiesPage, model: modelPage, appearance: appearancePage, speaking: speakingPage, listening: listeningPage, shortcuts: shortcutsPage, general: generalPage, about: aboutPage, whatsnew: whatsNewPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const same = render.tab === tab; render.tab = tab;
    const before = new Set([...pane.querySelectorAll('[data-anim]')].filter(shown).map((n) => n.dataset.anim));
    // A page with a list fits it to the room left and pages it; any other page scrolls.
    const draw = () => { pane.replaceChildren(...PANES[tab]().flat().filter(Boolean));
    pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); keepGone(); };
    draw();
    // Lists show as many rows as fit: drawn once to measure, again if a different number fits.
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    if (same && !animate) for (const n of pane.querySelectorAll('[data-anim]')) if (shown(n) && !before.has(n.dataset.anim)) grow(n, true);
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  // The window changes size with the screen it opens on: as many rows as fit there.
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  // copy: the app has the full error behind this line; Copy details puts it on the clipboard (and the note stays
  // up longer, to leave time to press it).
  const copyProblem = () => send({ type: 'copy_problem', from: 'panel' });
  let noteTimer = 0;
  function note(text, bad = false, copy = false) {
    const n = $('note');
    n.replaceChildren(el('span', { textContent: text, title: text }), ...(copy ? [link('Скопировать детали', copyProblem, { k: 'note-copy' })] : []));
    n.removeAttribute('title'); n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, copy ? 20000 : bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    // Pages that became Abilities tabs (and Memory's old Skills tab) open that tab.
    if (ABILITY_TABS.some(([id]) => id === name)) { ui.tabs.abilities = name; name = 'abilities'; }
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null; ui.rec = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Changing a shortcut on the Shortcuts page: the next key with Control, Option (Alt) or Command (Win) is the new one.
  const KEY_CODE = /^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
  document.addEventListener('keydown', (e) => {
    const which = ui.rec;
    if (!which) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { ui.rec = null; render(`rec-${which}`); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) || !KEY_CODE.test(e.code)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { note(state.os === 'mac' ? 'Удерживайте также Control, Option или Command.' : 'Удерживайте также Ctrl или Alt.', true); return; }
    ui.rec = null;
    act(`shortcut:${which}:${[...mods, e.code].join('+')}`);
    render(`rec-${which}`);
  }, true);
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key) closeKey(); else if (disarm()) render(was ?? undefined); else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // The Roamie switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit();
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"], .ibtn[aria-pressed="true"]')) {
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(); // a tick or X goes back in place, so it can ease back
    }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      if (m.state.tab) show(m.state.tab, true); // opened for a reason (asked with nothing signed in: the Model page)
    }
    else if (m.kind === 'note') note(m.text, m.bad, m.copy);
    else if (m.kind === 'copied' && m.which === 'problem') note(m.ok ? 'Детали ошибки скопированы. Вставьте их в отчёт.' : 'Не удалось скопировать детали. Попробуйте «Сохранить диагностику».', !m.ok);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Скопировано. Вставьте в новую горячую клавишу.' : 'Не удалось скопировать. Выделите команду и скопируйте вручную.', !m.ok);
    }
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Roamies panel (preview with sample data)';
    const at = Date.now(), q = new URLSearchParams(location.search);
    const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const s = {
      version: '0.9.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: true, method: 'oauth', key: true, signedIn: true, models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', levels: CLAUDE_LEVELS }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', levels: CLAUDE_LEVELS }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', key: true, models: [] },
        { id: 'gemini', label: 'Gemini', on: true, method: 'key', key: true, keySaved: true, models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', levels: ['high'] }] },
        { id: 'moonshot', label: 'Kimi (Moonshot)', on: false, method: 'key', models: [], kinds: [
          { id: 'kimi-code', label: 'Kimi Code', billing: 'Uses your Kimi Code plan. Create the key in the Kimi Code Console.' },
          { id: 'moonshot', label: 'Moonshot', billing: 'Pay-per-token from platform.moonshot.ai.' }] },
        { id: 'local', label: 'Local models', on: q.has('local'), method: 'local', models: q.has('local') ? [{ id: 'local/ollama/qwen3-vl:8b', name: 'qwen3-vl:8b (Ollama)', levels: [] }] : [],
          // A coding model that can't see images: only the subagent pickers offer it.
          textModels: q.has('local') ? [{ id: 'local/ollama/qwen3-coder:30b', name: 'qwen3-coder:30b (Ollama)', levels: [] }] : [] },
        ...['xAI', 'GLM (Z.ai)', 'MiniMax', 'Xiaomi', 'DeepSeek', 'Sakana', 'OpenRouter', 'Hugging Face'].map((label) => ({ id: label.toLowerCase().replace(/\W/g, ''), label, on: false, method: 'key', models: [] })),
      ],
      // ?local: Ollama connected, LM Studio not running, and an added server whose models can't see images.
      localServers: [
        { id: 'ollama', label: 'Ollama', custom: false, baseUrl: null, on: q.has('local'), note: '' },
        { id: 'lmstudio', label: 'LM Studio', custom: false, baseUrl: null, on: q.has('local'), note: q.has('local') ? "LM Studio isn't running." : '' },
        ...(q.has('local') ? [{ id: 'gpu-box', label: 'GPU box', custom: true, baseUrl: 'http://192.168.1.40:8000/v1', on: true, note: 'None marked as seeing images. Re-add to change.' }] : []),
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the Roamies 1.0 launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso' }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      jobs: [{ id: 'j1a2b3c', title: 'Tech news', paused: false, next: 'Thu 6 Nov, 08:00', repeat: 'weekdays', last: 'Last: Summed up 6 stories on AI chips and a Mac update', bad: false },
        { id: 'j4d5e6f', title: 'Tidy Downloads', paused: true, next: 'Paused', repeat: 'Fri', last: "Didn't run: Allow File Edits & Commands is off", bad: true }],
      skills: [{ slug: 'export-figma-frames', name: 'Export Figma frames', description: 'When they want frames out of Figma as PNGs at 2x.' },
        { slug: 'weekly-invoice', name: 'Weekly invoice', description: 'When making the Friday invoice in Numbers from the hours sheet.' }], learnSkills: true,
      connections: [{ name: 'linear', remote: true, where: 'https://mcp.linear.app/mcp', enabled: true, state: 'connected', toolCount: 23, error: null },
        { name: 'notion', remote: true, where: 'https://mcp.notion.com/mcp', enabled: true, state: 'needs-login', toolCount: 0, error: 'Requires login.' },
        { name: 'everything', remote: false, where: 'npx -y @modelcontextprotocol/server-everything', enabled: true, state: 'error', toolCount: 0, error: 'spawn npx ENOENT' },
        { name: 'files', remote: false, where: 'npx -y @modelcontextprotocol/server-filesystem ~/Desktop', enabled: false, state: 'off', toolCount: 0, error: null }],
      name: 'Roamie', look: 'classic', looks: [['classic', 'Roamie'], ['jarvis', 'JARVIS'], ['glayos', 'GlayOS'], ['ultren', 'Ultren'], ['anime', 'Anime Girl'], ['sarah', 'Sarah'], ['adrian', 'Adrian'], ['rita', 'Rita X']],
      size: 'default', sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      replies: 'voice', fishKey: true, fishModel: 'drama-3', fishFree: false,
      // ?tts=gemini: Gemini as the voice, its key saved.
      tts: new URLSearchParams(location.search).get('tts') === 'gemini' ? 'gemini' : 'fish', geminiKey: new URLSearchParams(location.search).get('tts') === 'gemini', geminiVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      // &shared: speaking with the AI's Gemini key, none saved for the voice.
      geminiShared: new URLSearchParams(location.search).has('shared'), geminiModel: 'gemini-3.8-flash-lite-tts',
      geminiModels: [{ id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite', per10s: 0.0015 }, { id: 'gemini-3.8-flash-tts', name: 'Flash', per10s: 0.00225 }],
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      // Hybrid models: a job on a model picked here (the sidecar sends these; active is the one a heavy job is on right now).
      hybrid: { on: true, jobs: [
        { kind: 'code', label: 'Coding and commands', value: '' },
        { kind: 'computer', label: 'Computer use', value: 'anthropic:claude-sonnet-5' },
        { kind: 'web', label: 'Web research', value: '' },
        { kind: 'draw', label: 'Drawing', value: '' },
        { kind: 'agents', label: 'Background agents', value: '' } ], active: '' },
      // Subagents: Scout has its own model, Builder follows hybrid's coding model (none set here, so it is off the crew).
      subagents: { on: true, delegate: 'auto', crew: [
        { id: 'scout', label: 'Scout', hint: 'Web research.', value: 'gemini:gemini-3.8-flash', via: 'own', uses: 'gemini:gemini-3.8-flash' },
        { id: 'builder', label: 'Builder', hint: 'Code, pages and scripts.', value: '', via: 'hybrid', uses: 'anthropic:claude-sonnet-5' },
        { id: 'writer', label: 'Writer', hint: 'Documents, slides and copy.', value: '', via: '', uses: '' } ] },
      // If a limit is reached: backups 1 and 2 (the Gemini model is free while Claude is at its limit, so it's in use).
      fallbacks: { on: true, slots: ['gemini:gemini-3.8-flash', ''], limited: [{ label: 'Claude', until: at + 40 * 60e3 }], using: 'gemini:gemini-3.8-flash' },
      // Effort per slot: '' is automatic (low); computer use is set to High, and backup 1 (Gemini, which only thinks at High) too.
      efforts: { default: '', computer: 'high', code: '', agents: '', draw: '', web: '', backup1: 'high', backup2: '' },
      voice: { on: true, keys: '⌃⌥', ready: true, mac: true, lang: 'auto', langOnline: null, studioSpeak: 'short', mute: true, autoListen: q.has('listen'), listenEvery: false, listenSecs: 8, listenChoices: [3, 5, 8, 10, 15], mics: [{ id: 'BuiltIn', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], mic: '', micAuto: 'MacBook Pro Microphone', wake: !q.has('nowake'), wakeWord: false, wakeName: 'Roamies', download: null }, askKeys: '⌥⌘', brief: { on: true, todoist: false, canTodoist: true }, focus: { until: null, task: '', list: ['YouTube', 'Reddit', 'X', 'Steam', 'Netflix'], custom: false }, sync: { dir: '', at: null, error: null, paused: false }, shortcuts: { talk: { value: 'control+option', pairs: [['control+option', 'Control+Option'], ['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] }, keys: [{ id: 'summon', words: 'Control+Option+S' }, { id: 'snap', words: 'Control+Option+A' }, { id: 'list', words: 'Control+Option+L' }] }, writeKeys: { value: 'option+command', pairs: [['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] },
      sound: true, notch: q.has('notch') || q.has('capsule') ? 'drop' : null, notchReal: q.has('notch'), actions: false, skipAllow: false, login: { on: true },
      update: { available: new URLSearchParams(location.search).has('update') && new URLSearchParams(location.search).get('update') !== 'failed' ? '0.9.1' : null, installing: false, checking: false, result: null },
      intro: false,
    };
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], jobs: [], skills: [], connections: [], usage: null });
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}` }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
      s.recent = Array.from({ length: 30 }, (_, i) => ({ ...s.recent[i % s.recent.length], at: at - i * 70e3 }));
    }
    // ?problem: an error was shown earlier (About gets Copy last error). ?note=bad: a failed save, with Copy details.
    // ?update=failed: the last check for updates failed (the button's tooltip says why).
    if (q.has('problem') || q.get('note') === 'bad') s.problem = { code: 'E30', at };
    if (q.get('note') === 'bad') setTimeout(() => window.__panel({ kind: 'note', text: "That key didn't save (E30). Try again.", bad: true, copy: true }), 400);
    if (q.get('update') === 'failed') s.update.result = { ok: false, error: "Couldn't check for updates. Check your internet." };
    if (q.has('checking')) s.update.checking = true;
    // ?studio: VoiceStudio is the voice provider (?studio=off: it isn't running; ?studio=engine: its engine isn't ready; ?studio=empty: no saved voices).
    const STUDIO = {
      on: { ok: true, engine: 'OmniVoice', voices: [{ id: 'a642d572', name: 'Ben' }, { id: 'fa08aff1', name: 'British · Female · Young Adult · High' }], voice: 'fa08aff1' },
      empty: { ok: true, engine: 'KittenTTS', voices: [], voice: null },
      off: { ok: false, reason: 'offline', message: 'Run VoiceStudio first.' },
      engine: { ok: false, reason: 'engine', message: "VoiceStudio's voice engine isn't ready (CosyVoice): not installed. Pick or install an engine in VoiceStudio, then press Check again." },
    };
    if (q.has('studio')) Object.assign(s, { tts: 'voicestudio', studio: STUDIO[q.get('studio')] ?? STUDIO.on });
    if (q.has('uptodate')) s.update.result = { ok: true, at: Date.now() + 60e3 };
    // ?v=0.1.36&from=0.1.35: What's new as it looks just after updating from one version to the other.
    if (q.get('v')) s.version = q.get('v');
    if (q.get('from')) s.whatsNewFrom = q.get('from');
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); if (q.get('atab')) ui.tabs.abilities = q.get('atab'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      // A look change comes back as new state, as from the sidecar, so the Roamie's reaction can be seen.
      if (args.msg?.type === 'copy_problem') setTimeout(() => window.__panel({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }), 150);
      const id = args.msg?.id ?? '';
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('tts:')) { s.tts = id.slice(4); s.studio = s.tts === 'voicestudio' ? STUDIO[q.get('studio')] ?? STUDIO.on : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('studiovoice:') && s.studio) { s.studio.voice = id.slice(12) === 'default' ? null : id.slice(12); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'lite') { s.lite = !s.lite; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'hybrid') { s.hybrid.on = !s.hybrid.on; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'backups') { s.fallbacks.on = !s.fallbacks.on; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('effort_')) { const at = id.indexOf(':'); s.efforts[id.slice(7, at)] = id.slice(at + 1); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && ['autolisten', 'listenevery'].includes(id)) { const k = id === 'autolisten' ? 'autoListen' : 'listenEvery'; s.voice[k] = !s.voice[k]; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && id.startsWith('speechlang:')) { s.voice.lang = id.slice(11); s.voice.langOnline = ['ar-SA', 'he-IL'].includes(s.voice.lang) ? true : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && id.startsWith('listensecs:')) { s.voice.listenSecs = Number(id.slice(11)); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      // Removing a row (a skill, connection, job, fact or commitment) comes back as new state, as from the sidecar.
      const gone = [[/^skill:forget:(.+)$/, 'skills', (x, v) => x.slug === v], [/^mcp:remove:(.+)$/, 'connections', (x, v) => x.name === v], [/^job:remove:(.+)$/, 'jobs', (x, v) => x.id === v],
        [/^forget:(.+)$/, 'facts', (x, v) => x.id === v], [/^(?:done|drop):(.+)$/, 'commitments', (x, v) => x.id === v]].find(([re]) => re.test(id));
      if (gone) { const v = id.match(gone[0])[1]; s[gone[1]] = s[gone[1]].filter((x) => !gone[2](x, v)); setTimeout(() => window.__panel({ kind: 'state', state: s }), Number(q.get('lag') ?? 120)); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = s.looks.find(([v]) => v === s.look)?.[1] ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();

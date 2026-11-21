import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dir;
const shell = readFileSync(join(dir, 'client-shell.js'), 'utf8');
const css = readFileSync(join(dir, 'client-shell.css'), 'utf8');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const ops = readFileSync(join(dir, 'operations.js'), 'utf8');
const mapShell = readFileSync(join(dir, 'map-shell.js'), 'utf8');

function extractHtmlScript(source: string): string {
  const start = source.indexOf('<script>\n');
  const end = source.indexOf('\n</script><script src="/map-shell.js">', start);
  return source.slice(start + 9, end);
}

interface FakeEl {
  tagName: string;
  className: string;
  id: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  inert: boolean;
  value: string;
  title: string;
  tabIndex: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  _innerHTML: string;
  _h?: string | null;
  _inner?: string;
  _rect?: string;
  _dismiss?: () => void;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: FakeEl[];
  parentElement: FakeEl | null;
  classList: {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    toggle: (c: string, force?: boolean) => boolean;
    contains: (c: string) => boolean;
  };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  hasAttribute: (k: string) => boolean;
  removeAttribute: (k: string) => void;
  append: (...nodes: any[]) => void;
  prepend: (...nodes: any[]) => void;
  before: (...nodes: any[]) => void;
  insertBefore: (node: any, ref: any) => any;
  remove: () => void;
  replaceChildren: (...nodes: any[]) => void;
  insertAdjacentHTML: (pos: string, markup: string) => void;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
  closest: (sel: string) => FakeEl | null;
  contains: (node: any) => boolean;
  matches: (sel: string) => boolean;
  focus: () => void;
  blur: () => void;
  onclick: any;
  onkeydown: any;
  innerHTML: string;
  readonly isConnected: boolean;
  readonly firstElementChild: FakeEl | null;
  readonly nextElementSibling: FakeEl | null;
}

function makeDom(rootTag = 'DIV') {
  let doc: any;
  const active = { current: null as FakeEl | null };
  function parseTagAttrs(raw: string) {
    const attrs: Record<string, string> = {};
    for (const m of raw.matchAll(/([A-Za-z0-9_-]+)(?:="([^"]*)")?/g)) {
      if (m[1]) attrs[m[1]] = m[2] ?? '';
    }
    return attrs;
  }
  function parseSimpleHtml(parent: FakeEl, markup: string) {
    parent.children = [];
    const tokens = markup.match(/<\/?[a-zA-Z0-9-]+(?:\s+[^>]*)?>|[^<]+/g) || [];
    const stack: FakeEl[] = [parent];
    for (const tok of tokens) {
      if (tok.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (tok.startsWith('<')) {
        const m = tok.match(/^<([a-zA-Z0-9-]+)\s*([^>]*?)(\/?)>$/);
        if (!m) continue;
        const tag = m[1].toUpperCase();
        const attrs = parseTagAttrs(m[2] || '');
        const el = createEl(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        stack[stack.length - 1].append(el);
        const voidTag = m[3] === '/' || ['IMG', 'INPUT', 'BR', 'HR', 'META', 'LINK'].includes(tag);
        if (!voidTag) stack.push(el);
      } else {
        stack[stack.length - 1].textContent += tok;
      }
    }
  }
  function matchesSelector(el: FakeEl, part: string): boolean {
    let p = part.trim();
    if (!p) return false;
    if (p.startsWith(':scope > ')) p = p.slice(9).trim();
    const attrMatches = [...p.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    const bare = p.replace(/\[[^\]]+\]/g, '');
    const idMatch = bare.match(/#([A-Za-z0-9_-]+)/);
    if (idMatch && el.id !== idMatch[1]) return false;
    const classes = [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
    if (classes.some(c => !el.classList.contains(c))) return false;
    const tagMatch = bare.match(/^([A-Za-z0-9-]+)/);
    if (tagMatch && el.tagName !== tagMatch[1].toUpperCase()) return false;
    for (const am of attrMatches) {
      const k = am[1];
      let val = k in el.attrs ? el.attrs[k] : undefined;
      if (val === undefined && k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (camel in el.dataset) val = el.dataset[camel];
      }
      if (val === undefined) return false;
      if (am[2] !== undefined && val !== am[2]) return false;
    }
    return true;
  }
  function walkMatch(root: FakeEl, sel: string, onlyFirst: boolean): FakeEl[] {
    const alts = sel.split(',').map(s => s.trim()).filter(Boolean);
    const results: FakeEl[] = [];
    const checkList = (node: FakeEl, directOnly: boolean): boolean => {
      for (const ch of node.children) {
        if (alts.some(a => {
          if (a.startsWith(':scope > ')) return directOnly && matchesSelector(ch, a);
          const parts = a.split(/\s+/);
          if (parts.length > 1) return matchesSelector(ch, parts[parts.length - 1]);
          return matchesSelector(ch, a);
        })) {
          results.push(ch);
          if (onlyFirst) return true;
        }
        if (checkList(ch, false)) return true;
      }
      return false;
    };
    checkList(root, true);
    return results;
  }
  function createEl(tag = 'DIV'): FakeEl {
    const classes = new Set<string>();
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      id: '',
      textContent: '',
      hidden: false,
      disabled: false,
      inert: false,
      value: '',
      title: '',
      tabIndex: 0,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      _innerHTML: '',
      attrs: {},
      dataset: {},
      style: {},
      children: [],
      parentElement: null,
      get className() {
        return [...classes].join(' ');
      },
      set className(v: string) {
        classes.clear();
        for (const c of String(v || '').split(/\s+/).filter(Boolean)) classes.add(c);
        el.attrs.class = [...classes].join(' ');
      },
      classList: {
        add: (...c) => { for (const x of c) if (x) classes.add(x); el.attrs.class = [...classes].join(' '); },
        remove: (...c) => { for (const x of c) classes.delete(x); el.attrs.class = [...classes].join(' '); },
        toggle: (c, f) => {
          const next = f === undefined ? !classes.has(c) : !!f;
          if (next) classes.add(c); else classes.delete(c);
          el.attrs.class = [...classes].join(' ');
          return next;
        },
        contains: c => classes.has(c),
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'id') this.id = String(v);
        else if (k === 'title') this.title = String(v);
        else if (k === 'class') this.className = String(v);
        else if (k === 'hidden') this.hidden = true;
        else if (k === 'disabled') this.disabled = true;
        else if (k === 'inert') this.inert = true;
        else if (k.startsWith('data-')) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          this.dataset[camel] = String(v);
        }
      },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) {
        delete this.attrs[k];
        if (k === 'inert') this.inert = false;
        if (k === 'hidden') this.hidden = false;
        if (k === 'disabled') this.disabled = false;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (!n || typeof n === 'string') continue;
          n.remove?.();
          n.parentElement = this;
          this.children.push(n);
        }
      },
      prepend(...nodes) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          if (!n || typeof n === 'string') continue;
          n.remove?.();
          n.parentElement = this;
          this.children.unshift(n);
        }
      },
      before(...nodes) {
        if (!this.parentElement) return;
        for (const n of nodes) {
          if (!n || typeof n === 'string') continue;
          n.remove?.();
          n.parentElement = this.parentElement;
          const idx = this.parentElement.children.indexOf(this);
          this.parentElement.children.splice(idx < 0 ? 0 : idx, 0, n);
        }
      },
      insertBefore(node, ref) {
        node.remove?.();
        node.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx < 0) this.children.push(node);
        else this.children.splice(idx, 0, node);
        return node;
      },
      remove() {
        if (!this.parentElement) return;
        const i = this.parentElement.children.indexOf(this);
        if (i >= 0) this.parentElement.children.splice(i, 1);
        this.parentElement = null;
      },
      replaceChildren(...nodes) {
        for (const ch of [...this.children]) ch.parentElement = null;
        this.children = [];
        this.append(...nodes);
      },
      insertAdjacentHTML(_pos, markup) {
        this._innerHTML += String(markup);
        const tmp = createEl('DIV');
        parseSimpleHtml(tmp, markup);
        for (const ch of [...tmp.children]) this.append(ch);
      },
      querySelector(sel) { return walkMatch(this, sel, true)[0] || null; },
      querySelectorAll(sel) { return walkMatch(this, sel, false); },
      closest(sel) {
        let cur: FakeEl | null = this;
        while (cur) {
          if (sel.split(',').some(s => matchesSelector(cur!, s))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      contains(node) {
        let cur = node;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      matches(sel) { return sel.split(',').some(s => matchesSelector(this, s)); },
      focus() { active.current = this; },
      blur() { if (active.current === this) active.current = null; },
      onclick: null,
      onkeydown: null,
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v: string) {
        this._innerHTML = String(v);
        parseSimpleHtml(this, this._innerHTML);
      },
      get isConnected() {
        let cur: FakeEl | null = this;
        while (cur) {
          if (cur === doc.body) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      get firstElementChild() { return this.children[0] || null; },
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i >= 0 ? this.parentElement.children[i + 1] || null : null;
      },
    };
    return el;
  }
  const body = createEl(rootTag);
  doc = {
    body,
    documentElement: createEl('HTML'),
    createElement: (tag: string) => createEl(tag),
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    getElementById: (id: string) => body.querySelector('#' + id),
    get activeElement() { return active.current || body; },
  };
  return { doc, createEl, setActive: (el: FakeEl | null) => { active.current = el; } };
}

test('1. Game Options container scrolls cleanly above the social and settings tab row without clipping', () => {
  expect(css).toContain('.game-tabs{position:absolute;right:0;bottom:0;width:232px;max-height:100%;display:flex;flex-direction:column;pointer-events:auto');
  expect(css).toContain('.tab-row{flex:none;position:relative;z-index:2;display:grid');
  expect(css).toContain('.game-panel{flex:0 1 auto;min-height:0;height:292px;max-height:calc(100% - 72px)');
  expect(css).toContain('overflow-y:auto;overflow-x:hidden');
  expect(css).toContain('.game-panel[data-tab="settings"] label{display:flex;align-items:center;justify-content:space-between');
  expect(css).toContain('@media(max-height:560px){.game-panel{height:200px;max-height:calc(100% - 72px)}}');

  const panelCode = shell.slice(shell.indexOf('  function gamePanel(){'), shell.indexOf('  // The XP Tracker plugin'));
  const panelEl = {
    dataset: {} as Record<string, string>,
    classList: { contains: () => false },
    contains: () => false,
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const btns = [{
    dataset: { gameTab: 'settings' },
    className: '',
    attributes: {} as Record<string, string>,
    classList: { contains: () => false, toggle(_c: string, _on: boolean) {} },
    getAttribute(k: string) { return this.attributes[k] ?? null; },
    setAttribute(k: string, v: string) { this.attributes[k] = v; },
  }];
  const hud = {
    classList: { contains: () => false },
    querySelector: (s: string) => (s === '#game-panel' ? panelEl : null),
    querySelectorAll: (s: string) => (s === '[data-game-tab]' ? btns : []),
  };
  new Function(
    'hud', 'document', 'app', '$', 'CSS', 'put', 'questScope', 'selectedTab', 'account', 'S', 'window', 'E', 'nf', 'dur', 'asset', 'skills', 'realSkill', 'reported', 'level', 'curLevel',
    'combatLine', 'bankedLine', 'questPointsOf', 'questDetail', 'questFilter', 'questQuery', 'questReqData', 'questReady', 'questStatusOf', 'questReqProgress', 'questRewardData', 'rewardText', 'reqHtml', 'itemHtml',
    'itemStats', 'itemAlch', 'icon', 'qty', 'chargeTag', 'idTag', 'statTip', 'priceTip', 'invTag', 'invWorth', 'inventoryLayout', 'stackValue', 'gp',
    'deathMarks', 'deathCls', 'wornBonuses', 'equipStats', 'setupSlot', 'setupPanel', 'equipAdvisorHtml', 'teleLine', 'bestSpell', 'spellbookData', 'runeCasts', 'prayerLasts', 'recordedHp', 'healthNote',
    'safeName', 'placesBox', 'placesOptionsHtml', 'notifyOn', 'worldPanel', 'VIEWER', 'mode',
    `${panelCode};gamePanel();`,
  )(
    hud, { activeElement: null }, { classList: { contains: () => false } }, (s: string) => (s === '#game-panel' ? panelEl : { value: '1' }), { escape: String },
    (el: any, htmlStr: string) => { el.innerHTML = htmlStr; }, 'account', 'settings', () => null, { bots: [] },
    { atlasOperator: () => false, atlasRoofsOff: () => true, atlasQuality: 1, FleetShim: { signedIn: () => null } },
    String, String, String, (n: string) => n, [], () => true, () => true, () => null, () => 1,
    () => '', () => '', () => null, null, 'all', '', null, () => false, () => '', () => '', null, () => '', () => '', () => '',
    {}, {}, () => '', () => '', () => '', () => '', () => '', () => '', () => '', () => '', () => ({ cells: [], note: '' }), () => ({ value: 0, unpriced: 0 }), String,
    () => null, () => '', () => null, () => '', () => ({ cls: '', tip: '' }), () => '', () => '', () => '', () => null, null, () => 0, () => 0, () => null, () => '',
    String, null, () => '', () => false, () => '', { state: 'ready' }, '3d',
  );
  expect(panelEl.dataset.tab).toBe('settings');
  expect(panelEl.innerHTML).toContain('Game Options');
  expect(panelEl.innerHTML).toContain('Show / hide chatbox');
  expect(panelEl.innerHTML).toContain('Places & camera');
  expect(btns[0].attributes['aria-pressed']).toBe('true');
});

test('2. Welcome modal centers inside a backdrop with Escape, backdrop dismiss, and focus return', () => {
  expect(css).toContain('.game-hud .visitor-backdrop{position:absolute;inset:0;z-index:150;display:grid;place-items:center');
  expect(css).toContain('.game-hud .visitor-backdrop .visitor-card,.game-hud .visitor-card{position:relative;left:auto;top:auto;transform:none;animation:pop-in');
  expect(css).toContain('max-height:min(440px,calc(100vh - 96px),100%);overflow-y:auto');

  const welcomeCode = shell.slice(shell.indexOf('  function welcomeCard(){'), shell.indexOf('  function openShot('));
  const keyStart = shell.lastIndexOf("  window.addEventListener('keydown'");
  const keyEnd = shell.indexOf('  window.atlasClient=');
  const { doc, createEl, setActive } = makeDom('DIV');
  const hud = createEl('DIV');
  hud.className = 'game-hud';
  doc.body.append(hud);
  const opener = createEl('BUTTON');
  doc.body.append(opener);
  setActive(opener);

  const actions: string[] = [];
  let keydownHandler: ((e: any) => void) | null = null;
  const win = {
    atlasOperator: () => false,
    addEventListener: (_t: string, fn: any) => { keydownHandler = fn; },
    atlasWallOn: () => false,
  };
  const fn = new Function(
    'hud', 'document', 'window', 'localStorage', 'mode', 'VIEWER', 'WELCOME_KEY', 'tourAsked',
    'tourSet', 'showPlugin', 'focus', 'wallButton', 'wallEnd', 'wallToggle', 'wallPress', 'focusOpen', 'focusStep',
    'selectedTab', 'gamePanel', 'render', 'context', '$',
    `let welcomeDone=false;${welcomeCode};${shell.slice(keyStart, keyEnd)};return {welcomeCard,reset:()=>{welcomeDone=false;}};`,
  );
  const focusEl = { classList: { contains: () => false } };
  const api = fn(
    hud, doc, win, { getItem: () => null, setItem: () => {} }, '3d', { state: 'ready' }, 'k', false,
    (v: boolean) => actions.push('tour:' + v),
    (id: string) => actions.push('plugin:' + id),
    focusEl, { hidden: true, disabled: true }, () => false, () => {}, () => false, () => {}, () => {},
    'inventory', () => {}, () => {}, null, () => null,
  );

  api.welcomeCard();
  const backdrop = hud.querySelector('.visitor-backdrop');
  expect(backdrop).not.toBeNull();
  const dialog = backdrop!.querySelector('.visitor-card')!;
  expect(dialog.getAttribute('role')).toBe('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.getAttribute('aria-labelledby')).toBe('visitor-card-title');
  expect(doc.activeElement.getAttribute('data-card')).toBe('tour');

  // Escape through the global keydown handler closes the modal and restores focus.
  keydownHandler!({ key: 'Escape', target: doc.activeElement, preventDefault() {}, stopPropagation() {} });
  expect(hud.querySelector('.visitor-backdrop')).toBeNull();
  expect(doc.activeElement).toBe(opener);

  // Re-open and dismiss via backdrop click.
  api.reset();
  api.welcomeCard();
  const backdrop2 = hud.querySelector('.visitor-backdrop')!;
  backdrop2.onclick({ target: backdrop2 });
  expect(hud.querySelector('.visitor-backdrop')).toBeNull();

  // Re-open and click "See the hiscores".
  api.reset();
  api.welcomeCard();
  const boardsBtn = hud.querySelector('[data-card="boards"]')!;
  hud.querySelector('.visitor-backdrop')!.onclick({ target: boardsBtn });
  expect(actions).toContain('plugin:boards');
  expect(hud.querySelector('.visitor-backdrop')).toBeNull();
});

test('3. Fleet sidebar preserves account button DOM nodes across live ticks in both operations.js and index.html', () => {
  const { doc, createEl, setActive } = makeDom('DIV');
  const body = createEl('DIV');
  doc.body.append(body);

  const fleetHelpers = ops.slice(ops.indexOf(' // Fleet deck:'), ops.indexOf(' function account(){'));
  const reconcileSlice = ops.slice(ops.indexOf(' function reconcileFleet('), ops.indexOf(' function toast(text){'));
  const topOps = [
    "const isOwner=()=>window.atlasOperator?.()??true;",
    "const button=(text,action,value='',kind='')=>`<button class=\"op-button ${kind}\" data-op=\"${action}\" data-value=\"${E(value)}\">${E(text)}</button>`;",
    'const bots=()=>S?.bots?.filter(b=>!b.practice)||[];',
    "const title=(e,n,d)=>!isOwner()?'':`<div class=\"op-heading\">${E(n)}</div>`;",
    'function issues(){return bots().filter(b=>[\'blocked\',\'failed\',\'died\',\'active-stale\',\'unobserved\'].includes(b.operation));}',
    "function page(h){return '<div class=\"op-page\">'+h+'</div>';}",
    "const allocation=()=>'unknown';const resultSummary=t=>E(t);const st=b=>b.operation==='observed'?['on','playing']:b.operation==='paused'?['off','paused']:['off',b.operation||'offline'];",
  ].join('\n');

  const SRef: any = {
    now: 2000,
    bots: [
      { name: 'Alice', operation: 'observed', inWorld: true, fresh: true, at: 1000, role: 'fishing', xpPerHour: 12000, skills: [{ name: 'Fishing', level: 60 }] },
      { name: 'Bob', operation: 'observed', inWorld: true, fresh: true, at: 1000, role: 'mining', xpPerHour: 8000, skills: [{ name: 'Mining', level: 55 }] },
    ],
    coordination: { tasks: [] },
    world: { players: 25 },
  };
  const opsFn = new Function(
    'S', 'api', 'body', 'document', 'window', 'E', 'nf', 'ago', 'age', 'dur', 'safeName', 'CSS',
    `let fleetFilter='all',fleetQuery='',sel='Alice',stockView='stock',stockQuery='',pluginQuery='';const views={};${topOps}\n${fleetHelpers}\nviews.fleet=fleet;\n${reconcileSlice};body.innerHTML=fleet();return {reconcile:()=>renderCurrent(),setBots:(b)=>{S.bots=b;S.now+=1000;}};`,
  );
  const opsHarness = opsFn(
    SRef, { selectedPlugin: () => 'fleet' }, body, doc, { atlasOperator: () => true }, String, String, () => '1s', () => '1s', () => '1m', String, { escape: String },
  );
  const aliceBtnBefore = body.querySelector('.fl-main[data-value="Alice"]');
  const aliceRowBefore = body.querySelector('.fl-row[data-account-row="Alice"]');
  expect(aliceBtnBefore).not.toBeNull();
  setActive(aliceBtnBefore);

  // Live tick updates Alice XP/hr, removes Bob, inserts Carl
  opsHarness.setBots([
    { name: 'Carl', operation: 'observed', inWorld: true, fresh: true, at: 3000, role: 'woodcutting', xpPerHour: 24000, skills: [{ name: 'Woodcutting', level: 70 }] },
    { name: 'Alice', operation: 'observed', inWorld: true, fresh: true, at: 3000, role: 'fishing', xpPerHour: 19500, skills: [{ name: 'Fishing', level: 61 }] },
  ]);
  opsHarness.reconcile();
  expect(body.querySelector('.fl-main[data-value="Alice"]')).toBe(aliceBtnBefore);
  expect(body.querySelector('.fl-row[data-account-row="Alice"]')).toBe(aliceRowBefore);
  expect(doc.activeElement).toBe(aliceBtnBefore);
  expect(body.querySelector('.fl-main[data-value="Bob"]')).toBeNull();
  expect(body.querySelector('.fl-main[data-value="Carl"]')).not.toBeNull();

  // 3b. index.html roster() preserves button.fleet-row DOM node identity
  const script = extractHtmlScript(html);
  const rosterStart = script.indexOf('function roster(){');
  const rosterCode = script.slice(rosterStart, script.indexOf('\nfunction ', rosterStart + 10));
  const hDom = makeDom('DIV');
  const box = hDom.createEl('DIV');
  box.id = 'roster';
  box.clientHeight = 400;
  const search = hDom.createEl('INPUT');
  search.id = 'search';
  const filter = hDom.createEl('SELECT');
  filter.id = 'filter';
  filter.value = 'all';
  const fleetCount = hDom.createEl('SPAN');
  fleetCount.id = 'fleet-count';
  const fleetPageEl = hDom.createEl('SPAN');
  fleetPageEl.id = 'fleet-page';
  const prevB = hDom.createEl('BUTTON');
  prevB.id = 'fleet-prev';
  const nextB = hDom.createEl('BUTTON');
  nextB.id = 'fleet-next';
  hDom.doc.body.append(box, search, filter, fleetCount, fleetPageEl, prevB, nextB);

  const indexS: any = {
    now: 5000,
    bots: [
      { name: 'Alice', operation: 'observed', inWorld: true, fresh: true, at: 5000, bankAt: 4000, xpPerTick: 12 },
      { name: 'Bob', operation: 'offline', inWorld: false, fresh: false, at: 2000, bankAt: 2000 },
    ],
  };
  const rosterRun = new Function(
    'S', 'document', 'CSS', 'innerWidth', 'innerHeight', '$', 'put', 'E', 'safeName', 'st', 'running', 'K', 'KC', 'stateClass', 'ALLOCATION', 'allocation', 'stateName', 'offlineGoal', 'operationPhase', 'workMetric', 'observedAt', 'age', 'liveBots',
    `let sel='Alice',fleetPage=0,fleetPages=1;${rosterCode};return {roster,setBots:(b)=>{S.bots=b;S.now+=1000;}};`,
  )(
    indexS, hDom.doc, { escape: String }, 1280, 720,
    (s: string) => hDom.doc.querySelector(s),
    (s: any, markup: string) => { const el = typeof s === 'string' ? hDom.doc.querySelector(s) : s; if (el) el.innerHTML = markup; },
    String, String, (b: any) => [b.inWorld ? 'on' : 'off', b.inWorld ? 'playing' : 'offline'],
    (b: any) => b.operation === 'observed', { x: 'xp' }, { xp: '#ff0' }, () => 'good', { unknown: 'Offline' }, () => 'unknown', (s: string) => s,
    () => 'Goal', () => 'Phase', () => ({ text: '12/t', title: '' }), () => true, () => '1s', () => indexS.bots,
  );
  rosterRun.roster();
  const rowBefore = box.querySelector('.fleet-row[data-account="Alice"]');
  expect(rowBefore).not.toBeNull();
  expect(fleetCount.textContent).toBe('1 playing · 1 in world · 2 tracked');

  rosterRun.setBots([
    { name: 'Zed', operation: 'observed', inWorld: true, fresh: true, at: 6000, bankAt: 6000, xpPerTick: 20 },
    { name: 'Alice', operation: 'observed', inWorld: true, fresh: false, at: 6000, bankAt: 6000, xpPerTick: 14 },
  ]);
  rosterRun.roster();
  expect(box.querySelector('.fleet-row[data-account="Alice"]')).toBe(rowBefore);
  expect(fleetCount.textContent).toBe('2 playing · 2 in world · 2 tracked');
});

test('4. Fleet filter status counts strictly partition All in owner and public views with no off-by-one', () => {
  const { doc, createEl } = makeDom('DIV');
  const body = createEl('DIV');
  doc.body.append(body);
  const fleetHelpers = ops.slice(ops.indexOf(' // Fleet deck:'), ops.indexOf(' function account(){'));

  const mixedBots = [
    { name: 'Play1', operation: 'observed', inWorld: true, fresh: true, at: 1000, xpPerHour: 10000 },
    { name: 'Idle1', operation: 'observed', inWorld: true, fresh: true, action: 'idle', timeline: 'iiiiiiiiiiii', at: 1000 },
    { name: 'Wild1', operation: 'observed', inWorld: true, fresh: true, pos: { x: 3100, z: 3600, level: 0 }, at: 1000 },
    { name: 'Fail1', operation: 'failed', inWorld: false, fresh: false, at: 1000 },
    { name: 'Stale1', operation: 'active-stale', inWorld: true, fresh: false, at: 1000 },
    { name: 'Pause1', operation: 'paused', inWorld: false, fresh: false, at: 1000 },
    { name: 'Off1', operation: 'offline', inWorld: false, fresh: false, at: 1000 },
    { name: 'InWorldOffOp', operation: 'offline', inWorld: true, fresh: false, at: 1000 },
    { name: 'PracticeExcluded', practice: true, operation: 'observed', inWorld: true, fresh: true },
  ];

  require('./xp-tracker.js');
  const X = (globalThis as any).atlasXp;

  for (const isOwner of [true, false]) {
    const topOps = [
      "const isOwner=()=>window.atlasOperator?.()??true;",
      "const button=(text,action,value='',kind='')=>`<button data-op=\"${action}\" data-value=\"${E(value)}\">${E(text)}</button>`;",
      'const bots=()=>S?.bots?.filter(b=>!b.practice)||[];',
      "const title=(e,n,d)=>!isOwner()?'':`<div>${E(n)}</div>`;",
      'function issues(){return bots().filter(b=>[\'blocked\',\'failed\',\'died\',\'active-stale\',\'unobserved\'].includes(b.operation));}',
      "function page(h){return '<div class=\"op-page\">'+h+'</div>';}",
      "const allocation=()=>'unknown';const resultSummary=t=>E(t);const st=b=>b.operation==='observed'?['on','playing']:b.operation==='paused'?['off','paused']:['off',b.operation||'offline'];",
    ].join('\n');

    const runner = new Function(
      'S', 'window', 'document', 'E', 'nf', 'age', 'dur', 'safeName',
      `let fleetFilter='all',fleetQuery='',sel=null;${topOps}\n${fleetHelpers};return {fleet,setFilter:(f)=>{fleetFilter=f;}};`,
    )(
      { now: 2000, bots: mixedBots, world: { players: 12 }, results: [] },
      { atlasOperator: () => isOwner, atlasXp: X },
      doc, String, String, () => '1s', () => '1m', String,
    );

    body.innerHTML = runner.fleet();
    const chipCounts: Record<string, number> = Object.fromEntries(
      body.querySelectorAll('[data-fleet-filter-bar] button[data-op="fleet-filter"]').map(btn => [
        String(btn.getAttribute('data-value') || ''),
        Number(btn.querySelector('.op-count')?.textContent ?? '-1'),
      ]),
    );

    // Primary status partition sums cleanly to All
    const sum = (chipCounts.working || 0) + (chipCounts.attention || 0) + (chipCounts.paused || 0) + (chipCounts.held || 0);
    expect(sum).toBe(chipCounts.all);
    expect(chipCounts.all).toBe(8);
    expect(chipCounts.working).toBe(3);
    expect(chipCounts.inworld).toBe(5);
    expect(chipCounts.attention).toBe(2);
    expect(chipCounts.paused).toBe(1);
    expect(chipCounts.held).toBe(2);

    // Clicking each filter chip renders exact count of rows
    for (const [fk, expected] of Object.entries(chipCounts)) {
      runner.setFilter(fk!);
      body.innerHTML = runner.fleet();
      const rows = body.querySelectorAll('#op-fleet-list .fl-row[data-account-row]').length;
      expect(rows).toBe(expected);
    }

    // Playing vs In world distinction in fleetDeck for owner view
    if (isOwner) {
      expect(body.innerHTML).toContain('3<i> / 8</i>');
      expect(body.innerHTML).toContain('5 in world · 12 world players');
    }
  }
});

test('5. XP Tracker surfaces active training rates, TTL, EHP, and clear live/reported labels without a tick timeline', () => {
  require('./xp-tracker.js');
  const X = (globalThis as any).atlasXp;
  const code = shell.slice(shell.indexOf('  const XP_STORE='), shell.indexOf('  function commitCalcTarget('));
  const { doc, createEl } = makeDom('DIV');
  const body = createEl('DIV');
  const panel = createEl('DIV');
  panel.className = 'xp-tracker';
  body.append(panel);
  doc.body.append(body);

  let currentBot: any;
  let idleBots: any[] = [];
  const fn = new Function(
    'window', 'document', 'body', 'S', 'account', 'localStorage', 'E', 'nf', 'dur', 'asset', 'skillFile', 'safeName', 'put',
    'efficiencyBox', 'calcBox', 'trainedSkill', 'tickStrip', 'TICK_LABEL', 'bestSpot', 'skillActions', 'icon', 'sourcePin', 'gatherText', 'guideText',
    `let calcSkill=null,calcTarget=null,calcAccount=null,xpHideMaxed=false,xpSort='rate';${code};return {refreshXp};`,
  );
  const runRefresh = () => fn(
    { atlasXp: X, atlasOperator: () => false }, doc, body, { bots: idleBots, world: { tickMs: 400 } }, () => currentBot,
    { getItem: () => null, setItem: () => {} }, String, (n: number) => Math.round(n).toLocaleString('en-US'),
    (ms: number) => Math.round(ms / 60000) + 'm', (n: string) => n, (n: string) => n.toLowerCase(), String,
    (el: any, markup: string) => { el.innerHTML = markup; },
    () => '', () => '', () => null, () => '', {}, () => null, {}, () => '', null, () => '', () => '',
  ).refreshXp();

  // Case A: Hosted bot actively training Mining with no tick timeline and 0 local XP delta yet
  currentBot = {
    name: 'ProMiner',
    fresh: true,
    inWorld: true,
    xpPerHour: 48_000,
    rateSkill: 'Mining',
    goalSkill: 'Mining',
    goalLevel: 85,
    skills: [{ name: 'Mining', level: 70, xp: 750_000 }],
  };
  idleBots = [currentBot];
  runRefresh();
  const statsHtml = () => panel.querySelector('.xp-stats')!.innerHTML;
  const resultsHtml = () => panel.querySelector('.xp-results')!.innerHTML;
  expect(resultsHtml()).toContain('Mining');
  expect(resultsHtml()).toContain('48,000 XP/hr');
  expect(statsHtml()).toContain('Reported rate <b>48,000/hr</b>');
  expect(resultsHtml()).toContain('class="xp-rate-tag reported"');
  expect(resultsHtml()).toContain('TTL ');
  expect(resultsHtml()).toContain('% EHP)');

  // Case B: Remote/level-only account sharing xpPerHour + rateSkill without exact skill xp
  currentBot = {
    name: 'CloudFisher',
    fresh: true,
    remote: true,
    xpPerHour: 32_000,
    rateSkill: 'Fishing',
    skills: [{ name: 'Fishing', level: 80 }],
  };
  idleBots = [currentBot];
  runRefresh();
  expect(resultsHtml()).toContain('Fishing');
  expect(resultsHtml()).toContain('32,000 XP/hr');
  expect(resultsHtml()).toContain('class="xp-rate-tag reported"');
  expect(resultsHtml()).toContain('TTL ');

  // Ensure atlasPluginIdle does not hide XP Tracker when xpPerHour > 0
  const idleCheck = new Function('window', 'S', `${shell.slice(shell.indexOf('  window.atlasPluginIdle='), shell.indexOf('  // Only the tabs'))};return window.atlasPluginIdle('xp');`);
  expect(idleCheck({ atlasOperator: () => false }, { bots: [{ name: 'CloudFisher', remote: true, xpPerHour: 32_000 }] })).toBe(false);
});

test('6. Overlay renames public subheading to Fleet hiscores and advances Session clock only when live world feed confirms online', () => {
  const overlayCode = shell.slice(shell.indexOf('  function overlay(){'), shell.indexOf('  // Skills tab tooltip'));
  const boxCode = shell.slice(shell.indexOf('  function infoboxes(){'), shell.indexOf('  // Board progress'));

  const el = { _h: '', innerHTML: '', offsetTop: 10, offsetHeight: 120, style: {} as Record<string, string> };
  const ib = { _h: '', innerHTML: '', style: { top: '' } as Record<string, string> };
  const hud = { querySelector: (s: string) => (s === '.game-overlay' ? el : s === '.game-infoboxes' ? ib : null) };

  // Public fleet summary uses Fleet hiscores
  new Function(
    'S', 'account', 'hud', 'E', 'nf', 'gp', 'dur', 'age', 'ago', 'safeName', 'st', 'wildLevel', 'pvpState', 'inMulti', 'window',
    `${overlayCode};overlay();`,
  )(
    { bots: [{ name: 'A', operation: 'observed', fresh: true }], boards: [{ board: 'Mining', best: { rank: 1, name: 'A' } }] },
    () => null, hud, String, String, String, String, String, String, String, () => ['on', 'playing'], () => 0, () => null, () => false, { atlasOperator: () => false },
  );
  expect(el.innerHTML).toContain('<h4 class="race">Fleet hiscores</h4>');

  // Advancing Session timer between 10-minute snapshots when live world feed confirms online
  let mockNow = 10_000_000;
  const RealNow = Date.now;
  Date.now = () => mockNow;
  try {
    const bot = {
      name: 'MinerOne',
      inWorld: true,
      fresh: true,
      uptime: 120_000,
      at: mockNow - 300_000,
      live: { seen: mockNow - 1_500 },
      skills: [],
    };
    const S: any = { bots: [bot], roster: [['MinerOne', 3200, 3200, 0, 50]], clockOffset: 0, now: mockNow };
    const fmtDur = (ms: number) => `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
    const fmtAge = (at: number) => `${Math.floor(Math.max(0, mockNow - at) / 1000)}s`;
    const runBoth = () => {
      new Function(
        'S', 'account', 'hud', 'E', 'nf', 'gp', 'dur', 'age', 'ago', 'safeName', 'st', 'wildLevel', 'pvpState', 'inMulti', 'window',
        `${overlayCode};overlay();`,
      )(
        S, () => bot, hud, String, String, String, fmtDur, fmtAge, (ms: number) => `${Math.floor(ms / 1000)}s`, String,
        () => ['on', 'playing'], () => 0, () => null, () => false, { atlasOperator: () => false, atlasLiveRoster: () => true },
      );
      new Function('S', 'window', 'account', 'hud', 'E', 'asset', 'skillFile', 'dur', 'age', 'realSkill', `${boxCode};infoboxes();`)(
        S, { atlasLiveRoster: () => true }, () => bot, hud, String, (n: string) => n, (n: string) => n.toLowerCase(),
        fmtDur, String, () => true,
      );
    };

    runBoth();
    expect(el.innerHTML).toContain('<span>Session</span><b>7m 00s</b>');
    expect(ib.innerHTML).toContain('title="Session: 7m 00s"');

    // 15 seconds later without a new snapshot, Session timer advances cleanly to 7m 15s
    mockNow += 15_000;
    bot.live.seen = mockNow - 1_000;
    runBoth();
    expect(el.innerHTML).toContain('<span>Session</span><b>7m 15s</b>');

    // Without live world feed on a stale snapshot, clock stays frozen and marks stale
    delete (bot as any).live;
    S.roster = [];
    runBoth();
    expect(el.innerHTML).toContain('<span>Session</span><b>2m 00s (stale)</b>');
    expect(ib.innerHTML).toContain('title="Session (stale snapshot): 2m 00s"');

    // Offline account omits Session and uses lastSeen accurately
    const offBot = { name: 'MinerOne', inWorld: false, uptime: 120_000, lastSeen: mockNow - 45_000, at: mockNow - 315_000, skills: [] };
    new Function(
      'S', 'account', 'hud', 'E', 'nf', 'gp', 'dur', 'age', 'ago', 'safeName', 'st', 'wildLevel', 'pvpState', 'inMulti', 'window',
      `${overlayCode};overlay();`,
    )(
      { ...S, bots: [offBot] }, () => offBot, hud, String, String, String, fmtDur, fmtAge, (ms: number) => `${Math.floor(ms / 1000)}s`,
      String, () => ['off', 'offline'], () => 0, () => null, () => false, { atlasOperator: () => false },
    );
    expect(el.innerHTML).not.toContain('<span>Session</span>');
    expect(el.innerHTML).toContain('<span>Last seen</span><b>45s ago</b>');
  } finally {
    Date.now = RealNow;
  }
});

test('7. Chat log sorts merged messages chronologically across late snapshot arrivals, server offset, and equal timestamps', () => {
  const topSlice = shell.slice(shell.indexOf('  const chat=[],seen='), shell.indexOf("  // Game: fleet events"));
  const feedCode = shell.slice(shell.indexOf('  let welcomed=false;'), shell.indexOf('  // Desktop notifications'));
  const deathCode = shell.slice(shell.indexOf('  const deathsSeen='), shell.indexOf('  // Logins, logouts'));
  const logEl = { innerHTML: '', scrollHeight: 100, scrollTop: 100, clientHeight: 100, _h: '' };
  const hud = { querySelector: () => logEl };
  const S: any = { clockOffset: 5000, bots: [], events: [], results: [] };

  const runner = new Function(
    'S', 'hud', 'E', 'safeName', 'window', 'desktopNotify', 'shotFor',
    `const chatOff=new Set();${topSlice}\n${feedCode}\n${deathCode};return {chat,pushChat,chatFeed,deaths};`,
  )(S, hud, String, String, { atlasOperator: () => true, atlasHousekeeping: () => false, atlasJobName: String }, () => {}, () => {});

  const RealNow = Date.now;
  const now = 200_000;
  Date.now = () => now;
  try {
    S.events = [{ at: 105_000, name: 'Ann', text: 'First event' }];
    runner.chatFeed();
    runner.deaths();
    runner.pushChat({ kind: 'Public', name: 'Bob', text: 'Live line', at: 150_000 });

    // Equal-timestamp burst preserves _seq insertion tiebreaker
    runner.pushChat({ kind: 'Game', text: 'Equal A', at: 160_000 }, { kind: 'Game', text: 'Equal B', at: 160_000 });

    // Late snapshot / account-switch event arrives with an older server timestamp t=95000 (browser 90000) & death t=125000 (browser 120000)
    S.events.push({ at: 95_000, name: 'Ann', text: 'Older backfill event' });
    S.bots = [{ name: 'Ann', death: { at: 125_000, text: 'slain' } }];
    runner.chatFeed();
    runner.deaths();

    const texts = runner.chat.map((c: any) => `${c.at}:${c.text}`);
    expect(texts.indexOf('90000:Older backfill event')).toBeLessThan(texts.indexOf('100000:First event'));
    expect(texts.indexOf('100000:First event')).toBeLessThan(texts.indexOf('120000:Oh dear, you are dead!'));
    expect(texts.indexOf('120000:Oh dear, you are dead!')).toBeLessThan(texts.indexOf('150000:Live line'));
    expect(texts.indexOf('160000:Equal A')).toBeLessThan(texts.indexOf('160000:Equal B'));

    const firstIdx = logEl.innerHTML.indexOf('Older backfill event');
    const deathIdx = logEl.innerHTML.indexOf('Oh dear, you are dead!');
    const liveIdx = logEl.innerHTML.indexOf('Live line');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(deathIdx);
    expect(deathIdx).toBeLessThan(liveIdx);
  } finally {
    Date.now = RealNow;
  }
});

test('8. Collapsed sidebar sets aria-expanded=false, aria-hidden=true, inert, returns focus, and hides via CSS', () => {
  expect(css).toContain('.client-collapsed .client-plugin,.client-plugin[aria-hidden="true"]{display:none!important;visibility:hidden!important;opacity:0;transform:translateX(12px);pointer-events:none}');
  expect(css).toContain('.app:not(.mobile-plugin) .client-plugin{display:none!important;visibility:hidden!important;opacity:0;transform:translateX(12px);pointer-events:none}');

  const { doc, createEl, setActive } = makeDom('DIV');
  const app = createEl('DIV');
  const sidebarBtn = createEl('BUTTON');
  sidebarBtn.id = 'client-sidebar';
  const plugin = createEl('ASIDE');
  plugin.className = 'client-plugin';
  const innerBtn = createEl('BUTTON');
  plugin.append(innerBtn);
  app.append(sidebarBtn, plugin);
  doc.body.append(app);
  setActive(innerBtn);

  const syncCode = shell.slice(shell.indexOf('  const syncSidebar='), shell.indexOf('  function showPlugin('));
  const listeners: Record<string, any> = {};
  let narrow = false;
  const runSync = new Function(
    'app', 'plugin', 'document', 'window', '$', 'matchMedia', 'listeners',
    `${syncCode};return {syncSidebar};`,
  )(
    app, plugin, doc, {}, (s: string) => doc.querySelector(s),
    () => ({ get matches() { return narrow; }, addEventListener: (k: string, fn: any) => { listeners[k] = fn; } }),
    listeners,
  );
  runSync.setNarrow = (v: boolean) => { narrow = v; listeners.change?.(); };

  runSync.syncSidebar();
  expect(sidebarBtn.getAttribute('aria-expanded')).toBe('true');
  expect(plugin.getAttribute('aria-hidden')).toBe('false');
  expect(plugin.inert).toBe(false);

  app.classList.add('client-collapsed');
  runSync.syncSidebar();
  expect(sidebarBtn.getAttribute('aria-expanded')).toBe('false');
  expect(plugin.getAttribute('aria-hidden')).toBe('true');
  expect(plugin.inert).toBe(true);
  expect(doc.activeElement).toBe(sidebarBtn);

  app.classList.remove('client-collapsed');
  runSync.syncSidebar();
  expect(plugin.getAttribute('aria-hidden')).toBe('false');
  expect(plugin.inert).toBe(false);

  runSync.setNarrow(true);
  expect(plugin.getAttribute('aria-hidden')).toBe('true');
  expect(plugin.inert).toBe(true);
});

test('9. Asset/DOM/copy hygiene: no empty img src, crisp rev-289 Hiscores icons, clear GE counts, explicit Go label', () => {
  // 9a. Empty image omission in infoboxes() & shotsView
  const boxCode = shell.slice(shell.indexOf('  function infoboxes(){'), shell.indexOf('  // Board progress'));
  const el = { _h: '', innerHTML: '' };
  new Function('S', 'window', 'account', 'hud', 'E', 'asset', 'skillFile', 'dur', 'age', 'realSkill', `${boxCode};infoboxes();`)(
    { bots: [] }, {}, () => ({ name: 'NoUptime', inWorld: true, skills: [{ name: 'Attack', level: 40, currentLevel: 45 }] }),
    { querySelector: () => el }, String, (n: string) => (n.includes('attack') ? '' : n), (n: string) => n.toLowerCase(), String, String, () => true,
  );
  expect(el.innerHTML).not.toContain('src=""');

  const shotsSlice = ops.slice(ops.indexOf('  function shotsView(){'), ops.indexOf('  function flowBoxes('));
  const shotsHtml = new Function(
    'window', 'E', 'safeName', 'age', 'gp',
    `${shotsSlice};return shotsView();`,
  )(
    { atlasShots: () => ({ shots: [{ id: '1', name: 'Ann', text: 'Level 20', at: 1000, url: '' }, { id: '2', name: 'Bob', text: 'Death', at: 2000, url: '/shot.png' }], cfg: { level: true, death: true, loot: 0 } }) },
    String, String, () => '1s', String,
  );
  expect(shotsHtml).not.toContain('src=""');
  expect(shotsHtml).toContain('src="/shot.png"');

  // 9b. Hiscores bottom 3 tiles (Equipment, Bank, Runite) render real rev-289 assets instead of T/C/Ro text badges, even when S.icons is populated
  const script = extractHtmlScript(html);
  const iconSlice = script.slice(script.indexOf('const BOARD_ICONS='), script.indexOf('const ITEM_SPRITE_COUNT='));
  const keySlice = script.slice(script.indexOf('const boardKey='), script.indexOf('const liveBots='));
  const realIconSlice = script.slice(script.indexOf('function icon('), script.indexOf('// Stack numbers'));
  const boardUtils = new Function(
    'S', 'E', 'LOCAL_ITEMS', 'ITEM_SPRITE_COUNT',
    `const SKILL_ICONS={attack:'a'};${keySlice};${realIconSlice};${iconSlice};return {skillIcon,boardKey};`,
  )({ icons: { shark: 385 } }, String, { coins: 617, 'runite ore': 451 }, 4089);

  expect(boardUtils.boardKey('Equipment (worn value)')).toBe('equipment');
  expect(boardUtils.boardKey('Bank (bank value)')).toBe('bank');
  expect(boardUtils.boardKey('Lava Maze Runite (ores)')).toBe('runite');

  const equipHtml = boardUtils.skillIcon('Equipment (worn value)');
  const bankHtml = boardUtils.skillIcon('Bank (bank value)');
  const runiteHtml = boardUtils.skillIcon('Lava Maze Runite (ores)');
  expect(equipHtml).toContain('/client-assets/tab-equipment.png');
  expect(bankHtml).not.toContain('ico none');
  expect(runiteHtml).not.toContain('ico none');
  expect(bankHtml).toContain('class="ico"');
  expect(bankHtml).toContain('title="Coins"');
  expect(runiteHtml).toContain('class="ico"');
  expect(runiteHtml).toContain('title="Runite ore"');

  // Strict rev-289 skill list in client-shell.js (exactly 19 skills, no post-2004 skills)
  const skillsLine = shell.match(/const skills=\[([^\]]+)\];/)?.[1] || '';
  expect(skillsLine.split(',').length).toBe(19);
  for (const post2004 of ['Slayer', 'Farming', 'Construction', 'Hunter', 'Summoning']) {
    expect(skillsLine).not.toContain(post2004);
  }

  // 9c. Clear Grand Exchange counts
  const geCode = shell.slice(shell.indexOf('  let geQuery='), shell.indexOf('  // Pull requests plugin:'));
  const geFn = new Function(
    'S', 'window', 'E', 'nf', 'icon', 'age', 'alchOf', 'geSources',
    `${geCode};return {geResults,setAll:(v)=>{geAll=v;},setSort:(v)=>{geSort=v;}};`,
  )(
    { economy: { pricesAt: 1000, supplies: [{ id: 1, name: 'Shark', ask: 1000, bid: 950, vwap: 980, stock: 50 }, { id: 2, name: 'Empty', ask: null, bid: null, vwap: 0, stock: 0 }] } },
    { atlasOperator: () => false }, String, String, () => '', () => '1m', () => 0, () => '',
  );
  expect(geFn.geResults()[0]).toContain('Showing 1 of 1 items (active offers)');
  expect(geFn.geResults()[0]).toContain('Show 1 with no offer (2 total)');
  geFn.setAll(true);
  expect(geFn.geResults()[0]).toContain('Showing 2 of 2 items (1 active, 1 with no offer)');
  geFn.setSort('flip');
  expect(geFn.geResults()[0]).toContain('profitable');
  expect(geFn.geResults()[0]).not.toContain('data-ge-all');

  // 9d. Explicit Go button accessible label in map-shell.js
  expect(mapShell).toContain('id="atlas-go"');
  expect(mapShell).toContain('aria-label="Go to place"');
});

test('10. Performance (lazy heavy JSONs, rAF minimap coalescing, no wasted overlay layout reads) & Fleet Wall status states', async () => {
  // 10a. Booting npcDrops / opponentBox never fetches npc-drops.json until an NPC opponent appears, then caches it
  const fetched: string[] = [];
  const dropsSlice = shell.slice(shell.indexOf('  let npcNames=null'), shell.indexOf("  window.addEventListener('message',e=>{if(e.origin!==location.origin"));
  const { doc, createEl } = makeDom('DIV');
  const hud = createEl('DIV');
  doc.body.append(hud);
  const oppApi = new Function(
    'fetch', 'asset', 'hud', 'E', '$', 'window', 'document', 'AbortSignal',
    `${dropsSlice};return {opponentBox,hasDrops:()=>!!npcDrops};`,
  )(
    (url: string) => {
      fetched.push(url);
      if (url.includes('npc-names.json')) return Promise.resolve({ ok: true, json: async () => ({ 1: ['Man', 2] }) });
      if (url.includes('npc-drops.json')) return Promise.resolve({ ok: true, json: async () => ({ byId: { 1: [['Bones', 'always']] } }) });
      return Promise.resolve({ ok: false });
    },
    (n: string) => '/client-assets/' + n, hud, String, () => null, {}, doc, { timeout: () => undefined },
  );
  expect(fetched).toEqual([]);
  expect(oppApi.hasDrops()).toBe(false);

  // First NPC opponent triggers npc-names.json and npc-drops.json strictly on demand
  await oppApi.opponentBox({ kind: 'npc', type: 1, hp: [5, 7] });
  await Bun.sleep(0);
  expect(fetched.filter(u => u.includes('npc-drops.json'))).toHaveLength(1);
  expect(hud.querySelector('.game-opponent')!.innerHTML).toContain('Bones');

  // Second NPC encounter reuses cached tables without re-fetching
  await oppApi.opponentBox({ kind: 'npc', type: 1, hp: [3, 7] });
  expect(fetched.filter(u => u.includes('npc-drops.json'))).toHaveLength(1);
  expect(fetched.filter(u => u.includes('npc-names.json'))).toHaveLength(1);

  // item-sources.json and npc-spawns.json load strictly inside their lazy loaders, not at boot
  const bootJsonSection = shell.slice(shell.indexOf('  // NPC finder:'), shell.indexOf('  // The teleport (cast from anywhere)'));
  const bootFetches: string[] = [];
  new Function('fetch', 'asset', 'E', 'body', 'safeName', 'S', 'AbortSignal', 'AbortController', `${bootJsonSection};`)(
    (u: string) => { bootFetches.push(u); return Promise.resolve({ ok: false }); },
    (n: string) => n, String, { querySelector: () => null }, String, null, { timeout: () => undefined }, class { signal = {}; abort() {} },
  );
  expect(bootFetches).not.toContain('npc-spawns.json');
  expect(bootFetches).not.toContain('item-sources.json');

  // 10b. minimapSoon coalesces rapid calls in a single rAF callback
  const rafQueue: (() => void)[] = [];
  let draws = 0;
  const miniSlice = shell.slice(shell.indexOf('  let miniRaf=0;'), shell.indexOf('  const miniCanvas='));
  const miniRunner = new Function('minimap', 'requestAnimationFrame', `${miniSlice};return minimapSoon;`)(
    () => { draws++; },
    (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
  );
  miniRunner(); miniRunner(); miniRunner();
  expect(rafQueue).toHaveLength(1);
  expect(draws).toBe(0);
  rafQueue[0]();
  expect(draws).toBe(1);

  // 10c. overlay() does not read offsetHeight when HTML is unchanged
  let heightReads = 0;
  const overlayCode = shell.slice(shell.indexOf('  function overlay(){'), shell.indexOf('  // Skills tab tooltip'));
  const ovEl: any = { _h: '', innerHTML: '', offsetTop: 0, get offsetHeight() { heightReads++; return 90; } };
  const ovIb: any = { style: { top: '' } };
  const runOverlay = () => new Function('S', 'account', 'hud', 'E', 'nf', 'gp', 'dur', 'age', 'ago', 'safeName', 'st', 'wildLevel', 'pvpState', 'inMulti', 'window', `${overlayCode};overlay();`)(
    { bots: [{ name: 'A', operation: 'observed', fresh: true }] }, () => null,
    { querySelector: (s: string) => (s === '.game-overlay' ? ovEl : s === '.game-infoboxes' ? ovIb : null) },
    String, String, String, String, String, String, String, () => ['on', 'playing'], () => 0, () => null, () => false, { atlasOperator: () => true },
  );
  runOverlay();
  expect(heightReads).toBe(1);
  runOverlay();
  expect(heightReads).toBe(1);

  // 10d. Fleet Wall Connecting... / Loading map... / Offline labels and Wall · X of Y shown accuracy
  const focusCode = shell.slice(shell.indexOf('  function focusState(){'), shell.indexOf('  function focusRows(){'));
  const wallRoot = createEl('DIV');
  const wallTilesMap = new Map<string, any>();
  const wallObj: any = { names: ['Ann', 'Bob', 'Cat'], shown: 0, reported: false, seen: new Set(), offline: new Set(), layout: 'grid', focus: 'Ann', main: 'Ann' };
  const sForWall = { bots: [{ name: 'Ann', inWorld: true, fresh: true, phaseShort: 'Woodcutting' }, { name: 'Bob', inWorld: true }, { name: 'Cat', inWorld: true }] };
  const makeTile = () => ({
    el: createEl('DIV'), dot: createEl('I'), name: createEl('SPAN'), note: createEl('SPAN'), num: createEl('SPAN'),
    pin: createEl('BUTTON'), strip: createEl('DIV'), at: { x: 0, y: 0, w: 100, h: 100 },
  });
  const wallMsgCode = shell.slice(shell.indexOf('  function wallMessage('), shell.indexOf('  function wallClick('));
  const wallPaintCode = shell.slice(shell.indexOf('  function wallPaint('), shell.indexOf('  // The layout switcher'));
  const evalWall = new Function(
    'S', 'sel', 'focusLive', 'wall', 'phoneWidth', 'st', 'safeName', 'E', '$', 'wallRoot', 'wallGrip', 'wallGhost', 'wallTools', 'wallEdges', 'wallLayoutButtons', 'wallCycleButton', 'wallIcon', 'wallSvg', 'WALL_LAYOUT_NAMES', 'WALL_MAX', 'WALL_GAP', 'wallTiles', 'wallSame', 'wallRects', 'wallNextFrame', 'wallPress', 'wallLocked', 'wallShown', 'wallGaps', 'wallMoveTimer', 'focusPaint', 'window', 'wallClock',
    `let wallDrag=null,wallSize=null,wallEdge=null;
     const wallStill=()=>true;
     ${wallMsgCode};
     ${wallPaintCode};
     ${focusCode};
     return {wallMessage,wallPaint,focusState};`,
  )(
    sForWall, 'Ann', () => sForWall.bots, wallObj, { matches: false }, (b: any) => [b.fresh ? 'on' : 'off', b.fresh ? 'playing' : 'idle'], String, String,
    () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }), wallRoot, createEl('DIV'), createEl('DIV'), { hidden: true }, [], [], { dataset: {} }, {}, () => '', {}, 16, 4, wallTilesMap,
    (a: string, b: string) => a.toLowerCase() === b.toLowerCase(), () => null, () => {}, () => false, () => false, () => wallObj.names, () => [], 0, () => {}, {}, () => Date.now(),
  );

  for (const name of wallObj.names) wallTilesMap.set(name, makeTile());
  evalWall.wallPaint();
  expect(wallTilesMap.get('Ann').note.textContent).toBe('Connecting…');
  expect(evalWall.focusState()[0]).toBe('Wall · 0 of 3 shown');

  evalWall.wallMessage({ viewerMulti: { names: ['Ann', 'Bob', 'Cat'], shown: ['Ann', 'Cat'], offline: ['Cat'] } });
  expect(wallTilesMap.get('Ann').note.textContent).toBe('Woodcutting');
  expect(wallTilesMap.get('Bob').note.textContent).toBe('Loading map…');
  expect(wallTilesMap.get('Cat').note.textContent).toBe('Offline');
  expect(evalWall.focusState()[0]).toBe('Wall · 1 of 3 shown');
});

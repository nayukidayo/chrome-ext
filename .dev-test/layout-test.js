// 布局逻辑回归测试：在桩 DOM 中运行 content/translate.js 的真实函数
// 运行：node .dev-test/layout-test.js

const fs = require('fs');
const vm = require('vm');

const SOURCE = fs
  .readFileSync('content/translate.js', 'utf8')
  .replace(
    /\}\)\(\);\s*$/,
    `globalThis.__test = { isPanelClipped, placeFloat, enterFloatMode, exitFloatMode, tryHoist, canHostPanel };
})();\n`
  );

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${
      ok ? '' : `  <- 期望 ${JSON.stringify(expected)}`
    }`
  );
  if (ok) pass++;
  else fail++;
};

/** 把 {top,left,width,height} 补全成带 right/bottom 的 DOMRect 形状 */
function rect({ top, left, width, height }) {
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

function makeEl(name, spec, cs = {}) {
  const box = rect(spec);
  const style = {};
  const node = {
    nodeName: name.toUpperCase(),
    nodeType: 1,
    isConnected: true,
    parentElement: null,
    children: [],
    style,
    dataset: {},
    hidden: false,
    attributes: new Set(),
    clientTop: cs.clientTop ?? 0,
    clientLeft: cs.clientLeft ?? 0,
    clientHeight: cs.clientHeight ?? box.height,
    clientWidth: cs.clientWidth ?? box.width,
    scrollTop: 0,
    __box: box,
    __onAttach: null,
    getBoundingClientRect() {
      return node.__box;
    },
    get nextSibling() {
      const p = node.parentElement;
      if (!p) return null;
      const i = p.children.indexOf(node);
      return i < 0 ? null : p.children[i + 1] || null;
    },
    __cs: {
      overflowX: 'visible',
      overflowY: 'visible',
      contain: 'none',
      clipPath: 'none',
      maskImage: 'none',
      contentVisibility: 'visible',
      display: 'block',
      position: 'static',
      ...cs
    },
    matches: (sel) => sel === ':popover-open' && node.attributes.has('open'),
    showPopover() {
      node.attributes.add('open');
    },
    hidePopover() {
      node.attributes.delete('open');
    },
    setAttribute(k) {
      node.attributes.add(k);
    },
    removeAttribute(k) {
      node.attributes.delete(k);
    },
    appendChild(child) {
      return node.insertBefore(child, null);
    },
    insertBefore(child, ref) {
      const prev = child.parentElement;
      if (prev) {
        const i = prev.children.indexOf(child);
        if (i >= 0) prev.children.splice(i, 1);
      }
      const at = ref ? node.children.indexOf(ref) : -1;
      if (at >= 0) node.children.splice(at, 0, child);
      else node.children.push(child);

      child.parentElement = node;
      child.isConnected = true;
      if (typeof child.__onAttach === 'function') child.__onAttach(node);
      return child;
    },
    remove() {
      const p = node.parentElement;
      if (p) {
        const i = p.children.indexOf(node);
        if (i >= 0) p.children.splice(i, 1);
      }
      node.parentElement = null;
      node.isConnected = false;
    }
  };
  Object.defineProperty(style, 'cssText', {
    get: () => style.__text || '',
    set: (v) => {
      style.__text = v;
    }
  });
  return node;
}

/** 用指定视口尺寸跑一份 translate.js，返回内部函数与环境 */
function createEnv(vw, vh) {
  const docEl = makeEl('html', { top: 0, left: 0, width: vw, height: vh });
  docEl.clientWidth = vw;
  docEl.clientHeight = vh;
  const body = makeEl('body', { top: 0, left: 0, width: vw, height: vh });
  body.parentElement = docEl;

  const listeners = new Set();
  const sandbox = {
    console,
    // 元素遍历用到的全局常量
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: { documentElement: docEl, body, caretRangeFromPoint: () => null },
    getComputedStyle: (node) => node.__cs,
    window: {
      innerWidth: vw,
      innerHeight: vh,
      addEventListener: (type, fn, capture) => listeners.add(`${type}:${capture === true}`),
      removeEventListener: (type, fn, capture) => listeners.delete(`${type}:${capture === true}`)
    },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: {
      runtime: { lastError: null },
      storage: { sync: { get: (d, cb) => cb(d) }, onChanged: { addListener() {} } }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  return { t: sandbox.__test, body, docEl, listeners, baseline: new Set(listeners) };
}

const env = createEnv(1000, 800);
const t = env.t;
const body = env.body;

/* ---------- 场景 1：固定高度 + overflow:hidden 的容器 ---------- */
{
  const clipper = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 70 },
    { overflowY: 'hidden', clientHeight: 70, clientWidth: 600 }
  );
  clipper.parentElement = body;

  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 60 });
  block.parentElement = clipper;

  const overflowHost = makeEl('hymt-panel', { top: 64, left: 0, width: 600, height: 80 });
  check('固定高度容器内溢出 -> 被裁剪', t.isPanelClipped({ block, host: overflowHost }), true);

  const insideHost = makeEl('hymt-panel', { top: 5, left: 0, width: 600, height: 30 });
  check('面板完全在容器内 -> 不浮层', t.isPanelClipped({ block, host: insideHost }), false);
}

/* ---------- 场景 2：line-clamp（段落自身裁剪自己） ---------- */
{
  const clamped = makeEl(
    'p',
    { top: 0, left: 0, width: 600, height: 63 },
    { overflowY: 'hidden', display: '-webkit-box', clientHeight: 63, clientWidth: 600 }
  );
  clamped.parentElement = body;
  const host = makeEl('hymt-panel', { top: 60, left: 0, width: 600, height: 40 });
  check('段落自身 line-clamp -> 被裁剪', t.isPanelClipped({ block: clamped, host }), true);
}

/* ---------- 场景 3：普通页面不应浮层 ---------- */
{
  const p = makeEl('p', { top: 100, left: 40, width: 700, height: 80 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 186, left: 40, width: 700, height: 60 });
  check('普通文档流 -> 不浮层', t.isPanelClipped({ block: p, host }), false);
}

/* ---------- 场景 4：contain:paint 祖先越界 ---------- */
{
  const card = makeEl('div', { top: 0, left: 0, width: 500, height: 200 }, { contain: 'paint' });
  card.parentElement = body;
  const p = makeEl('p', { top: 10, left: 0, width: 500, height: 40 });
  p.parentElement = card;

  const overHost = makeEl('hymt-panel', { top: 60, left: 0, width: 500, height: 180 });
  check('contain:paint 越界 -> 被裁剪', t.isPanelClipped({ block: p, host: overHost }), true);

  const fitHost = makeEl('hymt-panel', { top: 60, left: 0, width: 500, height: 100 });
  check('contain:paint 未越界 -> 不浮层', t.isPanelClipped({ block: p, host: fitHost }), false);
}

/* ---------- 场景 5：浮层定位，下方放得下 ---------- */
{
  const p = makeEl('p', { top: 100, left: 50, width: 400, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 400, height: 80 });

  t.placeFloat({ floating: true, block: p, host });
  check('下方放得下 -> 贴段落底部 + 间距', host.style.top, '148px');
  check('水平对齐段落左边', host.style.left, '50px');
  check('宽度跟随段落', host.style.width, '400px');
}

/* ---------- 场景 6：下方空间不足时向上翻转 ---------- */
{
  const p = makeEl('p', { top: 700, left: 50, width: 400, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 400, height: 80 });
  t.placeFloat({ floating: true, block: p, host });
  check('下方放不下 -> 翻到段路上方', host.style.top, '612px');
}

/* ---------- 场景 7：靠右 / 超宽时夹进视口 ---------- */
{
  const p = makeEl('p', { top: 100, left: 900, width: 600, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 600, height: 80 });
  t.placeFloat({ floating: true, block: p, host });
  check('宽度取段落宽度', host.style.width, '600px');
  check('左边距夹进视口', host.style.left, '392px');
}

{
  const p = makeEl('p', { top: 100, left: 0, width: 4000, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 4000, height: 80 });
  t.placeFloat({ floating: true, block: p, host });
  check('超宽段落 -> 宽度封顶 640', host.style.width, '640px');
}

/* ---------- 场景 8：进入/退出浮层的事件与属性清理 ---------- */
{
  const p = makeEl('p', { top: 100, left: 0, width: 500, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 500, height: 60 });
  const record = { floating: false, visible: true, block: p, host, destroyed: false, floatFrame: 0 };

  t.enterFloatMode(record);
  check('进入浮层 -> floating 标记', record.floating, true);
  check('进入浮层 -> 设置 popover 属性', host.attributes.has('popover'), true);
  check('进入浮层 -> 打上 data-floating', 'floating' in host.dataset, true);
  check(
    '进入浮层 -> 新增 scroll/resize/keydown 监听',
    [...env.listeners].filter((k) => !env.baseline.has(k)).sort(),
    ['keydown:true', 'resize:false', 'scroll:true']
  );

  t.exitFloatMode(record);
  check('退出浮层 -> floating 清除', record.floating, false);
  check('退出浮层 -> 移除 popover 属性', host.attributes.has('popover'), false);
  check('退出浮层 -> 移除 data-floating', 'floating' in host.dataset, false);
  check('退出浮层 -> 内联样式已还原', host.style.cssText, '');
  check(
    '退出浮层 -> 注销全部新增监听',
    [...env.listeners].filter((k) => !env.baseline.has(k)),
    []
  );
}

/* ---------- 场景 9：重复进入/退出不残留 ---------- */
{
  const p = makeEl('p', { top: 100, left: 0, width: 500, height: 40 });
  p.parentElement = body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 500, height: 60 });
  const record = { floating: false, visible: true, block: p, host, destroyed: false, floatFrame: 0 };

  t.enterFloatMode(record);
  t.enterFloatMode(record);
  t.exitFloatMode(record);
  t.exitFloatMode(record);
  check('重复调用后无残留监听', [...env.listeners].filter((k) => !env.baseline.has(k)), []);
  check('重复调用后 floating 为 false', record.floating, false);
}

/* ---------- 场景 10：极窄视口下宽度仍不超出 ---------- */
{
  const narrow = createEnv(200, 600);
  const p = makeEl('p', { top: 50, left: 0, width: 400, height: 40 });
  p.parentElement = narrow.body;
  const host = makeEl('hymt-panel', { top: 0, left: 0, width: 400, height: 60 });

  narrow.t.placeFloat({ floating: true, block: p, host });
  check('200px 视口 -> 宽度夹到 184', host.style.width, '184px');
  check('200px 视口 -> 左边距', host.style.left, '8px');
}

/* ---------- 场景 11：YouTube 式 body（高度 0 + overflow: scroll）不应浮层 ---------- */
// 回归用例：ytd-app 是 fixed，body 撑不开，导致 body.clientHeight = 0、
// rect.bottom 为负数。旧实现把 body 当裁剪容器，任何面板都会被判定为“被裁剪”。
{
  const yt = createEnv(1000, 800);
  const b = yt.body;
  b.clientHeight = 0;
  b.getBoundingClientRect = () => rect({ top: -1400, left: 0, width: 1000, height: 0 });
  b.__cs = { ...b.__cs, overflowY: 'scroll', overflowX: 'auto' };

  const wrap = makeEl('div', { top: 599, left: 0, width: 600, height: 140 });
  wrap.parentElement = b;
  const block = makeEl('p', { top: 621, left: 0, width: 600, height: 20 });
  block.parentElement = wrap;
  const host = makeEl('hymt-panel', { top: 641, left: 0, width: 600, height: 100 });

  check('YouTube 式 body（高度0 + scroll）-> 不浮层', yt.t.isPanelClipped({ block, host }), false);
}

/* ---------- 场景 12：可滚动容器不算裁剪，应改用滚动 ---------- */
{
  const scroller = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 90 },
    { overflowY: 'auto', clientHeight: 90 }
  );
  scroller.parentElement = body;
  const block = makeEl('p', { top: 10, left: 0, width: 600, height: 40 });
  block.parentElement = scroller;
  const host = makeEl('hymt-panel', { top: 50, left: 0, width: 600, height: 150 });
  check('overflow:auto 溢出 -> 不算裁剪', t.isPanelClipped({ block, host }), false);
}

/* ---------- 场景 13：overflow: clip 同样算裁剪 ---------- */
{
  const clipEl = makeEl('div', { top: 0, left: 0, width: 600, height: 70 }, { overflowY: 'clip' });
  clipEl.parentElement = body;
  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  block.parentElement = clipEl;
  const host = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 100 });
  check('overflow:clip 溢出 -> 被裁剪', t.isPanelClipped({ block, host }), true);
}

/* ---------- 场景 14：容差内的轻微溢出不浮层 ---------- */
{
  const almost = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden' }
  );
  almost.parentElement = body;
  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  block.parentElement = almost;
  // 面板底部 101，比容器多 1px，小于 CLIP_TOLERANCE(2px)
  const host = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 61 });
  check('溢出 1px -> 容差内不浮层', t.isPanelClipped({ block, host }), false);
}

/* ---------- 场景 15：裁剪边界是 padding box，要扣掉边框 ---------- */
{
  const bordered = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden', borderBottomWidth: '10px' }
  );
  bordered.parentElement = body;
  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  block.parentElement = bordered;

  // padding box 底部 = 100 - 10 = 90
  const fits = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 48 });
  check('边框内仍放得下 -> 不浮层', t.isPanelClipped({ block, host: fits }), false);

  const over = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 55 });
  check('超出 padding box -> 被裁剪', t.isPanelClipped({ block, host: over }), true);
}

/* ---------- 场景 16：被裁剪时向上提升到不裁剪的祖先（仍是文档流） ---------- */
{
  const outer = makeEl('div', { top: 0, left: 0, width: 600, height: 400 });
  outer.parentElement = body;

  const clipper = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden' }
  );
  outer.appendChild(clipper);

  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  clipper.appendChild(block);

  const host = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 120 });
  // 模拟真实布局：面板在裁剪容器内会被切，在容器外则整体下移
  host.__onAttach = (parent) => {
    host.__box =
      parent === outer
        ? rect({ top: 100, left: 0, width: 600, height: 120 })
        : rect({ top: 40, left: 0, width: 600, height: 120 });
  };
  block.appendChild(host);

  const record = { floating: false, visible: true, block, host, destroyed: false, floatFrame: 0 };

  check('提升前 -> 被裁剪', t.isPanelClipped(record), true);
  check('向上提升成功', t.tryHoist(record), true);
  check('提升后父节点是外层容器', host.parentElement === outer, true);
  check(
    '提升后紧跟承载块之后',
    outer.children.indexOf(host) === outer.children.indexOf(clipper) + 1,
    true
  );
  check('提升后不再被裁剪', t.isPanelClipped(record), false);
}

/* ---------- 场景 17：多层裁剪时继续向上提升到 body ---------- */
{
  const outer = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden' }
  );
  body.appendChild(outer);

  const inner = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden' }
  );
  outer.appendChild(inner);

  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  inner.appendChild(block);

  const host = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 120 });
  block.appendChild(host);

  const record = { floating: false, visible: true, block, host, destroyed: false, floatFrame: 0 };

  check('多层裁剪 -> 一路提升到 body', t.tryHoist(record), true);
  check('提升到 body 后紧跟裁剪容器', host.parentElement === body && body.children.indexOf(host) === body.children.indexOf(outer) + 1, true);
}

/* ---------- 场景 18：flex row 容器不能承载面板 ---------- */
{
  const row = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { display: 'flex', flexDirection: 'row' }
  );
  check('flex row -> 不可承载', t.canHostPanel(row), false);

  const col = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { display: 'flex', flexDirection: 'column' }
  );
  check('flex column -> 可承载', t.canHostPanel(col), true);

  const plain = makeEl('div', { top: 0, left: 0, width: 600, height: 100 }, { display: 'block' });
  check('block -> 可承载', t.canHostPanel(plain), true);

  const inline = makeEl('span', { top: 0, left: 0, width: 600, height: 100 }, { display: 'inline' });
  check('inline -> 不可承载', t.canHostPanel(inline), false);
}

/* ---------- 场景 19：外层无可提升目标时提升到 body（仍内嵌） ---------- */
{
  const clipper = makeEl(
    'div',
    { top: 0, left: 0, width: 600, height: 100 },
    { overflowY: 'hidden' }
  );
  body.appendChild(clipper);

  const block = makeEl('p', { top: 0, left: 0, width: 600, height: 40 });
  clipper.appendChild(block);

  const host = makeEl('hymt-panel', { top: 40, left: 0, width: 600, height: 120 });
  host.__onAttach = (parent) => {
    host.__box =
      parent === body
        ? rect({ top: 100, left: 0, width: 600, height: 120 })
        : rect({ top: 40, left: 0, width: 600, height: 120 });
  };
  block.appendChild(host);

  const record = { floating: false, visible: true, block, host, destroyed: false, floatFrame: 0 };
  check('提升到 body 成功', t.tryHoist(record), true);
  check('提升后父节点是 body', host.parentElement === body, true);
  check('提升到 body 后不浮层', t.isPanelClipped(record), false);
}

/* ---------- 场景 20：要脱离的是定位容器（弹层）时不做提升，改用浮层 ---------- */
{
  const overlay = makeEl(
    'div',
    { top: 0, left: 0, width: 300, height: 60 },
    { overflowY: 'hidden', position: 'fixed' }
  );
  body.appendChild(overlay);

  const block = makeEl('p', { top: 0, left: 0, width: 300, height: 20 });
  overlay.appendChild(block);

  const host = makeEl('hymt-panel', { top: 20, left: 0, width: 300, height: 120 });
  block.appendChild(host);

  const record = { floating: false, visible: true, block, host, destroyed: false, floatFrame: 0 };
  check('定位容器内不提升到 body', t.tryHoist(record), false);
  check('失败后放回原位（交由浮层）', host.parentElement === block, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

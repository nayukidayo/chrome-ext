/**
 * 段落翻译内容脚本
 *
 * - 按住 Ctrl 并左键点击网页段落 → 在该段落末尾插入译文卡片
 * - 再次 Ctrl + 点击同一段落 → 隐藏译文（译文已缓存，再点即可恢复显示）
 *
 * 实现要点：
 * - 通过 caretRangeFromPoint 取得鼠标所在文字节点，向上找到最近的块级容器作为「段落」
 * - 译文面板使用自定义元素 + Shadow DOM + 构造式样式表，避免被页面样式 / CSP 干扰
 * - 样式表与模板在全文档内只解析一次，所有面板实例共享
 * - 面板内容全部使用 textContent 写入，不注入任何 HTML
 * - 段落被固定高度 / overflow / line-clamp 等容器裁剪时，自动改用 Popover 顶层浮层显示
 */

(() => {
  'use strict';

  if (window.__hymtTranslateInjected) return;
  window.__hymtTranslateInjected = true;

  const PANEL_TAG = 'hymt-panel';
  const PANEL_TAG_UPPER = 'HYMT-PANEL';
  const MODEL_LABEL = 'hy-mt2-lite';
  const TARGET_LANG = '中文';
  const MAX_SOURCE_CHARS = 2000;

  /** 这些元素上的 Ctrl+点击保持浏览器原生行为（新标签打开、按钮点击等） */
  const SKIP_ANCESTOR = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'label',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]'
  ].join(',');

  const BLOCK_DISPLAYS = new Set([
    'block',
    'list-item',
    'table-cell',
    'table-caption',
    'flow-root',
    'flex',
    'grid',
    'inline-block',
    'inline-flex',
    'inline-grid',
    'inline-table'
  ]);

  const HAS_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const NON_CJK_LETTER =
    /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0530-\u058f\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/;

  /** 浮层模式：贴住段落的间距、宽高限制 */
  const FLOAT_GAP = 8;
  const FLOAT_MAX_WIDTH = 640;
  const FLOAT_MIN_WIDTH = 220;
  /** 小于该像素数的“裁剪”视为舍入误差，不触发浮层 */
  const CLIP_TOLERANCE = 2;
  /** 被裁剪时最多向上提升几层去寻找可容纳面板的祖先 */
  const MAX_HOIST_STEPS = 6;

  /** 可以直接承载面板（面板会作为块级元素参与布局）的 display 值 */
  const HOSTABLE_DISPLAYS = new Set([
    'block',
    'flow-root',
    'list-item',
    'table-cell',
    'table-caption',
    'inline-block',
    'inline-flow-root'
  ]);
  const STACK_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

  const PANEL_CSS = `
    :host {
      all: initial;
      display: block;
    }
    :host([hidden]) {
      display: none !important;
    }
    .card {
      margin: 8px 0 12px;
      padding: 8px 12px 10px;
      border-left: 3px solid #1877f2;
      border-radius: 6px;
      background: #eef4ff;
      color: #1a1a1a;
      font: 14px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      text-align: left;
      letter-spacing: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      animation: hymt-in 0.16s ease-out;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 2px;
      font-size: 12px;
      line-height: 1.6;
      color: #5f6b7a;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      background: #1877f2;
      color: #fff;
      font-size: 11px;
      line-height: 1;
    }
    .meta {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .spacer {
      flex: 1 1 auto;
    }
    .btn {
      border: 0;
      margin: 0;
      padding: 0 2px;
      background: transparent;
      color: #5f6b7a;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .btn:hover {
      color: #1877f2;
      text-decoration: underline;
    }
    .body {
      white-space: pre-wrap;
    }
    .body.error {
      color: #c0392b;
    }
    .spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 6px;
      border: 2px solid #b9cbe8;
      border-top-color: #1877f2;
      border-radius: 50%;
      vertical-align: -1px;
      animation: hymt-spin 0.8s linear infinite;
    }
    @keyframes hymt-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes hymt-in {
      from {
        opacity: 0;
        transform: translateY(-2px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    /* 浮层模式：进入 top layer，不受任何祖先裁剪 / transform / z-index 影响 */
    :host([data-floating]) {
      position: fixed;
      inset: auto;
      margin: 0;
      padding: 0;
      border: 0;
      width: auto;
      height: auto;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      overflow: visible;
      background: transparent;
      z-index: 2147483647;
    }
    :host([data-floating]) .card {
      margin: 0;
      max-height: calc(100vh - 16px);
      overflow: auto;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
      animation: hymt-in 0.12s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #1b2430;
        color: #e6edf3;
        border-left-color: #4c8dff;
      }
      .bar,
      .btn {
        color: #9aa7b4;
      }
      .body.error {
        color: #ff8a80;
      }
      .spinner {
        border-color: #31415a;
        border-top-color: #4c8dff;
      }
    }
  `;

  const PANEL_HTML = `
    <div class="card" part="card">
      <div class="bar">
        <span class="tag">译</span>
        <span class="meta">${MODEL_LABEL}</span>
        <span class="spacer"></span>
        <button type="button" class="btn retry" hidden>重试</button>
        <button type="button" class="btn hide">隐藏</button>
      </div>
      <div class="body"></div>
    </div>
  `;

  /* ==========================================================================
   * 共享资源：样式表 / 模板
   *
   * 同一个构造式样式表可以被任意多个 ShadowRoot 同时 adopt，改动会同步到所有
   * 采用它的 root，所以整篇文档只需要解析一次 CSS。限制是 sheet 必须在本
   * Document 内构造：内容脚本以 all_frames 注入，每个 iframe 各自持有一份即
   * 每个 document 一份，正好符合要求。
   * ======================================================================== */

  let panelSheet = null;

  /** 取共享样式表（minimum_chrome_version 156 已保证构造式样式表可用） */
  function getPanelSheet() {
    if (!panelSheet) {
      panelSheet = new CSSStyleSheet();
      panelSheet.replaceSync(PANEL_CSS);
    }
    return panelSheet;
  }

  /** PANEL_HTML 只解析一次，之后靠 cloneNode 复制 */
  const panelTemplate = document.createElement('template');
  panelTemplate.innerHTML = PANEL_HTML;

  /** block -> record */
  const records = new WeakMap();
  const liveRecords = new Set();
  const state = { enabled: true };
  let pendingBlock = null;

  /* ==========================================================================
   * 设置
   * ======================================================================== */

  function applyEnabled(enabled) {
    state.enabled = enabled !== false;
    if (!state.enabled) hideAll();
  }

  try {
    chrome.storage.sync.get({ translateEnabled: true }, (value) => {
      if (chrome.runtime.lastError) return;
      applyEnabled(value.translateEnabled);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.translateEnabled) return;
      applyEnabled(changes.translateEnabled.newValue);
    });
  } catch (error) {
    console.warn('[HY-MT] 读取设置失败：', error);
  }

  /* ==========================================================================
   * DOM 工具
   * ======================================================================== */

  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  function isOwnPanel(node) {
    let current = node;
    while (current) {
      if (current.nodeName === PANEL_TAG_UPPER) return true;
      current = parentOf(current);
    }
    return false;
  }

  function isOwnPanelEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some((node) => node && node.nodeName === PANEL_TAG_UPPER);
  }

  /** 鼠标位置对应的元素 */
  function elementAtPoint(x, y) {
    let node = null;

    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y);
      if (range) node = range.startContainer;
    }
    if (!node && typeof document.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(x, y);
      if (position) node = position.offsetNode;
    }
    if (!node) node = document.elementFromPoint(x, y);
    if (!node) return null;

    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  /** 向上找到最近的、真正承载文字的块级容器 */
  function findBlock(startEl) {
    let node = startEl;

    while (node && node !== document.body && node !== document.documentElement) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const display = getComputedStyle(node).display;
        if (display === 'none') return null;
        if (BLOCK_DISPLAYS.has(display) && (node.innerText || '').trim()) return node;
      }
      node = parentOf(node);
    }

    return null;
  }

  function resolveBlockAt(x, y) {
    const element = elementAtPoint(x, y);
    if (!element || !element.closest) return null;
    if (isOwnPanel(element)) return null;
    if (element.closest(SKIP_ANCESTOR)) return null;

    const block = findBlock(element);
    if (!block) return null;
    if (block.isContentEditable) return null;
    if (block.closest('pre, code, kbd, samp, svg, math')) return null;

    return block;
  }

  /* ==========================================================================
   * 取原文
   * ======================================================================== */

  function extractSource(block) {
    // 取原文时先把所有已显示的译文面板藏起来（含嵌套段落里的），避免把译文当成原文
    const hiddenRecords = [];
    for (const record of liveRecords) {
      if (!record.host.hidden) {
        record.host.hidden = true;
        hiddenRecords.push(record);
      }
    }

    let text = '';
    try {
      text = block.innerText || block.textContent || '';
    } finally {
      for (const record of hiddenRecords) record.host.hidden = false;
    }

    text = text
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let truncated = false;
    if (text.length > MAX_SOURCE_CHARS) {
      text = text.slice(0, MAX_SOURCE_CHARS);
      const cut = text.lastIndexOf(' ');
      if (cut > MAX_SOURCE_CHARS * 0.6) text = text.slice(0, cut);
      truncated = true;
    }

    return { text, truncated };
  }

  /** 纯中文段落不需要再翻译（混有拉丁 / 假名 / 谚文等则照常翻译） */
  function needsTranslation(text) {
    if (!HAS_CJK.test(text)) return true;
    return NON_CJK_LETTER.test(text);
  }

  /* ==========================================================================
   * 面板
   * ======================================================================== */

  function createRecord(block) {
    const host = document.createElement(PANEL_TAG);
    host.hidden = true;

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = [getPanelSheet()];

    shadow.appendChild(panelTemplate.content.cloneNode(true));

    const record = {
      block,
      host,
      body: shadow.querySelector('.body'),
      meta: shadow.querySelector('.meta'),
      retryBtn: shadow.querySelector('.retry'),
      hideBtn: shadow.querySelector('.hide'),
      status: 'idle',
      visible: false,
      source: '',
      translation: '',
      truncated: false,
      destroyed: false,
      // 布局相关
      floating: false,
      layoutFrame: 0,
      floatFrame: 0,
      onViewportChange: null,
      onKeydown: null,
      resizeObserver: null
    };

    record.hideBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideRecord(record);
    });

    record.retryBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (record.status === 'error') void requestTranslation(record);
    });

    block.appendChild(host);
    return record;
  }

  /* ==========================================================================
   * 布局：裁剪检测 / 浮层定位
   *
   * 面板默认按文档流插在段落末尾。若段落自身或祖先有裁剪（固定高度 + overflow、
   * -webkit-line-clamp、contain:paint、clip-path 等），面板会被切掉，
   * 此时改用 Popover API 把面板提升到 top layer，彻底摆脱祖先裁剪。
   * ======================================================================== */

  function viewportWidth() {
    return document.documentElement.clientWidth || window.innerWidth;
  }

  function viewportHeight() {
    return document.documentElement.clientHeight || window.innerHeight;
  }

  /** 该元素是否会对后代做像素级裁剪（与 overflow 无关的那些） */
  function clipsPaint(cs) {
    if (cs.contain && /paint|strict|content/.test(cs.contain)) return true;
    if (cs.clipPath && cs.clipPath !== 'none') return true;
    if (cs.maskImage && cs.maskImage !== 'none') return true;
    return cs.contentVisibility === 'hidden';
  }

  /**
   * overflow 是否会直接裁掉内容。
   * auto / scroll / overlay 是可以滚到面板的，不算裁剪（由 nudgeIntoView 处理）。
   */
  function clipsOverflow(value) {
    return value === 'hidden' || value === 'clip';
  }

  /** 溢出裁剪的边界是 padding box，用 rect 减边框算出来（对 transform / 小数尺寸更稳） */
  function paddingBox(cs, rect) {
    const edge = (value) => parseFloat(value) || 0;
    return {
      top: rect.top + edge(cs.borderTopWidth),
      bottom: rect.bottom - edge(cs.borderBottomWidth),
      left: rect.left + edge(cs.borderLeftWidth),
      right: rect.right - edge(cs.borderRightWidth)
    };
  }

  /** 面板是否被某个祖先（含段落自身）的裁剪框切掉 */
  function isPanelClipped(record) {
    const host = record.host;
    if (!host.isConnected) return false;

    const box = host.getBoundingClientRect();
    if (box.height < 1) return false;

    // 从面板自身的位置向上走（面板可能已被提升到更高的祖先）
    const start = host.parentElement || record.block;
    for (let node = start; node; node = node.parentElement) {
      // body / html 不是“裁剪容器”：它们的自身盒可能高度为 0
      // （例如 YouTube 的 ytd-app 是 fixed，body 撑不开），
      // 而它们的内容超出视口只是正常滚动，不应触发浮层。
      if (node === document.body || node === document.documentElement) break;

      const cs = getComputedStyle(node);
      const rect = node.getBoundingClientRect();

      if (clipsOverflow(cs.overflowY) || clipsOverflow(cs.overflowX)) {
        const pad = paddingBox(cs, rect);
        if (
          (clipsOverflow(cs.overflowY) &&
            (box.bottom > pad.bottom + CLIP_TOLERANCE || box.top < pad.top - CLIP_TOLERANCE)) ||
          (clipsOverflow(cs.overflowX) &&
            (box.right > pad.right + CLIP_TOLERANCE || box.left < pad.left - CLIP_TOLERANCE))
        ) {
          return true;
        }
      }

      if (
        clipsPaint(cs) &&
        (box.bottom > rect.bottom + CLIP_TOLERANCE ||
          box.top < rect.top - CLIP_TOLERANCE ||
          box.right > rect.right + CLIP_TOLERANCE ||
          box.left < rect.left - CLIP_TOLERANCE)
      ) {
        return true;
      }
    }

    return false;
  }

  /** 该元素的布局是否能容纳一个块级面板 */
  function canHostPanel(parent) {
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return false;

    const cs = getComputedStyle(parent);
    if (HOSTABLE_DISPLAYS.has(cs.display)) return true;
    if (STACK_DISPLAYS.has(cs.display)) {
      return String(cs.flexDirection || '').startsWith('column');
    }
    return false;
  }

  /**
   * 面板被裁剪时，逐层向上把面板插到承载块「后面」，直到不再被裁剪。
   * 这样面板仍然在文档流里（会顶开后续内容），只是换了位置。
   * 例：YouTube 评论的 div#content 带 -webkit-line-clamp + overflow:hidden，
   * 长评论高度锁死，面板会被切掉；提升到 ytd-expander 后就能完整显示。
   */
  function tryHoist(record) {
    const host = record.host;
    const origin = host.parentElement || record.block;
    let node = origin;

    for (let step = 0; step < MAX_HOIST_STEPS; step += 1) {
      const parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;

      if (parent === document.body) {
        // 允许挂到 body（仍在内嵌文档流里），但如果要脱离的是一个「定位容器」
        // （弹层 / 浮窗等），提到 body 会让面板跑到页面其它位置，此时放弃提升。
        if (getComputedStyle(node).position !== 'static') break;
      }

      if (canHostPanel(parent)) {
        parent.insertBefore(host, node.nextSibling);
        if (!isPanelClipped(record)) return true;
      }

      node = parent;
    }

    // 没找到合适的祖先：恢复原位，交给浮层
    origin.appendChild(host);
    return false;
  }

  /** 面板在可滚动容器里看不见时，直接调整该容器的 scrollTop（不影响整页） */
  function nudgeIntoView(record) {
    const host = record.host;
    if (!host.isConnected || record.floating) return;

    const box = host.getBoundingClientRect();
    if (box.height < 1) return;

    const start = host.parentElement || record.block;
    for (let node = start; node && node !== document.body; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (!/auto|scroll|overlay/.test(cs.overflowY)) continue;
      // clientHeight 为 0 的容器（如 YouTube 的 body）没有可见的滚动区，跳过
      if (node.clientHeight < 1) continue;

      const top = node.getBoundingClientRect().top + node.clientTop;
      const bottom = top + node.clientHeight;
      const slack = FLOAT_GAP;

      if (box.bottom > bottom - slack) node.scrollTop += box.bottom - bottom + slack;
      else if (box.top < top + slack) node.scrollTop -= top - box.top + slack;

      return;
    }
  }

  function placeFloat(record) {
    const host = record.host;
    if (!record.floating || !host.isConnected) return;

    const anchor = record.block.getBoundingClientRect();
    const vw = viewportWidth();
    const vh = viewportHeight();

    // 窄视口下允许比 FLOAT_MIN_WIDTH 更窄，但不能超出视口
    const available = Math.max(120, vw - FLOAT_GAP * 2);
    const preferred = Math.max(
      FLOAT_MIN_WIDTH,
      Math.min(anchor.width || FLOAT_MIN_WIDTH, FLOAT_MAX_WIDTH)
    );
    const width = Math.round(Math.min(preferred, available));

    host.style.inset = 'auto';
    host.style.margin = '0';
    host.style.width = `${width}px`;
    host.style.top = '0px';
    host.style.left = '0px';

    // 先归零再量高度，避免上一帧位置影响判断
    const height = host.getBoundingClientRect().height;

    // 只参考段落落在视口内的部分：超长段落不会把面板顶到屏幕外
    const anchorTop = Math.max(FLOAT_GAP, Math.min(anchor.top, Math.max(FLOAT_GAP, vh - FLOAT_GAP)));
    const anchorBottom = Math.max(anchorTop, Math.min(anchor.bottom, Math.max(FLOAT_GAP, vh - FLOAT_GAP)));

    const below = anchorBottom + FLOAT_GAP;
    const above = anchorTop - FLOAT_GAP - height;

    let top;
    if (below + height <= vh - FLOAT_GAP || above < FLOAT_GAP) {
      // 下方放得下（或上方同样放不下）→ 优先贴段落下方
      top = Math.min(below, Math.max(FLOAT_GAP, vh - height - FLOAT_GAP));
    } else {
      top = Math.max(FLOAT_GAP, above);
    }

    const left = Math.min(
      Math.max(FLOAT_GAP, anchor.left),
      Math.max(FLOAT_GAP, vw - width - FLOAT_GAP)
    );

    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  }

  function scheduleFloatReposition(record) {
    if (record.floatFrame || record.destroyed || !record.floating) return;
    record.floatFrame = requestAnimationFrame(() => {
      record.floatFrame = 0;
      if (record.destroyed || !record.floating || !record.visible) return;
      placeFloat(record);
    });
  }

  function enterFloatMode(record) {
    const host = record.host;
    if (record.floating || record.destroyed) return;

    record.floating = true;
    host.hidden = false;
    host.dataset.floating = '';
    host.setAttribute('popover', 'manual');

    try {
      host.showPopover();
    } catch (error) {
      // 未连接等情况下降级为普通 fixed 定位
      console.warn('[HY-MT] 打开浮层失败：', error);
    }

    placeFloat(record);

    record.onViewportChange = () => scheduleFloatReposition(record);
    window.addEventListener('scroll', record.onViewportChange, true);
    window.addEventListener('resize', record.onViewportChange);

    record.onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      hideRecord(record);
    };
    window.addEventListener('keydown', record.onKeydown, true);

    try {
      record.resizeObserver = new ResizeObserver(() => scheduleFloatReposition(record));
      record.resizeObserver.observe(host);
    } catch (error) {
      console.warn('[HY-MT] ResizeObserver 不可用：', error);
    }
  }

  function exitFloatMode(record) {
    if (!record.floating) return;
    record.floating = false;

    if (record.floatFrame) {
      cancelAnimationFrame(record.floatFrame);
      record.floatFrame = 0;
    }

    if (record.onViewportChange) {
      window.removeEventListener('scroll', record.onViewportChange, true);
      window.removeEventListener('resize', record.onViewportChange);
      record.onViewportChange = null;
    }

    if (record.onKeydown) {
      window.removeEventListener('keydown', record.onKeydown, true);
      record.onKeydown = null;
    }

    if (record.resizeObserver) {
      record.resizeObserver.disconnect();
      record.resizeObserver = null;
    }

    const host = record.host;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
    } catch (error) {
      console.warn('[HY-MT] 关闭浮层失败：', error);
    }

    host.removeAttribute('popover');
    delete host.dataset.floating;
    host.style.cssText = '';
  }

  function scheduleLayoutCheck(record) {
    if (record.layoutFrame) return;
    record.layoutFrame = requestAnimationFrame(() => {
      record.layoutFrame = 0;
      if (record.destroyed || !record.visible || record.floating) return;

      // 优先保持文档流：能内嵌就内嵌，被裁就向上提升，实在不行才浮层
      if (!isPanelClipped(record) || tryHoist(record)) {
        nudgeIntoView(record);
        return;
      }

      enterFloatMode(record);
    });
  }

  /** 内容或可见性变化后重新决定布局 */
  function refreshLayout(record) {
    if (record.destroyed || !record.visible) return;
    if (record.floating) scheduleFloatReposition(record);
    else scheduleLayoutCheck(record);
  }

  function setVisible(record, visible) {
    record.visible = visible;

    if (!visible) {
      if (record.layoutFrame) {
        cancelAnimationFrame(record.layoutFrame);
        record.layoutFrame = 0;
      }
      exitFloatMode(record);
      record.host.hidden = true;
      return;
    }

    record.host.hidden = false;
    refreshLayout(record);
  }

  function showRecord(record) {
    setVisible(record, true);
  }

  function hideRecord(record) {
    setVisible(record, false);
  }

  function hideAll() {
    for (const record of liveRecords) setVisible(record, false);
  }

  function destroyRecord(record) {
    record.destroyed = true;

    if (record.layoutFrame) {
      cancelAnimationFrame(record.layoutFrame);
      record.layoutFrame = 0;
    }

    exitFloatMode(record);
    record.host.remove();
    records.delete(record.block);
    liveRecords.delete(record);
  }

  function renderLoading(record) {
    record.retryBtn.hidden = true;
    record.hideBtn.hidden = false;
    record.meta.textContent = MODEL_LABEL;
    record.body.classList.remove('error');
    record.body.textContent = '';

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    record.body.append(spinner, document.createTextNode('翻译中…'));

    refreshLayout(record);
  }

  function renderText(record, text) {
    record.retryBtn.hidden = true;
    record.hideBtn.hidden = false;
    record.meta.textContent = record.truncated ? `${MODEL_LABEL} · 原文较长已截断` : MODEL_LABEL;
    record.body.classList.remove('error');
    record.body.textContent = text;

    refreshLayout(record);
  }

  function renderNote(record, text) {
    record.retryBtn.hidden = true;
    record.hideBtn.hidden = false;
    record.meta.textContent = MODEL_LABEL;
    record.body.classList.remove('error');
    record.body.textContent = text;

    refreshLayout(record);
  }

  function renderError(record, message) {
    record.retryBtn.hidden = false;
    record.hideBtn.hidden = false;
    record.meta.textContent = MODEL_LABEL;
    record.body.classList.add('error');
    record.body.textContent = message;

    refreshLayout(record);
  }

  function friendlyError(error) {
    const message = String(error?.message || error || '未知错误');
    if (/Extension context invalidated|Could not establish connection|Receiving end does not exist/i.test(message)) {
      return '扩展已更新或重新加载，请刷新页面后重试';
    }
    return message;
  }

  /* ==========================================================================
   * 翻译流程
   * ======================================================================== */

  async function requestTranslation(record) {
    if (record.destroyed) return;

    record.status = 'loading';
    showRecord(record);
    renderLoading(record);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'translate',
        text: record.source,
        targetLang: TARGET_LANG
      });

      if (record.destroyed) return;
      if (!response || response.ok !== true) {
        throw new Error(response?.error || '扩展后台没有返回结果');
      }

      const translation = response.data?.translation;
      if (!translation) throw new Error('没有拿到译文');

      record.translation = translation;
      record.status = 'done';
      renderText(record, translation);
    } catch (error) {
      if (record.destroyed) return;
      record.status = 'error';
      renderError(record, friendlyError(error));
    }
  }

  /** 清理已经从文档中移除的历史面板，避免长时间浏览时内存累积 */
  function pruneDetachedRecords() {
    if (liveRecords.size <= 40) return;
    for (const record of liveRecords) {
      if (!record.host.isConnected) destroyRecord(record);
    }
  }

  function toggleBlock(block) {
    pruneDetachedRecords();

    const existing = records.get(block);

    if (existing) {
      if (existing.visible) {
        hideRecord(existing);
        return;
      }
      showRecord(existing);
      if (existing.status === 'error') void requestTranslation(existing);
      return;
    }

    const record = createRecord(block);
    records.set(block, record);
    liveRecords.add(record);

    const { text, truncated } = extractSource(block);
    record.source = text;
    record.truncated = truncated;

    if (!text || text.length < 2) {
      destroyRecord(record);
      return;
    }

    if (!needsTranslation(text)) {
      record.status = 'done';
      record.translation = text;
      renderNote(record, '原文已是中文，未调用翻译');
      showRecord(record);
      return;
    }

    void requestTranslation(record);
  }

  /* ==========================================================================
   * 事件
   * ======================================================================== */

  function handleMouseDown(event) {
    pendingBlock = null;

    if (!state.enabled) return;
    if (event.button !== 0 || !event.ctrlKey) return;
    if (event.shiftKey || event.altKey || event.metaKey) return;
    if (isOwnPanelEvent(event)) return;

    const block = resolveBlockAt(event.clientX, event.clientY);
    if (!block) return;

    pendingBlock = block;
    // 阻止 Ctrl+点击 触发的选区 / 拖拽等默认行为
    event.preventDefault();
  }

  function handleClick(event) {
    const block = pendingBlock;
    pendingBlock = null;

    if (!block || !state.enabled) return;
    if (event.button !== 0 || !event.ctrlKey) return;
    if (isOwnPanelEvent(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    toggleBlock(block);
  }

  window.addEventListener('mousedown', handleMouseDown, true);
  window.addEventListener('click', handleClick, true);
})();

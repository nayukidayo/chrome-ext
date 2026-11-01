/**
 * 段落翻译内容脚本
 *
 * - 按住 Ctrl 并左键点击网页段落 → 在该段落末尾插入译文卡片
 * - 再次 Ctrl + 点击同一段落 → 隐藏译文（译文已缓存，再点即可恢复显示）
 *
 * 实现要点：
 * - 通过 caretRangeFromPoint 取得鼠标所在文字节点，向上找到最近的块级容器作为「段落」
 * - 译文面板使用自定义元素 + Shadow DOM + 构造式样式表，避免被页面样式 / CSP 干扰
 * - 面板内容全部使用 textContent 写入，不注入任何 HTML
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
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (error) {
      // 旧版内核兜底
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML;
    shadow.appendChild(wrapper);

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
      destroyed: false
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

  function setVisible(record, visible) {
    record.visible = visible;
    record.host.hidden = !visible;
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
  }

  function renderText(record, text) {
    record.retryBtn.hidden = true;
    record.hideBtn.hidden = false;
    record.meta.textContent = record.truncated ? `${MODEL_LABEL} · 原文较长已截断` : MODEL_LABEL;
    record.body.classList.remove('error');
    record.body.textContent = text;
  }

  function renderNote(record, text) {
    record.retryBtn.hidden = true;
    record.hideBtn.hidden = false;
    record.meta.textContent = MODEL_LABEL;
    record.body.classList.remove('error');
    record.body.textContent = text;
  }

  function renderError(record, message) {
    record.retryBtn.hidden = false;
    record.hideBtn.hidden = false;
    record.meta.textContent = MODEL_LABEL;
    record.body.classList.add('error');
    record.body.textContent = message;
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

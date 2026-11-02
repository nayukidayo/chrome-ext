/**
 * 鼠标手势内容脚本
 *
 * 按住鼠标右键在页面中划动，根据轨迹方向执行动作：
 *   下右 → 关闭当前页面
 *   上左 → 打开刚关闭的页面
 *   上下 → 刷新页面
 *   左   → 后退（上一页）
 *   右   → 前进（下一页）
 *   上   → 整个页面滚动到顶部（不处理页面内部的滚动容器）
 *
 * 实现要点：
 * - Pointer Events + 指针捕获：右键拖动期间事件不会因为移出元素而中断
 * - 轨迹先按 Ramer–Douglas–Peucker 简化，再映射成 U/D/L/R 方向序列，手抖不会误判
 * - 只按「每个方向段」的长度判定：每段都要长于 MIN_DIRECTION_LENGTH（30px），
 *   如「下右」要求向下、向右各超过 30px；不看总轨迹长度
 * - 只要按住右键滑动过，就拦掉网页右键菜单（不要求匹配到手势）
 * - 轨迹是单色实线，绘制在 Shadow DOM 里的全屏 canvas 上，
 *   使用构造式样式表，避免被页面样式 / CSP 干扰
 */

(() => {
  'use strict';

  if (window.__hymtGestureInjected) return;
  window.__hymtGestureInjected = true;

  /* ==========================================================================
   * 参数
   * ======================================================================== */

  /** 每个方向段（直线段）的最短长度：短于此值的抖动会被忽略，也不会触发手势 */
  const MIN_DIRECTION_LENGTH = 30;
  /** 轨迹采样间距：移动超过该距离才记录一个点 */
  const SAMPLE_DISTANCE = 2;
  /** RDP 轨迹简化容差：消除手抖与轻微弧度 */
  const SIMPLIFY_TOLERANCE = 12;
  /** 累计移动超过该距离才开始显示轨迹 */
  const DRAW_START_DISTANCE = 10;
  /** 轨迹点上限，防止长距离拖动占用过多内存 */
  const MAX_POINTS = 4000;
  /** 松手后轨迹淡出时长（毫秒） */
  const FADE_DURATION = 200;
  /** 拦截右键菜单的时间窗：contextmenu 紧跟 pointerup 触发 */
  const MENU_SUPPRESS_WINDOW = 500;

  const TRAIL_RGB = '24, 119, 242';
  const TRAIL_WIDTH = 3;

  /** 方向序列 → 动作 */
  const GESTURES = new Map([
    ['DR', 'closeTab'], // 下右：关闭当前页面
    ['UL', 'reopenTab'], // 上左：打开刚关闭的页面
    ['UD', 'reloadTab'], // 上下：刷新
    ['L', 'goBack'], // 左：后退
    ['R', 'goForward'], // 右：前进
    ['U', 'scrollTop'] // 上：回到顶部
  ]);

  const state = {
    enabled: true,
    tracking: false,
    pointerId: -1,
    points: [],
    distance: 0,
    /** 在该时间点之前到达的 contextmenu 将被拦掉 */
    suppressMenuUntil: 0
  };

  /* ==========================================================================
   * 设置
   * ======================================================================== */

  function applyEnabled(enabled) {
    state.enabled = enabled !== false;
    if (!state.enabled) cancelTracking();
  }

  try {
    chrome.storage.sync.get({ gestureEnabled: true }, (value) => {
      if (chrome.runtime.lastError) return;
      applyEnabled(value.gestureEnabled);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.gestureEnabled) return;
      applyEnabled(changes.gestureEnabled.newValue);
    });
  } catch (error) {
    console.warn('[gesture] 读取设置失败：', error);
  }

  /* ==========================================================================
   * 轨迹浮层
   * ======================================================================== */

  const OVERLAY_CSS = `
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  /** @type {{ host: HTMLElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D | null, width: number, height: number } | null} */
  let overlay = null;
  let drawFrame = 0;
  let fadeFrame = 0;

  function createOverlay() {
    const host = document.createElement('hymt-gesture-trail');
    host.setAttribute('aria-hidden', 'true');
    // 内联样式优先级最高，页面 CSS 无法干扰浮层
    host.style.cssText = [
      'position: fixed',
      'inset: 0',
      'width: 100%',
      'height: 100%',
      'display: block',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'background: transparent',
      'overflow: hidden',
      'pointer-events: none',
      'z-index: 2147483647'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (error) {
      // 旧版内核兜底
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      shadow.appendChild(style);
    }

    const canvas = document.createElement('canvas');
    shadow.appendChild(canvas);
    (document.documentElement || document.body).appendChild(host);

    overlay = { host, canvas, ctx: canvas.getContext('2d'), width: 0, height: 0 };
    resizeOverlay();
    return overlay;
  }

  function resizeOverlay() {
    if (!overlay) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    overlay.width = width;
    overlay.height = height;

    if (overlay.canvas.width !== pixelWidth || overlay.canvas.height !== pixelHeight) {
      overlay.canvas.width = pixelWidth;
      overlay.canvas.height = pixelHeight;
    }
    if (overlay.ctx) overlay.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ensureOverlay() {
    if (overlay) resizeOverlay();
    else createOverlay();
  }

  function destroyOverlay() {
    if (drawFrame) {
      cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }
    if (fadeFrame) {
      cancelAnimationFrame(fadeFrame);
      fadeFrame = 0;
    }
    if (!overlay) return;

    overlay.host.remove();
    overlay = null;
  }

  /** 单色实线：整条轨迹一笔描完，没有描边也没有渐变 */
  function drawTrail(points, opacity) {
    if (!overlay || !overlay.ctx) return;

    const ctx = overlay.ctx;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (points.length < 2 || opacity <= 0) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = TRAIL_WIDTH;
    ctx.strokeStyle = `rgba(${TRAIL_RGB}, ${opacity})`;
    ctx.stroke();
  }

  function scheduleDraw() {
    if (drawFrame) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      drawTrail(state.points, 1);
    });
  }

  function fadeOutTrail(points) {
    if (!overlay) return;

    if (drawFrame) {
      cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }
    if (fadeFrame) {
      cancelAnimationFrame(fadeFrame);
      fadeFrame = 0;
    }

    const startedAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / FADE_DURATION));
      drawTrail(points, 1 - progress);
      if (progress < 1) {
        fadeFrame = requestAnimationFrame(step);
      } else {
        fadeFrame = 0;
        destroyOverlay();
      }
    };
    fadeFrame = requestAnimationFrame(step);
  }

  /* ==========================================================================
   * 手势识别
   * ======================================================================== */

  function directionOf(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'R' : 'L';
    return dy >= 0 ? 'D' : 'U';
  }

  /** Ramer–Douglas–Peucker 轨迹简化 */
  function simplifyPath(points, tolerance) {
    if (points.length <= 2) return points.slice();

    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    const squaredTolerance = tolerance * tolerance;
    const stack = [[0, points.length - 1]];

    while (stack.length) {
      const [first, last] = stack.pop();
      const a = points[first];
      const b = points[last];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;

      let farthest = -1;
      let farthestSquared = 0;

      for (let i = first + 1; i < last; i += 1) {
        const point = points[i];
        let distanceSquared;

        if (lengthSquared === 0) {
          const px = point.x - a.x;
          const py = point.y - a.y;
          distanceSquared = px * px + py * py;
        } else {
          let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
          t = Math.max(0, Math.min(1, t));
          const px = point.x - (a.x + t * dx);
          const py = point.y - (a.y + t * dy);
          distanceSquared = px * px + py * py;
        }

        if (distanceSquared > farthestSquared) {
          farthestSquared = distanceSquared;
          farthest = i;
        }
      }

      if (farthest > 0 && farthestSquared > squaredTolerance) {
        keep[farthest] = 1;
        stack.push([first, farthest], [farthest, last]);
      }
    }

    const simplified = [];
    for (let i = 0; i < points.length; i += 1) {
      if (keep[i]) simplified.push(points[i]);
    }
    return simplified;
  }

  /**
   * 采样点 → 方向串
   * 1. RDP 简化去掉手抖
   * 2. 每段按主轴映射为 U / D / L / R
   * 3. 过滤短于 MIN_DIRECTION_LENGTH 的段，并合并相邻同方向
   *    即每个方向都要划够长度，例如「下右」需要向下、向右各超过 30px
   */
  function extractDirections(points) {
    const vertices = simplifyPath(points, SIMPLIFY_TOLERANCE);
    let pattern = '';
    let lastDirection = '';

    for (let i = 1; i < vertices.length; i += 1) {
      const dx = vertices[i].x - vertices[i - 1].x;
      const dy = vertices[i].y - vertices[i - 1].y;
      if (Math.hypot(dx, dy) < MIN_DIRECTION_LENGTH) continue;

      const direction = directionOf(dx, dy);
      if (direction === lastDirection) continue;

      pattern += direction;
      lastDirection = direction;
    }

    return pattern;
  }

  /* ==========================================================================
   * 动作
   * ======================================================================== */

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {
      return false;
    }
  }

  /** 「上」只滚动整页，不处理页面内部的滚动容器 */
  function scrollPageToTop() {
    const scrolling = document.scrollingElement || document.documentElement;
    if (!scrolling) return;

    scrolling.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  async function sendAction(action) {
    try {
      const response = await chrome.runtime.sendMessage({ type: `gesture:${action}` });
      if (response && response.ok === false) {
        console.warn('[gesture] 手势执行失败：', response.error);
      }
    } catch (error) {
      console.warn('[gesture] 手势执行失败：', error);
    }
  }

  function runAction(action) {
    if (action === 'scrollTop') {
      // 手势可能起自 iframe（例如资讯站内嵌的「大家在看」板块）：
      // 子框架滚不到整页，交给后台转发给顶层框架执行
      if (window.top === window) scrollPageToTop();
      else void sendAction('scrollTop');
      return;
    }
    void sendAction(action);
  }

  /* 后台转发来的动作（目前只有顶层框架的「上」） */
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'gesture:scrollTop') scrollPageToTop();
    });
  } catch (error) {
    console.warn('[gesture] 监听后台消息失败：', error);
  }

  /* ==========================================================================
   * 事件
   * ======================================================================== */

  function cancelTracking() {
    state.tracking = false;
    state.pointerId = -1;
    state.points = [];
    state.distance = 0;
    destroyOverlay();
  }

  function finishGesture(x, y, execute) {
    if (!state.tracking) return;
    state.tracking = false;

    const points = state.points;
    const last = points[points.length - 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const step = Math.hypot(x - last.x, y - last.y);
      if (step >= 0.5) {
        points.push({ x, y });
        state.distance += step;
      }
    }

    const distance = state.distance;
    state.pointerId = -1;
    state.points = [];
    state.distance = 0;

    if (execute) {
      // 只要按住右键滑动过（哪怕没匹配到手势）就拦掉右键菜单
      if (distance > 0) {
        state.suppressMenuUntil = performance.now() + MENU_SUPPRESS_WINDOW;
      }

      const pattern = extractDirections(points);
      const action = GESTURES.get(pattern);
      if (action) runAction(action);
    }

    fadeOutTrail(points);
  }

  function onPointerDown(event) {
    if (!state.enabled) return;
    if (event.button !== 2 || !event.isPrimary) return;
    if (event.pointerType && event.pointerType !== 'mouse') return;

    // 正常不会走到这里（上一轮手势未结束），保险起见先清空
    cancelTracking();

    state.suppressMenuUntil = 0;
    state.tracking = true;
    state.pointerId = event.pointerId;
    state.points = [{ x: event.clientX, y: event.clientY }];
    state.distance = 0;

    try {
      if (event.target instanceof Element) {
        event.target.setPointerCapture(event.pointerId);
      }
    } catch (error) {
      // 捕获失败也不影响 window 级别的事件监听
    }
  }

  function onPointerMove(event) {
    if (!state.tracking || event.pointerId !== state.pointerId) return;

    // 某些情况下 pointerup 会丢失：按键已松开就结束
    if ((event.buttons & 2) === 0) {
      finishGesture(event.clientX, event.clientY, false);
      return;
    }

    const last = state.points[state.points.length - 1];
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    const step = Math.hypot(dx, dy);
    if (step < SAMPLE_DISTANCE) return;

    state.distance += step;

    if (state.points.length < MAX_POINTS) {
      state.points.push({ x: event.clientX, y: event.clientY });
    } else {
      state.points[state.points.length - 1] = { x: event.clientX, y: event.clientY };
    }

    if (state.distance >= DRAW_START_DISTANCE) {
      ensureOverlay();
      scheduleDraw();
    }
  }

  function onPointerUp(event) {
    if (!state.tracking || event.pointerId !== state.pointerId) return;
    finishGesture(event.clientX, event.clientY, true);
  }

  function onPointerCancel(event) {
    if (!state.tracking || event.pointerId !== state.pointerId) return;
    finishGesture(event.clientX, event.clientY, false);
  }

  function onContextMenu(event) {
    if (!state.enabled) return;
    if (performance.now() > state.suppressMenuUntil) return;

    state.suppressMenuUntil = 0;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('contextmenu', onContextMenu, true);
})();

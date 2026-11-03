/**
 * 鼠标手势内容脚本
 *
 * 按住鼠标右键在页面中划动，根据轨迹方向执行动作：
 *   左右 → 翻译手势起点处的段落
 *   下右 → 关闭当前页面
 *   上左 → 打开刚关闭的页面
 *   上下 → 刷新页面
 *   左   → 后退（上一页）
 *   右   → 前进（下一页）
 *   上   → 整个页面滚动到顶部（不处理页面内部的滚动容器）
 *   下   → 整个页面滚动到底部（不处理页面内部的滚动容器）
 *
 * 实现要点：
 * - Pointer Events + 指针捕获：右键拖动期间事件不会因为移出元素而中断
 * - 轨迹先按 Ramer–Douglas–Peucker 简化，再映射成 U/D/L/R 方向序列，手抖不会误判
 * - 方向锥：上 / 下 / 左 / 右各有一个 30° 的夹角，只有段方向落在某个锥形内才算命中方向；
 *   锥形之间的对角区域是模糊区，拐弯时的过渡轨迹会被直接忽略，既不产生方向也不切断当前段，
 *   直到轨迹重新笔直指向某个方向才继续判定——组合手势的拐弯因此能平滑过渡
 * - 严格判定：方向串必须与手势完全一致（只包含触发手势的方向），
 *   且每个方向段都要长于 MIN_DIRECTION_LENGTH（30px）；任何一段太短都判为无效，
 *   不会被忽略，如「先向右 20px 再向下」不会误触发「下」
 * - 单方向手势还要求整条轨迹的总位移也落在该方向的夹角内，否则视为「在夹角外」，整个操作无效
 * - 拖动距离达到 DRAW_START_DISTANCE（轨迹出现）才拦掉网页右键菜单（不要求匹配到手势）；
 *   更小的位移视为按下时的手抖，按普通右键点击处理，照常弹出菜单
 * - 轨迹是单色实线，绘制在 Shadow DOM 里的全屏 SVG 上（矢量，无需处理 DPR），
 *   使用构造式样式表，避免被页面样式 / CSP 干扰
 * - 轨迹浮层永远在窗口最上层：手势起自 iframe 时，轨迹点会逐级转发到顶层框架，
 *   由顶层统一绘制（否则会被 iframe 的边界裁掉），右键菜单也由顶层负责拦截
 */

(() => {
  'use strict';

  if (window.__hymtGestureInjected) return;
  window.__hymtGestureInjected = true;

  /* ==========================================================================
   * 参数
   * ======================================================================== */

  /**
   * 每个方向段（直线段）的最短长度
   * 严格判定：简化后只要有方向段短于此值，整个手势就判为无效（不是忽略该段），
   * 所以「下」不会因为轨迹里夹了一小段别的方向而误触发
   */
  const MIN_DIRECTION_LENGTH = 30;
  /**
   * 方向锥的夹角（度）：以四个轴向（上 / 下 / 左 / 右）为中心、左右各 HALF_CONE 度
   * 只有段方向落在锥形内才算命中该方向；锥形之间的对角区域是模糊区，
   * 拐弯时的过渡轨迹会落在这里，被直接忽略，不会产生方向段
   */
  const DIRECTION_CONE = 30;
  const HALF_CONE = DIRECTION_CONE / 2;
  /** 轨迹采样间距：移动超过该距离才记录一个点 */
  const SAMPLE_DISTANCE = 2;
  /** RDP 轨迹简化容差：消除手抖与轻微弧度 */
  const SIMPLIFY_TOLERANCE = 12;
  /**
   * 累计移动超过该距离才开始显示轨迹
   * 也是「右键是否还算普通点击」的阀值：轨迹未出现就松手，照常弹出右键菜单
   */
  const DRAW_START_DISTANCE = 10;
  /** 轨迹点上限，防止长距离拖动占用过多内存 */
  const MAX_POINTS = 4000;
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
    ['LR', 'translate'], // 左右：翻译手势起点处的段落
    ['U', 'scrollTop'], // 上：整个页面滚动到顶部
    ['D', 'scrollBottom'] // 下：整个页面滚动到底部
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

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const OVERLAY_CSS = `
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    path {
      fill: none;
      stroke: rgb(${TRAIL_RGB});
      stroke-width: ${TRAIL_WIDTH};
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `;

  /** @type {{ host: HTMLElement, svg: SVGSVGElement, path: SVGPathElement } | null} */
  let overlay = null;
  let drawFrame = 0;
  /** 本帧待绘制的轨迹点（绘制与转发共用一帧，天然限频） */
  let pendingPoints = null;

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
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(OVERLAY_CSS);
    shadow.adoptedStyleSheets = [sheet];

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const path = document.createElementNS(SVG_NS, 'path');
    svg.appendChild(path);
    shadow.appendChild(svg);
    (document.documentElement || document.body).appendChild(host);

    overlay = { host, svg, path };
    return overlay;
  }

  function ensureOverlay() {
    if (!overlay) createOverlay();
  }

  function destroyOverlay() {
    if (drawFrame) {
      cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }
    pendingPoints = null;

    if (!overlay) return;

    overlay.host.remove();
    overlay = null;
  }

  /** 单色实线：把轨迹点写进 path 的 d，SVG 是矢量，无需处理 DPR */
  function drawTrail(points) {
    if (!overlay) return;

    if (points.length < 2) {
      overlay.path.removeAttribute('d');
      return;
    }

    let d = `M${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i += 1) {
      d += `L${points[i].x} ${points[i].y}`;
    }
    overlay.path.setAttribute('d', d);
  }

  function scheduleDraw(points) {
    pendingPoints = points;
    if (drawFrame) return;

    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      const current = pendingPoints;
      pendingPoints = null;
      if (current) drawTrail(current);
      // 转发与绘制同频，避免每条 pointermove 都发一条消息
      flushRelay();
    });
  }

  /* ==========================================================================
   * 跨框架轨迹转发
   *
   * 轨迹浮层只有画在顶层文档里才不会被子框架的边界裁掉：
   * 手势起自 iframe 时，轨迹点逐级 postMessage 给父框架，每级换算成父框架的视口坐标，
   * 最终由顶层框架用同一个浮层绘制；顶层因此也知道松手时该拦掉网页右键菜单。
   * ======================================================================== */

  const RELAY_KEY = '__hymtGestureTrail';
  /** 顶层超过该时间没收到新轨迹就认为转发已中断，丢弃残留轨迹 */
  const RELAY_TIMEOUT = 3000;
  /** 心跳间隔：用户按住右键停顿不动时，也能让顶层知道手势还在进行 */
  const RELAY_HEARTBEAT = 1000;

  const isTopFrame = window.top === window;

  /** 当前框架是手势起点时的转发状态 */
  const outbound = {
    active: false,
    id: '',
    sent: 0,
    heartbeat: 0
  };

  /** 顶层框架：正在镜像的子框架轨迹 */
  const foreign = {
    id: '',
    points: [],
    distance: 0,
    timer: 0
  };

  function createSessionId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 向父框架转发；顶层没有父框架（自己绘制），直接返回 */
  function postToParent(kind, points, suppress) {
    if (isTopFrame) return;

    const message = {
      [RELAY_KEY]: kind,
      id: outbound.id,
      width: window.innerWidth,
      height: window.innerHeight
    };

    if (points) {
      message.points = points.map((point) => [
        Math.round(point.x * 100) / 100,
        Math.round(point.y * 100) / 100
      ]);
    }
    if (suppress !== undefined) message.suppress = suppress;

    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      // 父框架不可达（页面正在卸载等），放弃转发
      outbound.active = false;
    }
  }

  /** 轨迹出现时开始转发：带上已有的点，顶层画出的轨迹才完整 */
  function beginRelay() {
    if (isTopFrame || outbound.active) return;

    outbound.active = true;
    outbound.id = createSessionId();
    outbound.sent = state.points.length;
    postToParent('begin', state.points);

    // 心跳让顶层知道手势还在进行（止住不动时轨迹不会超时消失）
    outbound.heartbeat = setInterval(() => {
      if (outbound.active) postToParent('alive');
    }, RELAY_HEARTBEAT);
  }

  /** 把尚未转发的点送出去（每帧一次，和绘制同频） */
  function flushRelay() {
    if (!outbound.active || outbound.sent >= state.points.length) return;

    postToParent('points', state.points.slice(outbound.sent));
    outbound.sent = state.points.length;
  }

  /** 手势结束：补上最后的点，并告知顶层要不要继续拦右键菜单 */
  function endRelay(suppress) {
    if (!outbound.active) return;

    flushRelay();
    outbound.active = false;
    if (outbound.heartbeat) {
      clearInterval(outbound.heartbeat);
      outbound.heartbeat = 0;
    }
    postToParent('end', null, suppress);
  }

  /* --------------------------------------------------------------------------
   * 接收并向上转发子框架的轨迹
   * ------------------------------------------------------------------------ */

  /** event.source → iframe 元素，避免每条消息都重新遍历 DOM */
  const childFrames = new WeakMap();

  /** event.source 是否真的是当前文档里的直接子框架 */
  function isChildWindow(source) {
    if (!source) return false;

    const frames = window.frames;
    for (let i = 0; i < frames.length; i += 1) {
      if (frames[i] === source) return true;
    }
    return false;
  }

  /** 找出子框架对应的 iframe / frame 元素（会展开 open shadow root） */
  function findChildFrame(source) {
    const cached = childFrames.get(source);
    if (cached && cached.isConnected && cached.contentWindow === source) return cached;

    for (const element of document.querySelectorAll('iframe, frame')) {
      if (element.contentWindow === source) {
        childFrames.set(source, element);
        return element;
      }
    }

    // iframe 可能被放在 open shadow root 里；闭包 shadow root 无法访问
    const roots = [];
    for (const element of document.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    while (roots.length) {
      const root = roots.pop();
      for (const frame of root.querySelectorAll('iframe, frame')) {
        if (frame.contentWindow === source) {
          childFrames.set(source, frame);
          return frame;
        }
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }

    return null;
  }

  /**
   * 子框架内容区在当前框架视口中的实际位置与大小
   * clientLeft / clientTop 是边框宽度；rect / offset 的比值抵消 CSS 变换的缩放
   */
  function childViewportRect(element) {
    const rect = element.getBoundingClientRect();
    const offsetWidth = element.offsetWidth || rect.width || 1;
    const offsetHeight = element.offsetHeight || rect.height || 1;
    const scaleX = rect.width / offsetWidth;
    const scaleY = rect.height / offsetHeight;

    return {
      left: rect.left + element.clientLeft * scaleX,
      top: rect.top + element.clientTop * scaleY,
      width: (element.clientWidth || offsetWidth) * scaleX,
      height: (element.clientHeight || offsetHeight) * scaleY
    };
  }

  /** 子框架视口坐标 → 当前框架视口坐标（两者视口宽度的比值就是缩放） */
  function toFramePoint(rect, width, height, x, y) {
    const scaleX = width > 0 ? rect.width / width : 1;
    const scaleY = height > 0 ? rect.height / height : 1;
    return [rect.left + x * scaleX, rect.top + y * scaleY];
  }

  function onFrameMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    const kind = data[RELAY_KEY];
    if (kind !== 'begin' && kind !== 'points' && kind !== 'alive' && kind !== 'end') return;
    if (!isChildWindow(event.source)) return;

    const element = findChildFrame(event.source);
    if (!element) return;

    // 消息里的宽高是子框架的视口尺寸，用它和 iframe 内容区的比值换算坐标
    const viewport = childViewportRect(element);
    const width = Number(data.width) || 0;
    const height = Number(data.height) || 0;
    const points = Array.isArray(data.points)
      ? data.points
          .filter((point) => Array.isArray(point) && point.length >= 2)
          .map((point) =>
            toFramePoint(viewport, width, height, Number(point[0]) || 0, Number(point[1]) || 0)
          )
      : [];

    if (isTopFrame) {
      applyForeignTrail(kind, data, points);
      return;
    }

    // 中间框架：换算成自己的坐标后继续往上传
    const message = {
      [RELAY_KEY]: kind,
      id: data.id,
      width: window.innerWidth,
      height: window.innerHeight
    };
    if (points.length) message.points = points;
    if (kind === 'end') message.suppress = Boolean(data.suppress);

    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      // 父框架不可达，轨迹到此为止
    }
  }

  /** 顶层框架：把子框架的轨迹画在自己的浮层上 */
  function applyForeignTrail(kind, data, points) {
    // 顶层自己正在手势时不可能同时有子框架轨迹（一轮只有一次拖动）
    if (state.tracking) return;

    const id = typeof data.id === 'string' ? data.id : '';

    if (kind === 'end') {
      if (id !== foreign.id) return;
      if (data.suppress) state.suppressMenuUntil = performance.now() + MENU_SUPPRESS_WINDOW;
      clearForeignTrail();
      return;
    }

    if (kind === 'alive') {
      if (id === foreign.id) resetForeignTimer();
      return;
    }

    if (id !== foreign.id) {
      // 新会话（或 begin 丢了），从头开始记
      foreign.id = id;
      foreign.points = [];
      foreign.distance = 0;
    }

    for (const point of points) {
      const last = foreign.points[foreign.points.length - 1];
      if (last) {
        const step = Math.hypot(point[0] - last.x, point[1] - last.y);
        if (step < 0.01) continue;
        foreign.distance += step;
      }
      foreign.points.push({ x: point[0], y: point[1] });
    }

    if (!foreign.points.length) return;

    resetForeignTimer();

    if (foreign.points.length >= 2) {
      ensureOverlay();
      scheduleDraw(foreign.points);
    }
  }

  function resetForeignTimer() {
    if (foreign.timer) clearTimeout(foreign.timer);
    foreign.timer = setTimeout(() => {
      foreign.timer = 0;
      clearForeignTrail();
    }, RELAY_TIMEOUT);
  }

  function clearForeignTrail() {
    if (foreign.timer) {
      clearTimeout(foreign.timer);
      foreign.timer = 0;
    }

    const hadTrail = foreign.points.length > 0;
    foreign.id = '';
    foreign.points = [];
    foreign.distance = 0;

    // 顶层自己的手势正在使用时不能拆浮层
    if (hadTrail && !state.tracking) destroyOverlay();
  }

  /* ==========================================================================
   * 手势识别
   * ======================================================================== */

  /**
   * 方向向量 → U / D / L / R
   * 只有方向落在某个方向锥内才算命中；锥外（对角附近的模糊区）返回 null，
   * 调用方会把这部分轨迹当作拐弯过渡直接忽略
   */
  function directionOf(dx, dy) {
    if (dx === 0 && dy === 0) return null;

    // 与水平轴的夹角：0° 为纯水平，90° 为纯垂直
    const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;

    if (angle <= HALF_CONE) return dx >= 0 ? 'R' : 'L';
    if (angle >= 90 - HALF_CONE) return dy >= 0 ? 'D' : 'U';
    return null;
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
   * 1. RDP 简化去掉手抖（偏差不超过 SIMPLIFY_TOLERANCE 的抖动不产生折点），
   *    拐弯处的圆弧会被拆成若干折线段
   * 2. 每段按方向锥分类；锥外的段（拐弯时的模糊轨迹）直接跳过：
   *    它既不产生方向，也不打断当前段，所以「下 → 斜线 → 下」仍是一段「下」，
   *    「下 → 斜线 → 右」则得到「下」「右」两段
   * 3. 合并相邻同方向段
   * 4. 严格判定：只要有方向段短于 MIN_DIRECTION_LENGTH 就返回空串（整个手势无效），
   *    而不是丢弃这一段；否则「先向右 20px 再向下」会被简化成「下」而误触发
   * 5. 单方向手势还要求整条轨迹的总位移也落在同一个方向锥内，否则视为「在夹角外」，
   *    整个操作无效
   * 6. 方向串必须与 GESTURES 中的键完全一致，多一段、少一段都不触发
   */
  function extractDirections(points) {
    const vertices = simplifyPath(points, SIMPLIFY_TOLERANCE);

    /** @type {{ direction: 'U' | 'D' | 'L' | 'R', length: number }[]} */
    const segments = [];

    for (let i = 1; i < vertices.length; i += 1) {
      const dx = vertices[i].x - vertices[i - 1].x;
      const dy = vertices[i].y - vertices[i - 1].y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;

      // 拐弯处的过渡轨迹不在任何方向锥内，直接忽略
      const direction = directionOf(dx, dy);
      if (!direction) continue;

      const previous = segments[segments.length - 1];
      if (previous && previous.direction === direction) {
        previous.length += length;
      } else {
        segments.push({ direction, length });
      }
    }

    if (segments.length === 0) return '';

    // 严格判定：任何一段太短都直接判为无效，而不是忽略这一段
    for (const segment of segments) {
      if (segment.length < MIN_DIRECTION_LENGTH) return '';
    }

    // 单方向手势：整条轨迹的总位移也必须落在同一个方向上。
    // 前面对折线段逐个判定，缓慢偏斜的长曲线可能各小段都在锥内、整体却已明显偏出夹角
    if (segments.length === 1) {
      const start = points[0];
      const end = points[points.length - 1];
      if (directionOf(end.x - start.x, end.y - start.y) !== segments[0].direction) return '';
    }

    return segments.map((segment) => segment.direction).join('');
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

  /** 「上」/「下」只滚动整页，不处理页面内部的滚动容器 */
  function scrollPageTo(edge) {
    const scrolling = document.scrollingElement || document.documentElement;
    if (!scrolling) return;

    const top = edge === 'bottom' ? scrolling.scrollHeight : 0;
    scrolling.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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

  function runAction(action, start) {
    if (action === 'translate') {
      translateAtPoint(start);
      return;
    }

    if (action === 'scrollTop' || action === 'scrollBottom') {
      // 手势可能起自 iframe（例如资讯站内嵌的「大家在看」板块）：
      // 子框架滚不到整页，交给后台转发给顶层框架执行
      if (window.top === window) scrollPageTo(action === 'scrollTop' ? 'top' : 'bottom');
      else void sendAction(action);
      return;
    }
    void sendAction(action);
  }

  /** 手势「左右」：翻译轨迹起点处的段落，具体定位与展示由 content/translate.js 负责 */
  function translateAtPoint(point) {
    if (!point) return;

    const api = window.__hymtTranslate;
    if (!api || typeof api.translateAtPoint !== 'function') {
      console.warn('[gesture] 翻译脚本未就绪，无法翻译');
      return;
    }

    api.translateAtPoint(point.x, point.y);
  }

  /* 后台转发来的动作（顶层框架的「上」/「下」） */
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'gesture:scrollTop') scrollPageTo('top');
      else if (message?.type === 'gesture:scrollBottom') scrollPageTo('bottom');
    });
  } catch (error) {
    console.warn('[gesture] 监听后台消息失败：', error);
  }

  /* ==========================================================================
   * 事件
   * ======================================================================== */

  function cancelTracking() {
    if (outbound.active) endRelay(false);

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
    const start = points[0];
    const last = points[points.length - 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const step = Math.hypot(x - last.x, y - last.y);
      if (step >= 0.5) {
        points.push({ x, y });
        state.distance += step;
      }
    }

    const distance = state.distance;

    // 轨迹正转发给顶层的话，先补上最后的点、再通知结束
    if (outbound.active) endRelay(execute && distance >= DRAW_START_DISTANCE);

    state.pointerId = -1;
    state.points = [];
    state.distance = 0;

    if (execute) {
      // 轨迹已出现（拖动超过 DRAW_START_DISTANCE，哪怕没匹配到手势）才拦掉右键菜单；
      // 轨迹没出现就松手，说明只是按下时的手抖，让网页照常弹出右键菜单
      if (distance >= DRAW_START_DISTANCE) {
        state.suppressMenuUntil = performance.now() + MENU_SUPPRESS_WINDOW;
      }

      const pattern = extractDirections(points);
      const action = GESTURES.get(pattern);
      if (action) runAction(action, start);
    }

    // 不做淡出：手势结束后轨迹立即消失
    destroyOverlay();
  }

  function onPointerDown(event) {
    if (!state.enabled) return;
    if (event.button !== 2 || !event.isPrimary) return;
    if (event.pointerType && event.pointerType !== 'mouse') return;

    // 正常不会走到这里（上一轮手势未结束），保险起见先清空
    cancelTracking();
    // 新手势开始时，丢弃可能残留的子框架轨迹
    clearForeignTrail();

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
      beginRelay();
      scheduleDraw(state.points);
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

    // 起自子框架的轨迹：结束消息可能比 contextmenu 晚到，
    // 只要顶层浮层上还有这条轨迹就一并拦掉（结束消息到达时浮层会被移除）
    const foreignTrail = foreign.distance >= DRAW_START_DISTANCE && foreign.points.length > 0;

    if (performance.now() > state.suppressMenuUntil && !foreignTrail) return;

    state.suppressMenuUntil = 0;
    clearForeignTrail();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('message', onFrameMessage);
})();

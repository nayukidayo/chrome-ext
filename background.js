/**
 * 后台 Service Worker
 *
 * 1) 代理切换：在「代理(fixed_servers)」与「直连(direct)」之间切换（chrome.proxy）
 *    —— 用 fixed_servers 而非 system，是为了给翻译接口加 bypassList（直连）
 * 2) 段落翻译：调用腾讯云 TokenHub 的 hy-mt2-lite（OpenAI 兼容 /v1/chat/completions）
 * 3) 鼠标手势：内容脚本识别手势后，由这里执行关闭 / 恢复 / 刷新标签页
 *
 * API Key 由用户在弹窗中填写，保存在 chrome.storage.local，
 * 只由本 Service Worker 读取使用，内容脚本与网页都拿不到密钥。
 */

'use strict';

const MODEL = 'hy-mt2-lite';
const DEFAULT_TARGET_LANG = '中文';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SOURCE_CHARS = 6000;

/**
 * 接入地域
 *
 * 广州 / 新加坡是两套互相独立的服务，密钥也不通用（不支持跨地域调用）。
 * 每个地域都有自己的默认地址与官方备用地址。
 * 文档：https://cloud.tencent.com/document/product/1823/130078
 */
const REGIONS = [
  {
    id: 'guangzhou',
    label: '广州',
    endpoints: [
      'https://tokenhub.tencentmaas.com/v1/chat/completions',
      'https://tokenhub.tencentmaas.cn/v1/chat/completions'
    ]
  },
  {
    id: 'singapore',
    label: '新加坡',
    endpoints: [
      'https://tokenhub-intl.tencentmaas.com/v1/chat/completions',
      'https://tokenhub-intl.tencentmaas.cn/v1/chat/completions'
    ]
  }
];

const REGION_BY_ID = new Map(REGIONS.map((region) => [region.id, region]));

/**
 * 代理配置
 *
 * 使用 fixed_servers 而不是 system，因为 system 模式不允许附带 bypassList；
 * 有了绕过列表，翻译请求（TokenHub）就可以直连，不依赖代理是否在运行。
 */
const DEFAULT_PROXY_SERVER = 'http://127.0.0.1:10801';
const PROXY_MODES = new Set(['proxy', 'direct']);
const PROXY_SCHEMES = new Set(['http', 'https', 'socks4', 'socks5', 'quic']);
const PROXY_DEFAULT_PORTS = { http: 80, https: 443, socks4: 1080, socks5: 1080, quic: 443 };

/** 不走代理的主机：TokenHub（含新加坡 intl 站点）直连，其余走本地代理 */
const PROXY_BYPASS_LIST = [
  '*.tencentmaas.com',
  '*.tencentmaas.cn',
  'localhost',
  '127.0.0.1',
  '[::1]',
  '<local>'
];

/** 简易 LRU 上限，避免 Service Worker 内存无限增长 */
const CACHE_LIMIT = 400;
const translationCache = new Map();
const inflight = new Map();

/* ============================================================================
 * API Key（广州 / 新加坡 各一把）
 * ========================================================================== */

function maskApiKey(key) {
  const text = String(key || '');
  if (text.length <= 10) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** 规范化用户输入：去掉 Bearer 前缀与空白 */
function normalizeApiKey(input) {
  return String(input ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

const EMPTY_API_KEYS = { guangzhou: '', singapore: '' };

/** 读取两把 Key；旧版本只存了单把 apiKey，自动迁移成广州地域的 Key */
async function getApiKeys() {
  const stored = await chrome.storage.local.get({ apiKeys: null, apiKey: '' });
  const storedKeys = stored.apiKeys && typeof stored.apiKeys === 'object' ? stored.apiKeys : null;

  if (!storedKeys) {
    const migrated = { ...EMPTY_API_KEYS, guangzhou: normalizeApiKey(stored.apiKey) };
    await chrome.storage.local.set({ apiKeys: migrated });
    if (stored.apiKey) await chrome.storage.local.remove('apiKey');
    return migrated;
  }

  const keys = { ...EMPTY_API_KEYS };
  for (const region of REGIONS) keys[region.id] = normalizeApiKey(storedKeys[region.id]);
  return keys;
}

async function readApiKeyState() {
  const keys = await getApiKeys();
  const regions = REGIONS.map((region) => {
    const apiKey = keys[region.id];
    return {
      id: region.id,
      label: region.label,
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : ''
    };
  });

  return { hasApiKey: regions.some((region) => region.hasApiKey), regions };
}

async function saveApiKey(regionId, input) {
  const region = REGION_BY_ID.get(regionId);
  if (!region) throw new Error(`未知地域：${regionId}`);

  const apiKey = normalizeApiKey(input);
  if (!apiKey) throw new Error('请输入 API Key');
  if (apiKey.length < 8 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('API Key 格式看起来不正确，应为 TokenHub 控制台创建的一串可见字符');
  }

  const keys = await getApiKeys();
  keys[region.id] = apiKey;
  await chrome.storage.local.set({ apiKeys: keys });

  return readApiKeyState();
}

/* ============================================================================
 * 翻译
 * ========================================================================== */

function extractApiError(raw) {
  try {
    const data = JSON.parse(raw);
    return data?.error?.message || data?.message || data?.Response?.Error?.Message || '';
  } catch {
    return '';
  }
}

/**
 * 发一次请求。
 * 成功 → { ok: true, translation }
 * 失败 → { ok: false, error, retryEndpoint }：retryEndpoint 表示换本地域的备用域名
 *        还有意义（网络错误 / 5xx / 返回体损坏）；4xx 属于请求或密钥本身的问题，
 *        换域名没用，但换地域（另一把 Key）可能有用。
 * 审核不通过 → 直接抛出（换哪个地域都一样）。
 */
async function requestTranslation(endpoint, apiKey, payload) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return {
        ok: false,
        timeout: true,
        error: new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`)
      };
    }
    return {
      ok: false,
      retryEndpoint: true,
      error: new Error(`无法连接 TokenHub：${error?.message || error}`)
    };
  }

  const raw = await response.text();

  if (!response.ok) {
    const message = extractApiError(raw) || raw.slice(0, 300);
    return {
      ok: false,
      retryEndpoint: response.status >= 500,
      error: new Error(`接口错误 ${response.status}：${message}`)
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, retryEndpoint: true, error: new Error('接口返回了无法解析的内容') };
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return { ok: true, translation: content.trim() };
  }

  if (choice?.finish_reason === 'sensitive') throw new Error('内容未通过审核，无法翻译');
  return { ok: false, retryEndpoint: false, error: new Error('模型没有返回译文') };
}

/** 有 Key 的地域随机打乱顺序：先随机挑一个，失败再切另一个 */
function shuffleRegions(regions) {
  const order = regions.slice();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

async function callModel(text, targetLang) {
  const keys = await getApiKeys();
  const usable = REGIONS.filter((region) => Boolean(keys[region.id]));

  if (usable.length === 0) {
    throw new Error('未填写 API Key：请点击工具栏图标，在「段落翻译」中填写广州或新加坡的 TokenHub API Key');
  }

  const payload = JSON.stringify({
    model: MODEL,
    // 官方基础翻译写法
    messages: [
      {
        role: 'user',
        content: `将以下文本翻译为${targetLang}，注意只需要输出翻译后的结果，不要额外解释：${text}`
      }
    ],
    stream: false
  });

  const failures = new Map();

  // 尝试顺序：
  // 第一轮 各写一行的地域默认地址 —— 先随机挑一个，失败立刻切另一个
  // 第二轮 各写一行的备用地址 —— 前面全失败时的最后手段
  const order = shuffleRegions(usable);
  const attempts = [];
  for (const region of order) attempts.push({ region, endpoint: region.endpoints[0] });
  for (const region of order) {
    for (const endpoint of region.endpoints.slice(1)) attempts.push({ region, endpoint });
  }

  /** 该地域已确定失败且换域名也无意义（超时 / 4xx 等），不再重试它的备用地址 */
  const deadRegions = new Set();

  for (const { region, endpoint } of attempts) {
    if (deadRegions.has(region.id)) continue;

    const result = await requestTranslation(endpoint, keys[region.id], payload);
    if (result.ok) return result.translation;

    if (!failures.has(region.id)) failures.set(region.id, result.error);
    // 超时不再纠缠该地域；4xx 属于请求或密钥本身的问题，换域名同样无效
    if (result.timeout || !result.retryEndpoint) deadRegions.add(region.id);
  }

  const errors = usable.filter((region) => failures.has(region.id));
  if (errors.length === 1) throw failures.get(errors[0].id);

  throw new Error(
    `翻译失败（${errors
      .map((region) => `${region.label}：${failures.get(region.id).message}`)
      .join('；')}）`
  );
}

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  // 命中后移到末尾，近似 LRU
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (translationCache.size >= CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

function translateText(rawText, targetLang) {
  const source = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!source) throw new Error('没有可翻译的文本');

  const text = source.length > MAX_SOURCE_CHARS ? source.slice(0, MAX_SOURCE_CHARS) : source;
  const lang = targetLang || DEFAULT_TARGET_LANG;
  const cacheKey = `${lang}\u0000${text}`;

  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = callModel(text, lang)
    .then((translation) => {
      cacheSet(cacheKey, translation);
      inflight.delete(cacheKey);
      return translation;
    })
    .catch((error) => {
      inflight.delete(cacheKey);
      throw error;
    });

  inflight.set(cacheKey, job);
  return job;
}

/* ============================================================================
 * 代理
 * ========================================================================== */

function proxySet(details) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function proxyGet(details) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get(details, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

/** 解析 "http://127.0.0.1:10801" / "127.0.0.1:10801" / "socks5://127.0.0.1:1080" */
function parseProxyServer(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!PROXY_SCHEMES.has(scheme)) return null;

  let host = url.hostname;
  if (!host) return null;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  const port = url.port ? Number(url.port) : PROXY_DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { scheme, host, port };
}

function formatProxyServer(server) {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  return `${server.scheme}://${host}:${server.port}`;
}

function buildProxyConfig(server) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: server.scheme, host: server.host, port: server.port },
      bypassList: PROXY_BYPASS_LIST
    }
  };
}

async function getProxyServer() {
  const { proxyServer } = await chrome.storage.local.get({ proxyServer: DEFAULT_PROXY_SERVER });
  return parseProxyServer(proxyServer) || parseProxyServer(DEFAULT_PROXY_SERVER);
}

async function readProxyState() {
  const stored = await chrome.storage.local.get({ proxyMode: 'proxy' });
  const server = await getProxyServer();

  let settings = null;
  try {
    settings = await proxyGet({ incognito: false });
  } catch (error) {
    console.warn('[proxy] 读取代理设置失败：', error);
  }

  // 旧版本存的是 'system'，迁移后视为「代理」态
  const rawMode =
    settings?.value?.mode || (stored.proxyMode === 'direct' ? 'direct' : 'fixed_servers');

  let mode;
  if (rawMode === 'direct') mode = 'direct';
  else if (rawMode === 'fixed_servers') mode = 'proxy';
  else mode = 'other';

  return {
    mode,
    rawMode,
    server: formatProxyServer(server),
    bypass: PROXY_BYPASS_LIST,
    levelOfControl: settings?.levelOfControl || 'controllable_by_this_extension'
  };
}

async function applyProxyMode(mode) {
  if (!PROXY_MODES.has(mode)) throw new Error(`不支持的代理模式：${mode}`);

  const config = mode === 'direct' ? { mode: 'direct' } : buildProxyConfig(await getProxyServer());

  await proxySet({ value: config, scope: 'regular' });
  await chrome.storage.local.set({ proxyMode: mode });
  await refreshBadge();

  return readProxyState();
}

/** 更新代理地址；当前处于「代理」态时立即生效 */
async function setProxyServer(input) {
  const server = parseProxyServer(input);
  if (!server) throw new Error('代理地址格式不正确，示例：http://127.0.0.1:10801');

  const text = formatProxyServer(server);
  await chrome.storage.local.set({ proxyServer: text });

  const { proxyMode } = await chrome.storage.local.get({ proxyMode: 'proxy' });
  if (proxyMode === 'proxy') {
    await proxySet({ value: buildProxyConfig(server), scope: 'regular' });
  }

  await refreshBadge();
  return readProxyState();
}

async function refreshBadge() {
  try {
    const { mode } = await readProxyState();
    const label = mode === 'direct' ? '直连' : mode === 'proxy' ? '代理' : '其他';

    await chrome.action.setBadgeText({ text: label });
    await chrome.action.setBadgeBackgroundColor({ color: mode === 'direct' ? '#2e7d32' : '#1565c0' });
    await chrome.action.setTitle({
      title: `工具箱 — 当前代理：${label}`
    });
  } catch (error) {
    console.warn('[proxy] 更新角标失败：', error);
  }
}

/* ============================================================================
 * 鼠标手势
 * ========================================================================== */

function requireTabId(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') throw new Error('无法确定当前标签页');
  return tabId;
}

/** 关闭手势所在的标签页 */
async function closeGestureTab(sender) {
  await chrome.tabs.remove(requireTabId(sender));
  return { action: 'closeTab' };
}

/** 刷新手势所在的标签页（手势在 iframe 里也能刷新整个页面） */
async function reloadGestureTab(sender) {
  await chrome.tabs.reload(requireTabId(sender));
  return { action: 'reloadTab' };
}

/**
 * 「上」：让顶层框架把整页滚到顶部
 * 手势可能起自 iframe，那里没有可滚动的整页，必须转给 frameId 0
 */
async function scrollGestureTabTop(sender) {
  const tabId = requireTabId(sender);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'gesture:scrollTop' }, { frameId: 0 });
  } catch (error) {
    console.warn('[gesture] 通知顶层框架滚动失败：', error);
  }
  return { action: 'scrollTop' };
}

/** 恢复最近关闭的页面；最近关闭的是窗口时恢复整个窗口 */
async function reopenClosedTab() {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
  const latest = sessions?.[0];
  if (!latest) throw new Error('没有可恢复的页面');

  if (latest.tab) {
    await chrome.sessions.restore(latest.tab.sessionId);
    return { action: 'reopenTab', kind: 'tab' };
  }
  if (latest.window) {
    await chrome.sessions.restore(latest.window.sessionId);
    return { action: 'reopenTab', kind: 'window' };
  }

  throw new Error('没有可恢复的页面');
}

/* ============================================================================
 * 消息分发
 * ========================================================================== */

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'translate': {
      const translation = await translateText(message.text, message.targetLang);
      return { translation };
    }
    case 'proxy:get':
      return readProxyState();
    case 'proxy:set':
      return applyProxyMode(message.mode);
    case 'proxy:server':
      return setProxyServer(message.server);
    case 'apikey:get':
      return readApiKeyState();
    case 'apikey:set':
      return saveApiKey(message.region, message.apiKey);
    case 'gesture:closeTab':
      return closeGestureTab(sender);
    case 'gesture:reloadTab':
      return reloadGestureTab(sender);
    case 'gesture:scrollTop':
      return scrollGestureTabTop(sender);
    case 'gesture:reopenTab':
      return reopenClosedTab();
    default:
      throw new Error(`未知消息类型：${message?.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true; // 异步响应
});

/* ============================================================================
 * 生命周期
 * ========================================================================== */

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    const { proxyMode } = await chrome.storage.local.get({ proxyMode: '' });

    // 首次安装：直接写入 fixed_servers 配置
    // 升级：旧版本写入的是 system 模式，迁移到带绕过列表的 fixed_servers
    const shouldApply =
      details.reason === 'install' || (details.reason === 'update' && proxyMode === 'system');

    if (shouldApply) {
      await applyProxyMode(proxyMode === 'direct' ? 'direct' : 'proxy').catch((error) =>
        console.warn('[proxy] 初始化代理设置失败：', error)
      );
    }

    await refreshBadge();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshBadge();
});

try {
  chrome.proxy.settings.onChange.addListener(() => {
    void refreshBadge();
  });
} catch (error) {
  console.warn('[proxy] 监听代理变化失败：', error);
}

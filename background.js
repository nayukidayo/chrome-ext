/**
 * 后台 Service Worker
 *
 * 1) 代理切换：在「走本地代理(fixed_servers)」与「直连(direct)」之间切换（chrome.proxy）
 *    —— 用 fixed_servers 而非 system，是为了给翻译接口加 bypassList（直连）
 * 2) 段落翻译：调用腾讯云 TokenHub 的 hy-mt2-lite（OpenAI 兼容 /v1/chat/completions）
 *
 * API Key 存放在扩展目录的 key 文件中（纯文本，一行），
 * 只由本 Service Worker 读取，内容脚本始终拿不到密钥。
 */

'use strict';

const MODEL = 'hy-mt2-lite';
const DEFAULT_TARGET_LANG = '中文';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SOURCE_CHARS = 6000;

/** 默认接入地址（广州）+ 官方备用地址 */
const ENDPOINTS = [
  'https://tokenhub.tencentmaas.com/v1/chat/completions',
  'https://tokenhub.tencentmaas.cn/v1/chat/completions'
];

const KEY_FILES = ['key', 'key.txt'];

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

/** 不走代理的主机：TokenHub 直连，其余走本地代理 */
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

let apiKeyPromise = null;

/* ============================================================================
 * API Key
 * ========================================================================== */

function parseKeyFile(text) {
  return (
    String(text)
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && !line.startsWith('//')) || ''
  );
}

/** 读取扩展目录下的 key 文件（同源 fetch，页面无法访问） */
function loadApiKey() {
  if (!apiKeyPromise) {
    apiKeyPromise = (async () => {
      for (const file of KEY_FILES) {
        try {
          const response = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
          if (!response.ok) continue;
          const key = parseKeyFile(await response.text());
          if (key) return key;
        } catch (error) {
          console.warn('[HY-MT] 读取', file, '失败：', error);
        }
      }
      return '';
    })();
  }
  return apiKeyPromise;
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

async function callModel(text, targetLang) {
  const apiKey = await loadApiKey();
  if (!apiKey) {
    throw new Error('未找到 API Key：请在扩展目录的 key 文件中填入 TokenHub 的 API Key，然后重新加载扩展');
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

  let lastError = null;

  for (const endpoint of ENDPOINTS) {
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
        throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请稍后重试`);
      }
      // 网络层错误 → 尝试备用域名
      lastError = new Error(`无法连接 TokenHub：${error?.message || error}`);
      continue;
    }

    const raw = await response.text();

    if (!response.ok) {
      const message = extractApiError(raw) || raw.slice(0, 300);
      const error = new Error(`接口错误 ${response.status}：${message}`);
      // 5xx 可以换域名重试，4xx 属于请求本身的问题
      if (response.status < 500) throw error;
      lastError = error;
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      lastError = new Error('接口返回了无法解析的内容');
      continue;
    }

    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }

    if (choice?.finish_reason === 'sensitive') throw new Error('内容未通过审核，无法翻译');
    lastError = new Error('模型没有返回译文');
  }

  throw lastError || new Error('翻译失败');
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
 * 消息分发
 * ========================================================================== */

async function handleMessage(message) {
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
    default:
      throw new Error(`未知消息类型：${message?.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(
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

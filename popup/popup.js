'use strict';

const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
const proxyBadge = document.getElementById('proxy-badge');
const proxyHint = document.getElementById('proxy-hint');
const proxyServerInput = document.getElementById('proxy-server');
const apiKeyInputs = [
  { region: 'guangzhou', el: document.getElementById('api-key-guangzhou') },
  { region: 'singapore', el: document.getElementById('api-key-singapore') }
];
const keyHint = document.getElementById('key-hint');
const translateToggle = document.getElementById('translate-toggle');
const gestureToggle = document.getElementById('gesture-toggle');
const versionEl = document.getElementById('version');

const DEFAULT_HINT = '翻译请求已设为直连，代理未启动也能翻译。';
const KEY_HINT_DEFAULT = '模型：hy-mt2-lite · 随机选一个地域，失败时自动切另一个';
const KEY_HINT_EMPTY = '至少填写一个地域的 API Key，否则无法翻译。';
const KEY_HINT_PARTIAL = '只填了一个地域：另一个地域留空则不参与随机与回退。';

let busy = false;
let locked = false;
let lastServer = '';

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || '操作失败');
  }
  return response.data;
}

function setHint(text, warn = false) {
  proxyHint.textContent = text;
  proxyHint.classList.toggle('warn', warn);
}

function renderProxy(proxyState, { syncInput = false } = {}) {
  const { mode, levelOfControl, server } = proxyState;

  for (const button of modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }

  proxyBadge.textContent = mode === 'direct' ? '直连' : mode === 'proxy' ? '代理' : '其他';
  proxyBadge.dataset.state = mode;

  if (server) {
    lastServer = server;
    if (syncInput || document.activeElement !== proxyServerInput) proxyServerInput.value = server;
  }

  locked =
    levelOfControl === 'controlled_by_other_extensions' || levelOfControl === 'not_controllable';

  if (locked) {
    setHint(
      levelOfControl === 'not_controllable'
        ? '当前代理设置由系统策略接管，扩展无法修改。'
        : '当前代理设置由其他扩展程序接管，扩展无法修改。',
      true
    );
  } else if (mode === 'other') {
    setHint('当前是扩展之外的代理配置（PAC / 自动检测等）。', false);
  } else {
    setHint(DEFAULT_HINT, false);
  }

  for (const button of modeButtons) button.disabled = locked || busy;
  proxyServerInput.disabled = locked || busy;
}

async function refreshProxy() {
  try {
    renderProxy(await send({ type: 'proxy:get' }));
  } catch (error) {
    proxyBadge.textContent = '读取失败';
    delete proxyBadge.dataset.state;
    setHint(error.message, true);
  }
}

async function setProxyMode(mode) {
  if (busy || locked) return;

  busy = true;
  for (const button of modeButtons) button.disabled = true;

  try {
    renderProxy(await send({ type: 'proxy:set', mode }));
  } catch (error) {
    setHint(error.message, true);
  } finally {
    busy = false;
    await refreshProxy();
  }
}

async function saveProxyServer() {
  const value = proxyServerInput.value.trim();

  if (!value) {
    proxyServerInput.value = lastServer;
    return;
  }
  if (value === lastServer) return;

  try {
    const state = await send({ type: 'proxy:server', server: value });
    renderProxy(state, { syncInput: true });
    setHint(`已保存代理地址 ${state.server}`, false);
  } catch (error) {
    proxyServerInput.value = lastServer;
    setHint(error.message, true);
  }
}

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    void setProxyMode(button.dataset.mode);
  });
}

proxyServerInput.addEventListener('change', () => {
  void saveProxyServer();
});

proxyServerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    proxyServerInput.blur();
  }
});

/* 翻译 API Key */
function setKeyHint(text, warn = false) {
  keyHint.textContent = text;
  keyHint.classList.remove('muted');
  keyHint.classList.toggle('warn', warn);
}

function renderApiKey(state) {
  const regions = Array.isArray(state?.regions) ? state.regions : [];
  const byId = new Map(regions.map((region) => [region.id, region]));

  for (const { region, el } of apiKeyInputs) {
    const info = byId.get(region);
    el.value = '';
    // 已保存时占位符直接显示密钥掩码
    el.placeholder = info?.hasApiKey ? info.apiKeyMasked : 'sk-...';
  }

  const filled = regions.filter((region) => region.hasApiKey).length;
  if (filled === 0) {
    setKeyHint(KEY_HINT_EMPTY, true);
  } else if (filled < regions.length) {
    setKeyHint(KEY_HINT_PARTIAL);
    keyHint.classList.add('muted');
  } else {
    keyHint.textContent = KEY_HINT_DEFAULT;
    keyHint.classList.add('muted');
    keyHint.classList.remove('warn');
  }
}

async function refreshApiKey() {
  try {
    renderApiKey(await send({ type: 'apikey:get' }));
  } catch (error) {
    setKeyHint(error.message, true);
  }
}

async function saveApiKey(region, input) {
  const value = input.value.trim();

  if (!value) {
    // 没输入内容：恢复成已保存状态的提示，不覆盖原有密钥
    await refreshApiKey();
    return;
  }

  try {
    renderApiKey(await send({ type: 'apikey:set', region, apiKey: value }));
  } catch (error) {
    // 失败时保留输入内容，方便修正
    setKeyHint(error.message, true);
  }
}

for (const { region, el } of apiKeyInputs) {
  el.addEventListener('change', () => {
    void saveApiKey(region, el);
  });

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el.blur(); // 交给 change 事件保存
    }
  });
}

/* 功能开关（storage.sync，默认开启） */
function bindToggle(input, key) {
  try {
    chrome.storage.sync.get({ [key]: true }, (value) => {
      if (chrome.runtime.lastError) return;
      input.checked = value[key] !== false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[key]) return;
      input.checked = changes[key].newValue !== false;
    });

    input.addEventListener('change', () => {
      void chrome.storage.sync.set({ [key]: input.checked });
    });
  } catch (error) {
    console.warn(`[popup] 读取 ${key} 开关失败：`, error);
  }
}

bindToggle(translateToggle, 'translateEnabled');
bindToggle(gestureToggle, 'gestureEnabled');

versionEl.textContent = `v${chrome.runtime?.getManifest?.()?.version ?? 'dev'}`;
void refreshProxy();
void refreshApiKey();

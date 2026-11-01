'use strict';

const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
const proxyBadge = document.getElementById('proxy-badge');
const proxyHint = document.getElementById('proxy-hint');
const proxyServerInput = document.getElementById('proxy-server');
const translateToggle = document.getElementById('translate-toggle');
const versionEl = document.getElementById('version');

const DEFAULT_HINT = '翻译请求已设为直连，代理未启动也能翻译。';

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

  proxyBadge.textContent = mode === 'direct' ? '直连' : mode === 'proxy' ? '走代理' : '其他';
  proxyBadge.dataset.mode = mode === 'direct' ? 'direct' : 'system';

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
    proxyBadge.removeAttribute('data-mode');
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

/* 翻译开关 */
try {
  chrome.storage.sync.get({ translateEnabled: true }, (value) => {
    if (chrome.runtime.lastError) return;
    translateToggle.checked = value.translateEnabled !== false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.translateEnabled) return;
    translateToggle.checked = changes.translateEnabled.newValue !== false;
  });

  translateToggle.addEventListener('change', () => {
    void chrome.storage.sync.set({ translateEnabled: translateToggle.checked });
  });
} catch (error) {
  console.warn('[popup] 读取翻译开关失败：', error);
}

versionEl.textContent = `v${chrome.runtime?.getManifest?.()?.version ?? 'dev'}`;
void refreshProxy();

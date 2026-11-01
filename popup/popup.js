'use strict';

const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
const proxyBadge = document.getElementById('proxy-badge');
const proxyHint = document.getElementById('proxy-hint');
const translateToggle = document.getElementById('translate-toggle');
const versionEl = document.getElementById('version');

let busy = false;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || '操作失败');
  }
  return response.data;
}

function renderProxy(proxyState) {
  const { mode, rawMode, levelOfControl } = proxyState;

  for (const button of modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }

  proxyBadge.textContent = mode === 'direct' ? '直连' : '系统代理';
  proxyBadge.dataset.mode = mode;

  const locked =
    levelOfControl === 'controlled_by_other_extensions' || levelOfControl === 'not_controllable';

  if (locked) {
    proxyHint.textContent =
      levelOfControl === 'not_controllable'
        ? '当前代理设置由系统策略接管，扩展无法修改。'
        : '当前代理设置由其他扩展程序接管，扩展无法修改。';
    proxyHint.classList.add('warn');
  } else {
    proxyHint.textContent =
      rawMode && rawMode !== mode ? `实际生效模式：${rawMode}` : '切换后对所有网站生效。';
    proxyHint.classList.remove('warn');
  }

  for (const button of modeButtons) button.disabled = locked || busy;
}

async function refreshProxy() {
  try {
    renderProxy(await send({ type: 'proxy:get' }));
  } catch (error) {
    proxyBadge.textContent = '读取失败';
    proxyBadge.removeAttribute('data-mode');
    proxyHint.textContent = error.message;
    proxyHint.classList.add('warn');
  }
}

async function setProxyMode(mode) {
  if (busy) return;

  busy = true;
  for (const button of modeButtons) button.disabled = true;

  try {
    renderProxy(await send({ type: 'proxy:set', mode }));
  } catch (error) {
    proxyHint.textContent = error.message;
    proxyHint.classList.add('warn');
  } finally {
    busy = false;
    await refreshProxy();
  }
}

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    void setProxyMode(button.dataset.mode);
  });
}

/* 翻译开关 */
chrome.storage.sync.get({ translateEnabled: true }, (value) => {
  translateToggle.checked = value.translateEnabled !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.translateEnabled) return;
  translateToggle.checked = changes.translateEnabled.newValue !== false;
});

translateToggle.addEventListener('change', () => {
  void chrome.storage.sync.set({ translateEnabled: translateToggle.checked });
});

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
void refreshProxy();

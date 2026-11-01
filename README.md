# 工具箱（Chrome 扩展）

Manifest V3 扩展，包含三个功能位：

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 1. 代理切换 | ✅ | 在「代理（fixed_servers）」与「直连」之间一键切换 |
| 2. 段落翻译 | ✅ | `Ctrl` + 左键点击段落 → 段落下方显示中文译文，再点一次隐藏 |
| 3. 鼠标手势 | ⏳ | 预留，暂未实现（弹窗中占位） |

## 安装

1. 打开 `chrome://extensions/`，右上角开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 点击工具栏图标打开弹窗。

> 想在 `file://` 页面使用翻译，需要在扩展详情页打开「允许访问文件网址」。

## API Key

翻译使用腾讯云 TokenHub 的 `hy-mt2-lite` 模型。
API Key 在**弹窗 →「段落翻译」→ API Key** 中填写，点「保存」或按回车生效：

```
sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- 保存后输入框清空，占位提示显示掩码（如 `已保存 sk-z…THK`），方便确认已生效。
- 密钥保存在 `chrome.storage.local`，只由后台 Service Worker 读取；
  内容脚本与网页都拿不到密钥。
- 不再从扩展目录的 `key` 文件读取；如果旧版本留下过 `key` / `key.txt`，可以直接删除。

## 功能说明

### 1. 代理切换

弹窗中「代理 / 直连」二选一，通过 `chrome.proxy.settings` 的 `regular` 作用域生效：

- 代理：`fixed_servers` + `singleProxy` 指向本地代理（默认 `http://127.0.0.1:10801`，可在弹窗里改）。
- 直连：`{ mode: "direct" }`，所有请求不走代理。

为什么不用 `system` 模式：官方规定 `system` 模式**不允许附带其他参数**，因此无法加 `bypassList`。
改用 `fixed_servers` 后就能为 TokenHub 域名加绕过规则，翻译请求直连、不依赖代理是否运行：

```
bypassList: ['*.tencentmaas.com', '*.tencentmaas.cn', 'localhost', '127.0.0.1', '[::1]', '<local>']
```

工具栏角标显示当前状态（`代理` / `直连`）。
如果代理设置已被其他扩展或系统策略接管（`levelOfControl` 不是本扩展可控），弹窗会提示并禁用按钮。

### 2. 段落翻译

- **触发**：按住 `Ctrl` 后左键点击网页任意段落。
- **定位**：用 `caretRangeFromPoint` 取鼠标下的文字节点，向上找最近的块级容器（`p`、`li`、`td`、`div` 等）作为「段落」。
- **展示**：译文卡片插入在该段落末尾（原文下方），使用自定义元素 + Shadow DOM + 构造式样式表，页面 CSS / CSP 基本不会干扰。
- **隐藏**：再次 `Ctrl` + 点击同一段落即隐藏；译文已缓存，第三次点击直接显示而不重复请求。
- **跳过**：链接、按钮、输入框、可编辑区域、`pre/code` 等不拦截，保留浏览器原生 `Ctrl+点击` 行为。

请求由后台 Service Worker 发出（内容脚本不直接联网）：

```
POST https://tokenhub.tencentmaas.com/v1/chat/completions
Authorization: Bearer <key>
{
  "model": "hy-mt2-lite",
  "messages": [{ "role": "user",
    "content": "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：<原文>" }],
  "stream": false
}
```

细节：

- 主域名失败（网络错误 / 5xx）时自动尝试备用域名 `tokenhub.tencentmaas.cn`。
- 同一段落在后台有内存缓存 + 并发去重，最多 400 条。
- 单次最多翻译 2000 字符，超出会截断并在卡片上标注。
- 纯中文段落不会调用接口，只显示提示。
- 卡片上的「隐藏」按钮可直接关闭；出错时出现「重试」按钮。

### 3. 鼠标手势（未实现）

弹窗中保留入口，代码尚未编写，后续接入时建议新增 `content/gestures.js` 并在
`manifest.json` 的 `content_scripts` 中追加。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `proxy` | 切换代理模式（fixed_servers / direct） |
| `storage` | 保存代理模式、代理地址、API Key 与翻译开关 |
| `host_permissions`（TokenHub 域名） | 后台 Service Worker 调用翻译接口 |
| `content_scripts` 的 `<all_urls>` | 在所有网页监听 `Ctrl` + 点击 |

## 目录结构

```
manifest.json
background.js            # Service Worker：代理切换 + 调用 HY-MT2-Lite
content/
  translate.js           # 段落定位、译文面板、Ctrl+点击交互
  translate.css          # 仅打印时隐藏译文
popup/
  popup.html / popup.css / popup.js
icons/                   # 16/32/48/128 图标
.dev-test/harness.html   # 开发自测页（桩掉 chrome API，直接双击可用）
```

## 已知限制

- 代理地址写在 `chrome.storage.local`（默认 `http://127.0.0.1:10801`），弹窗里可直接修改；支持 `http/https/socks4/socks5/quic`。
- 若代理需要认证，扩展无法代替你输入账号密码，这类请求会失败（本地代理通常不需要）。
- Chrome 不允许在 `chrome://`、Chrome 应用商店等特权页面注入内容脚本。
- 若段落位于跨域 iframe 内，需要该 iframe 允许注入（已开启 `all_frames`）。
- 部分用 Canvas / 自定义渲染的「文字」不在 DOM 中，无法翻译。

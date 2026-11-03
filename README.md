# 工具箱（Chrome 扩展）

Manifest V3 扩展，包含三个功能位：

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 1. 代理切换 | ✅ | 在「代理（fixed_servers）」与「直连」之间一键切换 |
| 2. 段落翻译 | ✅ | 手势「左右」→ 翻译轨迹起点处的段落；优先内嵌，显示不开时改用气泡 |
| 3. 鼠标手势 | ✅ | 按住右键划动：左右翻译、下右关闭页面、上左恢复页面、上下刷新、左后退、右前进、上回到顶部、下滚动到底部 |

## 安装

1. 打开 `chrome://extensions/`，右上角开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 点击工具栏图标打开弹窗。

> 想在 `file://` 页面使用翻译，需要在扩展详情页打开「允许访问文件网址」。

## API Key

翻译使用腾讯云 TokenHub 的 `hy-mt2-lite` 模型。TokenHub 按地域分成两个相互独立的站点，
API Key **不互通**（只能用对应地域的 Key 调用对应地域的地址）：

| 地域 | 默认地址 | 备用地址 |
| --- | --- | --- |
| 广州 | `https://tokenhub.tencentmaas.com` | `https://tokenhub.tencentmaas.cn` |
| 新加坡 | `https://tokenhub-intl.tencentmaas.com` | `https://tokenhub-intl.tencentmaas.cn` |

API Key 在**弹窗 →「段落翻译」→ 广州 / 新加坡** 两个输入框中分别填写，回车或失焦即保存：

```
广州     sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
新加坡   sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- 至少填一个；只填一个时不会随机、也不会切换，失败就直接报错。
- 保存后输入框清空，占位符变为密钥掩码（如 `sk-z…hTHK`），方便确认已生效。
- 密钥保存在 `chrome.storage.local`，只由后台 Service Worker 读取；
  内容脚本与网页都拿不到密钥。
- 不再从扩展目录的 `key` 文件读取；如果旧版本留下过 `key` / `key.txt`，可以直接删除。
- 旧版本只存了一把 Key（`apiKey`），升级后会自动迁移成广州地域的 Key。

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

- **触发**：按住右键先向左、再向右划动（手势「左右」，两个方向各超过 30px 后松手），翻译鼠标轨迹起点所在的段落。
- **定位**：用 `caretRangeFromPoint` 取鼠标下的文字节点，向上找最近的块级容器（`p`、`li`、`td`、`div` 等）作为「段落」。
- **内嵌展示**：译文卡片插入在该段落末尾（原文下方），使用自定义元素 + Shadow DOM + 构造式样式表，页面 CSS / CSP 基本不会干扰。
- **气泡展示**：以下情况改用 Popover API 把卡片提升到 **top layer** 显示成气泡：
  - 链接、按钮、标签等交互元素，塞入译文会撑破布局或误触点击；
  - 段落自身或祖先会裁剪内容（固定高度 + `overflow: hidden`、`-webkit-line-clamp`、`contain: paint`、`clip-path` 等），向上提升后仍然显示不全。

  气泡贴住目标定位：下方空间不够时翻到上方，超出视口时向内收，窗口缩放时跟随重定位；
  **滚动页面、点击别处或按 `Esc` 时自动关闭**；长译文内部可滚动。
- **自动滚动**：若内嵌面板处于 `overflow: auto/scroll` 容器内并落到可视区之外，会微调该容器的 `scrollTop`（不影响整页滚动）。
- **再次触发**：对同一段落再划一次「左右」会隐藏已显示的译文；译文已缓存，第三次触发直接显示而不重复请求。
- **跳过**：输入框、下拉框、可编辑区域、`pre/code` 等不翻译，保留页面原生行为。

请求由后台 Service Worker 发出（内容脚本不直接联网）：

```
POST https://tokenhub.tencentmaas.com/v1/chat/completions        # 广州
POST https://tokenhub-intl.tencentmaas.com/v1/chat/completions   # 新加坡
Authorization: Bearer <该地域的 key>
{
  "model": "hy-mt2-lite",
  "messages": [{ "role": "user",
    "content": "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：<原文>" }],
  "stream": false
}
```

细节：

- **随机选地域**：每次请求在有 Key 的地域里随机挑一个作为首选（保证两把 Key 都能分摊流量）。
- **失败即切换**：首选地域失败（网络错误 / 4xx / 5xx / 超时）后立刻换另一个地域重试；
  两边都失败时才报错，报错信息会分别列出各地域的原因。
- **备用域名轮到最后**：两个地域的默认地址都失败后，才会依次尝试各自的备用域名。
- 超时的地域不再纠缠其备用域名；内容审核不通过则直接失败（换地域结果相同）。
- 同一段落在后台有内存缓存 + 并发去重，最多 400 条。
- 单次最多翻译 2000 字符，超出会截断并在卡片上标注。
- 纯中文段落不会调用接口，只显示提示。
- 卡片上的「隐藏」按钮可直接关闭；出错时出现「重试」按钮。

### 3. 鼠标手势

按住鼠标**右键**在页面中划动，松手后执行对应动作，拖动过程中会显示蓝色轨迹：

| 手势 | 动作 | 实现方式 |
| --- | --- | --- |
| 左右 | 翻译手势起点处的段落 | 内容脚本调用 `content/translate.js` |
| 下右 | 关闭当前页面 | 后台 `chrome.tabs.remove` |
| 上左 | 打开刚关闭的页面 | 后台 `chrome.sessions.restore` |
| 上下 | 刷新页面 | 后台 `chrome.tabs.reload` |
| 左 | 后退（上一页） | 后台 `chrome.tabs.goBack` |
| 右 | 前进（下一页） | 后台 `chrome.tabs.goForward` |
| 上 | 整个页面滚动到顶部 | 顶层框架内容脚本 `scrollTo({ top: 0, behavior: 'smooth' })` |
| 下 | 整个页面滚动到底部 | 顶层框架内容脚本 `scrollTo({ top: scrollHeight, behavior: 'smooth' })` |

识别细节：

- **按单向长度判定（不看总长）**：轨迹先按 Ramer–Douglas–Peucker 简化，再按主轴映射为 `U / D / L / R`，
  **每个方向段都要超过 30px** 才算数。例如「下右」需要向下 > 30px 且向右 > 30px；「上」或「下」只需单向 > 30px。
- **拦截右键菜单**：按住右键拖动到**轨迹出现**（累计移动 ≥ 10px）才拦掉网页原生右键菜单（不要求匹配到手势）；
  轨迹还没出现就松手（包括完全没移动、以及按下时的手抖）一律按普通右键点击处理，照常弹出菜单。
- **轨迹显示**：绘制在全屏 SVG 浮层（自定义元素 + Shadow DOM + 构造式样式表）上，
  蓝色单色实线，无描边也无渐变，松手后立即消失（无淡出动画）。
- **仅右键**：不影响左键点击、选区与链接拖拽。
- **开关**：弹窗中的鼠标手势卡片可随时启用 / 停用，设置保存在 `chrome.storage.sync`。
- 页面内的 iframe 也生效（`all_frames`）；即使手势起自 iframe（如 IT之家文章页里的「大家在看」板块），所有手势都能正常识别。
- 手势动作需要标签页信息的由内容脚本发消息给后台执行，刷新与关闭针对整个标签页而不是单个 iframe。
- 「上」/「下」只滚动整个页面，不会去滚鼠标下方的内部滚动容器（如评论列表、侧栏）。
  在 iframe 内划「上」/「下」时，子框架会把动作转给后台、再由后台通知顶层框架滚动，所以同样能滚到整页顶部 / 底部。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `proxy` | 切换代理模式（fixed_servers / direct） |
| `storage` | 保存代理模式、代理地址、两把 API Key、翻译开关与鼠标手势开关 |
| `sessions` | 恢复最近关闭的标签页（`chrome.sessions`） |
| `host_permissions`（TokenHub 广州 / 新加坡域名） | 后台 Service Worker 调用翻译接口 |
| `content_scripts` 的 `<all_urls>` | 在所有网页监听右键手势与段落翻译 |

## 目录结构

```
manifest.json
background.js            # Service Worker：代理切换 + 调用 HY-MT2-Lite
content/
  translate.js           # 段落定位、译文卡片 / 气泡、对外提供 translateAtPoint
  translate.css          # 仅打印时隐藏译文
  gesture.js             # 右键手势识别、轨迹浮层、整页滚动、调用翻译
popup/
  popup.html / popup.css / popup.js
icons/                   # 16/32/48/128 图标
.dev-test/harness.html   # 开发自测页（桩掉 chrome API，直接双击可用）
.dev-test/layout-test.js # 布局逻辑回归测试：node .dev-test/layout-test.js
```

## 已知限制

- 最低支持 Chrome 156（`minimum_chrome_version`），依赖 Popover API 与构造式样式表。
- 一旦某个段落切换到气泡模式，本次显示期间会一直保持气泡（避免内嵌/气泡来回跳动），
  滚动页面、点击别处或按 `Esc` 关闭后，再次触发会重新判定。
- 代理地址写在 `chrome.storage.local`（默认 `http://127.0.0.1:10801`），弹窗里可直接修改；支持 `http/https/socks4/socks5/quic`。
- 若代理需要认证，扩展无法代替你输入账号密码，这类请求会失败（本地代理通常不需要）。
- Chrome 不允许在 `chrome://`、Chrome 应用商店等特权页面注入内容脚本，鼠标手势在这些页面同样不可用。
- 若段落位于跨域 iframe 内，需要该 iframe 允许注入（已开启 `all_frames`）。
- 部分用 Canvas / 自定义渲染的「文字」不在 DOM 中，无法翻译。
- 右键手势依赖鼠标事件：触屏、部分仅支持触控笔的设备无法使用； macOS 上右键菜单在按下时就弹出，手势体验可能不完整。
- 在 iframe 内起手的手势，轨迹只会绘制在该 iframe 的可见区域内。

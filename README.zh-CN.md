# LongChat Perf

**一个让长 ChatGPT 对话保持流畅的轻量本地渲染补丁（浏览器扩展）。**

```
无网络请求。  无统计埋点。  不删除任何消息。
```

核心 JS 约 300 行。无框架、无构建步骤、运行时零依赖。

[English (README.md)](README.md)

---

## 这个扩展**不**做什么

- 不导出对话
- 没有任何 AI 功能
- 无统计埋点
- 无后端
- 无账号体系
- 不删除 DOM 节点
- 无构建框架

它是一个单一用途的渲染补丁：长对话会随消息全部驻留在 DOM 中而逐渐变卡，
LongChat Perf 负责减少"你当前没在看的内容"的渲染开销。

## 安装

当前仅以源码形式分发，两步即可：

1. 下载本仓库 ZIP（或 `git clone`）。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启**开发者模式**，
   点击**加载已解压的扩展程序**，选择 `longchat-perf/` 文件夹。

无需构建、无需包管理器、无需注册。

## 原理

content script 提供四个可选补丁，均可通过工具栏弹窗单独开关（也可整体停用）。

| 补丁 | 作用 |
|---|---|
| **屏外渲染跳过** | 给消息与代码块元素应用 `content-visibility: auto` + `contain-intrinsic-size`，浏览器跳过视口外内容的布局与绘制（Chromium 85+、Firefox 125+、Safari 18+）。 |
| **中和毛玻璃** | 作为可选的高强度性能补丁禁用 `backdrop-filter`，避免滚动时毛玻璃表面逐帧合成图层。 |
| **旧消息渐进折叠** | 向下滚动时，将视口上方至少两屏之外的消息以 CSS 折叠为零高度，收进一条提示条；向上滚动即全部展开。 |
| **流式输出节流** | 回答流式输出期间暂停消息区的动画与过渡，降低每个 token 到达时的合成开销。 |

### 折叠的行为约定

- 折叠是**渐进且由滚动驱动**的：只在您向下滚动时发生，且只碰远离视口的历史消息；
  扩展绝不会在后台自行折叠内容。
- **向上滚动立即全部展开**，且不会移动您正在阅读的内容。
- 任何一次展开后有 8 秒冷却，避免折叠/展开反复抖动。
- 对话顶部的提示条可一键跳到最早的消息。

**关于折叠的边界说明：** 它主要减少布局/绘制/渲染开销，而非真正虚拟化或删除
DOM 节点。它不删除 ChatGPT 托管的消息节点；折叠基于 CSS 且可逆。消息节点、
React 状态与 JS 内存始终保留。

**兼容性：** ChatGPT 前端是闭源的且会持续变化。脚本通过稳定的 DOM 属性
（`div[data-message-author-role][data-message-id]`）定位消息。如果 ChatGPT
改变渲染策略或 DOM 结构，可能需要重新验证兼容性。

## 开发

```bash
npm install   # 安装 jsdom（仅开发依赖）
npm test      # 运行 tools/smoke-test.js（24 项断言，基于 jsdom）
```

重新生成图标（纯标准库，无需 Pillow）：

```bash
python3 tools/gen_icons.py
```

## 隐私

扩展无网络请求、无统计、无后端，不传输任何对话内容；仅通过
`chrome.storage.sync` 保存您的开关设置。详见 [PRIVACY.md](PRIVACY.md)。

## 许可证

MIT。详见 [LICENSE](LICENSE)。

## 路线图（P1 — 尚未实现）

- 在真实超长会话上采集 Before/After 数据（输入延迟、滚动帧耗时、内存）
- 一段 Before/After 演示 GIF
- GitHub Actions 在 CI 上运行 `npm test`
- Chrome Web Store / Edge Store 分发

## 免责声明

本项目为非官方项目，与 OpenAI 无关联、未经其认可或赞助。"ChatGPT" 及相关
商标归其各自所有者所有，此处提及仅为描述兼容目标。

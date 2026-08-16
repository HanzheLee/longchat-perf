// ============================================================
// ChatGPT 会话性能优化 —— Content Script
// 运行于 chatgpt.com / chat.openai.com。
// 思路：不修改任何站点代码，通过切换 html.lcp-* 类来启停注入
// 样式，并配合轻量 DOM 补丁（旧消息折叠）解决长会话卡顿。
//
// v2 折叠策略（修复 v1 的体验问题）：
//   - 只在【用户向下滚动】时渐进折叠远离视口的历史消息，绝不后台自动折叠
//   - 用户【向上滚动】即展开全部（视口内容不动），彻底消除"往上拉看不到"
//   - 折叠高度补偿改为【累加】，多次折叠后展开位置依然准确
//   - 展开后有 8s 冷却，防止反复折叠-展开抖动
// ============================================================
(() => {
  'use strict';
  if (window.__cpfInjected) return;
  window.__cpfInjected = true;

  const DEFAULTS = {
    enabled: true,      // 总开关
    cv: true,           // 补丁1: content-visibility 核心渲染跳过
    noblur: true,       // 补丁2: 中和毛玻璃
    collapse: true,     // 补丁3: 旧消息折叠
    stream: true,       // 补丁4: 流式输出防抖
    keepMessages: 60,   // 折叠时保留最近的多少条消息不折
  };

  const store = chrome.storage.sync || chrome.storage.local;
  let settings = { ...DEFAULTS };

  /* ---------------- 根类管理：决定启用哪些补丁 ---------------- */
  function applyClasses() {
    const root = document.documentElement;
    const on = settings.enabled;
    root.classList.toggle('lcp-on', on);
    root.classList.toggle('lcp-cv', on && settings.cv);
    root.classList.toggle('lcp-noblur', on && settings.noblur);
    root.classList.toggle('lcp-collapse', on && settings.collapse);
    root.classList.toggle('lcp-stream', on && settings.stream);
    if (!on) expandAll();
  }

  /* ---------------- 工具 ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ChatGPT 每条消息：<div data-message-author-role="user|assistant" data-message-id="...">
  function getMessages() {
    return $$('div[data-message-author-role][data-message-id]');
  }

  let scrollCache = null;
  let scrollCacheAt = 0;
  function findScrollContainer(force = false) {
    const now = Date.now();
    if (!force && scrollCache && scrollCache.isConnected && now - scrollCacheAt < 15000) {
      return scrollCache;
    }
    const msgs = getMessages();
    let el = msgs.length ? msgs[msgs.length - 1] : document.body;
    let depth = 0;
    while (el && el !== document.documentElement && depth++ < 40) {
      const st = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 60) {
        scrollCache = el;
        scrollCacheAt = now;
        return el;
      }
      el = el.parentElement;
    }
    scrollCache = document.scrollingElement;
    scrollCacheAt = now;
    return scrollCache;
  }

  /* ---------------- 流式输出检测（突变频率 + 停止按钮兜底） ---------------- */
  const stream = {
    active: false,
    burst: 0,
    last: performance.now(),
    settleTimer: 0,
    mark() {
      if (!settings.enabled || !settings.stream) return;
      const now = performance.now();
      if (now - this.last > 600) this.burst = 0; // 滑动窗口
      this.last = now;
      this.burst += 1;
      if (this.burst > 30) this.set(true); // 600ms 内 30+ 次突变 ≈ 流式输出
    },
    set(v) {
      if (this.active === v) return;
      this.active = v;
      document.documentElement.classList.toggle('lcp-streaming', v);
      if (!v) repairBar(); // 流结束后确认提示条还在
    },
  };
  // 兜底：ChatGPT 生成期间会出现“停止生成”按钮
  setInterval(() => {
    const hasStop = !!$('button[aria-label*="Stop" i], [data-testid*="stop" i]');
    if (hasStop) {
      stream.set(true);
    } else if (stream.active) {
      clearTimeout(stream.settleTimer);
      stream.settleTimer = setTimeout(() => stream.set(false), 1500);
    }
  }, 800);

  /* ---------------- 旧消息折叠 ---------------- */
  const collapse = {
    folded: new Map(), // messageId -> el
    delta: 0,          // 已折叠造成的文档高度累计缩减（px，含提示条）
    bar: null,
  };
  let lastScrollTop = null;    // 滚动方向基线（首次滚动前由 bindScroll 建立）
  let expandCooldownUntil = 0; // 展开冷却（防止折叠-展开抖动）
  let lastBoundSc = null;      // 已绑定滚动监听的容器

  function updateBarLabel() {
    if (!collapse.bar) return;
    collapse.bar.textContent = `已折叠 ${collapse.folded.size} 条早期消息 · 点击展开（或向上滚动）`;
  }

  function ensureBar() {
    if (collapse.bar && collapse.bar.isConnected) return collapse.bar;
    const msgs = getMessages();
    const container = msgs.length ? msgs[0].parentElement : findScrollContainer();
    if (!container) return null;
    const bar = document.createElement('div');
    bar.className = 'lcp-fold-bar';
    bar.addEventListener('click', () => expandAll(true));
    container.insertBefore(bar, container.firstChild);
    collapse.bar = bar;
    updateBarLabel();
    return bar;
  }

  // 提示条可能被 React 重渲染清掉，随时补回来（不折叠、不挪动内容）
  function repairBar() {
    if (!settings.enabled || !settings.collapse || !collapse.folded.size) return;
    ensureBar();
  }

  function expandAll(nearTop = false) {
    // 所有展开路径（向上滚动 / 点击提示条 / popup 展开全部 / 设置关闭）统一进入冷却，
    // 防止展开后立即向下滚动被误判为"继续折叠"
    expandCooldownUntil = Date.now() + 8000;
    if (!collapse.folded.size && !collapse.bar) return;
    const sc = findScrollContainer();
    const oldDelta = collapse.delta;
    const had = collapse.folded.size;
    collapse.folded.forEach((el) => el.classList.remove('lcp-folded'));
    collapse.folded.clear();
    if (collapse.bar) {
      collapse.bar.remove();
      collapse.bar = null;
    }
    collapse.delta = 0;
    if (had) {
      if (nearTop) {
        // 点击提示条：跳到最早一条消息的位置
        sc.scrollTop = Math.min(oldDelta, sc.scrollHeight - sc.clientHeight);
      } else {
        // 向上滚动展开：保持视口内容不动（增量恢复）
        sc.scrollTop = Math.max(0, Math.min(sc.scrollTop + oldDelta, sc.scrollHeight - sc.clientHeight));
      }
    }
  }

  // 渐进折叠：只折叠「远离视口（≥2 屏）上方」的历史消息
  function foldUpwards(sc) {
    if (!settings.enabled || !settings.collapse) return;
    if (stream.active) return; // 流式输出期间不动历史
    const msgs = getMessages();
    const keep = Math.max(4, settings.keepMessages);
    if (!msgs.length || msgs.length <= keep + 2) return;

    const cutoff = msgs.length - keep;
    const barExisted = !!collapse.bar && collapse.bar.isConnected;
    const safeMargin = Math.max(400, sc.clientHeight * 2);
    const beforeH = sc.scrollHeight; // 折叠前文档高度
    let est = 0;                     // 预估折叠高度（含间距余量，用于滚动上限判断）

    for (let i = 0; i < cutoff; i++) {
      const el = msgs[i];
      const id = el.dataset.messageId;
      if (collapse.folded.has(id)) continue; // 已折叠（高度已是 0）
      const rect = el.getBoundingClientRect();
      if (rect.bottom > -safeMargin) break;  // 离视口太近：保持渐进，留给用户上滚余地
      const h = rect.height + 30;            // 高度 + 消息间距余量
      if (est + h + 48 > sc.scrollTop) break; // 滚动补偿上限：保证视口不跳
      el.classList.add('lcp-folded');
      collapse.folded.set(id, el);
      est += h;
    }

    // 清理已不在 DOM 中的记录（用户删了消息/新建会话等）
    const live = new Set(msgs.map((m) => m.dataset.messageId));
    for (const id of [...collapse.folded.keys()]) {
      if (!live.has(id)) collapse.folded.delete(id);
    }

    if (est === 0) {
      if (collapse.folded.size && !barExisted) ensureBar();
      updateBarLabel();
      return;
    }

    const bar = ensureBar();
    const afterH = sc.scrollHeight;  // 含提示条的折叠后高度
    const shrink = beforeH - afterH; // 真实缩短量（含消息间距与提示条，校准误差）
    if (shrink <= 0) return;         // 防御：无实际缩短则不动
    collapse.delta += shrink;        // 累加：多次折叠后展开位置依然准确
    updateBarLabel();
    sc.scrollTop = Math.max(0, sc.scrollTop - shrink); // 视口内容不动
  }

  // 滚动处理：向下=渐进折叠，向上=立即展开
  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking || !settings.enabled || !settings.collapse) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      const sc = findScrollContainer();
      const st = sc.scrollTop;
      if (lastScrollTop === null) {
        // 兜底：首个 scroll 事件只建立基线，不产生方向
        lastScrollTop = st;
        return;
      }
      const dir = st - lastScrollTop;
      lastScrollTop = st;

      if (collapse.folded.size && dir < 0) {
        // 用户向上滚动 → 想看来更早的内容：展开（视口内容不动）
        expandAll(false);
        return;
      }
      if (dir > 0 && Date.now() > expandCooldownUntil) {
        foldUpwards(sc);
      }
    });
  }

  function bindScroll(sc) {
    sc.addEventListener('scroll', onScroll, { passive: true });
    // 建立方向基线：恢复的长会话（如 scrollTop=30000）首次用户滚动即有正确方向；
    // 容器重绑时同步重置，避免跨容器错乱
    lastScrollTop = sc.scrollTop;
  }

  // 对话是懒加载的：启动时可能还没滚动容器，随着 React 渲染不断重找并重绑
  let lastRebind = 0;
  function maybeRebind() {
    const now = Date.now();
    if (now - lastRebind < 2000 || !settings.enabled) return;
    lastRebind = now;
    const sc = findScrollContainer(true);
    if (sc !== lastBoundSc) {
      bindScroll(sc);
      lastBoundSc = sc;
    }
  }

  /* ---------------- MutationObserver：只做流式检测 + 提示条维护 ----------------
     注意：不做后台自动折叠——折叠必须由用户滚动触发，避免"没动却只剩几轮"。 */
  const mo = new MutationObserver(() => {
    if (!settings.enabled) return;
    stream.mark();
    repairBar();
    maybeRebind();
  });

  /* ---------------- 与 popup 通信 ---------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'lcp-status') {
      sendResponse({
        on: settings.enabled,
        folded: collapse.folded.size,
        streaming: stream.active,
        messages: getMessages().length,
      });
    } else if (msg.type === 'lcp-fold-now') {
      const sc = findScrollContainer();
      foldUpwards(sc);
      sendResponse({ ok: true });
    } else if (msg.type === 'lcp-expand-all') {
      expandAll(true);
      sendResponse({ ok: true });
    }
  });

  /* ---------------- 设置变更实时生效 ---------------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    let changed = false;
    for (const k of Object.keys(DEFAULTS)) {
      if (k in changes) {
        settings[k] = changes[k].newValue;
        changed = true;
      }
    }
    if (!changed) return;
    applyClasses();
    if (!settings.enabled || !settings.collapse) expandAll();
  });

  /* ---------------- 启动 ---------------- */
  function boot() {
    store.get(DEFAULTS, (saved) => {
      settings = { ...DEFAULTS, ...saved };
      applyClasses();
      const start = () => {
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        lastBoundSc = findScrollContainer(true);
        bindScroll(lastBoundSc);
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    });
  }
  boot();
})();

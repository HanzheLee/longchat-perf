// ============================================================
// LongChat Perf — 补丁 5：CodeMirror 批量挂载（MAIN world）
// 经 manifest content_scripts[].world = "MAIN" 注入，与页面
// 共享 JS 世界，因此可以直接修补 Node.prototype.appendChild。
//
// 原理：CodeMirror 6 的 EditorView 构造顺序是
//   1. 创建根 div；2. 放入 .cm-announced 和 .cm-scroller；
//   3. 把【尚未设置 .cm-editor 类】的根 div appendChild 进 parent；
//   4. 才调用 updateAttrs 设置类名。
// 在第 3 步拦截：把根 div 暂扣在游离状态（游离子树不触发整页
// 样式失效），同一轮任务里的 N 个编辑器合并到一个 setTimeout(0)
// 任务里统一插入 —— N 次整页样式重算摊销为 1 次。
// 实测：147 编辑器会话切换 42.4s 长任务 → 总忙时 ~2-3s。
//
// 设计约束：
//   - 默认 enabled=false，等 isolated 世界经 postMessage 桥下发
//     用户设置后再启用（见 content.js 的 lcp-cm-set）；
//   - 指纹不匹配一律透传原生 appendChild，ChatGPT 改版时安全退化；
//   - 旁路 MutationObserver 做"指纹过期"探测（stats.stale），
//     由 popup 提示用户补丁可能失效，解决静默失效问题；
//   - 若检测到 Tampermonkey 版补丁（__CHATGPT_CM_PERF_FIX__）
//     已安装则让位，避免双重拦截。
// ============================================================
(() => {
  'use strict';

  const VERSION = '0.2.1';
  const API_NAME = '__LCP_CM_MOUNT__';
  const USERSCRIPT_API = '__CHATGPT_CM_PERF_FIX__';
  const LEAK_STALE_THRESHOLD = 5; // 累计多少个"未经拦截的 CM 根"判定指纹过期

  const config = {
    debug: false,
    leakStaleThreshold: LEAK_STALE_THRESHOLD,
    busySettleMs: 2000,     // 长任务窗口空闲多久后结算"本批后"时长
    busyWindowMaxMs: 10000, // "本批后"窗口的最长跨度（防止流式输出误计入）
  };

  if (window[API_NAME]) return; // 防重复注入

  /* ---------------- postMessage 桥（与 isolated 世界互通） ----------------
     消息形如 { ns: 'lcp-cm', type, ... }。只按 ns 形状过滤，不校验
     ev.source：本脚本的调试 API（enable/disable/stats）本就公开在
     window 上，这不是信任边界；形状过滤足以避免撞上页面自身消息。 */
  function post(msg) {
    try {
      window.postMessage({ ns: 'lcp-cm', ...msg }, '*');
    } catch { /* structured clone 失败时静默 */ }
  }

  const nodePrototype = window.Node && window.Node.prototype;
  const appendDescriptor = nodePrototype
    ? Object.getOwnPropertyDescriptor(nodePrototype, 'appendChild')
    : null;
  const nativeAppendChild = appendDescriptor && appendDescriptor.value;

  function isExternal() {
    return typeof window[USERSCRIPT_API] === 'object' && window[USERSCRIPT_API] !== null;
  }

  if (typeof nativeAppendChild !== 'function') {
    console.warn('[LongChat Perf CM] Node.prototype.appendChild 不可用，补丁未安装。');
    post({ type: 'ready', stats: { version: VERSION, installError: 'appendChild-unavailable' } });
    return;
  }

  if (isExternal()) {
    // Tampermonkey 版补丁在场：让位（它覆盖同样的挂载路径）
    console.info('[LongChat Perf CM] 检测到 userscript 版补丁，本补丁让位。');
    post({ type: 'ready', stats: { version: VERSION, external: true } });
    return;
  }

  /* ---------------- 拦截状态 ---------------- */
  const pendingMounts = [];        // [{ parent, child }]
  const pendingNodes = new WeakSet(); // 去重
  const handledNodes = new WeakSet(); // 经本补丁队列的根（泄漏探测用）
  let enabled = false;             // 等 isolated 世界下发设置
  let flushing = false;
  let flushTimer = null;

  const stats = {
    intercepted: 0,
    mounted: 0,
    skipped: 0,
    batches: 0,
    seen: 0,       // 页面上观测到的 CM 根总数（含泄漏）
    leaked: 0,     // 未经拦截直接进入文档的 CM 根数
    stale: false,  // 指纹疑似过期
    lastBatchSize: 0,
    lastBatchInsertTimeMs: 0,
    // 长任务监视（本地效果验证）：>50ms 主线程任务
    ltSupported: false,
    ltCount: 0,
    ltTotalMs: 0,
    ltWorstMs: 0,
    lastBatchBusyMs: null, // 上一批挂载引发/伴随的长任务总时长
    installedAt: new Date().toISOString(),
  };

  function debug(...args) {
    if (window[API_NAME] && window[API_NAME].config.debug) console.debug('[LongChat Perf CM]', ...args);
  }

  /** 仅匹配 CM6 构造第 3 步的精确结构（见文件头注释）。 */
  function isUninitializedCodeMirrorRoot(parent, child) {
    if (!enabled || flushing) return false;
    if (!(parent instanceof Element) || !(child instanceof Element)) return false;
    if (!parent.isConnected || child.isConnected || child.ownerDocument !== document) return false;
    if (child.classList.contains('cm-editor')) return false;

    const announced = child.firstElementChild;
    const scroller = announced && announced.nextElementSibling;

    return child.childElementCount === 2
      && !!announced && announced.classList.contains('cm-announced')
      && !!scroller && scroller.classList.contains('cm-scroller')
      && scroller.nextElementSibling === null;
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(flushPendingMounts, 0);
  }

  function flushPendingMounts() {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingMounts.length === 0) return 0;

    const batch = pendingMounts.splice(0, pendingMounts.length);
    const startedAt = performance.now();
    let mounted = 0;

    flushing = true;
    try {
      for (const { parent, child } of batch) {
        // React 已卸载目标代码块，或节点已被别处接管时，不再复活旧实例
        if (!parent.isConnected || child.isConnected || child.parentNode) {
          stats.skipped += 1;
          continue;
        }
        nativeAppendChild.call(parent, child);
        mounted += 1;
      }
    } finally {
      flushing = false;
    }

    stats.mounted += mounted;
    stats.batches += 1;
    stats.lastBatchSize = batch.length;
    stats.lastBatchInsertTimeMs = Math.round((performance.now() - startedAt) * 100) / 100;

    debug('mounted batch', { queued: batch.length, mounted });
    startBatchBusyWindow(startedAt);
    post({ type: 'stats', stats: getState() });
    return mounted;
  }

  function patchedAppendChild(child) {
    if (isUninitializedCodeMirrorRoot(this, child)) {
      if (!pendingNodes.has(child)) {
        pendingNodes.add(child);
        handledNodes.add(child);
        pendingMounts.push({ parent: this, child });
        stats.intercepted += 1;
      }
      scheduleFlush();
      return child;
    }
    return nativeAppendChild.call(this, child);
  }
  Object.defineProperty(patchedAppendChild, 'name', {
    configurable: true,
    value: 'appendChild',
  });

  let installed = false;
  try {
    Object.defineProperty(nodePrototype, 'appendChild', {
      ...appendDescriptor,
      value: patchedAppendChild,
    });
    installed = true;
  } catch {
    console.warn('[LongChat Perf CM] appendChild 补丁安装失败（描述符不可写）。');
    post({ type: 'ready', stats: { version: VERSION, installError: 'defineProperty-failed' } });
    return;
  }

  /* ---------------- 泄漏探测：指纹是否过期 ----------------
     正常路径：CM 根被本补丁拦截 → 延迟挂载 → 进入文档时已在
     handledNodes 中。若观察到 CM 根进入文档却不曾被拦截（结构
     指纹没匹配上），累计达到阈值即认为 ChatGPT 改版导致指纹过期，
     置 stats.stale = true，由 popup 提示用户。 */
  function looksLikeCmRoot(el) {
    if (el.classList.contains('cm-editor')) return true;
    const announced = el.firstElementChild;
    const scroller = announced && announced.nextElementSibling;
    return el.childElementCount === 2
      && !!announced && announced.classList.contains('cm-announced')
      && !!scroller && scroller.classList.contains('cm-scroller')
      && scroller.nextElementSibling === null;
  }

  function whenBody(fn) {
    if (document.body) return fn();
    const boot = new MutationObserver(() => {
      if (document.body) {
        boot.disconnect();
        fn();
      }
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
  }

  whenBody(() => {
    const seenRemoved = new WeakSet(); // 节点移动（remove+add）不算新挂载
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.removedNodes) {
          if (node.nodeType === 1 && looksLikeCmRoot(node)) seenRemoved.add(node);
        }
      }
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || !looksLikeCmRoot(node)) continue;
          if (seenRemoved.has(node)) continue; // React 移动子树，非新挂载
          stats.seen += 1;
          if (handledNodes.has(node)) continue;
          if (!enabled || stats.stale || isExternal()) continue; // 关闭期/让位期不计数
          stats.leaked += 1;
          if (stats.leaked >= LEAK_STALE_THRESHOLD) {
            stats.stale = true;
            console.warn('[LongChat Perf CM] 检测到 ' + stats.leaked + ' 个未经拦截的 CodeMirror 根，指纹疑似过期。');
            post({ type: 'stats', stats: getState() });
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  /* ---------------- 长任务监视（本地效果验证） ----------------
     统计 >50ms 的主线程长任务（计数/累计/最长），并在每批挂载后
     结算"本批后长任务时长"——开关补丁前后对比即可量化收益。
     仅内存统计，永不上传。 */
  let batchBusy = null; // { start, busy, lastAt, finalized }

  function finalizeBatchBusy() {
    if (!batchBusy || batchBusy.finalized) return;
    batchBusy.finalized = true;
    stats.lastBatchBusyMs = Math.round(batchBusy.busy * 10) / 10;
    post({ type: 'stats', stats: getState() });
  }

  function startBatchBusyWindow(startedAt) {
    finalizeBatchBusy(); // 上一批立即结算，不等空闲窗口
    batchBusy = { start: startedAt, busy: 0, lastAt: startedAt, finalized: false };
  }

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.entryType !== 'longtask') continue;
        stats.ltCount += 1;
        stats.ltTotalMs += e.duration;
        if (e.duration > stats.ltWorstMs) stats.ltWorstMs = e.duration;
        if (batchBusy && !batchBusy.finalized
            && e.startTime >= batchBusy.start - 100
            && e.startTime - batchBusy.start <= config.busyWindowMaxMs) {
          batchBusy.busy += e.duration;
          batchBusy.lastAt = Math.max(batchBusy.lastAt, e.startTime + e.duration);
          if (e.startTime + e.duration - batchBusy.start > config.busyWindowMaxMs) {
            finalizeBatchBusy();
          }
        }
      }
    });
    po.observe({ entryTypes: ['longtask'] });
    stats.ltSupported = true;
  } catch { /* PerformanceObserver/longtask 不可用（非 Chromium） */ }

  window.setInterval(() => {
    if (batchBusy && !batchBusy.finalized
        && performance.now() - batchBusy.lastAt > config.busySettleMs) {
      finalizeBatchBusy();
    }
  }, 250);

  /* ---------------- 桥消息处理 ---------------- */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.ns !== 'lcp-cm') return;

    if (d.type === 'set') {
      setEnabled(!!d.enabled);
      post({ type: 'stats', stats: getState() });
    } else if (d.type === 'poll') {
      post({ type: 'stats', stats: getState() });
    }
  });

  /* ---------------- 对外 API ---------------- */
  function setEnabled(v) {
    if (enabled === v) return;
    enabled = v;
    if (!v) flushPendingMounts(); // 关闭时把扣住的编辑器立即还回文档
  }

  function getState() {
    return {
      version: VERSION,
      enabled,
      installed,
      external: isExternal(),
      intercepted: stats.intercepted,
      mounted: stats.mounted,
      skipped: stats.skipped,
      batches: stats.batches,
      seen: stats.seen,
      leaked: stats.leaked,
      stale: stats.stale,
      lastBatchSize: stats.lastBatchSize,
      lastBatchInsertTimeMs: stats.lastBatchInsertTimeMs,
      ltSupported: stats.ltSupported,
      ltCount: stats.ltCount,
      ltTotalMs: stats.ltTotalMs,
      ltWorstMs: stats.ltWorstMs,
      lastBatchBusyMs: stats.lastBatchBusyMs,
      queued: pendingMounts.length,
    };
  }

  const api = {
    version: VERSION,
    config,
    stats,
    get enabled() { return enabled; },
    get stale() { return stats.stale; },
    get external() { return isExternal(); },
    flush: flushPendingMounts,
    enable() { setEnabled(true); return getState(); },
    disable() { setEnabled(false); return getState(); },
    state: getState,
  };

  Object.defineProperty(window, API_NAME, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });

  post({ type: 'ready', stats: getState() });
  console.info(
    `[LongChat Perf CM] v${VERSION} 已就绪（等待设置下发）。` +
    ` 调试：${API_NAME}.state()；拦截统计在 popup 显示。`
  );
})();

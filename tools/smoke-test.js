// ============================================================
// LongChat Perf — smoke test (jsdom)
// 运行：npm install && npm test
// 覆盖：渐进折叠 / delta 累加 / 视口保持 / 向上展开 / 冷却防抖 /
//       无后台自动折叠 / DOM 保留 / 首次滚动方向（T1）/ bar 展开冷却（T2）/
//       CodeMirror 批量挂载·桥接·泄漏探测（T3）
// ============================================================
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// 相对引用项目内 content.js（与工作目录无关，可复现）
const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content', 'content.js'), 'utf8');

let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name); }
}

// 构建一个带真实几何模拟的测试环境（含消息间距与提示条高度）
function makeEnv({ initialScrollTop = 0, keepMessages = 10 } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>
    <div id="sc" style="overflow-y:auto"><div id="list"></div></div>
    </body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const { document } = window;

  const list = document.getElementById('list');
  const N = 120;
  const heights = [];
  const msgs = [];
  for (let i = 0; i < N; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const el = document.createElement('div');
    el.setAttribute('data-message-author-role', role);
    el.setAttribute('data-message-id', 'msg-' + i);
    const h = role === 'user' ? 120 : 400;
    heights.push(h);
    el.textContent = `message ${i} `.repeat(20);
    list.appendChild(el);
    msgs.push(el);
  }
  const tops = [];
  let acc = 0;
  heights.forEach((h) => { tops.push(acc); acc += h + 16; });
  const totalH = acc; // 33120

  const GAP = 16;
  const BAR_H = 40;
  function barH() { return document.querySelector('.lcp-fold-bar') ? BAR_H : 0; }
  function foldedTotal() {
    let t = 0, c = 0;
    msgs.forEach((el, j) => { if (el.classList.contains('lcp-folded')) { t += heights[j]; c++; } });
    return t + c * GAP;
  }
  function foldedBefore(idx) {
    let off = 0, c = 0;
    for (let j = 0; j < idx; j++) if (msgs[j].classList.contains('lcp-folded')) { off += heights[j]; c++; }
    return off + c * GAP;
  }
  function docH() { return totalH - foldedTotal() + barH(); }

  let scrollTop = initialScrollTop; // 初始可非 0（模拟恢复的长会话）
  const sc = document.getElementById('sc');
  Object.defineProperty(sc, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => { scrollTop = Math.max(0, Math.min(v, Math.max(0, docH() - 800))); },
  });
  Object.defineProperty(sc, 'scrollHeight', { get: docH });
  Object.defineProperty(sc, 'clientHeight', { get: () => 800 });
  Object.defineProperty(document.documentElement, 'scrollHeight', { get: docH });

  function msgTopRel(i) { return tops[i] - foldedBefore(i) + barH() - scrollTop; }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const idx = msgs.indexOf(this);
    if (idx < 0 || this.classList.contains('lcp-folded')) {
      return { top: 0, bottom: 0, height: 0, width: 500, left: 0, right: 500, x: 0, y: 0, toJSON() {} };
    }
    const top = msgTopRel(idx);
    return { top, bottom: top + heights[idx], height: heights[idx], width: 500, left: 0, right: 500, x: 0, y: top, toJSON() {} };
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    get() {
      const idx = msgs.indexOf(this);
      if (idx < 0) return 0;
      return this.classList.contains('lcp-folded') ? 0 : heights[idx];
    },
  });
  window.getComputedStyle = () => ({ overflowY: 'auto' });

  window.chrome = {
    storage: {
      sync: { get: (d, cb) => cb({ ...d, keepMessages }), set: () => {} },
      local: { get: (d, cb) => cb({ ...d }), set: () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: { onMessage: { addListener: () => {} } },
  };

  window.eval(contentJs);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function scrollTo(v) {
    sc.scrollTop = v; // 走 setter（真实浏览器会对超范围滚动位置 clamp）
    sc.dispatchEvent(new window.Event('scroll'));
  }
  function foldedCount() { return document.querySelectorAll('.lcp-folded').length; }
  function viewportHead() {
    for (let i = 0; i < N; i++) {
      if (msgs[i].classList.contains('lcp-folded')) continue;
      if (msgTopRel(i) + heights[i] > 0) return i;
    }
    return N;
  }
  return { window, document, sc, msgs, heights, tops, sleep, scrollTo, foldedCount, viewportHead };
}

// ================= 主场景：渐进折叠 / 展开 / 冷却 / DOM 保留 =================
async function mainScenario(env) {
  const { document, scrollTo, foldedCount, viewportHead, sleep } = env;
  await sleep(100);
  assert(document.documentElement.classList.contains('lcp-on'), '启动后 html 有 lcp-on');

  // 1) 无后台自动折叠
  const el = document.createElement('div');
  el.setAttribute('data-message-author-role', 'assistant');
  el.setAttribute('data-message-id', 'new-msg');
  el.textContent = 'streaming...';
  document.getElementById('list').appendChild(el);
  await sleep(300);
  assert(foldedCount() === 0, '无用户滚动时绝不自动折叠');
  el.remove();

  // 2) 向下滚动 → 渐进折叠（对比折叠动作前后的视口内容）
  env.sc.scrollTop = 10000;
  const hPre1 = viewportHead();
  env.sc.dispatchEvent(new env.window.Event('scroll'));
  await sleep(100);
  const f1 = foldedCount();
  console.log('  第一次折叠:', f1, '条, scrollTop=', env.sc.scrollTop, ' head:', hPre1, '->', viewportHead());
  assert(f1 > 0 && f1 < 60, '向下滚动后发生渐进折叠');
  assert(viewportHead() === hPre1, '折叠动作前后视口内容未跳动');

  // 3) 二次滚动 → 增量折叠
  env.sc.scrollTop = 30000;
  const hPre2 = viewportHead();
  env.sc.dispatchEvent(new env.window.Event('scroll'));
  await sleep(100);
  const f2 = foldedCount();
  console.log('  第二次折叠:', f2, '条, scrollTop=', env.sc.scrollTop, ' head:', hPre2, '->', viewportHead());
  assert(f2 > f1, '二次滚动增量折叠了更多消息');
  assert(viewportHead() === hPre2, '二次折叠动作前后视口内容未跳动');

  // 4) 向上滚动 → 立即展开，视口内容不动
  const beforeExpand = env.sc.scrollTop;
  env.sc.scrollTop = Math.max(0, beforeExpand - 100);
  const hPreExp = viewportHead();
  env.sc.dispatchEvent(new env.window.Event('scroll'));
  await sleep(100);
  assert(foldedCount() === 0, '向上滚动立即全部展开');
  assert(!document.querySelector('.lcp-fold-bar'), '展开后提示条移除');
  assert(viewportHead() === hPreExp, '展开动作前后视口内容未跳动（delta 累加正确）');
  console.log('  展开: scrollTop=', env.sc.scrollTop, ' head:', hPreExp, '->', viewportHead());

  // 5) 展开冷却
  scrollTo(32000);
  await sleep(100);
  assert(foldedCount() === 0, '展开后 8s 冷却期内不立即重新折叠');

  // 6) 冷却过后可再次折叠；点击提示条跳转
  await sleep(8600);
  scrollTo(15000);
  await sleep(100);
  scrollTo(30000);
  await sleep(100);
  assert(foldedCount() > 0, '冷却期后可再次折叠');
  const bar = document.querySelector('.lcp-fold-bar');
  assert(!!bar, '提示条存在');
  if (bar) {
    const h = env.sc.scrollTop;
    bar.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    assert(foldedCount() === 0, '点击提示条展开全部');
    assert(env.sc.scrollTop >= h, '点击提示条后滚动位置前移（可见最早消息）');
  }

  // 7) 保留数边界 / DOM 不删
  assert(!document.querySelector('.lcp-folded[data-message-id="msg-119"]'), '最近 keepMessages 条消息从未被折叠');
  assert(document.querySelectorAll('div[data-message-author-role]').length >= 120, 'DOM 节点未被删除');
}

// ================= T1：初始滚动位置非 0 + 首次滚动方向正确 =================
// 回归：lastScrollTop 初始 0 时，恢复的长会话（scrollTop=30000）首次上滚
// 会被误判为向下(+29800) 而误折叠。修复后首个事件以绑定时的位置为基线。
async function T1() {
  console.log('\nT1: 初始滚动位置非 0 时的方向判定');
  // 场景 A：初始 30000，首次向下滚动 → 应正常折叠（基线正确）
  const a = makeEnv({ initialScrollTop: 30000 });
  await a.sleep(100);
  a.scrollTo(31000);
  await a.sleep(100);
  const fa = a.foldedCount();
  console.log('  A: 30000→31000 (向下), folded =', fa);
  assert(fa > 0, 'A: 首次向下滚动触发折叠（基线正确，dir>0）');

  // 场景 B：初始 30000，首次向上滚动 → 绝不误折叠
  const b = makeEnv({ initialScrollTop: 30000 });
  await b.sleep(100);
  b.scrollTo(29800);
  await b.sleep(100);
  const fb = b.foldedCount();
  console.log('  B: 30000→29800 (向上), folded =', fb);
  assert(fb === 0, 'B: 首次向上滚动不触发折叠（方向判定正确，非 +29800 误判）');

  // 场景 C：恢复后先下滚折叠，再上滚 → 上滚应展开而不是继续折叠
  const c = makeEnv({ initialScrollTop: 30000 });
  await c.sleep(100);
  c.scrollTo(33000);
  await c.sleep(100);
  assert(c.foldedCount() > 0, 'C: 折叠发生后（初始基线正确）');
  const before = c.foldedCount();
  c.scrollTo(30000);
  await c.sleep(100);
  const after = c.foldedCount();
  console.log('  C: 折叠', before, '条后上滚, folded =', after);
  assert(after < before, 'C: 上滚事件展开而非继续折叠');
}

// ================= T2：点击提示条展开后立即向下滚动不重新折叠 =================
// 回归：bar 点击路径此前不设 expandCooldownUntil，展开后立即下滚会误重新折叠。
async function T2() {
  console.log('\nT2: 点击提示条展开后 8s 冷却期内不重新折叠');
  const env = makeEnv({});
  await env.sleep(100);
  env.scrollTo(15000);
  await env.sleep(100);
  assert(env.foldedCount() > 0, '已折叠一批消息');
  const bar = env.document.querySelector('.lcp-fold-bar');
  assert(!!bar, '提示条存在');
  if (!bar) return;
  bar.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
  await env.sleep(100);
  assert(env.foldedCount() === 0, '点击提示条展开全部');
  // 立即向下滚动（不走任何 sleep 等待冷却过期）
  env.scrollTo(22000);
  await env.sleep(100);
  const f = env.foldedCount();
  console.log('  展开后立即向下滚动, folded =', f);
  assert(f === 0, '展开后立即向下滚动不重新折叠（bar 点击路径同样进入冷却）');
}

// ================= T3：补丁 5 — CodeMirror 批量挂载（MAIN world 模拟） =================
// jsdom 单窗口内同时扮演 MAIN world（cm-mount.js）与 isolated world（桥消息），
// 验证：拦截/批量合并/透传/桥启停/泄漏探测（指纹过期告警）。
const cmMountJs = fs.readFileSync(path.join(__dirname, '..', 'content', 'cm-mount.js'), 'utf8');

function makeCmEnv() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="wrap"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const { document } = window;

  // 模拟 PerformanceObserver（longtask 在 jsdom 不可用）——必须在 eval 之前安装
  const poInstances = [];
  window.PerformanceObserver = class {
    constructor(cb) { this.cb = cb; poInstances.push(this); }
    observe() {}
    disconnect() {}
  };
  function emitLongTask(duration) {
    const entry = { entryType: 'longtask', startTime: window.performance.now(), duration };
    poInstances.forEach((po) => po.cb({ getEntries: () => [entry] }));
  }

  window.eval(cmMountJs);
  const api = window.__LCP_CM_MOUNT__;
  const wrap = document.getElementById('wrap');

  // 模拟 isolated 世界：捕获 MAIN world 发来的 stats 广播
  const statsMsgs = [];
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.ns === 'lcp-cm' && ev.data.type === 'stats') {
      statsMsgs.push(ev.data.stats);
    }
  });

  // 模拟 CM6 构造第 3 步：未初始化根（.cm-announced + .cm-scroller，无 .cm-editor）
  function makeCmRoot(initialized = false) {
    const root = document.createElement('div');
    const a = document.createElement('div'); a.className = 'cm-announced';
    const s = document.createElement('div'); s.className = 'cm-scroller';
    root.appendChild(a); root.appendChild(s);
    if (initialized) root.classList.add('cm-editor'); // 模拟已过第 4 步
    return root;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return { window, document, api, wrap, makeCmRoot, sleep, statsMsgs, emitLongTask };
}

async function T3() {
  console.log('\nT3: 补丁 5 — CodeMirror 批量挂载');
  const { window, document, api, wrap, makeCmRoot, sleep, statsMsgs, emitLongTask } = makeCmEnv();

  assert(!!api, 'MAIN world 补丁已注入并暴露 API');
  assert(api.enabled === false, '默认禁用，等待设置下发');

  // 1) 未启用时透传：同步直接挂载
  const r0 = makeCmRoot();
  wrap.appendChild(r0);
  assert(r0.isConnected && api.stats.intercepted === 0, '未启用时 CM 根直接透传');

  // 2) 桥启用
  window.postMessage({ ns: 'lcp-cm', type: 'set', enabled: true }, '*');
  await sleep(20);
  assert(api.enabled === true, '桥消息启用补丁');

  // 3) 拦截 + 延迟挂载
  const r1 = makeCmRoot();
  wrap.appendChild(r1);
  assert(!r1.isConnected && api.stats.intercepted === 1, '命中指纹：暂扣游离，intercepted+1');
  await sleep(20);
  assert(r1.isConnected && api.stats.mounted === 1 && api.stats.batches === 1, 'flush 后统一挂载');

  // 4) 批量合并：同一任务 5 个编辑器 → 单批
  const roots = Array.from({ length: 5 }, () => makeCmRoot());
  roots.forEach((r) => wrap.appendChild(r));
  assert(roots.every((r) => !r.isConnected), '同任务 5 个编辑器全部暂扣');
  await sleep(20);
  assert(roots.every((r) => r.isConnected), '一批 flush 全部挂载');
  assert(api.stats.lastBatchSize === 5 && api.stats.batches === 2, '5 编辑器合并为单批');

  // 5) 普通节点 / 已初始化编辑器透传；后者计入泄漏（结构变化信号）
  const plain = document.createElement('span');
  wrap.appendChild(plain);
  assert(plain.isConnected, '普通节点同步透传');
  const rInit = makeCmRoot(true);
  wrap.appendChild(rInit);
  assert(rInit.isConnected && api.stats.intercepted === 6, '已初始化编辑器透传（指纹不命中）');
  await sleep(20);
  assert(api.stats.leaked === 1, '已初始化编辑器进入文档 → 泄漏计数 +1');

  // 6) 桥关闭 → 透传且不再计数；扣住的节点立即归还
  window.postMessage({ ns: 'lcp-cm', type: 'set', enabled: false }, '*');
  await sleep(20);
  const rOff = makeCmRoot();
  wrap.appendChild(rOff);
  assert(rOff.isConnected && api.stats.intercepted === 6 && api.enabled === false, '桥关闭后透传且不再拦截');

  // 7) 泄漏探测：指纹失效时页面会以别的路径挂编辑器（模拟为“已初始化根直接进入文档”）
  window.postMessage({ ns: 'lcp-cm', type: 'set', enabled: true }, '*');
  await sleep(20);
  for (let i = 0; i < 3; i++) wrap.appendChild(makeCmRoot(true));
  await sleep(30);
  assert(api.stats.leaked === 4 && !api.stats.stale, '泄漏累计但未达阈值（4 < 5）不告警');
  wrap.appendChild(makeCmRoot(true));
  await sleep(30);
  assert(api.stats.leaked === 5 && api.stats.stale === true, '泄漏达阈值 → stale 告警');

  // 8) stale 仅是告警，拦截仍工作；桥可回传状态
  const rS = makeCmRoot();
  wrap.appendChild(rS);
  assert(!rS.isConnected && api.stats.intercepted === 7, 'stale 后拦截仍工作（告警不致瘫）');
  await sleep(20);
  assert(rS.isConnected, 'stale 后 flush 仍完成挂载');
  window.postMessage({ ns: 'lcp-cm', type: 'poll' }, '*');
  await sleep(20);
  const last = statsMsgs[statsMsgs.length - 1];
  assert(!!last && last.version === '0.2.1' && last.stale === true, '桥 poll 返回完整状态（版本+stale）');

  // 9) 长任务监视：批量挂载后结算伴随长任务；桥携带字段
  assert(api.state().ltSupported === true, '长任务监视器已启用');
  api.config.busySettleMs = 60; // 测试用短结算窗口
  const rM = makeCmRoot();
  wrap.appendChild(rM); // 新批（结算上一批）
  await sleep(20);
  emitLongTask(300);
  emitLongTask(320);
  await sleep(600); // 等待 250ms 轮询 + 60ms settle
  assert(api.stats.ltCount === 2, '长任务计数正确');
  assert(Math.abs(api.stats.ltTotalMs - 620) < 1, '长任务累计时长正确');
  assert(api.stats.ltWorstMs === 320, '最长长任务被记录');
  assert(api.stats.lastBatchBusyMs === 620, '本批后长任务时长已结算');
  window.postMessage({ ns: 'lcp-cm', type: 'poll' }, '*');
  await sleep(20);
  const last2 = statsMsgs[statsMsgs.length - 1];
  assert(!!last2 && last2.ltSupported === true && last2.ltTotalMs === api.stats.ltTotalMs, '桥 stats 携带长任务字段');

  // 10) 新批次开始时立即结算上一批（不等空闲窗口）
  const rA = makeCmRoot();
  wrap.appendChild(rA);
  await sleep(20); // flush 批 A
  emitLongTask(150);
  const rB = makeCmRoot();
  wrap.appendChild(rB);
  await sleep(20); // 批 B flush → 立即结算批 A
  assert(api.stats.lastBatchBusyMs === 150, '新批次开始即结算上一批');
}

(async () => {
  console.log('LongChat Perf smoke test\n');
  console.log('== 主场景 ==');
  await mainScenario(makeEnv({}));
  await T1();
  await T2();
  await T3();
  console.log(failures ? `\n结果: ${failures} 项失败` : '\n结果: 全部通过 ✅');
  process.exit(failures ? 1 : 0);
})();

#!/usr/bin/env node
// ============================================================
// LongChat Perf — DevTools Performance trace 分析器
// 用法：node tools/trace-analyze.js <Trace.json[.gz]> [--pid <pid>]
//
// 流式逐行解析（新版 DevTools enhanced trace 每事件一行），
// 输出：
//   1. 录制有效性：时间跨度 / 渲染进程 / 主线程是否有内容
//   2. 主线程负载：任务数 / 长任务(>50ms) / 最长任务 + 内部阶段归因
//   3. 扩展监视器开销：250ms 定时器任务的实测耗时（µs 级为正常）
//   4. 扩展存活标记：console 'LongChat' / chatgpt.com URL 命中
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法: node tools/trace-analyze.js <Trace.json[.gz]> [--pid <pid>]');
  process.exit(1);
}
const pidArgIdx = process.argv.indexOf('--pid');
const onlyPid = pidArgIdx > -1 ? Number(process.argv[pidArgIdx + 1]) : null;

const isGz = file.endsWith('.gz');
const child = isGz ? spawn('gunzip', ['-c', file]) : fs.createReadStream(file, 'utf8');
const rl = readline.createInterface({ input: child.stdout || child });

const threadNames = new Map(); // pid:tid -> name
const processNames = new Map(); // pid -> name
const rendererMains = new Map(); // pid -> state

function stateFor(pid, tid) {
  const key = pid + ':' + tid;
  let st = rendererMains.get(key);
  if (!st) {
    st = {
      pid, tid,
      events: 0,
      taskCount: 0, taskTotalUs: 0,
      longCount: 0, longTotalMs: 0, worstMs: 0,
      topTasks: [], // {ts, durUs, phases}
      phases: {}, // name -> totalUs
      minTs: Infinity, maxTs: 0,
      currentTask: null,
    };
    rendererMains.set(key, st);
  }
  return st;
}

// 250ms 重复定时器（长任务监视器的 interval）
const timerIds = new Set(); // 安装的 timer id
const timerStats = { installs: 0, fires: 0, taskCount: 0, taskTotalUs: 0, taskMaxUs: 0 };
let consoleLongChatHits = 0;
const urlHits = new Map(); // pid -> url 样本
let totalEvents = 0;
let globalMinTs = Infinity, globalMaxTs = 0;
let hadLongtaskEntry = 0; // ResourceTiming longtask 类事件（若有）

const INTERESTING_PHASES = /^(UpdateLayoutTree|RecalcStyles|Layout|ParseHTML|V8\.Execute|FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|CompileScript|EvaluateScript|HitTest|Paint|PrePaint|Layerize|UpdateLayer|CommitLoad|XHRReadyStateChange|EmbedderCallback|RequestMainThreadFrame|RunMicrotasks|GarbageCollected)/;

rl.on('line', (line) => {
  const trimmed = line.trim().replace(/,$/, '');
  if (trimmed.length < 2 || trimmed[0] !== '{') return;
  if (trimmed === ']') return;
  let ev;
  try { ev = JSON.parse(trimmed); } catch { return; }
  totalEvents++;

  const { ph, pid, tid, ts, dur, name, args, cat } = ev;
  if (typeof ts === 'number' && ts > 0) {
    if (ts < globalMinTs) globalMinTs = ts;
    const end = ts + (typeof dur === 'number' ? dur : 0);
    if (end > globalMaxTs) globalMaxTs = end;
  }

  if (ph === 'M') {
    if (name === 'thread_name') threadNames.set(pid + ':' + tid, args && args.name);
    else if (name === 'process_name') processNames.set(pid, args && args.name);
    return;
  }
  if (ph !== 'X' && ph !== 'I') {
    if (name === 'EventTiming' && args && args.data && args.data.interactionId) { /* ignore */ }
  }

  // 扩展存活标记
  if (name === 'ConsoleMessageEvent' || name === 'ConsoleMessage' || (cat && cat.includes('devtools.console'))) {
    const text = JSON.stringify(args || {});
    if (text.includes('LongChat')) consoleLongChatHits++;
  }
  if (!urlHits.has(pid) && typeof args === 'object' && args) {
    const s = JSON.stringify(args);
    const m = s.match(/https:\/\/chatgpt\.com[^"\\]*/);
    if (m) urlHits.set(pid, m[0].slice(0, 90));
  }

  const tname = threadNames.get(pid + ':' + tid);
  if (tname !== 'CrRendererMain') return;
  if (onlyPid !== null && pid !== onlyPid) return;

  const st = stateFor(pid, tid);
  if (typeof ts === 'number' && ts > 0) {
    if (ts < st.minTs) st.minTs = ts;
    if (ts + (dur || 0) > st.maxTs) st.maxTs = ts + (dur || 0);
  }
  st.events++;

  // 任务（RunTask）统计 + 长任务归因窗口
  if (name === 'RunTask' && typeof dur === 'number') {
    st.taskCount++;
    st.taskTotalUs += dur;
    if (dur > 50000) {
      st.longCount++;
      st.longTotalMs += dur / 1000;
      if (dur / 1000 > st.worstMs) st.worstMs = dur / 1000;
      const rec = { ts, durUs: dur, phases: {} };
      st.topTasks.push(rec);
      st.currentTask = rec;
    } else if (dur > 10000) {
      const rec = { ts, durUs: dur, phases: {} };
      st.topTasks.push(rec);
      st.currentTask = rec;
    } else {
      st.currentTask = null;
    }
  } else if (typeof dur === 'number' && INTERESTING_PHASES.test(name)) {
    if (st.phases[name] === undefined) st.phases[name] = 0;
    st.phases[name] += dur;
    // 归因到覆盖它的当前任务（文件按 ts 排序，窗口近似成立）
    const cur = st.currentTask;
    if (cur && ts >= cur.ts && ts <= cur.ts + cur.durUs) {
      cur.phases[name] = (cur.phases[name] || 0) + dur;
    }
  }

  // 监视器定时器：TimerInstall(timeout=250, repeating) → 追踪其 Fire 所在任务耗时
  if (name === 'TimerInstall' && args && args.data) {
    const d = args.data;
    if (d.timeout === 250 && d.repeating === true) {
      timerIds.add(d.id);
      timerStats.installs++;
    }
  }
  if (name === 'TimerFire' && args && args.data && timerIds.has(args.data.id)) {
    timerStats.fires++;
    // 计入当前覆盖任务（TimerFire 之前的 RunTask）
    const cur = st.currentTask;
    if (cur && ts >= cur.ts && ts <= cur.ts + cur.durUs) {
      timerStats.taskCount++;
      timerStats.taskTotalUs += cur.durUs;
      if (cur.durUs > timerStats.taskMaxUs) timerStats.taskMaxUs = cur.durUs;
    }
  }
});

const fmtUs = (us) => us >= 1e6 ? (us / 1e6).toFixed(2) + 's' : us >= 1e3 ? (us / 1e3).toFixed(1) + 'ms' : us.toFixed(0) + 'µs';

function topPhases(phases, n) {
  return Object.entries(phases)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${fmtUs(v)}`)
    .join(' ');
}

rl.on('close', () => {
  const rangeS = (globalMaxTs - globalMinTs) / 1e6;
  console.log('══════════ Trace 概览 ══════════');
  console.log(`事件总数: ${totalEvents.toLocaleString()}  跨度: ${rangeS.toFixed(1)}s`);
  console.log(`进程: ${[...processNames.entries()].map(([p, n]) => `${p}(${n})`).join('  ')}`);
  console.log(`ChatGPT URL 命中: ${[...urlHits.entries()].map(([p, u]) => `pid ${p} → ${u}`).join(' | ') || '（无）'}`);
  console.log(`console 'LongChat' 标记: ${consoleLongChatHits} 次`);

  for (const st of rendererMains.values()) {
    const spanS = (st.maxTs - st.minTs) / 1e6;
    console.log(`\n══════════ Renderer pid=${st.pid} tid=${st.tid} ══════════`);
    console.log(`事件 ${st.events.toLocaleString()}  覆盖 ${spanS.toFixed(1)}s`);
    console.log(`任务: ${st.taskCount.toLocaleString()} 个, 忙时合计 ${fmtUs(st.taskTotalUs)} (busy ${(st.taskTotalUs / 1e6 / spanS * 100).toFixed(1)}%)`);
    console.log(`长任务(>50ms): ${st.longCount} 个, 合计 ${(st.longTotalMs / 1000).toFixed(2)}s, 最长 ${st.worstMs.toFixed(0)}ms`);

    const top = st.topTasks.sort((a, b) => b.durUs - a.durUs).slice(0, 12);
    console.log('最长任务 Top12（偏移 / 时长 / 内部主要阶段）:');
    for (const t of top) {
      const off = ((t.ts - st.minTs) / 1e6).toFixed(1);
      const inner = topPhases(t.phases, 4);
      console.log(`  +${off.padStart(7)}s  ${fmtUs(t.durUs).padStart(9)}  ${inner || '(无阶段事件)'}`);
    }
    console.log(`阶段总耗时: ${topPhases(st.phases, 10)}`);
  }

  console.log('\n══════════ 监视器开销（250ms 定时器实测） ══════════');
  if (timerStats.installs === 0) {
    console.log('未发现 250ms 重复定时器（监视器 interval 未被录制到，可能该段不在窗口内）');
  } else {
    console.log(`TimerInstall(250ms, repeating): ${timerStats.installs} 个`);
    console.log(`TimerFire: ${timerStats.fires} 次`);
    console.log(`对应任务耗时: 合计 ${fmtUs(timerStats.taskTotalUs)}, 平均 ${(timerStats.taskTotalUs / Math.max(1, timerStats.taskCount)).toFixed(0)}µs/次, 最长 ${fmtUs(timerStats.taskMaxUs)}`);
  }
  process.exit(0);
});

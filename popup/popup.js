// popup.js —— ChatGPT 会话性能优化 控制面板
const DEFAULTS = {
  enabled: true,
  cv: true,
  noblur: true,
  collapse: true,
  stream: true,
  cmMount: true,
  keepMessages: 60,
};
const store = chrome.storage.sync;

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return resolve(null);
      chrome.tabs.sendMessage(tab.id, msg, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res);
      });
    });
  });
}

async function refreshStatus() {
  const res = await send({ type: 'lcp-status' });
  const el = $('status');
  const cmEl = $('cmStatus');
  cmEl.classList.remove('warn');
  if (!res) {
    el.textContent = '未检测到 ChatGPT 会话页 — 请打开 chatgpt.com 的对话';
    cmEl.textContent = '';
    return;
  }
  el.textContent = `消息 ${res.messages} · 已折叠 ${res.folded} · ${res.streaming ? '● 流式输出中' : '空闲'}`;
  renderCmStatus(cmEl, res.cm);
}

function renderCmStatus(el, cm) {
  if (!cm || !cm.present) {
    el.textContent = '代码块补丁未注入 — 请刷新 ChatGPT 页面（需 Chrome 111+）';
    return;
  }
  if (cm.external) {
    el.textContent = '检测到其他 CM 性能补丁（userscript），批量挂载已让位';
    return;
  }
  if (cm.stale) {
    el.textContent = '⚠ 代码块补丁疑似失效：ChatGPT 页面结构已变化，拦截数为 0';
    el.classList.add('warn');
    return;
  }
  const s = cm.stats;
  if (s && s.intercepted > 0) {
    el.textContent = `代码块批量挂载：已拦截 ${s.intercepted} 个编辑器 · ${s.batches} 批 · 上批 ${s.lastBatchSize} 个 / ${s.lastBatchInsertTimeMs}ms`;
  } else {
    el.textContent = '代码块批量挂载：待命（打开或切换会话时生效）';
  }
}

function setEnabledState(on) {
  ['cv', 'noblur', 'collapse', 'stream', 'cmMount'].forEach((id) => {
    $(id).disabled = !on;
    $(id).closest('.row').classList.toggle('disabled', !on);
  });
  $('keep').disabled = !on;
  $('foldNow').disabled = !on;
  $('expandAll').disabled = !on;
}

function load() {
  store.get(DEFAULTS, (s) => {
    $('master').checked = s.enabled;
    $('cv').checked = s.cv;
    $('noblur').checked = s.noblur;
    $('collapse').checked = s.collapse;
    $('stream').checked = s.stream;
    $('cmMount').checked = s.cmMount;
    $('keep').value = s.keepMessages;
    setEnabledState(s.enabled);
  });
}

function save() {
  const keep = Math.max(10, Math.min(500, parseInt($('keep').value, 10) || 60));
  store.set({
    enabled: $('master').checked,
    cv: $('cv').checked,
    noblur: $('noblur').checked,
    collapse: $('collapse').checked,
    stream: $('stream').checked,
    cmMount: $('cmMount').checked,
    keepMessages: keep,
  });
  $('keep').value = keep;
  setEnabledState($('master').checked);
  setTimeout(refreshStatus, 400);
}

$('master').addEventListener('change', save);
['cv', 'noblur', 'collapse', 'stream', 'cmMount'].forEach((id) => $(id).addEventListener('change', save));
$('keep').addEventListener('change', save);

$('foldNow').addEventListener('click', async () => {
  await send({ type: 'lcp-fold-now' });
  setTimeout(refreshStatus, 500);
});
$('expandAll').addEventListener('click', async () => {
  await send({ type: 'lcp-expand-all' });
  setTimeout(refreshStatus, 500);
});

load();
refreshStatus();

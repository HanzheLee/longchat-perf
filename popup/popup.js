// popup.js —— ChatGPT 会话性能优化 控制面板
const DEFAULTS = {
  enabled: true,
  cv: true,
  noblur: true,
  collapse: true,
  stream: true,
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
  if (!res) {
    el.textContent = '未检测到 ChatGPT 会话页 — 请打开 chatgpt.com 的对话';
    return;
  }
  el.textContent = `消息 ${res.messages} · 已折叠 ${res.folded} · ${res.streaming ? '● 流式输出中' : '空闲'}`;
}

function setEnabledState(on) {
  ['cv', 'noblur', 'collapse', 'stream'].forEach((id) => {
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
    keepMessages: keep,
  });
  $('keep').value = keep;
  setEnabledState($('master').checked);
  setTimeout(refreshStatus, 400);
}

$('master').addEventListener('change', save);
['cv', 'noblur', 'collapse', 'stream'].forEach((id) => $(id).addEventListener('change', save));
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

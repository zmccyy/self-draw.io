'use strict';
/* ============================================================
   智绘 AI · Diagram Studio — 前端主逻辑
   - draw.io embed 协议握手 (postMessage JSON)
   - AI 对话流式渲染 (SSE)
   - 应用/撤销 XML、导出、模板、面板拖拽
   ============================================================ */

const $ = (s) => document.querySelector(s);

const EMPTY_XML = '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const FRAME_URL = '/drawio/index.html?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0';

const state = {
  ready: false,
  currentXml: EMPTY_XML,
  autoApply: true,
  history: [],          // [{role:'user'|'assistant', content}]
  undoStack: [],
  streaming: false,
  abort: null,
  exportPending: null,
  pendingApply: null,   // 编辑器未就绪时暂存待应用的 XML
  pinned: true,         // 聊天区是否贴底滚动
};

/* ---------------- 论文工具配置 ---------------- */
const THESIS_KEY = 'zhenhui-thesis';
const THEME_PRESETS = {
  standard: { fontSize: 14, strokeWidth: 2, rounded: 0 },
  defense: { fontSize: 16, strokeWidth: 2, rounded: 1 },
};
const thesis = (function () {
  const base = { gray: false, font: '', theme: '', prefix: '', figures: [] };
  try { Object.assign(base, JSON.parse(localStorage.getItem(THESIS_KEY) || '{}')); } catch (e) { /* 忽略 */ }
  if (!Array.isArray(base.figures)) base.figures = [];
  return base;
})();
function saveThesis() { try { localStorage.setItem(THESIS_KEY, JSON.stringify(thesis)); } catch (e) { /* 忽略 */ } }

// 论文管线：全局风格 → 字体 → 灰阶
function transformXml(xml) {
  return ThesisTransform.enhance(xml, {
    gray: thesis.gray,
    font: thesis.font,
    theme: THEME_PRESETS[thesis.theme] || null,
  });
}

const frame = $('#drawio-frame');
const chat = $('#chat');
const input = $('#input');
const sendBtn = $('#btn-send');

/* ---------------- draw.io embed 桥 ---------------- */

function postToEditor(msg) {
  try { frame.contentWindow.postMessage(JSON.stringify(msg), '*'); } catch (e) { /* iframe 未就绪 */ }
}

function setXml(xml) {
  state.currentXml = xml || EMPTY_XML;
  let bytes = 0;
  try { bytes = new Blob([state.currentXml]).size; } catch (e) { bytes = state.currentXml.length; }
  $('#xml-size').textContent = (bytes / 1024).toFixed(1);
}

function editorReady(ok) {
  state.ready = ok;
  const dot = $('#editor-dot'), txt = $('#editor-text');
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('err', !ok);
  txt.textContent = ok ? '编辑器已连接' : '连接异常';
  $('#canvas-loading').classList.toggle('hide', ok);
  $('#canvas-chip').classList.toggle('show', ok);
  if (ok) toast('draw.io 引擎已就绪', 'ok');
}

window.addEventListener('message', (evt) => {
  let msg = null;
  try { msg = JSON.parse(evt.data); } catch (e) { return; }
  if (!msg || typeof msg !== 'object' || evt.source !== frame.contentWindow) return;
  switch (msg.event) {
    case 'init':
      editorReady(true);
      if (state.pendingApply) {
        const xml = state.pendingApply;
        state.pendingApply = null;
        postToEditor({ action: 'load', xml, autosave: 1, fit: 1 });
        setXml(xml);
        toast('已应用生成结果 ✓', 'ok');
      } else {
        postToEditor({ action: 'load', xml: state.currentXml, autosave: 1, fit: 1 });
      }
      break;
    case 'autosave':
      if (msg.xml) setXml(msg.xml);
      break;
    case 'save':
      if (msg.xml) setXml(msg.xml);
      break;
    case 'export':
      if (state.exportPending) { const fn = state.exportPending; state.exportPending = null; fn(msg); }
      break;
    default:
      break;
  }
});

function hasContent() {
  return /vertex="1"/.test(state.currentXml) || /edge="1"/.test(state.currentXml);
}

function retransformCurrent() {
  if (!state.ready || !hasContent()) return false;
  state.undoStack.push(state.currentXml);
  if (state.undoStack.length > 30) state.undoStack.shift();
  const next = transformXml(state.currentXml);
  postToEditor({ action: 'load', xml: next, autosave: 1, fit: 1 });
  setXml(next);
  return true;
}

function applyXml(xml, silent, snapLabel) {
  if (!state.ready) {
    state.pendingApply = xml;
    toast('编辑器尚未就绪，就绪后将自动应用', 'warn');
    return false;
  }
  const next = transformXml(xml);
  state.undoStack.push(state.currentXml);
  if (state.undoStack.length > 30) state.undoStack.shift();
  postToEditor({ action: 'load', xml: next, autosave: 1, fit: 1 });
  setXml(next);
  if (snapLabel) saveSnapshot(snapLabel, next, true);
  if (!silent) toast('已应用到画布 ✓', 'ok');
  return true;
}

function undoLast() {
  if (!state.undoStack.length) return toast('没有可撤销的 AI 修改', 'warn');
  const prev = state.undoStack.pop();
  postToEditor({ action: 'load', xml: prev, autosave: 1, fit: 1 });
  setXml(prev);
  toast('已撤销上一次 AI 应用', 'ok');
}

const EXPORT_PNG_SCALE = 3; // 约 300 DPI，满足论文印刷

function buildExportName(ext) {
  const titleEl = document.getElementById('fig-title');
  const title = (titleEl && titleEl.value || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (title) {
    const no = thesis.figures.length + 1;
    return '图' + (thesis.prefix ? thesis.prefix + '-' : '') + no + '_' + title + '.' + ext;
  }
  return '智绘图表-' + stamp() + '.' + ext;
}

function exportDiagram(format, copyMode) {
  if (!state.ready) return toast('编辑器尚未就绪', 'warn');
  if (!hasContent()) return toast('画布为空，先让 AI 生成一张图吧', 'warn');
  const label = format === 'svg' ? 'SVG 矢量图' : '高清 PNG';
  toast('正在导出 ' + (copyMode ? '并复制' : '') + label + '…');
  const timer = setTimeout(() => { state.exportPending = null; toast('导出超时，请重试', 'err'); }, 30000);
  state.exportPending = async (msg) => {
    clearTimeout(timer);
    if (!msg || !msg.data) return toast('导出失败', 'err');
    if (copyMode) {
      try {
        const blob = await (await fetch(msg.data)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('已复制到剪贴板，Word 中 Ctrl+V 直接粘贴 ✓', 'ok');
      } catch (e) {
        downloadDataUri(msg.data, buildExportName('png'));
        toast('剪贴板不可用（' + (e.name || e.message) + '），已改为下载文件', 'warn');
      }
    } else {
      downloadDataUri(msg.data, buildExportName(format));
      toast(label + ' 已导出 ✓' + (format === 'svg' ? '（矢量，可无限缩放）' : ''), 'ok');
    }
  };
  const payload = { action: 'export', format, spinKey: 'exp-' + format };
  if (format === 'png') payload.scale = EXPORT_PNG_SCALE;
  postToEditor(payload);
}

function exportXmlFile() {
  if (!hasContent()) return toast('画布为空', 'warn');
  const blob = new Blob([state.currentXml], { type: 'text/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '智绘图表-' + stamp() + '.drawio';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('.drawio 文件已导出 ✓', 'ok');
}

function downloadDataUri(dataUri, name) {
  const a = document.createElement('a');
  a.href = dataUri;
  a.download = name;
  a.click();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* ---------------- 聊天 ---------------- */

function hideEmpty() { const e = $('#empty-state'); if (e) e.style.display = 'none'; }
function showEmpty() {
  let e = $('#empty-state');
  if (!e) return;
  e.style.display = '';
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function addMsgUser(text) {
  const m = el('div', 'msg msg-user');
  m.appendChild(el('div', 'bubble', ''));
  m.firstChild.textContent = text;
  chat.appendChild(m);
  scrollBottom(true);
}

function addStreamingAI() {
  const m = el('div', 'msg msg-ai');
  const b = el('div', 'bubble');
  const think = el('div', 'thinking', '<span class="tdots"><i></i><i></i><i></i></span><span class="think-text">正在构思图表…</span>');
  const stream = el('div', 'stream-text stream-caret');
  stream.style.display = 'none';
  b.appendChild(think); b.appendChild(stream);
  m.appendChild(b);
  chat.appendChild(m);
  scrollBottom(true);
  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = think.querySelector('.think-text');
    if (t) t.textContent = '正在构思图表… (' + Math.round((Date.now() - t0) / 1000) + 's)';
  }, 1000);
  return { root: m, bubble: b, think, stream, timer };
}

function addNotice(text) {
  chat.appendChild(el('div', 'msg-notice', '· ' + escapeHtml(text)));
  scrollBottom();
}

function scrollBottom(force) {
  if (force) state.pinned = true;
  if (!state.pinned) return;
  chat.scrollTop = chat.scrollHeight;
}
chat.addEventListener('scroll', () => {
  state.pinned = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 130;
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStreaming(on) {
  state.streaming = on;
  sendBtn.classList.toggle('stop', on);
  sendBtn.textContent = on ? '■' : '➤';
  sendBtn.title = on ? '停止生成' : '发送 (Enter)';
  input.disabled = false;
}

function finalizeAIMessage(ctx, data) {
  // data: {ok, text, xml, stats, issues, aborted, errMsg, snapLabel}
  clearInterval(ctx.timer);
  ctx.think.remove();
  ctx.bubble.classList.remove('stream-caret');

  if (data.aborted && !data.text) {
    ctx.root.classList.add('msg-error');
    ctx.bubble.innerHTML = '<span>已停止生成。</span>';
    return;
  }

  const raw = (data.text || '').trim();
  let summary = raw;
  let xmlBlock = null;
  const fenceIdx = raw.indexOf('```');
  if (fenceIdx !== -1) {
    summary = raw.slice(0, fenceIdx).trim();
    const m = raw.match(/```(?:xml|html)?\s*([\s\S]*?)```/i);
    xmlBlock = m ? m[1] : raw.slice(fenceIdx).replace(/^```(?:xml|html)?/i, '').replace(/```$/, '');
  }
  if (!summary) summary = data.xml ? '已生成图表 ✅' : (data.errMsg || '未能生成有效图表');

  const textNode = el('div', '');
  textNode.style.whiteSpace = 'pre-wrap';
  textNode.textContent = summary;
  ctx.bubble.innerHTML = '';
  ctx.bubble.appendChild(textNode);

  if (data.xml && data.stats) {
    const meta = el('div', 'ai-meta');
    meta.innerHTML = '<span class="stat-tag">✓ 校验通过</span>' +
      '<span><b>' + data.stats.vertices + '</b> 节点</span><span class="sep">·</span>' +
      '<span><b>' + data.stats.edges + '</b> 连线</span><span class="sep">·</span>' +
      '<span><b>' + data.stats.kb + '</b> KB</span>';
    (data.issues || []).forEach((i) => {
      const t = el('span', 'stat-tag warn', '⚠ ' + escapeHtml(i));
      meta.appendChild(t);
    });
    ctx.bubble.appendChild(meta);
  }

  // XML 查看块
  if (xmlBlock) {
    const det = el('details', 'xml-wrap');
    det.innerHTML = '<summary>查看生成的 XML</summary>';
    const pre = el('pre', 'xml-pre');
    pre.textContent = xmlBlock.trim();
    det.appendChild(pre);
    ctx.bubble.appendChild(det);
  }

  // 操作按钮
  const snapLabel = data.snapLabel || 'AI 应用';
  const actions = el('div', 'msg-actions');
  if (data.xml) {
    const b1 = el('button', 'mini-btn primary', '⟳ 重新应用到画布');
    b1.onclick = () => applyXml(data.xml, false, snapLabel);
    actions.appendChild(b1);
    const b2 = el('button', 'mini-btn', '↩ 撤销本次');
    b2.onclick = () => undoLast();
    actions.appendChild(b2);
    const b3 = el('button', 'mini-btn', '⧉ 复制XML');
    b3.onclick = () => {
      navigator.clipboard.writeText(data.xml).then(
        () => toast('XML 已复制到剪贴板', 'ok'),
        () => toast('复制失败', 'err'));
    };
    actions.appendChild(b3);
  } else if (!data.aborted) {
    const bx = el('button', 'mini-btn', '↻ 重试');
    bx.onclick = () => resendLast();
    actions.appendChild(bx);
  }
  if (actions.children.length) ctx.bubble.appendChild(actions);

  // 记录历史（剥离 XML，仅保留说明，避免 token 膨胀）
  state.history.push({ role: 'assistant', content: summary });
  scrollBottom();
}

function resendLast() {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'user') {
      const t = state.history[i].content;
      state.history.splice(i, 1);
      send(t, true);
      return;
    }
  }
}

/* ---------------- 发送 / SSE ---------------- */

async function send(text, isRetry) {
  text = (text != null ? text : input.value).trim();
  if (!text || state.streaming) return;
  if (!isRetry) {
    hideEmpty();
    addMsgUser(text);
  }
  state.history.push({ role: 'user', content: text });
  input.value = '';
  autoGrow();

  const ctx = addStreamingAI();
  setStreaming(true);
  const ctrl = new AbortController();
  state.abort = ctrl;
  let acc = '';
  let firstDelta = false;
  let doneData = null;
  // 快照标签：取本轮用户指令前24字
  let snapLabel = 'AI 应用';
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'user') { snapLabel = state.history[i].content.slice(0, 24); break; }
  }

  const handleSSE = (evt) => {
    if (!evt || !evt.type) return;
    if (evt.type === 'delta') {
      if (!firstDelta) { firstDelta = true; ctx.think.remove(); ctx.stream.style.display = ''; }
      acc += evt.text;
      ctx.stream.textContent = acc;
      scrollBottom();
    } else if (evt.type === 'notice') {
      clearInterval(ctx.timer);
      ctx.think.querySelector('.think-text').textContent = evt.text;
    } else if (evt.type === 'think') {
      clearInterval(ctx.timer);
      const t = ctx.think.querySelector('.think-text');
      if (t) t.textContent = '深度思考中，复杂图表推理需要更久…';
    } else if (evt.type === 'done') {
      doneData = evt;
    } else if (evt.type === 'error') {
      doneData = { ok: false, errMsg: evt.message };
    }
  };

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.history.slice(0, -1).concat([{ role: 'user', content: text }]), currentXml: state.currentXml }),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) throw new Error('服务端 HTTP ' + resp.status);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try { handleSSE(JSON.parse(line.slice(5).trim())); } catch (e) { /* 半包 */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      doneData = { ok: false, aborted: true, text: acc };
    } else {
      doneData = { ok: false, errMsg: '连接服务端失败：' + err.message };
    }
  } finally {
    setStreaming(false);
    state.abort = null;
    if (!doneData) doneData = { ok: false, aborted: acc.length > 0, text: acc };
    finalizeAIMessage(ctx, {
      text: doneData.text != null ? doneData.text : acc,
      xml: doneData.xml || null,
      stats: doneData.stats || null,
      issues: doneData.issues || null,
      aborted: doneData.aborted,
      snapLabel,
      errMsg: doneData.errMsg || (doneData.xml ? null : (doneData.issues && doneData.issues.length ? 'XML 校验未通过：' + doneData.issues.join('；') : null)),
    });
    // 自动应用
    try {
      if (doneData.xml && state.autoApply && state.ready) {
        applyXml(doneData.xml, true, snapLabel);
        toast('已应用到画布 ✓', 'ok');
      } else if (doneData.xml && !state.ready) {
        toast('编辑器未就绪，可点击「重新应用到画布」', 'warn');
      }
    } catch (applyErr) {
      console.error('自动应用失败', applyErr);
      toast('自动应用出错：' + (applyErr.message || applyErr), 'err');
    }
  }
}

/* ---------------- 输入框 ---------------- */

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (state.streaming) return;
    send();
  }
});
sendBtn.addEventListener('click', () => {
  if (state.streaming && state.abort) { state.abort.abort(); return; }
  send();
});

/* ---------------- 顶栏按钮 ---------------- */

$('#btn-new').addEventListener('click', () => {
  if (hasContent()) { state.undoStack.push(state.currentXml); }
  postToEditor({ action: 'load', xml: EMPTY_XML, autosave: 1, fit: 1 });
  setXml(EMPTY_XML);
  toast('已新建空白画布', 'ok');
});
$('#btn-undo').addEventListener('click', undoLast);
$('#btn-xml').addEventListener('click', exportXmlFile);
$('#btn-png').addEventListener('click', () => exportDiagram('png'));
$('#btn-svg').addEventListener('click', () => exportDiagram('svg'));
$('#btn-copy').addEventListener('click', () => exportDiagram('png', true));
$('#btn-clear').addEventListener('click', () => {
  if (state.streaming && state.abort) state.abort.abort();
  state.history = [];
  chat.querySelectorAll('.msg, .msg-notice').forEach((n) => n.remove());
  showEmpty();
  toast('对话已清空（画布保留）', 'ok');
});

$('#auto-apply').addEventListener('change', (e) => {
  state.autoApply = e.target.checked;
  toast(state.autoApply ? '已开启自动应用' : '已关闭自动应用（可手动应用）', 'ok');
});

/* ---------------- 模板 chips ---------------- */

document.querySelectorAll('.chip').forEach((c) => {
  c.addEventListener('click', () => send(c.getAttribute('data-p')));
});

/* ---------------- 面板拖拽 ---------------- */

(function initDivider() {
  const divider = $('#divider');
  let dragging = false;
  divider.addEventListener('mousedown', (e) => { dragging = true; divider.classList.add('dragging'); document.body.style.cursor = 'col-resize'; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(640, Math.max(320, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--panel-w', w + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    const w = getComputedStyle(document.documentElement).getPropertyValue('--panel-w');
    try { localStorage.setItem('zhenhui-panel-w', w.trim()); } catch (e) { /* 忽略 */ }
  });
  try {
    const saved = localStorage.getItem('zhenhui-panel-w');
    if (saved) document.documentElement.style.setProperty('--panel-w', saved);
  } catch (e) { /* 忽略 */ }
})();

/* ---------------- 弹窗通用 ---------------- */

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll('.modal-overlay').forEach((ov) => {
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.hidden = true; });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach((ov) => { ov.hidden = true; });
});
$('#thesis-close').addEventListener('click', () => closeModal('thesis-modal'));
$('#history-close').addEventListener('click', () => closeModal('history-modal'));

/* ---------------- 论文设置 ---------------- */

function syncThesisUI() {
  document.getElementById('opt-gray').checked = thesis.gray;
  document.getElementById('opt-font').value = thesis.font;
  document.getElementById('opt-theme').value = thesis.theme;
  document.getElementById('fig-prefix').value = thesis.prefix;
}
$('#btn-thesis').addEventListener('click', () => { syncThesisUI(); renderFigures(); openModal('thesis-modal'); });

document.getElementById('opt-gray').addEventListener('change', (e) => {
  thesis.gray = e.target.checked;
  saveThesis();
  if (retransformCurrent()) toast(thesis.gray ? '已切换为论文灰阶（原彩色版可用「撤销」找回）' : '已关闭灰阶，后续恢复彩色输出', 'ok');
  else toast(thesis.gray ? '灰阶已开启，AI 应用时自动转换' : '灰阶已关闭', 'ok');
});
document.getElementById('opt-font').addEventListener('change', (e) => {
  thesis.font = e.target.value;
  saveThesis();
  if (retransformCurrent()) toast('字体已应用到当前画布：' + (thesis.font || '默认'), 'ok');
  else toast('字体已保存：' + (thesis.font || '默认') + '，下次应用生效', 'ok');
});
document.getElementById('opt-theme').addEventListener('change', (e) => {
  thesis.theme = e.target.value;
  saveThesis();
  if (retransformCurrent()) toast('全局风格已应用到当前画布', 'ok');
  else toast('全局风格已保存，下次应用生效', 'ok');
});

/* ---------------- 图注与编号 ---------------- */

function renderFigures() {
  const list = document.getElementById('fig-list');
  list.innerHTML = '';
  if (!thesis.figures.length) {
    list.innerHTML = '<div class="fig-empty">暂无记录 · 填写章节号与标题后点击「记录当前图」</div>';
    return;
  }
  thesis.figures.forEach((f, i) => {
    const item = el('div', 'fig-item');
    item.innerHTML = '<span class="no">图' + escapeHtml(f.no) + '</span><span class="t" title="' + escapeHtml(f.title) + '">' + escapeHtml(f.title) + '</span>';
    const del = el('button', 'mini-btn del', '删除');
    del.onclick = () => { thesis.figures.splice(i, 1); saveThesis(); renderFigures(); };
    item.appendChild(del);
    list.appendChild(item);
  });
}
document.getElementById('fig-add').addEventListener('click', () => {
  const title = document.getElementById('fig-title').value.trim();
  if (!title) return toast('请先填写图标题', 'warn');
  const no = thesis.prefix ? thesis.prefix + '-' + (thesis.figures.length + 1) : String(thesis.figures.length + 1);
  thesis.figures.push({ no, title, time: Date.now() });
  saveThesis();
  renderFigures();
  document.getElementById('fig-title').value = '';
  toast('已记录 图' + no + '，导出文件名将携带编号', 'ok');
});
document.getElementById('fig-prefix').addEventListener('change', (e) => {
  thesis.prefix = e.target.value.trim();
  saveThesis();
});
document.getElementById('fig-copy-catalog').addEventListener('click', () => {
  if (!thesis.figures.length) return toast('还没有图注记录', 'warn');
  const text = thesis.figures.map((f) => '图' + f.no + '  ' + f.title).join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast('图目录已复制（共 ' + thesis.figures.length + ' 条）', 'ok'),
    () => toast('复制失败', 'err'));
});

/* ---------------- 版本历史（服务端落盘） ---------------- */

async function saveSnapshot(label, xml, silent) {
  try {
    const r = await fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, xml }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!silent) { toast('快照已保存 ✓', 'ok'); loadSnapshotList(); }
  } catch (e) {
    if (!silent) toast('快照保存失败：' + e.message, 'err');
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadSnapshotList() {
  const box = document.getElementById('snap-list');
  box.innerHTML = '<div class="snap-empty">加载中…</div>';
  try {
    const r = await (await fetch('/api/snapshots')).json();
    const snaps = r.snapshots || [];
    box.innerHTML = '';
    if (!snaps.length) {
      box.innerHTML = '<div class="snap-empty">暂无快照 · AI 每次应用会自动存档</div>';
      return;
    }
    snaps.forEach((s) => {
      const item = el('div', 'snap-item');
      const t = el('div', 't');
      t.innerHTML = '<b title="' + escapeHtml(s.label) + '">' + escapeHtml(s.label || '（无标题）') + '</b><i>' + fmtTime(s.time) + ' · ' + (s.bytes / 1024).toFixed(1) + ' KB</i>';
      item.appendChild(t);
      const bLoad = el('button', 'mini-btn primary', '载入');
      bLoad.onclick = async () => {
        try {
          const full = await (await fetch('/api/snapshots/' + s.id)).json();
          if (!state.ready) return toast('编辑器尚未就绪', 'warn');
          state.undoStack.push(state.currentXml);
          postToEditor({ action: 'load', xml: full.xml, autosave: 1, fit: 1 });
          setXml(full.xml);
          closeModal('history-modal');
          toast('快照已载入画布 ✓', 'ok');
        } catch (e) { toast('载入失败：' + e.message, 'err'); }
      };
      const bDl = el('button', 'mini-btn', '下载');
      bDl.onclick = async () => {
        try {
          const full = await (await fetch('/api/snapshots/' + s.id)).json();
          const blob = new Blob([full.xml], { type: 'text/xml' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = s.label.replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '-' + s.id + '.drawio';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        } catch (e) { toast('下载失败', 'err'); }
      };
      const bDel = el('button', 'mini-btn', '删除');
      bDel.onclick = async () => {
        try {
          await fetch('/api/snapshots/' + s.id, { method: 'DELETE' });
          loadSnapshotList();
        } catch (e) { toast('删除失败', 'err'); }
      };
      item.appendChild(bLoad); item.appendChild(bDl); item.appendChild(bDel);
      box.appendChild(item);
    });
  } catch (e) {
    box.innerHTML = '<div class="snap-empty">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
$('#btn-history').addEventListener('click', () => { openModal('history-modal'); loadSnapshotList(); });
$('#snap-save').addEventListener('click', () => {
  if (!hasContent()) return toast('画布为空', 'warn');
  saveSnapshot('手动快照 · ' + fmtTime(Date.now()), state.currentXml, true).then(() => loadSnapshotList());
});
$('#snap-refresh').addEventListener('click', loadSnapshotList);

/* ---------------- 模板 Tabs ---------------- */

document.querySelectorAll('.chip-tabs .tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.chip-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.getElementById('chips-general').style.display = t.dataset.tab === 'general' ? '' : 'none';
    document.getElementById('chips-academic').style.display = t.dataset.tab === 'academic' ? '' : 'none';
  });
});

/* ---------------- Toast ---------------- */

function toast(text, type) {
  const t = el('div', 'toast ' + (type || ''));
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 350); }, 3200);
}

/* ---------------- 启动 ---------------- */

(async function init() {
  frame.src = FRAME_URL;
  setXml(EMPTY_XML);
  try {
    const cfg = await (await fetch('/api/config')).json();
    const modelName = (cfg.model || '').replace(/^deepseek-/, '');
    $('#model-text').textContent = 'DeepSeek ' + modelName;
    if (!cfg.hasKey) toast('未配置 API Key，请在 .env 中填写 DEEPSEEK_API_KEY', 'err');
  } catch (e) {
    $('#model-text').textContent = '服务未连接';
    toast('无法连接后端服务', 'err');
  }
  // 30s 未就绪提示
  setTimeout(() => { if (!state.ready) toast('编辑器加载较慢，请检查网络或刷新页面', 'warn'); }, 30000);
  // 调试/测试句柄
  window.__zhenhui = { state, thesis, applyXml, transformXml };
})();

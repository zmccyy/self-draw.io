'use strict';
/**
 * 智绘 AI · Diagram Studio — 零依赖 Node 服务器
 * - 静态托管前端 (public/) 与 draw.io 引擎 (drawio-src/src/main/webapp)
 * - POST /api/chat: SSE 流式代理 DeepSeek，服务端校验/修复 draw.io XML，失败自动重试一次
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractXml, validateAndFix } = require('./lib/xmlutils');
const { buildMessages, CONTINUE_HINT } = require('./lib/prompt');

// ---------- .env ----------
function loadEnv(file) {
  const env = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch (e) { /* 忽略 */ }
  return env;
}
const ENV = loadEnv(path.join(__dirname, '.env'));
for (const k of ['PORT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'MAX_TOKENS']) {
  if (process.env[k]) ENV[k] = process.env[k];
}
const PORT = parseInt(ENV.PORT || '3210', 10);
const API_KEY = ENV.DEEPSEEK_API_KEY || '';
const MODEL = ENV.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const BASE_URL = (ENV.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MAX_TOKENS = parseInt(ENV.MAX_TOKENS || '8192', 10);

const PUB_DIR = path.join(__dirname, 'public');
const DRAWIO_DIR = path.join(__dirname, 'drawio-src', 'src', 'main', 'webapp');
const SNAP_DIR = path.join(__dirname, 'snapshots');
try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'text/xml; charset=utf-8', '. wasm': 'application/wasm',
  '.css.map': 'application/json', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.properties': 'text/plain; charset=utf-8',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ---------- 静态文件 ----------
function serveStatic(baseDir, relPath, req, res) {
  let p = decodeURIComponent(relPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.normalize(path.join(baseDir, p));
  if (!abs.startsWith(path.normalize(baseDir))) return send(res, 403, { error: 'forbidden' });
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // 目录回退 index.html
      const idx = path.join(abs, 'index.html');
      if (!err && fs.existsSync(idx)) return streamFile(idx, res);
      return send(res, 404, 'Not Found: ' + p, 'text/plain; charset=utf-8');
    }
    streamFile(abs, res);
  });
}
function streamFile(abs, res) {
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(abs).pipe(res);
}

// ---------- DeepSeek 流式调用 ----------
async function streamDeepSeek(messages, onDelta, onThink, signal) {
  const body = {
    model: MODEL,
    messages,
    stream: true,
    temperature: 0.6,
  };
  if (MAX_TOKENS > 0) body.max_tokens = MAX_TOKENS;

  const resp = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('DeepSeek API ' + resp.status + ': ' + text.slice(0, 300));
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = ''; let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content && onThink) onThink(delta.reasoning_content);
        if (delta.content) { full += delta.content; onDelta(delta.content); }
      } catch (e) { /* 忽略半包 */ }
    }
  }
  return full;
}

// ---------- /api/chat ----------
async function handleChat(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* 断开 */ } };
    send({ type: 'meta', model: MODEL });

    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
    const history = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    const currentXml = typeof body.currentXml === 'string' ? body.currentXml.slice(0, 120000) : '';

    if (!API_KEY) { send({ type: 'error', message: '未配置 DEEPSEEK_API_KEY，请检查 .env' }); return res.end(); }
    if (!history.length) { send({ type: 'error', message: '消息为空' }); return res.end(); }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      const messages = buildMessages({ history, currentXml });
      send({ type: 'notice', text: '请求模型 ' + MODEL + ' …' });

      const runOnce = async (msgs, prefixNote) => {
        if (prefixNote) send({ type: 'notice', text: prefixNote });
        let thinkSent = false;
        return await streamDeepSeek(msgs,
          (d) => send({ type: 'delta', text: d }),
          () => { if (!thinkSent) { thinkSent = true; send({ type: 'think' }); } },
          controller.signal);
      };

      let text = await runOnce(messages);
      let xml = extractXml(text);
      let v = validateAndFix(xml);

      // 自动重试一次修复
      if (!v.ok && !controller.signal.aborted) {
        const retryMsgs = messages.concat([
          { role: 'assistant', content: (text || '').slice(-4000) },
          { role: 'user', content: '你上一条回复中的 XML 无法通过 draw.io 校验，问题：' + v.issues.join('；') +
            '。请严格遵循系统规则，重新输出【完整、可直接渲染】的 mxGraphModel（一个 ```xml 代码块），不要解释。' },
        ]);
        text = await runOnce(retryMsgs, 'XML 校验未通过（' + v.issues[0] + '），已自动发起修复重试…');
        xml = extractXml(text);
        v = validateAndFix(xml);
      }

      if (v.ok) {
        send({ type: 'done', text, xml: v.xml, stats: v.stats, issues: v.issues, fixed: v.issues.filter(i => i.indexOf('自动') === 0) });
      } else {
        send({ type: 'done', text, xml: null, stats: null, issues: v.issues });
      }
    } catch (err) {
      if (controller.signal.aborted) { send({ type: 'done', text: '', xml: null, aborted: true }); }
      else send({ type: 'error', message: String(err.message || err) });
    }
    res.end();
  });
}

// ---------- 版本历史快照 ----------
function listSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR)
      .filter((f) => /^snap-[\w-]+\.json$/.test(f))
      .map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
          return { id: f.replace(/\.json$/, ''), label: j.label || '', time: j.time || 0, bytes: j.xml ? j.xml.length : 0 };
        } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time);
  } catch (e) { return []; }
}

function handleSnapshots(req, res, pathname) {
  if (pathname === '/api/snapshots' && req.method === 'GET') {
    return send(res, 200, { snapshots: listSnapshots() });
  }
  if (pathname === '/api/snapshots' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        const xml = typeof body.xml === 'string' ? body.xml : '';
        if (!xml.includes('<mxGraphModel')) return send(res, 400, { error: 'XML 无效' });
        const id = 'snap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const rec = { id, label: String(body.label || '').slice(0, 60), time: Date.now(), xml };
        fs.writeFileSync(path.join(SNAP_DIR, id + '.json'), JSON.stringify(rec));
        // 只保留最新 100 个
        const all = listSnapshots();
        for (const old of all.slice(100)) {
          try { fs.unlinkSync(path.join(SNAP_DIR, old.id + '.json')); } catch (e) { /* 忽略 */ }
        }
        send(res, 200, { ok: true, id, total: Math.min(all.length + 1, 100) });
      } catch (e) { send(res, 400, { error: String(e.message || e) }); }
    });
    return;
  }
  const m = pathname.match(/^\/api\/snapshots\/(snap-[\w-]+)$/);
  if (m) {
    const file = path.join(SNAP_DIR, m[1] + '.json');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return send(res, 200, { id: j.id, label: j.label, time: j.time, xml: j.xml });
    }
    if (req.method === 'DELETE') {
      fs.unlinkSync(file);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  // CORS（本机调试便利；生产可收紧）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/api/health') {
    return send(res, 200, {
      ok: true, model: MODEL, hasKey: !!API_KEY, baseUrl: BASE_URL,
      drawioReady: fs.existsSync(path.join(DRAWIO_DIR, 'index.html')),
      uptime: process.uptime(),
    });
  }
  if (pathname === '/api/config') return send(res, 200, { model: MODEL, hasKey: !!API_KEY });

  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (pathname.startsWith('/api/snapshots')) return handleSnapshots(req, res, pathname);

  if (pathname === '/' || pathname === '/index.html') return serveStatic(PUB_DIR, '/index.html', req, res);

  if (pathname.startsWith('/drawio/')) {
    return serveStatic(DRAWIO_DIR, pathname.slice('/drawio/'.length), req, res);
  }
  if (pathname.startsWith('/assets/') || pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
    return serveStatic(PUB_DIR, pathname, req, res);
  }
  return serveStatic(PUB_DIR, pathname, req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   智绘 AI · Diagram Studio                   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('  ➜ 本地访问   http://localhost:' + PORT);
  console.log('  ➜ 模型       ' + MODEL + (API_KEY ? '  (Key ✓)' : '  (缺少 API Key!)'));
  console.log('  ➜ draw.io    ' + (fs.existsSync(path.join(DRAWIO_DIR, 'index.html')) ? '本地引擎就绪' : '未找到源码，请先克隆 jgraph/drawio'));
  console.log('');
});

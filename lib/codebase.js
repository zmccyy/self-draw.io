'use strict';
/**
 * codebase.js — 读码绘图：本地代码库扫描 / 启发式推荐 / 预算裁剪（零依赖）
 */

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'target', 'out', 'bin', 'obj',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', '.next', '.nuxt',
  '.gradle', '.mvn', 'coverage', 'logs', 'tmp', 'site-packages', 'vendor',
  '.pytest_cache', '.cache', '.gitignore', '.eggs', 'migrations', '.dart_tool',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svgz', '.pdf',
  '.zip', '.jar', '.war', '.class', '.pyc', '.pyo', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.avi', '.mov',
  '.7z', '.gz', '.tar', '.rar', '.docx', '.xlsx', '.pptx', '.db', '.sqlite',
  '.bin', '.dat', '.wasm', '.deb', '.rpm', '.apk',
]);
const TEXT_CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rb', '.php', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.kt', '.swift', '.rs', '.scala', '.vue',
  '.sql', '.json', '.yml', '.yaml', '.xml', '.html', '.css', '.scss', '.less',
  '.md', '.txt', '.sh', '.bat', '.ps1', '.properties', '.gradle', '.toml',
  '.ini', '.cfg', '.env', '.proto', '.graphql', '.dart', '.pl', '.lua',
]);

const RECOMMEND_RULES = [
  { re: /(^|\/)(package\.json|pom\.xml|build\.gradle|settings\.gradle|requirements\.txt|environment\.yml|pyproject\.toml|go\.mod|cargo\.toml|composer\.json|gemfile)$/i, w: 10 },
  { re: /(^|\/)readme(\.md|\.rst|\.txt)?$/i, w: 9 },
  { re: /(^|\/)(main|app|index|server|manage|wsgi|asgi)\.(js|jsx|ts|tsx|py|java|go|rb|php)$/i, w: 8 },
  { re: /(^|\/)urls\.py$/i, w: 8 },
  { re: /application[^/]*\.(yml|yaml|properties)$/i, w: 7 },
  { re: /(^|\/)settings\.py$/i, w: 7 },
  { re: /(^|\/)(models?|entities|entity|domain|schema)(\/|[^/]*\.)/i, w: 7 },
  { re: /(^|\/)(routes?|controllers?|api|views|resources|services)(\/)/i, w: 6 },
  { re: /(^|\/)config(\/)[^/]+\.(js|ts|py|json|yaml|yml)$/i, w: 5 },
  { re: /\.sql$/i, w: 5 },
  { re: /dockerfile$/i, w: 4 },
];

function isRecommended(relPath) {
  const p = relPath.toLowerCase();
  for (const r of RECOMMEND_RULES) if (r.re.test(p)) return true;
  return false;
}

/** 扫描目录，返回文件清单（相对路径 / 分隔） */
function scan(root, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 4000;
  const files = [];
  let ignoredDirs = 0;
  let truncated = false;

  const walk = (absDir, relDir, depth) => {
    if (depth > 12 || files.length >= maxFiles) { truncated = files.length >= maxFiles; return; }
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const name = ent.name;
      const abs = path.join(absDir, name);
      const rel = relDir ? relDir + '/' + name : name;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(name) || name.startsWith('.') && name !== '.env.example') { ignoredDirs++; continue; }
        walk(abs, rel, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        let bytes = 0;
        try { bytes = fs.statSync(abs).size; } catch (e) { continue; }
        if (bytes > 2 * 1024 * 1024) continue; // 单个超大文件跳过
        if (!TEXT_CODE_EXT.has(ext) && !RECOMMEND_RULES.some((r) => r.re.test(rel.toLowerCase()))) continue;
        files.push({ path: rel.replace(/\\/g, '/'), bytes, recommended: isRecommended(rel) });
      }
    }
  };
  walk(root, '', 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  return { files, ignoredDirs, truncated, totalBytes };
}

/** 解码：UTF-8 优先，失败回退 GBK（中文注释常见），仍失败返回 null */
function decodeBuf(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* try GBK */ }
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return null; }
}

/** 读取单文件内容（带单文件截断） */
function readOne(absPath, perFileBytes) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return null; }
  let truncated = false;
  if (buf.length > perFileBytes) {
    const slice = buf.subarray(0, Math.min(buf.length, perFileBytes + 64 * 1024));
    let text = decodeBuf(slice);
    if (text == null) return null;
    const cut = text.lastIndexOf('\n', perFileBytes);
    text = (cut > 0 ? text.slice(0, cut) : text.slice(0, perFileBytes)) + '\n/* …[文件过长，已截断保留头部] */';
    return { text, truncated: true };
  }
  const text = decodeBuf(buf);
  return text == null ? null : { text, truncated: false };
}

/**
 * 按预算读取选中的文件。
 * 返回 { sent:[{path,bytes,truncated}], skipped:[{path,reason}], totalSentBytes }
 */
function pickContent(root, selectedPaths, budgetBytes, perFileBytes) {
  budgetBytes = budgetBytes || 500 * 1024;
  perFileBytes = perFileBytes || 100 * 1024;
  const rootResolved = path.resolve(root);
  const sent = []; const skipped = []; let total = 0;
  for (const rel of selectedPaths) {
    const abs = path.resolve(rootResolved, rel);
    if (!abs.startsWith(rootResolved)) { skipped.push({ path: rel, reason: '非法路径' }); continue; }
    if (total >= budgetBytes) { skipped.push({ path: rel, reason: '超出总预算' }); continue; }
    const r = readOne(abs, perFileBytes);
    if (!r) { skipped.push({ path: rel, reason: '读取/解码失败' }); continue; }
    const bytes = Buffer.byteLength(r.text, 'utf8');
    if (total + bytes > budgetBytes) {
      const remain = budgetBytes - total;
      if (remain > 8 * 1024) {
        const cut = r.text.lastIndexOf('\n', remain);
        sent.push({ path: rel, bytes: remain, truncated: true, content: r.text.slice(0, cut > 0 ? cut : remain) + '\n/* …[超出总预算已截断] */' });
        total += remain;
      } else {
        skipped.push({ path: rel, reason: '超出总预算' });
      }
    } else {
      sent.push({ path: rel, bytes, truncated: r.truncated, content: r.text });
      total += bytes;
    }
  }
  return { sent, skipped, totalSentBytes: total };
}

module.exports = { scan, pickContent, decodeBuf, IGNORE_DIRS };

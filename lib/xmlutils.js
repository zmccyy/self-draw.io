'use strict';

/**
 * draw.io XML 提取 / 校验 / 修复工具（零依赖）
 */

// 从模型输出中提取 draw.io XML：优先 ```xml 代码块，其次裸 <mxGraphModel>/<mxfile>
function extractXml(text) {
  if (!text) return null;
  let cand = null;
  const fence = text.match(/```(?:xml|html)?\s*([\s\S]*?)```/i);
  if (fence) cand = fence[1];
  if (!cand || cand.indexOf('<mxGraphModel') === -1 && cand.indexOf('<mxfile') === -1) {
    const i1 = text.indexOf('<mxGraphModel');
    const i2 = text.indexOf('<mxfile');
    let start = -1; let endTag = null;
    if (i1 !== -1 && (i2 === -1 || i1 < i2)) { start = i1; endTag = '</mxGraphModel>'; }
    else if (i2 !== -1) { start = i2; endTag = '</mxfile>'; }
    if (start !== -1) {
      const end = text.lastIndexOf(endTag);
      if (end !== -1 && end > start) cand = text.slice(start, end + endTag.length);
    }
  }
  if (!cand) return null;
  return cand.trim();
}

// 转义 value="..." 属性内的裸 < （LLM 常见错误，会破坏 XML 解析）
function escapeValueAttrs(xml) {
  return xml.replace(/value="([^"]*)"/g, (m, inner) => {
    const fixed = inner.replace(/</g, '&lt;').replace(/(?<!&)#(?![0-9a-fA-F]{3,8};)/g, '&#35;');
    return 'value="' + fixed + '"';
  });
}

// 修复未转义的 & 符号
function escapeAmp(xml) {
  return xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

// 校验 + 轻量修复，返回 {ok, xml, issues:[], stats}
function validateAndFix(raw) {
  const issues = [];
  if (!raw) return { ok: false, xml: null, issues: ['未找到XML内容'], stats: null };
  let xml = String(raw).trim();
  xml = xml.replace(/^\uFEFF/, '').replace(/^[^<]+/, ''); // 去掉前导说明文字
  xml = escapeAmp(xml);
  xml = escapeValueAttrs(xml);

  // 若被 mxfile 包裹，提取第一个 mxGraphModel
  const iMxfile = xml.indexOf('<mxfile');
  const iModel = xml.indexOf('<mxGraphModel');
  if (iMxfile !== -1 && (iModel === -1 || iMxfile < iModel)) {
    const inner = xml.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/);
    if (inner) xml = inner[0];
    else issues.push('mxfile 中未找到 mxGraphModel');
  }

  if (xml.indexOf('<mxGraphModel') === -1) {
    issues.push('缺少 <mxGraphModel> 根元素');
    return { ok: false, xml, issues, stats: null };
  }
  if (xml.indexOf('</mxGraphModel>') === -1) {
    issues.push('mxGraphModel 未闭合');
    return { ok: false, xml, issues, stats: null };
  }
  if (xml.indexOf('<root>') === -1 || xml.indexOf('</root>') === -1) {
    issues.push('缺少 <root> 容器');
    return { ok: false, xml, issues, stats: null };
  }
  if (xml.indexOf('<mxCell') === -1) {
    issues.push('没有任何 mxCell 单元格');
    return { ok: false, xml, issues, stats: null };
  }

  // 确保图层根节点 id=0 / id=1 存在
  let rootInner = xml.match(/<root>([\s\S]*?)<\/root>/);
  if (rootInner) {
    let inner = rootInner[1];
    const inject = [];
    if (!/id="0"/.test(inner)) inject.push('<mxCell id="0"/>');
    if (!/id="1"/.test(inner)) inject.push('<mxCell id="1" parent="0"/>');
    if (inject.length) {
      inner = inject.join('') + inner;
      xml = xml.replace(/<root>[\s\S]*?<\/root>/, '<root>' + inner + '</root>');
      issues.push('已自动补齐图层根节点(0/1)');
    }
  }

  // 标签配平粗检：mxCell 自闭合或显式闭合
  const openCells = (xml.match(/<mxCell[\s>]/g) || []).length;
  const selfClosed = (xml.match(/<mxCell[^>]*\/>/g) || []).length;
  const closedPairs = (xml.match(/<\/mxCell>/g) || []).length;
  if (openCells !== selfClosed + closedPairs) {
    issues.push('mxCell 标签未配平(开' + openCells + '/合' + (selfClosed + closedPairs) + ')');
    return { ok: false, xml, issues, stats: null };
  }
  const openGeo = (xml.match(/<mxGeometry[\s>]/g) || []).length;
  const selfGeo = (xml.match(/<mxGeometry[^>]*\/>/g) || []).length;
  const closedGeo = (xml.match(/<\/mxGeometry>/g) || []).length;
  if (openGeo !== selfGeo + closedGeo) {
    issues.push('mxGeometry 标签未配平');
    return { ok: false, xml, issues, stats: null };
  }

  // 统计
  const vertices = (xml.match(/vertex="1"/g) || []).length;
  const edges = (xml.match(/edge="1"/g) || []).length;
  const bytes = Buffer.byteLength(xml, 'utf8');
  const stats = { vertices, edges, bytes, kb: (bytes / 1024).toFixed(1) };

  return { ok: true, xml, issues, stats };
}

module.exports = { extractXml, validateAndFix };

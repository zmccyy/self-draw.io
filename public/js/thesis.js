'use strict';
/* ============================================================
 * ThesisTransform — 论文制图 XML 变换（纯字符串处理，零依赖）
 * - 灰阶转换：按亮度分档映射，深底自动反白
 * - 字体预设：向所有 style 注入 fontFamily
 * - 全局风格：统一 fontSize / strokeWidth / rounded
 * ============================================================ */
const ThesisTransform = (function () {

  function lum(hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // 亮度分 5 档灰阶，保持层次
  function grayFill(hex) {
    const L = lum(hex);
    if (L >= 0.83) return '#F5F5F5';
    if (L >= 0.60) return '#E0E0E0';
    if (L >= 0.38) return '#BFBFBF';
    if (L >= 0.18) return '#8C8C8C';
    return '#404040';
  }

  function grayStyle(style) {
    const fillM = style.match(/fillColor=(#[0-9a-fA-F]{3,8})/);
    const fillL = fillM ? lum(fillM[1]) : 1;
    const dark = fillL < 0.30;
    let s = style.replace(/fillColor=(#[0-9a-fA-F]{3,8})/g, (m, v) => 'fillColor=' + grayFill(v));
    s = s.replace(/strokeColor=(#[0-9a-fA-F]{3,8})/g, () => 'strokeColor=#333333');
    if (/(^|;)fontColor=/.test(s)) {
      s = s.replace(/fontColor=(#[0-9a-fA-F]{3,8})/g, () => 'fontColor=' + (dark ? '#FFFFFF' : '#000000'));
    } else if (dark) {
      s = s + ';fontColor=#FFFFFF';
    }
    return s;
  }

  function toGrayscale(xml) {
    let out = xml.replace(/style="([^"]*)"/g, (m, style) => 'style="' + grayStyle(style) + '"');
    out = out.replace(/background="(?!none)[^"]*"/g, 'background="#FFFFFF"');
    return out;
  }

  function applyFont(xml, family) {
    if (!family) return xml;
    return xml.replace(/style="([^"]*)"/g, (m, style) => {
      let s;
      if (/fontFamily=/.test(style)) {
        s = style.replace(/fontFamily=[^;]*;?/, 'fontFamily=' + family + ';');
      } else {
        s = 'fontFamily=' + family + ';' + style;
      }
      return 'style="' + s + '"';
    });
  }

  // theme: {fontSize, strokeWidth, rounded}
  function applyTheme(xml, theme) {
    if (!theme) return xml;
    return xml.replace(/style="([^"]*)"/g, (m, style) => {
      let s = style;
      const set = (key, val) => {
        const re = new RegExp('(^|;)' + key + '=[^;]*;?');
        if (re.test(s)) s = s.replace(re, (mm, p1) => p1 + key + '=' + val + ';');
        else s = key + '=' + val + ';' + s;
      };
      if (theme.fontSize) set('fontSize', theme.fontSize);
      if (theme.strokeWidth) set('strokeWidth', theme.strokeWidth);
      if (theme.rounded != null) set('rounded', theme.rounded);
      return 'style="' + s + '"';
    });
  }

  // opts: {gray:bool, font:string, theme:object|null}
  function enhance(xml, opts) {
    opts = opts || {};
    let out = xml;
    if (opts.theme) out = applyTheme(out, opts.theme);
    if (opts.font) out = applyFont(out, opts.font);
    if (opts.gray) out = toGrayscale(out);
    return out;
  }

  return { enhance, toGrayscale, applyFont, applyTheme, lum };
})();

/**
 * Detect text encoding from a buffer (UTF-8 vs GBK).
 * Returns the correctly decoded text string.
 *
 * Strategy:
 * 1. Try UTF-8 — if it contains U+FFFD (replacement char), it's not valid UTF-8 → fallback to GBK
 * 2. Try GBK and compare CJK character counts
 * 3. Check Latin-1 Supplement density in non-CJK parts of UTF-8 output
 *    (GBK bytes misread as UTF-8 often produce Latin-1 chars)
 * 4. If GBK has significantly more real CJK chars, prefer GBK
 *
 * @param {ArrayBuffer} buffer
 * @returns {string} decoded text
 */
export function detectEncoding(buffer) {
  // 1. Try UTF-8
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  // Quick check: replacement character means invalid UTF-8 → use GBK
  if (utf8Text.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(buffer); } catch {}
    return utf8Text;
  }

  // 2. Try GBK
  let gbkText;
  try { gbkText = new TextDecoder('gbk').decode(buffer); } catch { return utf8Text; }

  // 3. Compare CJK character counts
  const cjkReg = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;
  const utf8Cjk = (utf8Text.match(cjkReg) || []).length;
  const gbkCjk = (gbkText.match(cjkReg) || []).length;

  // 4. If GBK has more CJK characters → prefer GBK
  if (gbkCjk > utf8Cjk) return gbkText;

  // 5. When UTF-8 has more "CJK" chars, check if they're actually garbled:
  //    GBK bytes → UTF-8 often produces Latin-1 Supplement (U+0080-U+00FF) in non-CJK parts
  if (utf8Cjk > 0 && gbkCjk > 0) {
    const nonCjk = utf8Text.replace(cjkReg, '');
    // Remove ASCII printable (space, punctuation, letters, digits)
    const asciiClean = nonCjk.replace(/[\u0020-\u007e]/g, '');
    const latin1Count = (asciiClean.match(/[\u0080-\u00ff]/g) || []).length;
    // If Latin-1 chars make up >10% of non-CJK, likely GBK garbled as UTF-8
    if (asciiClean.length > 0 && latin1Count / asciiClean.length > 0.1) {
      return gbkText;
    }
  }

  // Default: UTF-8 looks clean
  return utf8Text;
}

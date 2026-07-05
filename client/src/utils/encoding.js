/**
 * Detect text encoding from a buffer (UTF-8 vs GBK vs UTF-16).
 * Returns the correctly decoded text string.
 *
 * Strategy (in order):
 * 1. Check for BOM (Byte Order Mark) — UTF-16 LE/BE, UTF-8
 * 2. Check for null bytes — strong indicator of UTF-16
 * 3. Try UTF-8 — if it contains U+FFFD (replacement char), fallback to GBK
 * 4. Try GBK and compare CJK character counts
 * 5. Check Latin-1 Supplement density in non-CJK parts of UTF-8 output
 *    (GBK bytes misread as UTF-8 often produce Latin-1 Supplement chars U+0080-U+00FF)
 * 6. If GBK has significantly more real CJK chars, prefer GBK
 *
 * @param {ArrayBuffer} buffer
 * @returns {string} decoded text
 */
export function detectEncoding(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return '';

  // ── 1. BOM-based detection ──

  // UTF-16 LE BOM (0xFF 0xFE) — Windows "Unicode" default
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    try { return new TextDecoder('utf-16le').decode(buffer); } catch { return ''; }
  }

  // UTF-16 BE BOM (0xFE 0xFF)
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    try { return new TextDecoder('utf-16be').decode(buffer); } catch { return ''; }
  }

  // UTF-8 BOM (0xEF 0xBB 0xBF) — definitely UTF-8, skip further detection
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buffer);
  }

  // ── 2. Null byte check — UTF-16 LE without BOM? ──
  // UTF-16 LE encodes ASCII as [char, 0x00]. If >5% of bytes are null (excluding
  // the last byte which might be padded), it's likely UTF-16.
  let nullCount = 0;
  for (let i = 1; i < bytes.length; i += 2) {
    if (bytes[i] === 0x00) nullCount++;
  }
  if (nullCount > 0 && bytes.length > 4) {
    const ratio = nullCount / Math.floor(bytes.length / 2);
    if (ratio > 0.5) {
      try { return new TextDecoder('utf-16le').decode(buffer); } catch { return ''; }
    }
  }

  // ── 3. Try UTF-8 ──
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  // Replacement character means invalid UTF-8 → use GBK
  if (utf8Text.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(buffer); } catch {}
    return '';
  }

  // ── 4. Try GBK ──
  let gbkText;
  try { gbkText = new TextDecoder('gbk').decode(buffer); } catch { return utf8Text; }

  // ── 5. Compare CJK character counts ──
  // Comprehensive CJK ranges covering:
  //   \u4e00-\u9fff   CJK Unified Ideographs (main block)
  //   \u3400-\u4dbf   CJK Unified Ideographs Extension A
  //   \uf900-\ufaff   CJK Compatibility Ideographs
  //   \u3000-\u303f   CJK Symbols and Punctuation
  //   \uff00-\uffef   Fullwidth Forms
  //   \u2e80-\u2eff   CJK Radicals Supplement
  //   \u2f00-\u2fdf   Kangxi Radicals
  //   \u3105-\u312f   Bopomofo
  //   \u31a0-\u31bf   Bopomofo Extended
  const cjkReg = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u2f00-\u2fdf\u3105-\u312f\u31a0-\u31bf]/g;
  const utf8Cjk = (utf8Text.match(cjkReg) || []).length;
  const gbkCjk = (gbkText.match(cjkReg) || []).length;

  // ── 6. Latin-1 Supplement density check in UTF-8 output ──
  // When GBK bytes are misread as UTF-8, the non-CJK portion of the UTF-8
  // output contains many Latin-1 Supplement characters (U+0080-U+00FF).
  // A clean UTF-8 text has negligible Latin-1 chars in non-CJK parts.
  const nonCjk = utf8Text.replace(cjkReg, '');
  const asciiClean = nonCjk.replace(/[\u0020-\u007e\r\n\t\f]/g, '');
  let latin1Ratio = 0;
  if (asciiClean.length > 0) {
    const latin1Count = (asciiClean.match(/[\u0080-\u00ff]/g) || []).length;
    latin1Ratio = latin1Count / asciiClean.length;
  }
  // High Latin-1 density (>8%) → GBK bytes misread as UTF-8
  const likelyGbk = latin1Ratio > 0.08;

  // ── 7. Decision logic ──
  if (gbkCjk > utf8Cjk) {
    // GBK has more CJK chars, but ONLY trust GBK if UTF-8 output shows noise
    // (Latin-1 chars) OR UTF-8 has zero CJK chars (meaning no real Chinese)
    if (likelyGbk || utf8Cjk === 0) return gbkText;
    // UTF-8 has both CJK characters AND clean non-CJK output → UTF-8 is correct
    return utf8Text;
  }

  if (likelyGbk) {
    // Even when CJK counts don't favor GBK, high Latin-1 density suggests GBK
    // This catches cases where GBK bytes decode as Latin-1 with few/no CJK
    return gbkText;
  }

  // ── 8. Default: UTF-8 looks clean ──
  return utf8Text;
}

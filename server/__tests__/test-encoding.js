/**
 * Quick test for detectEncoding — verifies correct decoding of various
 * encoding scenarios commonly found on Chinese Windows.
 *
 * Run with: node test-encoding.js
 */

// Polyfill TextEncoder/TextDecoder if needed (Node 24 has it globally)
// But the detectEncoding function expects `TextDecoder` which is available globally in Node 24.

import { detectEncoding } from '../../client/src/utils/encoding.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ── UTF-8 (no BOM) ──
function testUtf8() {
  const text = '你好世界 Hello World';
  const encoder = new TextEncoder();
  const buf = encoder.encode(text).buffer;
  const result = detectEncoding(buf);
  assert(result === text, `Expected "${text}", got "${result}"`);
}

// ── UTF-8 with BOM ──
function testUtf8WithBom() {
  const text = '中文测试 UTF-8 with BOM';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  // Prepend BOM: EF BB BF
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const combined = new Uint8Array(bom.length + bytes.length);
  combined.set(bom);
  combined.set(bytes, bom.length);
  const result = detectEncoding(combined.buffer);
  assert(result === text, `UTF-8 BOM: Expected "${text}", got "${result}"`);
}

// ── GBK/GB2312 encoding ──
function testGbk() {
  const text = '你好世界';
  // GBK encoding for common characters:
  // 你 = 0xC4 0xE3
  // 好 = 0xBA 0xC3
  // 世 = 0xCA 0xC0
  // 界 = 0xBD 0xE7
  const gbkBytes = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]);
  const result = detectEncoding(gbkBytes.buffer);
  assert(result === text, `GBK: Expected "${text}", got "${result}"`);
}

// ── GBK with mixed Chinese + ASCII ──
function testGbkMixed() {
  const text = 'Python入门教程';
  // GBK encoding:
  //  Py = P(0x50) y(0x79)
  //  t = 0x74, h = 0x68, o = 0x6F, n = 0x6E
  //  入 = 0xC8 0xEB
  //  门 = 0xC3 0xC5
  //  教 = 0xBD 0xCC
  //  程 = 0xB3 0xCC
  const gbkBytes = new Uint8Array([0x50, 0x79, 0x74, 0x68, 0x6F, 0x6E, 0xC8, 0xEB, 0xC3, 0xC5, 0xBD, 0xCC, 0xB3, 0xCC]);
  const result = detectEncoding(gbkBytes.buffer);
  assert(result === text, `GBK mixed: Expected "${text}", got "${result}"`);
}

// ── UTF-16 LE (Windows "Unicode") with BOM ──
function testUtf16Le() {
  const text = 'Hello 中文';
  const uint16 = new Uint16Array([0xFEFF, ...Array.from(text).map(c => c.charCodeAt(0))]);
  // Uint16Array stores as LE by default
  const buf = uint16.buffer;
  const result = detectEncoding(buf);
  assert(result === text, `UTF-16 LE: Expected "${text}", got "${result}"`);
}

// ── UTF-16 LE without BOM (rare but possible) ──
function testUtf16LeNoBom() {
  const text = 'Hello 中文 World!';
  const uint16 = new Uint16Array(Array.from(text).map(c => c.charCodeAt(0)));
  const result = detectEncoding(uint16.buffer);
  assert(result === text, `UTF-16 LE no BOM: Expected "${text}", got "${result}"`);
}

// ── Pure ASCII (no encoding confusion) ──
function testAscii() {
  const text = 'Hello World\nThis is a test\nWith multiple lines\n';
  const encoder = new TextEncoder();
  const buf = encoder.encode(text).buffer;
  const result = detectEncoding(buf);
  assert(result === text, `ASCII: Expected "${text}", got "${result}"`);
}

// ── Empty buffer ──
function testEmpty() {
  const buf = new ArrayBuffer(0);
  const result = detectEncoding(buf);
  assert(result === '', `Empty: Expected "", got "${result}"`);
}

// ── Markdown with Chinese + code blocks ──
function testMarkdown() {
  const text = `# Python 入门

## 变量

\`\`\`python
x = 10
print(x)
\`\`\`

## 数据类型

- 字符串 (String)
- 数字 (Number)
- 列表 (List)`;
  const encoder = new TextEncoder();
  const buf = encoder.encode(text).buffer;
  const result = detectEncoding(buf);
  assert(result === text, `Markdown UTF-8 mismatch`);
}

// ── Run tests ──
console.log('\n🧪 detectEncoding tests\n');

test('UTF-8 without BOM', testUtf8);
test('UTF-8 with BOM', testUtf8WithBom);
test('GBK (Pure Chinese)', testGbk);
test('GBK (Mixed Chinese + ASCII)', testGbkMixed);
test('UTF-16 LE with BOM', testUtf16Le);
test('UTF-16 LE without BOM', testUtf16LeNoBom);
test('Pure ASCII', testAscii);
test('Empty buffer', testEmpty);
test('Markdown with Chinese', testMarkdown);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

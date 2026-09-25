import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { colName, crc32, xlsxBuffer } from '../src/xlsx.mjs';

// 读回 zip：从中央目录拿每个文件的位置，解压，并核对 CRC
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = inflateRawSync(buf.subarray(start, start + size));
    assert.equal(crc32(data), crc, `${name} 的 CRC`);
    files[name] = data.toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('colName：A…Z、AA…', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
});

test('crc32：和标准值一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('xlsxBuffer：两张表；表头加粗、冻结首行；通过 / 不通过两种底色；数字写成数字；特殊字符转义、控制字符去掉', () => {
  const files = unzip(xlsxBuffer([
    { name: '汇总', head: ['任务', '花费'], rows: [['改后', 0.05]] },
    { name: '逐条', head: ['用例', '回复'], rows: [['a<b&c', '好'], ['坏\u0001', '"引号"']], rowStyle: (i) => (i === 0 ? 'pass' : 'fail') },
  ]));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(files[name], name);
  assert.match(files['xl/workbook.xml'], /<sheet name="汇总" sheetId="1" r:id="rId1"\/><sheet name="逐条" sheetId="2" r:id="rId2"\/>/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(s1, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">任务<\/t><\/is><\/c>/);
  assert.match(s1, /<c r="B2"><v>0\.05<\/v><\/c>/);
  const s2 = files['xl/worksheets/sheet2.xml'];
  assert.match(s2, /<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">a&lt;b&amp;c<\/t>/);
  assert.match(s2, /<c r="A3" s="3" t="inlineStr"><is><t xml:space="preserve">坏<\/t>/);
  assert.match(s2, /&quot;引号&quot;/);
  assert.match(files['xl/styles.xml'], /<cellXfs count="4">/);
});

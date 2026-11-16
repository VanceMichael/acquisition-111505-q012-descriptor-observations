import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodePayload } from '../src/decoder.mjs';

const table = JSON.parse(await readFile(new URL('../fixtures/tables-v1.json', import.meta.url), 'utf8'));
const payload = await readFile(new URL('../fixtures/observations.bin', import.meta.url));

test('描述符展开区分不同测站的传感器数量并保留缺测', () => {
  const { blocks, confirmed } = decodePayload(payload, table, ['stationBlock', 'stationBlock']);
  assert.deepEqual(blocks, [
    { station: 1, sensors: [{ temp: null, humidity: 65 }] },
    { station: 2, sensors: [{ temp: 21, humidity: 50 }, { temp: 22, humidity: 55 }] },
  ]);
  assert.equal(confirmed.length, 10);
  const temp = confirmed.find(entry => entry.path === 'stationBlock[0].sensors[0].temp');
  assert.equal(temp.missing, true);
  assert.equal(temp.value, null);
  assert.equal(temp.raw, 4095);
  assert.equal(temp.scale, 1);
  assert.equal(temp.reference, -500);
});

test('同一位流按不同表版本解释出不同数值', () => {
  const v2 = { ...table, version: 'v2', descriptors: { ...table.descriptors, temp: { ...table.descriptors.temp, reference: -400 } } };
  const { blocks } = decodePayload(payload, v2, ['stationBlock', 'stationBlock']);
  assert.equal(blocks[1].sensors[0].temp, 31);
  assert.equal(blocks[1].sensors[1].temp, 32);
  assert.equal(blocks[0].sensors[0].temp, null);
});

test('未知描述符报告已确认部分且不猜测跳过', () => {
  const broken = { ...table, descriptors: { ...table.descriptors, stationBlock: { ...table.descriptors.stationBlock, members: ['station', 'sensors', 'mystery'] } } };
  let caught;
  assert.throws(() => decodePayload(payload, broken, ['stationBlock', 'stationBlock']), error => { caught = error; return true; });
  assert.equal(caught.name, 'UnknownDescriptorError');
  assert.equal(caught.descriptor, 'mystery');
  assert.match(caught.message, /不可确定/);
  assert.equal(caught.confirmed.length, 4);
  assert(caught.confirmed.every(entry => entry.path.startsWith('stationBlock[0]')));
  assert.equal(caught.confirmed.find(entry => entry.path.endsWith('humidity')).value, 65);
});

test('截断的位流不能产出记录', () => {
  assert.throws(() => decodePayload(payload.subarray(0, -1), table, ['stationBlock', 'stationBlock']), /截断/);
});

test('末尾填充位必须为零且不得残留整字节', () => {
  assert.throws(() => decodePayload(Buffer.from([0b11100001]), table, ['sensorCount']), /填充位不是零/);
  assert.deepEqual(decodePayload(Buffer.from([0b11100000]), table, ['sensorCount']).blocks, [null]);
  assert.throws(() => decodePayload(Buffer.from([1, 2]), table, ['station']), /未解码字节/);
});

test('操作符的比例与参考值变化只作用于嵌套范围', () => {
  const local = {
    version: 'test',
    descriptors: {
      temp: { kind: 'element', bitWidth: 12, scale: 1, reference: -500 },
      scaledTemp: { kind: 'operator', scaleDelta: 1, members: ['temp'] },
      shiftedTemp: { kind: 'operator', referenceDelta: 100, members: ['temp'] },
    },
  };
  const bytes = Buffer.from([0x09, 0x20, 0x92, 0x09, 0x20, 0x92]);
  const { blocks, confirmed } = decodePayload(bytes, local, ['scaledTemp', 'temp', 'shiftedTemp', 'temp']);
  assert.equal(blocks[0].temp, -3.54);
  assert.equal(blocks[1], -35.4);
  assert.equal(blocks[2].temp, -25.4);
  assert.equal(blocks[3], -35.4);
  assert.equal(confirmed[0].scale, 2);
  assert.equal(confirmed[1].scale, 1);
  assert.equal(confirmed[2].reference, -400);
  assert.equal(confirmed[3].reference, -500);
});

test('作用域内的缺测位型仍然是缺测', () => {
  const local = { version: 'test', descriptors: { temp: { kind: 'element', bitWidth: 12, scale: 1, reference: -500 }, scaledTemp: { kind: 'operator', scaleDelta: 1, members: ['temp'] } } };
  const { blocks } = decodePayload(Buffer.from([0xff, 0xf0]), local, ['scaledTemp']);
  assert.equal(blocks[0].temp, null);
});

test('延迟重复次数缺测使后续偏移不可确定', () => {
  assert.throws(() => decodePayload(Buffer.from([0b11100000]), table, ['sensors']), /缺测/);
});

test('描述符循环展开被拒绝', () => {
  const cyclic = { version: 'test', descriptors: { a: { kind: 'sequence', members: ['b'] }, b: { kind: 'sequence', members: ['a'] } } };
  assert.throws(() => decodePayload(Buffer.from([0]), cyclic, ['a']), /循环/);
});

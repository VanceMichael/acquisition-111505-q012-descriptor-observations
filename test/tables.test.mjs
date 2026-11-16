import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TableStore } from '../src/tables.mjs';

async function withStore(context) {
  const directory = await mkdtemp(join(tmpdir(), 'tables-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return new TableStore(directory).initialize();
}

const v1bytes = Buffer.from(JSON.stringify({ version: 'v1', descriptors: { temp: { kind: 'element', bitWidth: 12, scale: 1, reference: -500 } } }));
const v2bytes = Buffer.from(JSON.stringify({ version: 'v2', descriptors: { temp: { kind: 'element', bitWidth: 12, scale: 1, reference: -400 } } }));
const fetched = bytes => ({ bytes, table: JSON.parse(bytes.toString('utf8')) });

test('首次获取按来源留存，之后同内容复用', async context => {
  const store = await withStore(context);
  const first = await store.resolve('v1', fetched(v1bytes));
  assert.equal(first.origin, 'source');
  assert.equal(first.pinned, true);
  const again = await store.resolve('v1', fetched(Buffer.from(v1bytes)));
  assert.equal(again.origin, 'source');
  assert.equal(again.pinned, false);
});

test('来源改版后旧版本公告按留存表解释', async context => {
  const store = await withStore(context);
  await store.resolve('v1', fetched(v1bytes));
  const resolved = await store.resolve('v1', fetched(v2bytes));
  assert.equal(resolved.origin, 'pinned');
  assert.equal(resolved.table.version, 'v1');
  assert.equal(resolved.table.descriptors.temp.reference, -500);
});

test('无留存时版本不一致或获取失败都被拒绝', async context => {
  const store = await withStore(context);
  await assert.rejects(() => store.resolve('v1', fetched(v2bytes)), /不一致/);
  await assert.rejects(() => store.resolve('v1', null, new Error('来源返回 404')), /无法获取/);
});

test('同版本表内容静默变化被拒绝', async context => {
  const store = await withStore(context);
  await store.resolve('v1', fetched(v1bytes));
  const mutated = Buffer.from(JSON.stringify({ version: 'v1', descriptors: { temp: { kind: 'element', bitWidth: 12, scale: 1, reference: -400 } } }));
  await assert.rejects(() => store.resolve('v1', fetched(mutated)), /静默变化/);
});

test('获取失败时留存的表仍可使用', async context => {
  const store = await withStore(context);
  await store.resolve('v1', fetched(v1bytes));
  const resolved = await store.resolve('v1', null, new Error('来源返回 404'));
  assert.equal(resolved.origin, 'pinned');
  assert.equal(resolved.table.version, 'v1');
});

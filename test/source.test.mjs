import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('描述表定义延迟重复而位流保留缺测位型', async context => {
  const { base } = await withSource(context); const table = await (await fetch(base + '/tables/current')).json();
  assert.equal(table.descriptors.sensors.factor, 'sensorCount'); assert.equal(table.descriptors.temp.bitWidth, 12);
  const raw = Buffer.from(await (await fetch(base + '/payload/b1')).arrayBuffer()); assert.equal(raw[0], 1); assert.equal((raw[1] & 0x1f), 0x1f);
});
test('表版本变化和未知描述符不被来源预处理掉', async context => {
  const { base, control } = await withSource(context); await control({ revision: 2, unknown: true });
  const table = await (await fetch(base + '/tables/current')).json(); assert.equal(table.version, 'v2'); assert.equal(table.descriptors.stationBlock.members.at(-1), 'unknown');
});

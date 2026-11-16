import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

async function withServices(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = async () => (await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) })).json();
  const records = async () => (await fetch(`${base}/api/records`)).json();
  const auto = list => list.filter(record => record.source.startsWith('source:'));
  return { base, source, control, collect, records, auto };
}

test('描述符驱动采集落实站点与观测时间归属，缺测保持缺测', async context => {
  const { base, collect, records, auto } = await withServices(context);
  const summary = await collect();
  assert.equal(summary.failed, 0);
  assert.equal(summary.received, 3);
  const [bulletin] = summary.bulletins;
  assert.equal(bulletin.status, 'received');
  assert.equal(bulletin.tableVersion, 'v1');
  const autoRecords = auto(await records());
  assert.equal(autoRecords.length, 3);
  const find = (station, sensor) => autoRecords.find(record => record.identity.station === station && record.identity.sensor === sensor);
  const first = find(1, 0);
  assert.equal(first.identity.tableVersion, 'v1');
  assert.equal(first.versions[0].data.temperature, null);
  assert.equal(first.versions[0].data.humidity, 65);
  assert.equal(first.versions[0].data.observationTime, '2026-11-01T00:00:00Z');
  const second = find(2, 0);
  assert.equal(second.versions[0].data.temperature, 21);
  assert.equal(second.versions[0].data.humidity, 50);
  const third = find(2, 1);
  assert.equal(third.versions[0].data.temperature, 22);
  assert.equal(third.versions[0].data.humidity, 55);
  const again = await collect();
  assert(again.bulletins[0].records.every(record => record.duplicate));
  assert.equal(auto(await records()).reduce((total, record) => total + record.versions.length, 0), 3);
  const manual = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ station: 'hall-a', tableVersion: 'v1', sensor: 0, temperature: null, humidity: 65 }) });
  assert.equal(manual.status, 201);
  const sources = new Set((await records()).map(record => record.source.split(':')[0]));
  assert(sources.has('manual'));
  assert(sources.has('source'));
});

test('描述表改版后旧交付仍按当时的表解释', async context => {
  const { control, collect, records, auto } = await withServices(context);
  await collect();
  await control({ revision: 2 });
  const summary = await collect();
  assert.equal(summary.failed, 0);
  const autoRecords = auto(await records());
  assert.equal(autoRecords.length, 6);
  const find = (station, sensor, tableVersion) => autoRecords.find(record => record.identity.station === station && record.identity.sensor === sensor && record.identity.tableVersion === tableVersion);
  assert.equal(find(2, 0, 'v1').versions[0].data.temperature, 21);
  assert.equal(find(2, 0, 'v2').versions[0].data.temperature, 31);
  assert.equal(find(2, 1, 'v2').versions[0].data.temperature, 32);
  await control({ staleBulletin: true });
  const redelivered = await collect();
  assert.equal(redelivered.failed, 0);
  const [bulletin] = redelivered.bulletins;
  assert.equal(bulletin.table, 'pinned');
  assert.equal(bulletin.tableVersion, 'v1');
  assert(bulletin.records.every(record => record.duplicate));
  const after = auto(await records());
  assert.equal(after.length, 6);
  assert.equal(find(2, 0, 'v1').versions.length, 1);
});

test('未知描述符不输出看似合理的记录，并报告已确认部分', async context => {
  const { control, collect, records } = await withServices(context);
  await control({ unknown: true });
  const summary = await collect();
  assert.equal(summary.received, 0);
  assert.equal(summary.failed, 1);
  const [bulletin] = summary.bulletins;
  assert.equal(bulletin.status, 'failed');
  assert.equal(bulletin.descriptor, 'unknown');
  assert.match(bulletin.error, /未知描述符/);
  const paths = bulletin.confirmed.map(entry => entry.path);
  assert(paths.includes('stationBlock[0].station'));
  assert(paths.includes('stationBlock[0].sensors[0].humidity'));
  assert(!paths.some(path => path.startsWith('stationBlock[1]')));
  const temp = bulletin.confirmed.find(entry => entry.path === 'stationBlock[0].sensors[0].temp');
  assert.equal(temp.missing, true);
  assert.equal(temp.value, null);
  assert.equal((await records()).length, 0);
});

test('截断的交付被拒绝且不写入归档', async context => {
  const { control, collect, records } = await withServices(context);
  await control({ truncated: true });
  const summary = await collect();
  assert.equal(summary.failed, 1);
  assert.match(summary.bulletins[0].error, /截断/);
  assert.equal((await records()).length, 0);
});

test('来源地址无效与不可达分别得到 400 与 502', async context => {
  const { base } = await withServices(context);
  const invalid = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'not-a-url' }) });
  assert.equal(invalid.status, 400);
  const unreachable = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'http://127.0.0.1:1' }) });
  assert.equal(unreachable.status, 502);
});

test('请求体可省略，默认来源来自 SOURCE_URL', async context => {
  const { base, source } = await withServices(context);
  process.env.SOURCE_URL = source;
  context.after(() => { delete process.env.SOURCE_URL; });
  const reply = await fetch(`${base}/api/collect`, { method: 'POST' });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).received, 3);
});

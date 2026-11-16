import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
const directories = [directory];
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = async endpoint => (await fetch(`${endpoint}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) })).json();
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const accepted = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  console.log(JSON.stringify({ 首次采集: await collect(base) }));
  await control({ revision: 2 });
  console.log(JSON.stringify({ 表改版后采集: await collect(base) }));
  await control({ staleBulletin: true });
  console.log(JSON.stringify({ 旧交付重发: await collect(base) }));
  const records = await (await fetch(`${base}/api/records`)).json();
  console.log(JSON.stringify({ 已存记录: records.map(record => ({ source: record.source, identity: record.identity, 版本数: record.versions.length, 最新: record.versions.at(-1).data })) }));
  await control({ staleBulletin: false, unknown: true });
  const isolated = await mkdtemp(join(tmpdir(), 'intake-demo-'));
  directories.push(isolated);
  const other = await createIntake(isolated);
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  try {
    console.log(JSON.stringify({ 未知描述符: await collect(`http://127.0.0.1:${other.address().port}`) }));
  } finally {
    other.closeAllConnections();
    await new Promise(resolve => other.close(resolve));
  }
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
}

import { readFile } from 'node:fs/promises';
import { request, decodeJson } from './transport.mjs';
import { decodePayload, DecodeError } from './decoder.mjs';
import { TableStore } from './tables.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

const PROJECTION = [['temp', 'temperature'], ['humidity', 'humidity']];

function validateBulletin(bulletin) {
  if (!bulletin || typeof bulletin !== 'object' || Array.isArray(bulletin)) throw new Error('公告条目不是对象');
  for (const field of ['id', 'observationTime', 'tableVersion', 'descriptorsHref', 'payloadHref']) {
    if (typeof bulletin[field] !== 'string' || bulletin[field] === '') throw new Error(`公告缺少 ${field}`);
  }
  if (!Array.isArray(bulletin.root) || bulletin.root.length === 0 || bulletin.root.some(root => typeof root !== 'string')) throw new Error('公告 root 描述符列表无效');
}

function blockToRecords(block, bulletin) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('stationBlock 解码结果不是对象');
  if (!Array.isArray(block.sensors)) throw new Error('stationBlock 解码结果缺少 sensors 延迟重复组');
  if (block.station === null || block.station === undefined) throw new Error('站点标识缺测，观测无法归属');
  return block.sensors.map((group, sensor) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('传感器组解码结果不是对象');
    for (const [element] of PROJECTION) if (!Object.hasOwn(group, element)) throw new Error(`传感器组缺少 ${element} 要素，无法按既有业务形状投影`);
    const identity = { station: block.station, tableVersion: bulletin.tableVersion, sensor };
    const data = { station: block.station, tableVersion: bulletin.tableVersion, sensor, observationTime: bulletin.observationTime, bulletin: bulletin.id };
    for (const [element, field] of PROJECTION) data[field] = group[element];
    return { identity, data };
  });
}

async function collectBulletin(archive, tables, base, sourceKey, bulletin) {
  const id = bulletin && typeof bulletin === 'object' && typeof bulletin.id === 'string' ? bulletin.id : null;
  try {
    validateBulletin(bulletin);
    let fetched = null; let fetchError = null;
    try {
      const reply = await request(new URL(bulletin.descriptorsHref, base));
      fetched = { bytes: reply.bytes, table: decodeJson(reply) };
    } catch (error) { fetchError = error; }
    const resolved = await tables.resolve(bulletin.tableVersion, fetched, fetchError);
    const payloadReply = await request(new URL(bulletin.payloadHref, base));
    if (payloadReply.status < 200 || payloadReply.status > 299) throw new Error(`观测负载返回 ${payloadReply.status}`);
    const decoded = decodePayload(payloadReply.bytes, resolved.table, bulletin.root);
    const records = [];
    for (const block of decoded.blocks) {
      for (const record of blockToRecords(block, bulletin)) {
        const receipt = await archive.accept(sourceKey, record.identity, record.data, payloadReply.bytes);
        records.push({ ...receipt, identity: record.identity });
      }
    }
    return { id: bulletin.id, status: 'received', tableVersion: resolved.table.version, table: resolved.origin, observationTime: bulletin.observationTime, records };
  } catch (error) {
    const failure = { id, status: 'failed', error: error.message };
    if (error instanceof DecodeError) {
      if (error.descriptor) failure.descriptor = error.descriptor;
      if (error.path) failure.path = error.path;
      if (error.confirmed) failure.confirmed = error.confirmed;
    }
    return failure;
  }
}

export async function collect(archive, source, directory) {
  const base = new URL(source);
  const tables = await new TableStore(directory).initialize();
  const listing = decodeJson(await request(new URL(configuration.probe, base)));
  if (!Array.isArray(listing)) throw new Error('来源公告列表格式无效');
  const sourceKey = `source:${base.origin}`;
  const bulletins = [];
  for (const item of listing) bulletins.push(await collectBulletin(archive, tables, base, sourceKey, item));
  const received = bulletins.reduce((total, item) => total + (item.records ? item.records.length : 0), 0);
  const failed = bulletins.filter(item => item.status === 'failed').length;
  return { source: base.origin, received, failed, bulletins };
}

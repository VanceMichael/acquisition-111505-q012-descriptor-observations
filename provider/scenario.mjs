export const initialState = () => ({ name: '环境描述符交付', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/bulletins') { json(200, [{ id: 'b1', observationTime: '2026-11-01T00:00:00Z', tableVersion: state.revision === 1 ? 'v1' : 'v2', descriptorsHref: '/tables/current', payloadHref: '/payload/b1', root: ['stationBlock', 'stationBlock'] }]); return true; }
  if (url.pathname === '/tables/current') {
    const table = JSON.parse(await readFile(new URL('../fixtures/tables-v1.json', import.meta.url), 'utf8')); if (state.unknown) table.descriptors.stationBlock.members.push('unknown');
    if (state.revision > 1) { table.version = 'v2'; table.descriptors.temp.reference = -400; }
    json(200, table); return true;
  }
  if (url.pathname === '/payload/b1') { let raw = await readFile(new URL('../fixtures/observations.bin', import.meta.url)); if (state.truncated) raw = raw.subarray(0, -1); bytes(200, raw); return true; }
  return false;
}

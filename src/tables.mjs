import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './archive.mjs';

export class TableStore {
  constructor(directory) {
    this.directory = join(directory, 'tables');
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    return this;
  }
  pathFor(version) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error(`表版本标识无效：${version}`);
    return join(this.directory, `${version}.json`);
  }
  async pinned(version) {
    try {
      return await readFile(this.pathFor(version));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async resolve(declared, fetched, fetchError) {
    if (fetched && fetched.table && fetched.table.version === declared) {
      const existing = await this.pinned(declared);
      if (existing === null) {
        await atomicWrite(this.pathFor(declared), fetched.bytes);
        return { table: fetched.table, origin: 'source', pinned: true };
      }
      if (!existing.equals(fetched.bytes)) throw new Error(`描述表版本 ${declared} 的内容发生静默变化，拒绝按变化后的表解释既有身份`);
      return { table: JSON.parse(existing.toString('utf8')), origin: 'source', pinned: false };
    }
    const existing = await this.pinned(declared);
    if (existing !== null) return { table: JSON.parse(existing.toString('utf8')), origin: 'pinned', pinned: false };
    if (fetched) throw new Error(`来源当前提供表版本 ${fetched.table && typeof fetched.table.version === 'string' ? fetched.table.version : '无效'}，与公告声明的 ${declared} 不一致，且本地无该版本留存`);
    throw new Error(`无法获取表版本 ${declared}${fetchError ? `（${fetchError.message}）` : ''}，且本地无留存`);
  }
}

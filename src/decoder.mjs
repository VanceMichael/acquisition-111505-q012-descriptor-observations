export class DecodeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DecodeError';
    Object.assign(this, details);
  }
}

export class UnknownDescriptorError extends DecodeError {
  constructor(name, path, confirmed) {
    super(`未知描述符 ${name}（${path}）：后续位偏移不可确定，解释依赖已断开`, { descriptor: name, path, confirmed });
    this.name = 'UnknownDescriptorError';
  }
}

const ROOT_SCOPE = Object.freeze({ scaleDelta: 0, referenceDelta: 0 });

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  get remaining() {
    return this.bytes.length * 8 - this.offset;
  }
  read(width) {
    if (this.remaining < width) throw new DecodeError(`位流不足：需要 ${width} 位，剩余 ${Math.max(this.remaining, 0)} 位`);
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      const position = this.offset + index;
      value = value * 2 + ((this.bytes[position >> 3] >> (7 - (position & 7))) & 1);
    }
    this.offset += width;
    return value;
  }
}

function scaled(raw, scale, reference) {
  const shifted = raw + reference;
  return scale >= 0 ? shifted / 10 ** scale : shifted * 10 ** -scale;
}

function decodeElement(name, desc, scope, path, state) {
  const { bitWidth, scale, reference } = desc;
  if (!Number.isInteger(bitWidth) || bitWidth < 1 || bitWidth > 32) throw new DecodeError(`描述符 ${name} 的 bitWidth 无效（${path}）`);
  if (!Number.isInteger(scale)) throw new DecodeError(`描述符 ${name} 的 scale 无效（${path}）`);
  if (!Number.isFinite(reference)) throw new DecodeError(`描述符 ${name} 的 reference 无效（${path}）`);
  if (state.reader.remaining < bitWidth) throw new DecodeError(`位流在 ${path} 处不足：需要 ${bitWidth} 位，剩余 ${state.reader.remaining} 位，交付可能被截断`);
  const raw = state.reader.read(bitWidth);
  const missing = raw === 2 ** bitWidth - 1;
  const effectiveScale = scale + scope.scaleDelta;
  const effectiveReference = reference + scope.referenceDelta;
  const value = missing ? null : scaled(raw, effectiveScale, effectiveReference);
  state.confirmed.push({ path, descriptor: name, raw, missing, scale: effectiveScale, reference: effectiveReference, value });
  return value;
}

function decodeGroup(name, members, scope, path, state) {
  if (!Array.isArray(members) || members.length === 0 || members.some(member => typeof member !== 'string')) throw new DecodeError(`描述符 ${name} 的 members 无效（${path}）`);
  const values = {};
  for (const member of members) {
    if (Object.hasOwn(values, member)) throw new DecodeError(`描述符 ${name} 的成员 ${member} 重复（${path}）`);
    values[member] = decodeDescriptor(member, scope, `${path}.${member}`, state);
  }
  return values;
}

function decodeReplication(name, desc, scope, path, state) {
  if (typeof desc.factor !== 'string') throw new DecodeError(`描述符 ${name} 的 factor 无效（${path}）`);
  if (!Array.isArray(desc.members) || desc.members.length === 0 || desc.members.some(member => typeof member !== 'string')) throw new DecodeError(`描述符 ${name} 的 members 无效（${path}）`);
  const count = decodeDescriptor(desc.factor, scope, `${path}#${desc.factor}`, state);
  if (count === null) throw new DecodeError(`延迟重复次数 ${desc.factor} 缺测（${path}），后续位偏移不可确定`);
  if (!Number.isInteger(count) || count < 0) throw new DecodeError(`延迟重复次数 ${desc.factor} 的值无效（${path}）`);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const group = {};
    for (const member of desc.members) {
      if (Object.hasOwn(group, member)) throw new DecodeError(`描述符 ${name} 的成员 ${member} 重复（${path}）`);
      group[member] = decodeDescriptor(member, scope, `${path}[${index}].${member}`, state);
    }
    items.push(group);
  }
  return items;
}

function decodeDescriptor(name, scope, path, state) {
  const desc = state.table.descriptors[name];
  if (!desc || typeof desc !== 'object') throw new UnknownDescriptorError(name, path, state.confirmed);
  if (state.stack.includes(name)) throw new DecodeError(`描述符 ${name} 循环展开（${path}）`);
  state.stack.push(name);
  try {
    switch (desc.kind) {
      case 'element': return decodeElement(name, desc, scope, path, state);
      case 'sequence': return decodeGroup(name, desc.members, scope, path, state);
      case 'operator': {
        const scaleDelta = desc.scaleDelta === undefined ? 0 : desc.scaleDelta;
        const referenceDelta = desc.referenceDelta === undefined ? 0 : desc.referenceDelta;
        if (!Number.isInteger(scaleDelta) || !Number.isFinite(referenceDelta)) throw new DecodeError(`描述符 ${name} 的增量无效（${path}）`);
        return decodeGroup(name, desc.members, { scaleDelta: scope.scaleDelta + scaleDelta, referenceDelta: scope.referenceDelta + referenceDelta }, path, state);
      }
      case 'replication': return decodeReplication(name, desc, scope, path, state);
      default: throw new DecodeError(`描述符 ${name} 的类别无效（${path}）`);
    }
  } finally {
    state.stack.pop();
  }
}

export function decodePayload(payload, table, roots) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!table || typeof table !== 'object' || typeof table.version !== 'string' || !table.descriptors || typeof table.descriptors !== 'object') throw new DecodeError('描述表缺少 version 或 descriptors');
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== 'string')) throw new DecodeError('根描述符列表无效');
  const reader = new BitReader(bytes);
  const confirmed = [];
  const state = { table, reader, confirmed, stack: [] };
  try {
    const blocks = roots.map((root, index) => decodeDescriptor(root, ROOT_SCOPE, `${root}[${index}]`, state));
    if (reader.remaining >= 8) throw new DecodeError(`位流末尾存在 ${Math.floor(reader.remaining / 8)} 个未解码字节，归属不可确定`);
    if (reader.read(reader.remaining) !== 0) throw new DecodeError('位流末尾填充位不是零');
    return { tableVersion: table.version, blocks, confirmed };
  } catch (error) {
    if (error instanceof DecodeError && !error.confirmed) error.confirmed = confirmed;
    throw error;
  }
}

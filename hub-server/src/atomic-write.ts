import { writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function atomicWrite(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

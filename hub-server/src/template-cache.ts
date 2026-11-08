import { readFileSync, statSync } from 'node:fs';

// Production reads the template once. Development checks metadata on access and
// reloads atomically only after the new template has been read successfully.
export class TemplateCache {
  private html: string;
  private signature: string;
  constructor(readonly file: string, public development = false) {
    this.html = readFileSync(file, 'utf8');
    this.signature = this.stat();
  }
  private stat() {
    const s = statSync(this.file, { bigint: true });
    return [s.mtimeNs, s.ctimeNs, s.size].join(':');
  }
  read() {
    if (this.development) {
      const signature = this.stat();
      if (signature !== this.signature) {
        const html = readFileSync(this.file, 'utf8');
        this.html = html; this.signature = signature;
      }
    }
    return this.html;
  }
}

/**
 * Bulk Load 文本解析。每行一张图纸，格式：ID, 图号, 专业, 标题。
 *
 * - 从 Excel/WPS 复制来的行是制表符分隔：只要一行里有制表符，就只按制表符分，逗号都算内容。
 * - 否则按英文逗号或中文逗号分。
 * - 标题是最后一列：第三个分隔符后面的内容全部归标题，标题里的逗号不会把它截断。
 * - 兼容 CSV 引号写法：字段可以用双引号包起来，里面的双引号写成两个（""）。
 * - 不满 4 列的行跳过，空行忽略。
 */
export interface BulkLoadRow {
  customId: string;
  drawingNo: string;
  discipline: string;
  title: string;
}

export interface BulkLoadResult {
  rows: BulkLoadRow[];
  /** 不满 4 列、被跳过的非空行（原文） */
  skipped: string[];
}

const unquote = (value: string): string => {
  const v = value.trim();
  const m = /^"((?:[^"]|"")*)"$/s.exec(v);
  return m ? m[1].replace(/""/g, '"') : v;
};

/** 把一行分成最多 4 列，第 4 列是剩下的全部内容。 */
export function splitBulkLoadLine(line: string): string[] {
  const text = line.replace(/\r$/, '');
  const isSep = text.includes('\t') ? (c: string) => c === '\t' : (c: string) => c === ',' || c === '，';
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 3) {
    // 跳过字段前的空格（制表符分隔时不跳制表符）
    while (i < text.length && text[i] === ' ') i++;
    if (i >= text.length) {
      if (fields.length > 0 || text.length > 0) fields.push('');
      return fields;
    }
    let value = '';
    if (text[i] === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += text[i++];
      }
      // 引号后面到分隔符之前的内容也算进这一列
      while (i < text.length && !isSep(text[i])) value += text[i++];
    } else {
      while (i < text.length && !isSep(text[i])) value += text[i++];
    }
    fields.push(value.trim());
    if (i >= text.length) return fields; // 没有更多分隔符了
    i++; // 跳过分隔符
  }
  fields.push(unquote(text.slice(i)));
  return fields;
}

export function parseBulkLoadText(input: string): BulkLoadResult {
  const rows: BulkLoadRow[] = [];
  const skipped: string[] = [];
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = splitBulkLoadLine(line);
    if (parts.length < 4) { skipped.push(line); continue; }
    rows.push({ customId: parts[0], drawingNo: parts[1], discipline: parts[2], title: parts[3] });
  }
  return { rows, skipped };
}

// Render the latest acceptance table; never delete or change product/evidence files.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=path.join(root,'docs/acceptance');
const result=JSON.parse(await readFile(path.join(dir,'results.json'),'utf8'));
const counts=result.rows.reduce((acc,row)=>(acc[row.result]++,acc),{PASS:0,FAIL:0,BLOCKED:0});
const keep=new Set(result.rows.map(row=>row.image).filter(Boolean));
for(const name of ['t5-22-manager-isolated-remark.png','t5-34-security-upload-attachment.png'])keep.add(name);
let bytes=0;for(const name of keep)try{bytes+=(await stat(path.join(dir,name))).size;}catch{}
const table=result.rows.map(row=>`| ${row.role} | ${row.label} | ${row.result} | ${row.image ? '[PNG]('+row.image+')' : 'HTTP / runner assertion'} |`).join('\n');
await writeFile(path.join(dir,'SUMMARY.md'),`# 最新验收结果\n\n${counts.PASS} PASS / ${counts.FAIL} FAIL / ${counts.BLOCKED} BLOCKED；${result.rows.length} 项。\n\n截图 ${keep.size} 张，合计 ${(bytes/1024/1024).toFixed(2)} MiB，无损重压缩 PNG。\n\n|角色|路径 / 行为|结果|证据|\n|---|---|---|---|\n${table}\n`);
// Exact list allows git to stage only current-run images, not stale exploratory screenshots.
await writeFile(path.join(dir,'evidence-files.json'),JSON.stringify([...keep],null,2));
console.log(JSON.stringify({counts,screenshots:keep.size,pngBytes:bytes}));

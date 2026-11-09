# PCF 图片存储与历史保留

## 数据格式

- 图片按内容（解码后字节的 sha256）单独存一份：`data/pcf/<项目>/.images/<哈希前两位>/<哈希>.<png|jpeg|webp>`。同一项目里同一张图只存一份，不同图纸共用。
- PCF JSON 和历史快照里只存引用：`{ id, name, mime, hash, width, height }`，不再有 `data` 字段。
- 在线 PCF 页面通过 `GET /pcf/<项目>/<图纸>/images/<哈希>` 取图（权限与页面相同：Bearer、页面 Cookie 或 `X-PCF-Token`），响应头 `Cache-Control: private, max-age=31536000, immutable`。
- 上传或粘贴的新图片仍以 data URL 随 `ops` 提交，服务器保存时落成文件、换成引用；引用一个服务器上没有的哈希会被拒绝（400）。
- 给船厂的离线 HTML、完整副本（HTML/JSON）在导出时把引用重新内嵌成 data URL，文件仍然自包含。导回时先把回传文件里的图片落盘，再按引用比较，所以同一张图不会被判成船东内容被改（ownerTampered）。
- 页面里的 Excel、打印版 Excel、外部版导出和 JSON 导出，会先在浏览器里按哈希取回图片再内嵌。
- 旧格式（内嵌 base64）照常能读：读取时在内存里换成引用（并补齐图片文件），下一次保存时写成新格式；旧快照恢复也可以。

## 一次性迁移

```
# 1. 停 Hub，整份备份 data 目录
# 2. 先试跑，只统计不写
npm run hub:migrate-pcf-images -- --data-dir <数据目录> --dry-run
# 3. 实跑
npm run hub:migrate-pcf-images -- --data-dir <数据目录> --hub-stopped
```

- 扫描 `pcf/<项目>/*.json` 和 `pcf/<项目>/.history/<图纸>/*.json`。只处理含内嵌图片的文件，其余不动。
- 每个要改的文件先原样复制到 `<数据目录>/pcf-image-migration-backup/<时间>/` 下的同一相对路径，再写图片文件，核对“换成引用后再内嵌”与原文件完全一致，最后用临时文件加改名原子替换。文件修改时间保持不变，历史快照的文件名（版本号和时间）不变。
- 可以重跑：第二次运行 `converted` 为 0，不再产生备份。
- 确认无误后，备份目录可以删掉。

## 不做的事

不清理图片文件：不再被任何当前文件或保留的历史快照引用的图片会一直留着（这一轮不做回收）。

## 历史保留规则

按保存时间从新到旧（日期按项目时区）：

1. 最近 50 份一律保留（`PCF_HISTORY_RECENT_LIMIT`）。
2. 30 天以内：每天保留当天最后一份（`PCF_HISTORY_DAILY_DAYS`）。
3. 30 到 180 天：每个 ISO 周（周一开始）保留最后一份（`PCF_HISTORY_WEEKLY_DAYS`）。
4. 180 天以前：每个自然月保留最后一份。

年龄从触发清理的那次保存算起。一周或一个月跨过两个区段时，两边可能各留一份。

## 测速

`node hub-server/test/image-storage-measure.mjs <标签> [仓库目录]`（先 `npm run hub:build`）：20 张 1-3 MB 的图、连续 10 次只改文字的保存，输出保存耗时、JSON 大小、历史大小和在线打开的传输量。

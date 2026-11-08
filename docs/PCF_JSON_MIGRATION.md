# PCF JSON 存储迁移与回滚（架构阶段 2）

## 数据布局与版本

- 当前权威文档：`data/pcf/<projectId>/<drawingId>.json`。
- 历史快照：`data/pcf/<projectId>/.history/<drawingId>/<rev>-<epoch>-<uuid>.json`；编辑段合并及保留策略不变，`.retention.json` 的文件指针同步转换。
- 模板：`pcf/template/PG-PCF-hub.html`，仍是可离线使用的独立 HTML。生产启动读入内存；`hub:dev` 检查文件变更后重新加载。
- 页面：模板 + JSON + 在线 `pahub-context`；磁盘不存每份文档的模板副本。
- `exports/*.html` 发出基线、收到的原始船厂回复 HTML、导入回执、`.pcf-export-key` 不被转换或删除。
- SQLite 仍只存指针和摘要，不存正文/图片。编号 SQL：001 当前完整结构；002 更新 PCF JSON 指针并将 `PRAGMA user_version` 设为 2。启动自动应用 001，**不自动运行 002 或转换文件**。

## 停服迁移

1. 停止使用目标数据目录的 Hub。工具不能自动证明 Hub 已停止；`--hub-stopped` 是操作者确认，不是自动停服指令。
2. 复制整个 `data/` 到新的目录，包含 `papc.db`、存在的 `papc.db-wal`、全部 PCF/历史/往来/密钥。数据库应直接位于数据根目录，非标准位置可用 `--db-path` 指定根目录内的文件。
3. 首先只在副本上校验（不写目标目录，不创建备份，也不修改 `user_version`；SQLite 验证使用私有临时 DB/WAL 副本）：

   ```sh
   npm run hub:migrate-pcf-json -- --data-dir <数据副本> --dry-run
   ```

4. 检查文档/快照数、JSON 字节统计。实跑同一副本：

   ```sh
   npm run hub:migrate-pcf-json -- --data-dir <数据副本> --hub-stopped
   ```

   每份 HTML 提取 `pcf-data`，保持 documentId/rev/实体时钟/回执和所有字段不变；验证 JSON 深度一致及当前模板渲染后可解析为相同数据；历史文件名 rev 与数据 rev 也校验。索引比文件新、损坏/缺失文档、已有冲突 JSON 目标都会在改写前报错。

5. 脚本先将整个数据目录备份到同级 `data-backup-before-pcf-json-<时间>-<uuid>`；在私有 staging 目录转换，随后将旧 `pcf/` 整体改名为数据目录内的 `pcf-html-backup-<时间>-<uuid>`，安装 JSON 目录，并在同一 SQLite 事务更新 `pcf_index.file_path`/版本号。旧目录绝不删除。
6. 常规失败还原目录并回滚事务；目录安装时进程中断会保留 `.pcf-json-migration.json`，重新实跑可根据数据库版本回滚未提交安装或确认已提交状态。存在中断记录时 dry-run 拒绝继续，要求先恢复。请仍保留完整备份，文件和数据库不是跨资源原子事务。
7. 用临时端口运行新 Hub 验证文档打开、编辑、导出、完整副本导回、Send All、船厂回复；验证结束关闭临时服务。确认之后的正式数据切换/部署由操作者安排，不在本次自动执行。

## 两种离线副本

- **完整副本**：自用，保留流转记录、审批历史、删除记录和其它业务字段，移除 Hub 内部实体时钟、幂等回执、clientId/IP。Download HTML copy 与 Export JSON 使用完整副本；服务器保存导出记录和 HTML 基线。
- **外发版**：对第三方仍用明确白名单；船厂版 `mode: builder` 锁定 Owner，Send All 与船厂回复导入规则不变。
- 完整副本带 `mode: complete` 的 export 元数据；导回以已保存基线/离线数据/当前服务器三方合并。不要删除或替换 documentId/exportId。相同字段双方改动须选择，服务器新增业务历史不能被旧副本整份清空。无有效基线的旧 HTML/JSON 不能当作完整副本安全导回，应先明确处理范围。未带 export 元数据的普通 JSON 仍保留旧的显式整文档替换确认流程，不具有三方合并保护；带 export 的副本不能经 PUT document 绕过合并。
- HTML 来信仅解析 JSON，服务器不执行其中脚本。不要直接打开不可信回复执行脚本。

### 完整副本 API

沿用可选 Bearer/限图凭据；未配置认证时匿名可用：

- `GET /api/pcf/:p/:d/download`：建立完整 HTML 基线并下载；`?format=json` 下载带同一类完整副本元数据的 JSON。此 GET 会创建导出记录/基线，不是只读备份查询。
- `POST .../exports`：`{mode:"complete",clientId,clientName}` 建立完整基线；省略 mode 或 `mode:"builder"` 仍是船厂版。
- `GET .../exports/:exportId/download?format=json`：下载该完整基线 JSON；普通 download 仍下载保存的 HTML。
- `POST .../imports`：`{step:"preview",html}` 或 `{step:"preview",json}` 自动按 `export.mode` 区分 complete/builder；apply 携同一数据、previewToken、UUID batchId 和冲突 choices。完整副本 choices 使用 local/server/merge（以预览 allowed 为准），重复导回需显式允许，作废/未知基线拒绝。
- 完整副本导回不触发船厂回复专用的 Reviewing 状态推进；作为文档修改保存、回写 PCF 摘要并通知在线页面。

## 导出项目完整 HTML ZIP

```sh
npm run hub:export-pcf -- --project <项目ID> --data-dir <数据目录> --output <新ZIP路径> --hub-stopped
```

必须停服，因为 CLI 会记录每份文档的完整副本基线。ZIP 使用稳定图纸 ID 文件名，`manifest.json` 记录图号、documentId 对应导出 ID/rev 和无 PCF 跳过项。已有输出路径拒绝覆盖；打包失败回滚本批导出记录和基线文件。不自动创建缺失 PCF。

该 ZIP 适合文档级离线备份、重新生成可离线打开的 HTML、通过完整副本导回做文档级恢复。它**不是整个部署备份**：不含数据库、全部审计、幂等回执、签名密钥或原始船厂附件。基线在服务器数据目录，导回需保留对应目录/密钥。

## 回滚

- 整体回退：停止新 Hub，保存切换后的数据，恢复迁移前完整 `data` 备份，再部署旧版本。不要把旧 SQLite 与新 JSON 目录混用。
- `pcf-html-backup-*` 是原始 HTML 目录保留件，需搭配迁移前数据库；只改目录名而不恢复索引/版本不是完整回滚。
- 新版本随时可用 `hub:export-pcf` 从 JSON 生成完整 HTML，但它会移除 Hub 内部字段，只能作为业务文档恢复，不保证旧服务的协同时钟/回执兼容。
- 模板升级：JSON 文档不需要 `hub:upgrade-pcf` 批量改写；替换当前模板并重启生产进程。旧命令仅供未迁移 HTML 的历史维护。

## 2026-11-08 本次副本预演

计划基准为 394 份文档/220 份快照；本次工作区 `data/` 实际为 **6 份文档/8 份快照**（共 29 个文件）。未访问其他服务或服务器查找数据。

- 创建副本前记录所有 29 文件 SHA-256，副本与源完全一致。
- 副本 dry-run/实跑：6 文档、8 快照、6 索引记录，2 份原往来 HTML 保留。
- 文档与快照合计：5,492,258 字节 HTML → 320,614 字节 JSON（减少约 94.16%）。
- `user_version`：0 → 001 基线 → 002 JSON 转换；旧项目 snapshots 表按既有流程先创建数据库备份后退役，仅在副本执行。
- 在临时端口 58944 验证全部 6 文档打开、编辑、船厂版导出，6/6；服务已关闭。
- 对迁移副本执行 `hub:export-pcf`：6 份完整 HTML、0 跳过、ZIP 1,480,403 字节（含 manifest 与导出基线记录）。
- 6/6 完整 ZIP HTML 离线 DOM 打开无脚本错误；再经临时端口 52860 对全部 6 份做离线改标题后导回，approvalHistory/circulation 与导回前完全一致；服务已关闭。
- 实跑后原 `data/` 29 文件 SHA-256 全部不变。

**未满足的现场验收**：394/220 数据集不在本工作区，需要操作者提供其完整副本后，按相同步骤补验。不能以当前 6/8 结果冒充 394/220 验收。

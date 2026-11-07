# PAhub 第 2 期：Node 24 + SQLite + PCF 托管

一个 Node 24 进程、一个 HTTP 端口托管原 PAPC 前端及 API，不需要 Cloudflare 账号、Worker 或 D1 服务。生产运行时无第三方服务器依赖包；数据库使用 Node 内置 node:sqlite，不使用 better-sqlite3。

已支持每张图一份权威 PCF HTML、细粒度 ops 保存、实体级冲突、历史恢复及意见摘要回写 PAPC。点图名即可在新标签页编辑。原 PCF v1.9 源文件保留不动，新增 pcf/template/PG-PCF-hub.html 同时支持托管和独立离线模式。SSE、在线/软锁、完整冲突对比、邮件三方合并、systemd 和备份自动化属于后续期。原 worker/ 保留，npm run build 及原 Wrangler 部署方式仍可使用。

PCF 路由、ops 协议、凭据及恢复边界见 [PCF 托管协议](../docs/PCF_HOSTED.md)。

## Windows 安装和启动

安装 Node.js 24.x LTS（含 npm），在 PowerShell 中运行：

~~~powershell
Set-Location C:\Users\Administrator\AgentDock\PAhub
node --version
npm ci
npm run hub:build
npm run hub:start
~~~

浏览器访问 http://localhost:8080，局域网访问 http://服务器IP:8080。必要时由管理员开放 Windows 防火墙的 TCP 8080；服务固定监听 0.0.0.0。Ctrl+C 停止。

首次启动会创建空库，不自动导入种子数据。如需测试，先构建、在首次启动前导入：

~~~powershell
node hub-server/scripts/import-d1.ts worker/sql/seed-test-data.sql
npm run hub:start
~~~

修改端口及数据库路径：

~~~powershell
$env:PORT = '8081'
$env:PAPC_DB_PATH = 'data/papc-other.db'
npm run hub:start
~~~

## Ubuntu 安装和启动

先安装 Node.js 24.x 和 npm（可使用 Node 官方发行包或现有的 Node 版本管理工具）；不要直接假设 Ubuntu 仓库的 nodejs 包是 24。示例采用已安装的 nvm：

~~~bash
nvm install 24
nvm use 24
node --version
cd /opt/PAhub
npm ci
npm run hub:build
npm run hub:start
~~~

无需安装 SQLite 开发库或本地编译数据库模块。服务账号需要对数据目录具有读写权限。自定义持久化目录可使用：

~~~bash
PORT=8080 PAHUB_DATA_DIR=/srv/pahub-data npm run hub:start
~~~

Ubuntu 的 systemd、Docker、定时备份和 HTTPS 属于后续期；本期只提供手动启动说明。

## 构建和开发

- npm run hub:build：严格检查 hub TypeScript，再构建前端 dist/ 和 hub-server/dist/。esbuild 直接打包 worker/src/index.ts；.html 使用 text loader，服务器不重写 Worker 业务逻辑。
- npm run hub:start：运行 hub-server/dist/server.mjs，仅一个 Node 进程。
- npm run hub:dev：同一 Node 进程及同一 HTTP/HMR 端口提供 Vite 前端热更新和 Worker/宿主自动重建。修改 SQL 文件后需重新运行 hub:build 或重启 dev。
- npm run hub:test：执行 D1、原 PAPC 端到端、PCF API 并发/回写/历史/凭据及 jsdom 模板测试。需先构建前端；测试使用系统临时目录，不修改生产 data/，临时产物路径会打印出来以供检查。

hub 模式强制 VITE_DATA_API_BASE_URL=/api、VITE_DATA_API_FALLBACK=false，避免 API 出错后回退到云存储；普通 npm run build 的配置不变。前端仓库类同时兼容相对 /api 和原绝对 Worker URL。

路由：/api/pcf/* 由 PCF 宿主处理，/pcf/:projectId/:drawingId 返回托管 HTML（必要时自动创建）；其余 /api 及 /api/* 去掉 /api 前缀后调用原 Worker。其它路径提供前端静态文件，无扩展名的未知路径回退 index.html，缺失静态资源返回 404。管理员页面为 /api/admin，宿主只重写返回 HTML 中的 /admin/api、/admin/auth 地址，使其使用 /api/admin/...。

## 数据目录和环境变量

默认数据目录 data/，数据库 data/papc.db，PCF data/pcf/<projectId>/<drawingId>.html，旧版本 data/pcf/<projectId>/.history/<drawingId>/<rev>-<时间>-<uuid>.html。路径相对于仓库根目录解析，不依赖启动时的当前目录；绝对路径也可。SQLite 开启 foreign_keys、WAL、5 秒 busy_timeout。运行中可能出现 papc.db-wal、papc.db-shm；备份时应先停止服务再复制整个数据目录（数据库和 HTML 必须一起备份），不能只复制运行中的主库文件。显式配置外部数据库路径时也需纳入备份。默认 data/ 和所有构建 dist/ 已被 Git 忽略；自定义目录请放仓库外。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| PORT | 8080 | HTTP 端口，监听 0.0.0.0；0 可供自动测试分配临时端口 |
| PAHUB_DATA_DIR | data | PCF 数据目录，默认数据库也放在此目录 |
| PAPC_DB_PATH | <PAHUB_DATA_DIR>/papc.db | 可选独立 SQLite 文件路径 |
| PAPC_DIST_DIR | dist | 前端静态资源目录 |
| MAX_BODY_BYTES | 33554432 | API 请求体上限，默认 32 MiB |
| API_TOKEN | 未设置 | 原 Worker Bearer token；为空则不校验 |
| ADMIN_PASSWORD | papc-admin-2026 | 原 Worker 管理密码；启动前建议设置非默认 ASCII 密码 |
| ALLOW_CORS_ORIGIN | * | 原 Worker CORS 来源；同源访问不依赖它 |
| VITE_DATA_API_TOKEN | 未设置 | 可选前端 Bearer token，构建时写入客户端 |

环境变量来自进程环境；hub 不自动读取 .env。Vite 按原机制读取前端 .env 文件。hub 不加载 worker/wrangler.toml 中的生产 token。

若启用 API_TOKEN，前端必须在构建时配置相同 VITE_DATA_API_TOKEN，然后重建。它会公开在浏览器资源中，仅保留原认证行为，不能充当用户登录/保密机制。管理员仍使用原 Worker 的独立认证；其 token 算法及权限未增强。不要直接把本期服务暴露到公网。

PCF API 接受同样的 Bearer token，也接受限定单张图、12 小时有效的签名 X-PCF-Token。页面有鉴权检查，不会通过公开 HTML 泄漏全局 API_TOKEN：PAPC 链接先用现有 Bearer 建立该图的 HttpOnly 会话 cookie；直接访问则提示输入共享凭据。页面注入的是限图凭据，下载/另存 HTML 会移除托管上下文，回到独立模式。匿名 clientId/昵称用于追溯，不是个人登录或授权。局域网 HTTP 无传输加密，公网使用前需另行加固。

~~~powershell
$env:API_TOKEN = 'your-lan-token'
$env:VITE_DATA_API_TOKEN = 'your-lan-token'
$env:ADMIN_PASSWORD = 'your-admin-password'
npm run hub:build
npm run hub:start
~~~

## Schema 初始化顺序和依据

判断依据是当前 Worker 源码，不是已过时的 worker/README.md：

1. getProjectList/getSettings/getProjectDetail/getReviewTracker 读取四个 api_* 视图。
2. DRAWING_UPSERT_SQL、saveProjectData、PATCH 路由写 projects/drawings/drawing_assignees/drawing_status_history/drawing_remarks/project_settings/discipline_defaults/discipline_default_assignees/reviewers/review_tracker。
3. writeJournal 和 /admin API 需要 audit_log，包括 project_id 及时间索引；快照路由需要 snapshots。

初始化在一个 SAVEPOINT 事务内执行，重复启动不会清空业务数据：

1. 检查已有主要表的归一化结构；发现旧 JSON 列 schema 时明确报错，而不猜测转换。
2. 用 PRAGMA table_info 检查已有 audit_log.project_id、drawings._deleted、review_tracker._deleted，缺少才 ALTER。此步骤在创建索引/视图前执行。
3. 执行 init-local.sql 的基础表部分（已包含 audit_log、snapshots 及索引）。
4. 执行 audit-journal.sql 的索引部分；它的无条件 ALTER 已由第 2 步幂等处理，不直接重复执行。
5. 幂等执行 snapshot-table.sql。
6. 执行 init-local.sql 中四个兼容视图部分。
7. 幂等创建 pcf_index/pcf_changes 及图纸变更索引，然后试读视图并检查外键完整性。PCF schema 由 hub-server/src/pcf-schema.ts 管理，不改原 Worker 表结构。

init-local.sql 是当前完整归一化 schema，且 conf_json 包含 projectSummary。compat-views-d1.sql 面向同一表族，但缺少该较新的字段，因此不覆盖 init-local 视图。read-model.sql 是 projects.project_json/conf_json、review_tracker.data_json 的历史模型；compat-views-from-normalized.sql 使用 settings/project_configs/drawing_logs/remarks 等另一套结构；admin-init.sql 是包含非幂等 ALTER 的历史增量脚本。不能把所有 SQL 无差别串行执行。seed-test-data.sql 只用于显式测试，不属于启动迁移。

构建会将这三份所需 SQL 复制到 hub-server/dist/sql/，运行时无需 Wrangler。

## D1 兼容范围

已 grep Worker 实际调用：prepare、bind、first、all、run、batch；未发现 raw、exec 调用。适配器覆盖上述六项，并补齐要求中的 raw、exec：

- bind 返回独立绑定语句，可复用原 prepared statement；接受字符串、有限数字、null、字节数组、ArrayBuffer/视图，拒绝 undefined、布尔值和普通对象（Worker 已将布尔值归一化为 0/1）。
- first 返回一行或 null，可选列名；all/run 返回 { results, success, meta }，含 changes、last_row_id、duration、changed_db、size_after、rows_read、rows_written。
- raw 支持列序数组和 columnNames；BLOB 读出为 D1 风格的字节数组。
- batch 按顺序执行，SAVEPOINT 内同步完成；任一语句失败，整批回滚。也兼容离线 JSON 整体导入时的外层事务。
- exec 执行多语句 SQL，返回 count 和 duration；计数忽略注释和引用的分号，并支持触发器块。

差异：没有 Cloudflare 地域/副本/会话元数据；duration 是本地执行耗时；rows_read 仅统计返回行数（不是 SQLite 扫描行数），rows_written 基于 total_changes（包括触发器/级联）；底层 SQL 异常沿用 node:sqlite 文本，而非完整 D1 错误包装；SQLite 版本随 Node 24 发行版而变化。整数采用 JS number 的安全范围，和本项目文本 UUID/小整数 schema 匹配。SQLite 同步执行会占用主事件循环，不用于高并发大型查询。

## 从 D1 迁移

先 npm run hub:build，然后选择一种来源。迁移脚本拒绝覆盖任何已有目标库（或其 WAL/SHM），先在目标目录内的临时库中导入、检查 schema/外键/integrity_check，通过后才写出新库。失败不会发布半成品库。输入 SQL 必须是可信导出文件。

### A. Wrangler SQL 导出

在仍能访问源 D1 的环境中导出（远端命令只用于获取数据，不在本期测试中调用）：

~~~bash
npx wrangler d1 export papc-review-db-final --remote --config worker/wrangler.toml --output papc-export.sql
node hub-server/scripts/import-d1.ts papc-export.sql --db data/papc-imported.db
~~~

支持带 CREATE TABLE 的完整 SQL dump（包括 BEGIN/COMMIT），也支持基于现行 schema 的数据-only SQL/seed。完整 dump 原有表数据（包括 snapshots/audit_log）会保留，之后补齐当前 schema 和视图。历史不同 schema 的 SQL 导出会被拒绝，请改用 JSON 方式。

### B. 原 Worker 的管理员 JSON 导出

在原 /admin 管理界面使用“整库导出”，或先 POST /admin/auth 获取管理员 token，再 GET /admin/api/export。

格式根据 Worker 代码确定：

~~~json
{
  "exportedAt": "2026-11-07T00:00:00.000Z",
  "projectCount": 1,
  "projects": [
    { "project": { "id": "project-id", "name": "Project", "drawings": [], "conf": {} }, "reviewTracker": {} }
  ]
}
~~~

~~~bash
node hub-server/scripts/import-d1.ts papc_db_export.json --db data/papc-imported.db
~~~

JSON 导入复用 Worker 自己的 /admin/api/import 处理函数，外面加整体 SQLite 事务，保留其归一化规则。入口校验项目数、项目/图纸 ID 和基本结构，避免 Worker 跳过坏条目而静默成功。

重要限制：原 /admin/api/export 不包含 snapshots、旧 audit_log 历史或独立的无项目全局设置；JSON 因而无法迁移这些数据（导入会生成新 IMPORT 日志）。需完整历史请使用 SQL。原 init-local 视图将 logs 固定为 []，当前 Worker 也不持久化该 drawing.logs 字段；这是已有 Worker 行为，本期不另行重写。

已有库要迁移时，请使用全新 --db 路径。核对成功后停止服务，将 PAPC_DB_PATH 指向新库再启动；旧库完整保留，不必删除或覆盖。第一次默认部署可直接省略 --db，目标为 data/papc.db。导入脚本默认路径仍为 data/papc.db；自定义 PAHUB_DATA_DIR 时请显式传 --db <数据目录>/papc.db。

## 验证

~~~bash
npm run hub:build
npm run hub:test
node hub-server/scripts/import-d1.ts worker/sql/seed-test-data.sql --db data/papc-smoke.db
~~~

以 PAPC_DB_PATH=data/papc-smoke.db 启动后，可访问 /api/health、/api/settings、/api/projects、/。项目完整读取沿用 POST /api/projects/:id（不是 GET）；图纸保存沿用 PUT 全量或 PATCH 增量；快照沿用 POST/GET /api/projects/:id/snapshots。

自动测试直接使用前端 CloudflareApiRepository 的 loadProject/saveDelta/saveProject/createSnapshot/loadSnapshots 方法，验证同源 /api、落库、状态日志、快照、服务重启持久化、API_TOKEN、管理员地址改写、静态页/资源/SPA/HEAD、SQL/JSON 导入、坏输入不发布、拒绝覆盖及 schema 幂等迁移。D1 单元测试覆盖返回结构、BLOB、列读取、raw、批量失败回滚和 exec。

在当前 Windows Codex 沙箱中，esbuild 会因父目录探测权限报 Access is denied；需允许构建/测试命令在正常权限下运行。普通 Windows/Ubuntu 环境不需要此 Codex 专用授权。

## 已知范围外事项

npm install 报告 22 个依赖漏洞（1 low、3 moderate、18 high），本期按要求不自动升级。前端构建有现存 Recharts 重导出/分块循环依赖警告。报表 Logo 和部分 PDF 导出脚本仍使用原第三方 CDN；核心 PAPC 数据 API 已同源，不再依赖 Cloudflare，但本期不承诺所有可选报表资源完全离线。

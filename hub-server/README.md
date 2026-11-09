# PAhub 运行说明

需要 Node.js 24.x。npm ci 后执行 npm run hub:build，npm run hub:start 启动；npm run hub:dev 提供同源开发模式。

服务器只读取进程环境：PORT（默认 8080）、PAHUB_DATA_DIR（默认仓库 data）、PAPC_DB_PATH（默认数据目录/papc.db）、PAPC_DIST_DIR（默认 dist）、MAX_BODY_BYTES（默认 32 MiB）、API_TOKEN、ADMIN_PASSWORD、PAHUB_BASIC_AUTH、ALLOW_CORS_ORIGIN。不自动加载 .env；Vite 在构建时读取 VITE_DATA_API_TOKEN。管理员身份由服务端 ADMIN_PASSWORD 校验（POST /api/session，12 小时会话 cookie）；未设置时所有人视为管理员。

认证均为可选开关，未设置时不做任何校验：API_TOKEN 为共享 Bearer 凭据；PAHUB_BASIC_AUTH（`<用户名>:<密码>`）开启后所有 HTTP 请求（含静态资源和 SSE）都要先通过 Basic Auth，适合经 frp tcp 暴露公网时使用，详见根目录 README。ADMIN_PASSWORD 没有内置默认值。设置后：`POST /api/session` 用常量时间比较校验密码并发 12 小时 httpOnly/SameSite=Strict 会话 cookie（失败按客户端地址限速），所有管理员写接口（项目 PATCH、Tracker 修改、图纸状态、Bulk、Builder 回复导入、PCF JSON 替换与应用回复、Send All 打包等）要求该会话，未授权返回 403；`/api/admin` 与管理后台也用它登录。未设置 ADMIN_PASSWORD 时所有人视为管理员（本地开发便利，启动日志告警）。API_TOKEN 仍用于机器调用并视为管理员。管理后台的 SQL 控制台只用于查询，每次执行都使用只读连接，写入、DDL 和 ATTACH 都会被拒绝。

前端 /api 使用 HubApiRepository；所有 API 由 hub-server 原生路由表注册，统一 JSON 解析、{error} 错误格式、请求日志和可选鉴权。服务器直接使用内置 SQLite 与规范化表，没有 Worker 或 D1Adapter 运行依赖；全部服务端源码通过 TypeScript strict 检查。同步 SQLite 执行会占用单进程事件循环，不适合高并发大查询；跨进程编辑、任务队列不在当前范围。

POST /api/pcf/:projectId/exports/batch，body 为 {drawingIds,batchId}（UUID）。鉴权与 PCF 写接口一致。先验证整批归属；无 PCF 跳过；当前服务器 rev 导出，每图一条签名基线。批次与 manifest 持久化，同 batchId 同图纸列表复用 exportId；不同列表返回 409。单张或 ZIP 失败回滚本批记录与基线文件。成功返回 application/zip，RFC 5987 中文附件名，manifest.csv 带 BOM。Send All 仅在状态保存与回读成功后调用，打包失败不回滚状态。

npm run hub:test 保留所有原有测试并增加 Send All 覆盖。旧数据迁移见 [一次性迁移说明](../docs/d1-migration.md)，PCF 使用见 [操作手册](../MANUAL.md)。备份应停止 Hub 并复制完整数据目录，包含 .pcf-export-key。核心数据 API 同源；部分可选报表资源仍来自第三方 CDN，不承诺全部报表离线。

## JSON 存储维护

PCF 文档与历史直接读写 JSON；模板启动时缓存，`hub:dev` 下按文件变更重新加载。Hub 在打开数据库和监听端口前检测旧 HTML/混合存储，自动复用 `hub:migrate-pcf-json` 迁移，成功后用 `PRAGMA user_version=2` 记录完成。已转换且没有残留 HTML 的目录再次启动不重复迁移或备份。

自动迁移前备份 PCF 目录及数据库（含存在的 WAL/SHM）到 `data/backups/before-pcf-json-<时间>-<uuid>/`；自定义数据目录和外置 `PAPC_DB_PATH` 同样适用。私有 staging 校验完成后才安装目录并提交索引；失败保留原文件，日志明确显示原因和 HTML fallback。有效旧 PCF 仍能打开、编辑、保存，历史 HTML 仍可读取/恢复；运行期间出现的旧文件也可按需回退读取。失败后修正原因并重启会重试；不执行收到的 HTML 脚本。

`npm run hub:migrate-pcf-json -- --data-dir <副本> --dry-run` 校验；`--hub-stopped` 实跑并自动备份。数据库必须直接位于数据根目录以保证整体备份包含 DB/WAL。

`npm run hub:export-pcf -- --project <ID> --data-dir <目录> --output <新ZIP> --hub-stopped` 导出完整 HTML 副本项目 ZIP，基线留在 data/ 中，完整 data 备份仍必需。细节见 [迁移说明](../docs/PCF_JSON_MIGRATION.md)。小改动可用 `node hub-server/scripts/test-related.mjs hub-server/test/<name>.test.ts` 只执行相关测试；全量构建/测试只在阶段完成时运行。

## 阶段 3 兼容性

- 启动时对结构版本 1/2 幂等删除旧 api_* 兼容视图；结构初始化本身不推进 user_version，PCF 自动迁移由前述启动转换流程负责。001 历史迁移保持原文，仅测试用 legacy-views.sql 验证旧读模型。
- 新旧实现对比可复跑 `node hub-server/scripts/test-parity.mjs`，从 git 的 c39a8f5 提取旧 Worker 到临时目录，6 项对比均执行，不依赖现存 worker/。
- 项目密码错误改为 JSON 后，HubApiRepository 仍提取 PASSWORD_REQUIRED / INVALID_PASSWORD 保持提示。PCF 的 API_TOKEN 输入页面仍保留为 HTML 认证挑战，不是 API 错误。

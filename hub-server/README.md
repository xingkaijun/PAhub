# PAhub 运行说明

需要 Node.js 24.x。npm ci 后执行 npm run hub:build，npm run hub:start 启动；npm run hub:dev 提供同源开发模式。

服务器只读取进程环境：PORT（默认 8080）、PAHUB_DATA_DIR（默认仓库 data）、PAPC_DB_PATH（默认数据目录/papc.db）、PAPC_DIST_DIR（默认 dist）、MAX_BODY_BYTES（默认 32 MiB）、API_TOKEN、ADMIN_PASSWORD、PAHUB_BASIC_AUTH、ALLOW_CORS_ORIGIN。不自动加载 .env；Vite 在构建时读取 VITE_DATA_API_TOKEN 与 VITE_EDIT_PASSWORD。

认证均为可选开关，未设置时不做任何校验：API_TOKEN 为共享 Bearer 凭据；PAHUB_BASIC_AUTH（`<用户名>:<密码>`）开启后所有 HTTP 请求（含静态资源和 SSE）都要先通过 Basic Auth，适合经 frp tcp 暴露公网时使用，详见根目录 README。ADMIN_PASSWORD 没有默认值：未设置时 `/api/admin` 管理后台整体不可用，也无法忽略被修改的 Owner 只读内容；设置后才可登录。管理后台的 SQL 控制台只用于查询，每次执行都使用只读连接，写入、DDL 和 ATTACH 都会被拒绝。

前端 /api 使用 HubApiRepository；worker/src 与 worker/sql 随 Hub 打包。服务器使用内置 SQLite 与 D1Adapter 兼容现有业务 API，没有旧独立部署入口。同步 SQLite 执行会占用单进程事件循环，不适合高并发大查询；跨进程编辑、任务队列不在当前范围。

POST /api/pcf/:projectId/exports/batch，body 为 {drawingIds,batchId}（UUID）。鉴权与 PCF 写接口一致。先验证整批归属；无 PCF 跳过；当前服务器 rev 导出，每图一条签名基线。批次与 manifest 持久化，同 batchId 同图纸列表复用 exportId；不同列表返回 409。单张或 ZIP 失败回滚本批记录与基线文件。成功返回 application/zip，RFC 5987 中文附件名，manifest.csv 带 BOM。Send All 仅在状态保存与回读成功后调用，打包失败不回滚状态。

npm run hub:test 保留所有原有测试并增加 Send All 覆盖。旧数据迁移见 [一次性迁移说明](../docs/d1-migration.md)，PCF 使用见 [操作手册](../MANUAL.md)。备份应停止 Hub 并复制完整数据目录，包含 .pcf-export-key。核心数据 API 同源；部分可选报表资源仍来自第三方 CDN，不承诺全部报表离线。

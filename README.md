# PAhub

单 Node.js 24 进程、同源 HTTP 服务：PAPC 图纸工作流、Review Tracker、PCF 在线协作编辑及船厂回复三方合并。SQLite 使用 Node 内置 node:sqlite，PCF 权威正文保存在 HTML 文件中。

## 快速开始

~~~powershell
npm ci
npm run hub:build
$env:ADMIN_PASSWORD = '<设置强密码>'
$env:API_TOKEN = '<设置共享凭据>'
$env:PAHUB_DATA_DIR = '<数据目录>'
npm run hub:start
~~~

默认 http://localhost:8080。服务端读取进程环境，不自动加载 .env。若启用 API_TOKEN，在前端 .env.local 配置相同的 VITE_DATA_API_TOKEN，再重新构建。共享 token 的浏览器可见性与局域网 HTTP 风险应按部署环境评估。

## 主要功能

图纸列表与 PCF 认可状态同步；APR 手动覆盖与旧记录兼容；Send All 保存并回读后自动下载船厂版 ZIP，持久幂等批次及失败重下载；PCF 细粒度编辑、SSE、冲突与离线恢复；单张导出、Owner 锁定、HMAC、船厂 HTML 预览及三方合并；快照与审计。

## 开发与验证

npm run hub:dev 启动同源开发模式；npm run hub:build 构建前端与服务端；npm run hub:test 执行 D1 适配、集成、PCF、实时、船厂往来和 Send All 测试。测试使用临时端口和临时数据目录。

worker/src 与 worker/sql 是由 Hub 打包执行的现有业务 API 和 SQL；不是独立部署目标。生产数据与日志不应提交。完整备份应含数据目录及 PCF 导出签名密钥。

使用手册：[MANUAL.md](MANUAL.md)。运行配置：[hub-server/README.md](hub-server/README.md)。旧数据一次性迁移：[docs/d1-migration.md](docs/d1-migration.md)。

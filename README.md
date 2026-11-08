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

## 经 frp 暴露到公网

匿名部署默认不做认证。公网暴露时用下面任意一种方式加一层 Basic Auth；两种方式互斥，只需要选一种。

- **frp http 类型代理**：直接在 frpc 配置里加凭据，不改 PAhub：

  ~~~toml
  [[proxies]]
  name = "pahub"
  type = "http"
  localPort = 8080
  customDomains = ["pahub.example.com"]
  httpUser = "pahub"
  httpPassword = "<强密码>"
  ~~~

  旧版 ini 配置中这两个字段名为 `http_user` / `http_pwd`。
- **frp tcp 类型代理**：frp 没有这个选项，改为设置服务端环境变量 `PAHUB_BASIC_AUTH=<用户名>:<密码>`（例如 `pahub:<强密码>`）。设置后，静态资源、API 和 SSE 所有请求都要先通过 Basic Auth，未通过返回 401 和 `WWW-Authenticate`；留空或未设置时完全不启用，行为与原来一致。

使用 Basic Auth 时，`API_TOKEN` 与构建前的 `VITE_DATA_API_TOKEN` 都必须留空：前端配置 token 后会发送 `Authorization: Bearer …`，该请求头会顶掉浏览器自动附加的 Basic 凭据，导致请求被拒。Basic Auth 的密码是明文传输，公网使用时应再在 frps 前面加一层 HTTPS（Caddy 或 nginx）。

## 主要功能

图纸列表与 PCF 认可状态同步；APR 手动覆盖与旧记录兼容；Send All 保存并回读后自动下载船厂版 ZIP，持久幂等批次及失败重下载；PCF 细粒度编辑、SSE、冲突与离线恢复；单张导出、Owner 锁定、HMAC、船厂 HTML 预览及三方合并；快照与审计。

## 开发与验证

npm run hub:dev 启动同源开发模式；npm run hub:build 构建前端与服务端；npm run hub:test 执行 D1 适配、集成、PCF、实时、船厂往来和 Send All 测试。测试使用临时端口和临时数据目录。

worker/src 与 worker/sql 是由 Hub 打包执行的现有业务 API 和 SQL；不是独立部署目标。生产数据与日志不应提交。完整备份应含数据目录及 PCF 导出签名密钥。

使用手册：[MANUAL.md](MANUAL.md)。运行配置：[hub-server/README.md](hub-server/README.md)。旧数据一次性迁移：[docs/d1-migration.md](docs/d1-migration.md)。

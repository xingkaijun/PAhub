# 第 1 期实际验收记录

执行日期：2026-11-07。环境：Windows，Node v24.20.0，npm 11.19.0，分支 pahub-main。

## 构建

命令：

~~~powershell
npm run hub:build
~~~

关键输出（退出码 0）：

~~~text
✓ 2658 modules transformed.
✓ built in 8.63s
PAhub build complete: frontend dist/ + hub-server/dist/ (same-origin /api)
~~~

保留原有 Recharts 重导出/分块循环依赖警告，未调整报表代码。

## 自动测试

命令：

~~~powershell
npm run hub:test
~~~

关键输出（退出码 0）：

~~~text
GET /api/health -> 200 {"ok":true,"service":"papc-d1-api","database":"connected","settingsSource":"api_settings","appSettingsRows":1}
GET /api/settings -> 200 reviewers=3 roundACycle=14
GET /api/projects -> 200 [{"id":"proj-test-001","name":"PG-VLEC-H2684","lastUpdated":"2026-11-07 07:14:18"}]
PATCH /api/projects/proj-test-001 -> {"success":true,"mode":"delta","statements":11,"verification":{"ok":true,"checked":1,"mismatched":[]}}
POST project readback + SQLite -> dwg-001 status=Approved
PUT /api/projects/proj-test-001 -> {"success":true,"verification":{"ok":true,"checked":9,"mismatched":[]}}
POST/GET snapshots -> count=1 note=phase-1 smoke
GET audit -> STATUS journal persisted
GET / -> 200 frontend HTML; JS=200; SPA=200; missing asset=404; HEAD=200
Worker /admin/api/export JSON import -> project/drawings/config/tracker/remarks preserved
Full schema SQL dump with BEGIN/COMMIT -> projects=1 drawings=6 integrity=ok
Restart -> status=Approved snapshots=1; API_TOKEN missing=401 valid=200
ℹ tests 5
ℹ pass 5
ℹ fail 0
~~~

直接运行真实前端 CloudflareApiRepository 的加载/保存/快照方法，不是替代接口的模拟客户端。另含 D1 返回结构、绑定类型/BLOB、raw、exec、批量回滚、坏导入不发布、禁止覆盖和幂等补列测试。

最新测试产物：C:\Users\ADMINI~1\AppData\Local\Temp\pahub-test-DBJCWB。测试创建的服务均已关闭。

## 默认生产入口

先前用 CLI 将 seed-test-data.sql 导入默认的 data/papc.db，得到：

~~~text
{"projects":1,"drawings":6,"snapshots":0,"audit_log":0,"integrity":"ok"}
~~~

实际执行 npm run hub:start，默认生产端口复核输出：

~~~text
PAhub listening on http://0.0.0.0:8080 (pid 20004)
PAhub database: C:\Users\Administrator\AgentDock\PAhub\data\papc.db
GET /api/health -> 200
GET /api/settings -> 200
GET /api/projects -> 200 [{"id":"proj-test-001","name":"PG-VLEC-H2684",...}]
GET / -> 200 <!DOCTYPE html>
~~~

先前通过 PATCH 改状态、创建快照；本次用独立只读 SQLite 连接再次确认 dwg-001.status=Approved，snapshots=1。默认测试库保留在被忽略的 data/ 中；PID 20004 已停止。

## 真实 Wrangler 导出迁移

只使用本地测试 D1，没有调用远端。

~~~powershell
npm exec -- wrangler d1 execute papc-review-db-final --local --config worker/wrangler.toml --persist-to data/wrangler-smoke --file worker/sql/init-local.sql
npm exec -- wrangler d1 execute papc-review-db-final --local --config worker/wrangler.toml --persist-to data/wrangler-smoke --file worker/sql/seed-test-data.sql
~~~

当前 Wrangler 3.80.0 的 d1 export 不支持 --persist-to。第一次调用提示 Unknown arguments；随后使用 data/wrangler-smoke/wrangler.toml 无密钥隔离配置，将上述测试数据复制到该配置默认的 .wrangler/state/v3，成功执行：

~~~powershell
npm exec -- wrangler d1 export papc-review-db-final --local --config data/wrangler-smoke/wrangler.toml --output data/wrangler-export.sql
node hub-server/scripts/import-d1.ts data/wrangler-export.sql --db data/from-wrangler.db
~~~

关键输出（退出码均为 0）：

~~~text
Exporting SQL to data/wrangler-export.sql...
Done!
Imported wrangler-export.sql -> C:\Users\Administrator\AgentDock\PAhub\data\from-wrangler.db
{"projects":1,"drawings":6,"snapshots":0,"audit_log":0,"integrity":"ok"}
~~~

## 开发入口

已运行 PORT=8081 的 npm run hub:dev：API、首页、/@vite/client、/index.tsx 均 200，同一 8081 端口的 HMR WebSocket 握手成功。触碰服务器源文件 mtime 后重建，Node PID 18292 不变；源文件内容未改。测试进程已停止。

## 环境与范围限制

- Windows 沙箱下 esbuild 父目录探测被拒绝，构建/测试/开发在获准的正常权限下执行。
- npm install 报告 22 个漏洞（1 low、3 moderate、18 high），按要求未处理。
- 没有 Ubuntu 实机，Ubuntu 启动方法见 README，未宣称在 Ubuntu 实际验收。
- 第 1 期核心数据 API 已脱离 Cloudflare；原有可选报表 CDN 资源未替换。

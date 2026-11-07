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

# 第 3 期实际验收记录

执行日期：2026-11-07。Windows，本机 Chrome，pahub-main；服务和数据库均使用隔离临时目录。

## 最终命令及关键输出

~~~powershell
npm run hub:test
npm run hub:build
node hub-server/test/browser-smoke.mjs
git diff --check
~~~

以上最终执行退出码均为 0。测试包含前两期全部回归。

~~~text
Concurrent duplicate batch applies once; conflict-only receipt exact replay at unchanged rev; body sentinel absent from every SQLite table
SSE A->B: rev=2 round:r1:owner clock=2; scoped credential 401 cross-drawing; presence focus+disconnect; Last-Event-ID rev=3 resync=true; same batch exact reply before/after restart, comment count=1
Remote delete #1: surviving UUID c2 renumbered #1; index C-0001; same focused reply DOM node
SSE heartbeat: none at 24,999ms; ping at 25,000ms; shutdown closes stream
IndexedDB dirty-only refresh -> latest server conflict; explicit discard removes document record
presence TTL: 59,999ms retained; 60,000ms released
jsdom changed: clean sibling patched in place, focused node unchanged, dirty value+clock retained, own event ignored, self presence hidden, add/delete index synchronized
jsdom conflicts: rich previews + text diff + image filenames; all-mine -> server clock retry; all-server -> discard; manual merge -> merged final saved
IndexedDB: unconfirmed UUID batch + base clocks + dirty local persisted; refreshed page recovery prompt; original batch replay saved once; beforeunload prevented
tests 16
pass 16
fail 0
duration_ms 9641.8835

✓ 2658 modules transformed.
✓ built in 8.06s
PAhub build complete: frontend dist/ + hub-server/dist/ (same-origin /api)

PAhub listening on http://0.0.0.0:51092
Browser initial: Save + Add comment
Chrome two isolated contexts: A input+save -> B auto displays; second owner update preserves B reply node+caret; pageerrors=0
Screenshots: hub-server/test/artifacts/realtime-A.png; hub-server/test/artifacts/realtime-B.png
Smoke data: C:\Users\ADMINI~1\AppData\Local\Temp\pahub-browser-95RYmG
~~~

已实际查看最终 B 截图：A 最新 Owner 内容显示正确，B 回复框保持聚焦；截图目录被 .gitignore 排除，不提交。自动测试临时目录包括 pahub-test-ku7cf8、pahub-pcf-XRZRTQ、pahub-realtime-yjs6Bc；测试服务与浏览器均已关闭。原 PG-PCF-v1.9-source.html 的 git diff 为空。

新增焦点重排测试最初发现：insertBefore 移动含焦点的祖先会使编辑框失焦。已改为移动其前置兄弟节点，保留活动子树；修复后完整回归和浏览器冒烟均通过。没有持续重试失败问题。

## 设计和交付边界

- 完整 PCF HTML 仍为唯一正文权威；SQLite 无正文哨兵命中。幂等回执放 HTML，窗口为最近 1000 批且 24 小时，依赖保留该窗口历史；目前无历史清理。
- SSE 只发实体标识/clock/操作摘要，随后读取快照，避免 SSE 重复搬运内嵌图片；未来可换按实体读取。限图签名在查询参数，代理须禁用缓冲并脱敏查询日志；HTTP 明文限制仍在。
- 60 秒无活动释放 presence，定时清理最多延迟 5 秒。广播有接口，但多进程仍需共享 presence 和写入互斥。
- 已有第二期权威 HTML 不会自动换脚本，需要另行备份并授权模板迁移；本期不改生产文件。PAPC 在线数量遵循原轮询节奏，自动同步关闭后只初始拉取。
- IndexedDB 失败提示下载副本；强杀/断电前未完成的写入事务无法保证。文本差异采用公共前后缀，不做像素或复杂文档 diff。
- 构建仍报告既有 Recharts Bar 分块循环依赖警告；依赖安装报告 22 个漏洞（1 low、3 moderate、18 high），没有进行范围外升级。

# 第 4 期实际验收记录

执行日期：2026-11-07。Windows、Node v24.20.0、npm 11.19.0、本机 Chrome、分支 pahub-main。所有本期服务和升级操作均使用隔离 Temp 数据；未对生产 data/ 执行升级。截图目录已被 git 忽略。

## 最终命令与关键输出

~~~powershell
npm run hub:build
npm run hub:test
node hub-server/test/browser-smoke.mjs
node hub-server/test/exchange-browser-smoke.mjs
# 此处 PAHUB_DATA_DIR 指向自动测试已升级的隔离数据，非生产目录
npm run hub:upgrade-pcf -- --dry-run --project project-x --drawing drawing-y
git diff --check
~~~

构建、测试、两次 Chrome 冒烟和 CLI 最终执行均退出 0。前三期测试包含在本次完整回归中。

~~~text
✓ 2658 modules transformed.
✓ built in 8.23s
PAhub build complete: frontend dist/ + hub-server/dist/ (same-origin /api)

Export: no credentials/internal URL/client history; immutable Owner/properties/register/IDs; HMAC present. jsdom Builder: two replies + v1.9 Save-as HTML stream OK
Three-way: ship-only automatic; same reply conflict; server addition retained; deleted+reply conflict/restored; silent deleted ignored; tampered Owner ignored with admin confirmation
Apply: rev +1; real SSE changed; PAPC 4/4 round B; history restore; exact batch replay before/after restart; documentId/exportId/void rejected; SQLite body sentinel absent
Upgrade CLI: dry-run byte-identical/no backup; real backup byte-identical; JSON deep-equal (documentId/hub/receipts/custom); atomic temp cleared; jsdom page loaded; rerun=current
Exchange edges: images compared/replaced as whole sets; Builder body + server image disjoint automatic; stale preview 409; wrong mode 409; old-template hint injected without changing authoritative HTML
tests 19
pass 19
fail 0
duration_ms 15922.3185

Chrome two isolated contexts: A input+save -> B auto displays; second owner update preserves B reply node+caret; pageerrors=0
Screenshots: hub-server/test/artifacts/realtime-A.png; realtime-B.png

Automatic merges (1)
Conflicts (1)
Ignored changes (0)
Chrome: Hub Export -> file:// Owner locked -> two Builder replies -> Save as/download -> reopened saved HTML -> upload preview (1 automatic/1 conflict) -> manual merge -> Confirm -> replies visible; correspondence Imported; pageerrors=0
Screenshots: hub-server/test/artifacts/builder-offline.png; builder-import-preview.png; builder-import-applied.png
~~~

npm CLI 实际输出（隔离目录已由正式升级测试升级至版本 4）：

~~~json
{"dryRun":true,"files":1,"report":[{"file":"...\\pcf\\project-x\\drawing-y.html","from":4,"to":4,"status":"current"}]}
~~~

旧版本的 dry-run 和正式升级也由自动测试以真实子进程执行：dry-run 原文件字节不变且无备份；正式备份字节与原文件一致，升级后内嵌 JSON 深比较完全相同，临时文件已清除，页面可正常加载。之后再执行报告 current。

## 场景覆盖与浏览器检查

新增 exchange.test.ts、exchange-edge.test.ts 和 exchange-browser-smoke.mjs，覆盖：

- 写接口鉴权；外发显式白名单剥离 hub/凭据/内部 URL/client 历史，嵌套未知字段不外发；内嵌 HMAC 存在。
- 船厂 UI 禁用 Owner、属性、人员、状态、增删、登记、图纸控制和非当前回复；控制台修改只读对象、数组索引/length、删除及重定义均被数据层保护拦住。
- jsdom 在 file:// 加载导出文件，填写两条 Builder 回复，调用 v1.9 真实 Save-as HTML 写入路径，解析保存文件验证回复。Chrome 同样执行离线填写与正常下载另存 fallback，再打开保存文件验证。
- 三方合并自动项、正文冲突、服务器新增保留、删除且有新回复冲突/显式恢复、删除无新回复忽略、Owner 篡改提示并以管理员确认忽略。
- 附图以整体集合比较；正文与图片分别合并，不同栏位的并行修改不互相覆盖。
- apply 的 rev 增长、真实 SSE changed、PAPC 意见数/开放数/轮次/版本回写、历史恢复；同 batchId 在重启前后精确重放且不重复应用；重复 exportId 提示及允许覆盖无实际改动时不增 rev。
- documentId/exportId 不匹配、作废导出、错误 mode、过期/服务器变更后的预览拒绝；SQLite 每张表中正文哨兵均未出现。
- 旧模板提示通过响应注入，权威文件字节不变；升级保留 documentId、完整业务 JSON、hub、receipts、自定义字段。

已实际查看最终三张 Builder 截图：顶部英文操作提示清楚，只读控件禁用，两条 Builder 回复无遮挡；预览显示一项自动合并及一项正文冲突，可手动合并；确认后页面显示船厂回复与手动合并结果。两个 Chrome 流程 pageerrors=0。截图不提交。

最终测试数据：Temp 下 pahub-exchange-eJVJ1g、pahub-exchange-edge-cuwBvl、pahub-upgrade-dTHuXg、pahub-test-VFkHOe、pahub-pcf-ANDoZ4、pahub-realtime-ADg2ZW；浏览器为 pahub-browser-YyAZry 和 pahub-exchange-browser-KDGQaq。服务与浏览器均已关闭。PG-PCF-v1.9-source.html 的 git diff 为空。

## 修复过程与边界

开发中分别修正了 JSX/内联脚本缺符号、Node strip-only 不支持参数属性（改为内存 esbuild 启动）、jsdom 缺 ResizeObserver mock、英文 UI 对应旧断言、以及浏览器异步往来面板等待。每项定位后已通过相关回归，没有对同一未解决问题持续重试。最终 diff 检查移除了文档末尾多余空行；Git 的 LF/CRLF 提示属于平台换行转换提示。

- HMAC 只检测只读内容篡改，不加密、不证明船厂身份，也不能把可自行改脚本的 HTML 变成安全沙箱；Owner 改动永不导入。业务正文/附图由用户提供，其中手写敏感 URL 不作擅自删改，外发前仍应审阅。
- 密钥 data/.pcf-export-key 必须与基线/历史一起备份并保护 ACL；部署须覆盖现有默认 ADMIN_PASSWORD。Windows mode=0600 不能替代 ACL，HTTP 明文仍有凭据风险。
- 当前单进程；模板升级必须停服，没有跨进程维护锁。尚无导出、基线、历史和导入回执自动清理，作废仅改状态不删除文件。
- 不自动升级生产旧文件；上线需要管理员选择停服时间并执行工具。无 Ubuntu 实机与 HTTPS 运维验收。
- 构建保留既有 Recharts Bar 分块循环依赖警告；既有依赖漏洞未作范围外升级。

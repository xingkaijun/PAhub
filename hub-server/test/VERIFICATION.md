# PAhub 验证与交接记录

## 接手文件处理结论

| 文件 | 处理结论 |
| --- | --- |
| components/DrawingRow.tsx | 保留认可标签方向，修正无 PCF / Not submitted 不显示，统一四色映射。 |
| components/ReviewTracker.tsx | 保留主体，修正 APR 有效值、来源提示、发送回读、打包、防双击和同批次重下载。 |
| hub-server/scripts/build.mjs | 保留绝对入口修正；构建通过。 |
| hub-server/scripts/test.mjs | 修正测试引用和绝对路径，保留原六份测试并加入 send-all。 |
| hub-server/src/database.ts | 修正 source 为可选升级列，启动自动 ALTER，保留旧库导入兼容。 |
| hub-server/src/pcf-api.ts | 保留批量入口，复用写鉴权，返回 ZIP 和 RFC 5987 文件名。 |
| hub-server/src/pcf-exchange.ts | 修正整批归属校验、持久化幂等、最新 rev、失败回滚与基线文件清理，复用单张导出。 |
| store.ts | 保留原轮询次数并缓存 index；手动 APR 写 source；清空移除 APR；回读拒绝残存 APR。 |
| types.ts | 保留 source 类型和兼容字段名称调整。 |
| worker/sql/compat-views-d1.sql | 已删除（阶段 0 清理）：无代码引用。 |
| worker/sql/compat-views-from-normalized.sql | 已删除（阶段 0 清理）：无代码引用。 |
| worker/sql/init-local.sql | 增加新库 source，保留旧库由启动 ALTER 升级；清理旧运行命令。 |
| worker/src/index.ts | 保留 source 读写；修正验证映射对象与布尔值比较；统一手动来源兼容；阶段 0 移除默认管理员密码。 |
| hub-server/src/zip.ts | 保留内置 zlib 实现；核验 CRC32、deflateRaw 和 UTF-8 bit 11。 |
| lib/pcf.ts | 保留并整理为统一 APR、状态选择、清空和标签 helper；补齐空标签隐藏测试。 |
| 根目录原四个 tmp-*.mjs | 删除；临时执行脚本仅位于系统临时目录。 |

## 其它实现与清理

| 文件 | 处理结论 |
| --- | --- |
| hub-server/src/pcf-schema.ts | 新增持久化批次表，projectId + batchId 唯一，保存 manifest 与文件名。 |
| hub-server/src/import-legacy.ts | 新增一次性迁移桥，旧路径字段自动转换；SQL 字符串和注释保持原文。 |
| hub-server/src/importer.ts | 接入旧 SQL / JSON 字段转换；保留一次性导入。 |
| hub-server/test/send-all.test.ts | 新增验收与原子回滚、跨重启幂等、旧库升级、正文保护测试。 |
| hub-server/test/integration.test.ts | 同步客户端类名、路径字段名，不删减原验收。 |
| services/data/HubApiRepository.ts | 同源 /api 客户端重命名并保留原保存、读回、快照和审核接口。 |
| services/data/AppRepository.ts | 更新客户端引用，移除旧部署注释。 |
| services/data/types.ts | 同步兼容路径字段名。 |
| App.tsx | 删除失效的存储选择分支，保留同源项目加载。 |
| package.json | 改名 PAhub，删除旧部署工具依赖。 |
| package-lock.json | 按依赖清理更新，不额外升级其它依赖。 |
| vite.config.ts | 删除旧存储环境变量注入；阶段 0 删除无引用的 GEMINI_API_KEY / API_KEY / VITE_PUSH_PASSWORD define。 |
| .env.example | 精简为当前 Hub / Vite 配置，补充 VITE_EDIT_PASSWORD。 |
| vite-env.d.ts | 清理旧配置声明，补充编辑密码类型。 |
| metadata.json | 已删除（阶段 0 清理）：Vercel / AI Studio 时期遗留。 |
| .gitignore | 保留本地数据和测试产物保护，删除旧代理专属项。 |
| worker/sql/read-model.sql | 已删除（阶段 0 清理）：无代码引用。 |
| worker/sql/seed-test-data.sql | 同步当前 schema 列名；继续用于临时测试。 |
| MANUAL.md | 重写简洁的启动、锁、列表、Tracker、在线 PCF、往来导入和备份说明。 |
| README.md | 重写当前 PAhub 启动与功能说明。 |
| docs/d1-migration.md | 精简为从旧 D1 一次性迁移，列出字段兼容。 |
| hub-server/README.md | 改为当前本地 Hub、进程环境和往来接口说明。 |
| worker/README.md | 明确由 Hub 打包运行，不独立部署。 |
| hub-server/test/VERIFICATION.md | 本交接与验证记录。 |

已删除旧存储 Provider / 接口、代理客户端与独立代理服务、旧部署配置和垃圾导出、过时保存说明。保留 worker/src、worker/sql、D1Adapter、import-d1 及原单张船厂版 HTML 逻辑。生产 data、logs 和已有 8080 服务未动。

## 同步与批量导出


POST /api/pcf/:projectId/exports/batch，body 为 {drawingIds,batchId}。保存并回读通过才调用；取服务器最新 rev，复用 Owner 锁定、HMAC、每图导出记录和基线。无 PCF 在带 BOM manifest 标记 skipped / no PCF。外项目图纸整批 400；同 batchId 返回同 exportId，跨重启不增记录；同 batchId 改图纸列表 409。任一图导出失败回滚本批记录并清理基线。打包失败不回滚已发送状态，可在当前页面内存中以同 batchId 重下载。

## 验证结果（2026-11-07）

- npm run hub:build：退出 0，前端 2659 modules，Hub 三个入口构建成功。
- npm run hub:test：22 tests，22 pass，0 fail / skipped / cancelled；最终约 18.2 秒。
- 原 d1、integration、pcf、realtime、exchange、exchange-edge 六份测试全部保留。
- 新测试覆盖 APR 优先级、状态选择和清空、ZIP / BOM / 中文非法字符 / 同名、CRC32 / UTF-8、导入 preview、最新 baseRev、401、外项目 400、重复批次、跨重启、故障整批回滚、旧 source 自动升级和 import-d1。
- 构建和集成测试不能同时替换前端 dist；出现一次资源切换 404 后，构建结束单独重跑全部通过。
- Chrome 冒烟：隔离会话、127.0.0.1:58608、系统临时数据目录；两张 Ready 分别 PCF Approved 与 Under review / 1 open。
- APR 来源 title 与有效值断言通过；确认框正确显示 1 Approved / 1 Waiting Reply，打包 2、跳过 0。
- 自动下载 ZIP，PowerShell Expand-Archive 得到两 HTML 与 manifest.csv；中文斜杠替换正确，全部 UTF-8 bit 11，baseRev 均为 2。
- 再下载原批次：exportId 不变，导出记录仍两条；服务器 tracker 的真实审核人均 false，APR 不存在。
- 补充模拟首次打包 500：提示“状态已发送，但打包下载失败”，服务器状态未回滚、APR 已清空；同 batchId 重试成功下载，错误提示消失。
- 截图：artifacts/sendall-before.png、artifacts/sendall-failure.png、artifacts/sendall-after.png。

## 已知非阻塞事项

构建仍有原图表分包循环依赖警告；依赖审计报告 12 项（1 low、2 moderate、9 high），本次没有扩范围升级。浏览器仅原 favicon 404 和人为注入的打包 500，无其它功能错误。浏览器缓存命名空间改为 pahub-storage，升级前应先同步旧页面未保存修改；服务端项目数据与旧数据库导入不受影响。无需要新授权或产品选择的阻塞事项。

## 第 6 期：批量导入船厂回复（2026-11-07）

- `npm run hub:build` 成功；`npm run hub:test` 42/42 通过（原有 30 项 + 新增 12 项）。
- 新覆盖 ZIP 多文件分类与 3 份回复的自动应用/冲突处理、非 HTML 忽略、重复导入、同批次幂等、preview 后同意见变更、Approved/Pending 状态不变、Owner 篡改忽略、永久删除意见冲突、ZIP-slip/跨项目拒绝、展开大小上限、模拟 PCF 写入失败回滚、v4 风格回复兼容、单图导入状态更新，以及无实际回复变更时不推进状态。
- PAPC Waiting Reply → Reviewing 的 `STATUS` 日志、三张图状态及非 Waiting Reply 状态保持均由隔离临时 SQLite 验证；未使用 `data/`、`logs/` 或 8080 服务。
- Chrome 截图：`hub-server/test/artifacts/row-no-status.png`、`batch-import-preview.png`、`batch-import-conflict.png`、`batch-import-applied.png`。6a 文件名后无往来状态；批量导入 2 clean + 1 conflict，冲突使用原托管 PCF 预览处理；最终 PAPC 显示 3 张 Reviewing；页面错误 0。

## 架构优化阶段 1（2026-11-08）

- 仅执行 docs/ARCHITECTURE_PLAN.md 阶段 1；未做 JSON 存储迁移、Worker 全面并入或前端拆分。
- 先写 A/B/C 复现测试，修复前 0/3 通过；C 确认存在（导入回复后关闭意见会回退轮次）。
- 轮次统一 lib/rounds.ts；截止日期统一 lib/deadline.ts，PROJECT_TIME_ZONE=Asia/Shanghai。起始日不计入，跳过周末/节假日，按项目日历日计算，保存截止日上海零点对应的 ISO 时刻。
- 有 PCF 的四列（意见总数/未关闭数/轮次/版本）只由 PCF 同步；旧 PATCH/PUT 整行保存与管理后台手改均忽略客户端这四列，写后校验同步排除。项目读取返回 hasPcf，输入框与命令栏不再允许手改。
- 原生状态接口：POST /api/projects/:projectId/drawings/:drawingId/status，body={status}。与旧页面保存、单张/批量船厂回复导入共用 transitionDrawingStatus；有 PCF 时同一串行队列中更新 currentRound、实体时钟、历史和索引。
- 新 PATCH 图纸格式：updatedDrawings:[{id,changes:{title,...}}]；未提交的列和关联表保留。仍接受旧整行格式。服务端返回 drawings 最终值，store 按字段合并，保存期间的新修改保持待保存。
- 编辑模式本地修改后约 3 秒防抖自动保存；分钟定时器保留作失败重试兜底。
- 所有服务验证使用临时端口和临时数据目录；未改真实 data/、PAhub-preview、8080/8081/8082 服务或 SGP0；认证仍为默认关闭的可选开关。
- 阶段 1 新增相关验收：drawing-state 11/11、drawing-fields 7/7、deadline 7/7、drawing-ownership-ui 5/5，合计 30/30 通过。
- 最终仅运行一次 npm run hub:build && npm run hub:test：构建成功；126 tests，126 pass，0 fail / skipped / cancelled，测试约 66 秒。

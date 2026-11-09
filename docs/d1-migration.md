# 从旧 D1 一次性迁移

旧 Cloudflare D1 的 SQL 全量导出或旧管理接口 JSON 可导入新的 PAhub 本地 SQLite。迁移工具保留，不再提供 WebDAV、OneDrive 或旧远程部署。

1. 在旧部署环境用原有 Wrangler 配置执行 npx wrangler d1 export <数据库名> --remote --config <旧配置路径> --output <导出.sql>；也可从旧 /admin/api/export 下载 JSON。此处需要旧环境的凭据，与新 Hub 无关。
2. 在 PAhub 执行 npm ci。停止目标 Hub，将导出导入一个不存在的目标路径（迁移工具不在默认的 hub:build 里，这条命令会先单独打包 hub-server/dist/import-d1.mjs 再运行）：

~~~powershell
npm run hub:import-d1 -- <导出.sql或.json> --db <新目录>/papc.db
~~~

3. 工具在临时数据库导入并检查完整性与外键，成功才发布；拒绝覆盖已有数据库。启动时自动补齐 review_tracker.source 等可选列，旧无 source 的 APR 仍视为手动。旧 webdav_path / webdavPath 仅转换为兼容元数据 storage_path / storagePath，不恢复旧存储服务。
4. 设置 PAPC_DB_PATH 指向新数据库，启动 Hub；检查项目、图纸、责任人、追踪记录、备注与快照。原 SQL/JSON 与旧系统备份保留到确认迁移成功。

旧 D1 不包含本地 PCF 权威文件与 .pcf-export-key；若从已有 Hub 迁移，还必须完整复制其数据目录。不要只迁移数据库后丢弃导出基线与签名密钥。

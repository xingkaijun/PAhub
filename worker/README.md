# Hub 内嵌业务 API

worker/src 和 worker/sql 由 hub-server 构建打包执行，保留现有图纸、追踪、快照及管理接口业务逻辑。数据库绑定使用 Hub 的 D1Adapter，实际存储为 Node.js 24 内置 SQLite。

本目录不是独立部署目标，没有部署配置。SQL 兼容视图只服务现有业务读模型；旧数据库一次性迁移使用 hub-server/dist/import-d1.mjs，见 ../docs/d1-migration.md。

在仓库根运行 npm run hub:build 与 npm run hub:test。生产运行 npm run hub:start；测试使用临时目录及随机端口。

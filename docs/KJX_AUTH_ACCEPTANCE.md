# KJX_AUTH 四角色浏览器验收（T5）

## 结论与范围

- 日期：2026-11-14；方案：v1.0 P4-8 **(b) 开发代理**。
- 被验产品：PR #7，`feat/p4-6-kjx-features`，`78177f888123dc74e60b300863579df35255abdd`。
- Worktree：`PAhub-kjx-t5`；验收分支：`test/p5-kjx-acceptance`。
- **45 通过 / 3 失败 / 0 阻塞，共 48 项。未满足全部通过；不作为上线批准。**
- [完整角色 × 路径 × 结果表（含逐项截图）](acceptance/SUMMARY.md)；[机器可读结果](acceptance/results.json)。
- 没有修改产品代码、构建入口、依赖、旧测试；缺陷只记录。没有服务器访问、部署、main 推送或合并。

## 环境及复跑

Node 24 + 项目已有 Playwright Chromium，1440×1000，独立临时 SQLite/PCF 数据。

```text
npm ci
npm run hub:build
node scripts/kjx-acceptance.mjs
node scripts/kjx-acceptance-report.mjs
```

开发代理 `scripts/kjx-dev-proxy.mjs` 仅监听 127.0.0.1；以开发角色 Cookie 选择身份、覆盖来访 X-Auth-Token 后转发，提供真实 HTTP 内存 JWKS。`NODE_ENV=production` 拒绝启动。随机账号 ID/用户名、服务凭据、签名密钥、JWT、临时管理员密码只存在内存；截图中的 Acceptance role 是显示标签，不是固定登录账号。未保存 browser storageState、trace/HAR、Cookie 或令牌。

目录桩实现 `/oauth/token` 和 `/api/directory/users`，可切换不可用模式。不可用测试重新创建后端与目录实例，避免五分钟缓存掩盖降级。不访问真实 kjx-auth、nginx、生产域名或服务器。`KJX_JWKS_URL` 指向代理，不通过 verifier 注入绕过生产 JWKS 获取路径。

浏览器实际点击、输入、选择、导出并截图；安全拒绝与导入四状态矩阵通过 browser context.request → proxy → 本地产品 HTTP 后端验证。48 项结果中 UI 与 HTTP 检查在结果表中明确区分，非内部授权函数单测。脚本退出 0 只表示证据采集完毕，**不是全部验收成功**，必须查看结果表。

代理与验收脚本没有加入 package/build entrypoints，不进产品构建产物。`npm run hub:build` 通过；本任务未声称重跑全部 hub:test/hub:e2e，核心交付是四角色验收。36 张最终 PNG 共约 7.08 MiB，使用 PNG IDAT 无损重压缩，无需新依赖。实际查看过截图，包含已渲染 PCF、Inventory、Actor 日志和目录降级界面，不是空白启动页。

## 覆盖概览

| 角色 / 范围 | 路径 | 结果 |
|---|---|---|
| 四角色分别 | 列表、PCF、banner 姓名/角色、账号链接、真实姓名 presence | 16/16 PASS |
| 四角色分别 | Daily Log Actor 列和按 manager 筛选 | 4/4 PASS |
| viewer | 直接写接口拒绝 | PASS |
| viewer | 所有写控件隐藏 | **FAIL · D1** |
| reviewer | 新意见自动本人且只读、改本人、拒改他人、拒改状态 | 4/4 PASS |
| manager | 改状态、独立改备注、编辑他人、指定提出人、单张导出状态不变、Team Setup 拒绝 | 6/6 PASS |
| manager | 改负责人后服务端落库 | **FAIL · D2** |
| manager | Builder 导入 Pending / Reviewing / Waiting Reply / Approved 状态矩阵 | 4/4 PASS |
| admin | 正常目录选人、目录不可用手填、Settings | 3/3 PASS |
| admin | 新建项目持久化 | **FAIL · D3** |
| 安全 | 伪造/过期/错 aud 直连拒绝、跨 Origin 拒绝、代理覆盖伪造身份、上传脚本不执行 | 4/4 PASS |
| legacy | 管理员密码登录/PCF、Builder 附件下载 | 2/2 PASS |
| 开发工具 | production 拒绝启动 | PASS |

[完整表](acceptance/SUMMARY.md) 为精确计数来源。四角色共用项逐角色算一项；JWT 三种错误合为一项；四种导入状态各算一项。

## 产品缺陷（仅记录）

### D1 · 中：viewer 写控件未全部隐藏

- 位置：`hub-server/src/pcf-kjx-adapter.ts:21-22`、`components/DrawingList.tsx:476-489`、`components/DrawingRow.tsx:341`。
- 复现：选 viewer → 打开 Acceptance Vessel → Inventory 与 PCF。
- 实测：Inventory 可见 Team Setup、Bulk Load、Delete；PCF 可见 `#add-btn`、`#save-btn`、`#pahub-export`。
- 原因线索：PCF gate 写 `add-comment-btn`，实际按钮为 `add-btn`；Save 不在 gate 中；hidden 属性和 toolbar display 样式交互。Inventory 多处只 disabled 而非隐藏。
- 影响：违反 P4-8 viewer UI 要求、诱导无效操作；直接状态写接口仍 403，**未确认服务端提权**。
- [viewer PCF 截图](acceptance/t5-17-viewer-all-write-controls-hidden.png)。

### D2 · 高：manager 改负责人夹带 tracker，被整批拒绝并阻止后续保存

- 位置：`components/DrawingRow.tsx:70-74`、`store/projectSlice.ts:212-217`、`store/projectSlice.ts:404-409`、`hub-server/src/project-patch-auth.ts:44-45`。
- 复现：manager 打开 ACC-001 → Assignees 选择 Acceptance reviewer → 等待自动保存。
- 实测：PATCH **403 / capability=admin.only**，body 顶层键为 projectName、updatedDrawings、reviewTracker；drawing_assignees 未新增。界面保留未保存标记和无权限提示。
- 路径：assignees 改动自动标脏 tracker；delta 包含 reviewTracker；后端把其归 admin.only，原子拒绝整批合法负责人更新。
- 连带：同一 context 下一次备注保存也被脏 tracker 拒绝；新 context 单独备注可成功落库，已独立验证。未修产品，也没有把删除 tracker 的请求冒充正常 UI 成功。
- [失败截图](acceptance/t5-21-manager-update-assignee-through-UI.png)；[独立备注截图](acceptance/t5-22-manager-isolated-remark.png)。

### D3 · 中：admin 在已打开干净 workspace 后新建项目未落库

- 位置：`App.tsx:378-396`、`store/projectSlice.ts:139-159`、`store/projectSlice.ts:379-382`。
- 复现：admin 已打开原项目进入 Config → 新标签打开大厅 → Create Workspace → 输入 Acceptance Created Workspace。
- 实测：连续两轮 12 秒没有新项目 PATCH，服务端未创建项目。初次有其他脏配置的上下文曾写成功，说明成功依赖无关脏状态；不能把本地新增等同于服务端创建。
- 原因线索：addProject 只加 localOnly 对象、不标脏、不切 activeProject；随后 saveProject 在没有 dirty 数据时跳过。
- [创建后仍是原项目界面](acceptance/t5-29-admin-create-project-via-lobby.png)。

## 验证边界与未冒称的结果

- 四角色账户菜单检查 Change password 的 origin/path 与 Sign out 的 POST form/action；不执行真实改密/登出。中央登录、强制改密、停用跨应用会话、nginx 覆盖、生产密钥轮换不能由开发代理证明，需上线人工验收。
- SSE presence 在真实浏览器连接后通过实际 presence HTTP 返回和页面验证真实姓名；没有只检查可伪造的 clientName 输入。
- Daily Log 使用 Server 源、Actor=manager，验证全部业务行 Actor，不把隐藏打印表的空单元格误判为产品缺陷。
- 目录测试验证选择与手填 UI 可用；不声称全角色成员管理或真实 kjx-auth 目录联通性。
- legacy 仅关键路径冒烟：随机密码登录、PCF 打开、附件原文可读。相对 fec6429 保留已批准的 additive session、H1 附件响应头及接入 schema 差异；未伪称本任务执行完整 fec6429 差分回归。
- 初轮验收脚本严格定位与异步渲染问题已修正，未列为产品缺陷；D1/D2 已重复确认，D3 在两次无进展后停止重复尝试。没有为通过验收修改产品。

## 后续

负责人安排产品修复 D1–D3 后，使用本脚本复跑失败项及受影响路径。本 PR 只提供开发工具与证据，不建议因其余 45 项通过而忽略这三项。

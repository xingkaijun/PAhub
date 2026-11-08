# PAhub 架构优化计划

> 版本 0.1 · 2026-11-08 · 基于提交 `26d37a7` · 状态：草案，确认后按阶段实施

## 背景与约束

- **部署方式**：局域网（Ubuntu 服务器），或经 frp 暴露到公网。匿名使用，不做账号、会话、角色体系。
- **PCF 格式**：模板必须保持为可以脱离 PAhub、离线使用的单文件 HTML（会直接用 HTML 编辑和分发）。PAhub 内部可以改为"数据 JSON + 渲染时套模板"，但必须保留"另存为单 HTML"的能力。
- **运行模型**：单个 Node 24 进程 + `node:sqlite`。实时推送和在线状态是内存实现，不考虑多进程部署。
- **与现有设计的关系**：阶段 2 会修订 [PAHUB_DESIGN.md](PAHUB_DESIGN.md) 的决策第 7 条（"服务器上每张图存的就是一个完整的 PCF .html"）和"架构"一节里的 PCF 文件路径。决策第 1、2 条（数据库不存正文，只存指针和摘要）保持不变。

## 现状数据（2026-11-08，本地 `data/`）

| 指标 | 数值 |
|---|---|
| PCF 文档 | 394 份，共 209.2 MB，全部为模板 v6 |
| 其中 `pcf-data` JSON | 4.8 MB（平均 12.5 KB，最大 107 KB） |
| 模板副本所占比例 | 97.7% |
| 当前模板 `PG-PCF-hub.html` | 566 KB |
| 历史快照 | 220 份，66.2 MB |
| SQLite 数据库 | 0.7 MB（另有 2.9 MB WAL） |

托管页面渲染 v6 文档时，一直用的是"当前模板 + 解析出的数据"（[pcf-api.ts:82](../hub-server/src/pcf-api.ts#L82)），文件里存的那份模板只有直接从磁盘打开时才用得上。但每次 API 请求（包括在线状态更新）都要读一份约 544 KB 的文件，再用正则从中扫出约 12.5 KB 的数据。每次打开页面，还会从磁盘重读一遍模板（[pcf-template.ts:8](../hub-server/src/pcf-template.ts#L8)）。

## 阶段总览

| 阶段 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| 0 | 安全底线、清理、CI | 小 | — |
| 1 | 理顺图纸状态由谁负责（数据正确性） | 中 | 阶段 0 的 CI |
| 2 | PCF 改为 JSON 存储 | 大 | 阶段 0；建议在阶段 1 之后 |
| 3 | 把旧 Worker 并入 hub-server | 大，可分批 | 阶段 0 |
| 4 | 前端整理 | 中 | 可与阶段 3 穿插 |

## 阶段 0：安全底线、清理、CI

开了 frp 之后，管理后台和能执行任意 SQL 的控制台都暴露在公网上，而管理后台还有硬编码的默认密码。因此先做下面几件小事。

### 0.1 Basic Auth

- 如果 frp 用 http 类型代理，直接在 frpc 里配置即可，不用改代码：

  ```toml
  [[proxies]]
  name = "pahub"
  type = "http"
  localPort = 8080
  customDomains = ["pahub.example.com"]
  httpUser = "pahub"
  httpPassword = "<强密码>"
  ```

  旧版 ini 配置里，这两个字段叫 `http_user` / `http_pwd`。
- 如果用 tcp 类型代理，frp 没有这个选项，就在 Hub 里加一个环境变量 `PAHUB_BASIC_AUTH=<用户名>:<密码>`。设置后，所有请求（静态资源、API、SSE）都要先通过 Basic Auth，失败时返回 401 和 `WWW-Authenticate`。
- 不管用哪种方式，`API_TOKEN` 和构建时的 `VITE_DATA_API_TOKEN` 都要留空。前端配置了 token 后会发送 `Authorization: Bearer …`，这个头会顶掉浏览器自动附带的 Basic 凭据，请求就会被拒。
- 条件允许的话，在 frps 前面加一层 HTTPS（Caddy 或 nginx），否则 Basic Auth 的密码是明文传输的。

### 0.2 管理后台不再有默认密码

去掉 [worker/src/index.ts:997](../worker/src/index.ts#L997) 和 [pcf-exchange.ts:198](../hub-server/src/pcf-exchange.ts#L198) 里的默认密码 `papc-admin-2026`。没设置 `ADMIN_PASSWORD` 时，直接关闭管理后台（`/api/admin`）和所有需要管理员密码的操作。

### 0.3 SQL 控制台只读

`/admin/api/sql`（[worker/src/index.ts:1183](../worker/src/index.ts#L1183)）改为用一个单独的只读连接执行（`new DatabaseSync(dbPath, { readOnly: true })`）。现在那套按语句开头拦截 DDL 的逻辑可以去掉，它在语句前加一行注释就能绕过。

### 0.4 清理遗留文件

| 文件 | 处理 | 原因 |
|---|---|---|
| `temp_update.sql` | 删除 | 含审图人缩写和项目名 |
| `worker/review_tracker_out.json` | 删除 | 真实的 tracker 数据 |
| `worker/list_db.txt` | 删除 | wrangler 输出，含 Cloudflare 账号下 7 个 D1 数据库的 UUID |
| `clone-to-test.js` | 删除 | 写死了真实项目 ID，指向已废弃的 wrangler dev 端口 |
| `vercel.json`、`metadata.json` | 删除 | Vercel / AI Studio 时期遗留 |
| `vite.config.ts` 中 `GEMINI_API_KEY`、`process.env.API_KEY`、`VITE_PUSH_PASSWORD` 的 define | 删除 | 没有代码使用 |
| `worker/sql/` 下的 `admin-init.sql`、`read-model.sql`、`compat-views-d1.sql`、`compat-views-from-normalized.sql` | 删除，同时修改 `hub-server/test/VERIFICATION.md` | 没有代码引用 |
| [App.tsx:205](../App.tsx#L205) 的 `if (!true \|\| …)` | 改掉 | 死代码 |
| 根目录的 `DEADLINE_FIX_SUMMARY.md`、`LAST_CHANGE_SORT_FEATURE.md`、`TRACKER_READY_SORT_FEATURE.md` | 移到 `docs/` 或删除 | 一次性说明 |
| `hub-server/test/artifacts/*.png` | `git rm --cached` | 已被 `.gitignore` 匹配，但仍被跟踪 |
| `src/index.css` | 删除 | 24 字节，没有引用 |

如果以后要公开仓库，还要用 `git filter-repo` 把前四个文件从 git 历史中清除。

### 0.5 CI

新增 `.github/workflows/ci.yml`。很多测试启动 Hub 时没有传 middleware，要求 `dist/index.html` 已存在，所以要先构建再测试：

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run hub:build
      - run: npm run hub:test
```

### 完成标准

- 没设置 `ADMIN_PASSWORD` 时，管理后台不可用；在 SQL 控制台执行 `DELETE` 会报错。
- 经 frp 访问时要先通过 Basic Auth，之后图纸列表、SSE 和 PCF 页面都能正常使用。
- CI 在 `main` 分支上通过。

## 阶段 1：理顺图纸状态由谁负责

### 问题

`drawings` 表里有四列（意见总数、未关闭意见数、`current_round`、`version`）同时被两处代码写入：

- PCF 每次保存时，服务端会根据文档内容重新计算这四列并写入（[pcf-storage.ts:88](../hub-server/src/pcf-storage.ts#L88)）。
- 前端保存时，又会把整行 upsert 回去（[worker/src/index.ts:431](../worker/src/index.ts#L431)）。

Worker 不知道 PCF 的存在，也没有版本校验，最后写入的那一方说了算。具体会出现下面几种情况：

- **场景 A：前端覆盖 PCF。**
  1. 管理员改了某张图的状态，还没到自动保存。
  2. 这期间有人在这张图的 PCF 里加了意见。
  3. SSE 触发刷新，但这张图有未保存的修改，于是整行保留本地版本（[mergeProject.ts:19](../services/data/mergeProject.ts#L19)）。
  4. 前端保存时，本地的旧意见数覆盖了服务器上的新值。

  之后系统不会自己修正：`pcf_index.rev` 没变，所以读取时不会重新同步；写后校验比对的是客户端发来的值，也查不出问题。
- **场景 B：PCF 把轮次改回去。** 状态从 Waiting Reply 变为 Reviewing 时，前端会推进轮次（[store.ts:441](../store.ts#L441)），但不会同步 PCF 的 `currentRound`。下一次 PCF 保存时，轮次就被改回去了。
- **场景 C（待确认）。** 导入船厂回复后，服务端也会推进轮次（[pcf-builder-replies.ts:18](../hub-server/src/pcf-builder-replies.ts#L18)）。如果新一轮开始之前先在 PCF 里关闭了意见，轮次可能同样会被改回去。

同一条业务规则在代码里有好几份实现，而且结果已经不一致：

- **轮次递增**：[lib/rounds.ts](../lib/rounds.ts) 和 [store.ts:441](../store.ts#L441) 各一份。当前轮次是 AA 时，前者算出 AB，后者算出 AAA。
- **截止日期**：一共三份，分别在 [store.ts:155](../store.ts#L155)、[Settings.tsx:279](../components/Settings.tsx#L279) 和 [pcf-builder-replies.ts:28](../hub-server/src/pcf-builder-replies.ts#L28)。服务端那份用服务器时区判断周末，却用 UTC 日期匹配节假日。用户在东八区时，北京时间 0–8 点之间的操作会把日期算错一天。

### 任务

1. **写复现测试**：在 `hub-server/test/` 新增测试，覆盖场景 A、B，并确认场景 C 是否存在。
2. **每条规则只留一份实现**：
   - 轮次统一用 `lib/rounds.ts`，删掉 `store.ts` 里的内联实现。
   - 截止日期抽到 `lib/deadline.ts`，统一按项目时区的日历日计算，并替换掉上面三处实现。时区直接沿用 [config.ts:11](../hub-server/src/config.ts#L11) 里的 `Asia/Shanghai`，把配置名改成通用的。
   - 单测覆盖以下情况：Z→AA、AA→AB、周末、节假日、北京时间 0–8 点。
3. **明确字段由谁负责**：

   | 字段 | 有 PCF 的图纸 | 没有 PCF 的图纸 |
   |---|---|---|
   | 意见总数、未关闭数 | PCF 计算 | 前端手填 |
   | 当前轮次 | PCF 的 `currentRound` | 服务端状态流转 |
   | 版本 | PCF 当前轮次登记里的 revision（为空时保留原值） | 前端手填 |

   - 服务端保存图纸时，只要这张图在 `pcf_index` 里有记录，就忽略客户端传来的这几列。写后校验（`verifyWrite`）也要同时排除这几列，否则会被当成写入失败，进而反复重试。
   - 有 PCF 时，前端对应的输入框（[DrawingRow.tsx:174](../components/DrawingRow.tsx#L174)、[DrawingRow.tsx:301](../components/DrawingRow.tsx#L301)、[CommandBar.tsx:99](../components/CommandBar.tsx#L99) 等）改为只读，并提示"由 PCF 管理"。
4. **状态流转改由服务端负责**：
   - 新增一个服务端函数，负责图纸进入 Reviewing 时的轮次推进和截止日期计算。有 PCF 时，在同一个串行队列里同时更新 PCF 的 `currentRound`。
   - 前端改状态、导入船厂回复，都调用这个函数。它以 hub 原生接口的形式提供，也作为阶段 3 的第一步。
   - 前端可以用同一个 `lib` 函数先算出结果、即时显示，最终以服务端返回的结果为准。
5. **按字段保存**：
   - store 按图纸记录哪些字段改过，`PATCH` 只提交这些字段，服务端也只更新对应的列。过渡期间，服务端仍接受旧的整行格式，因为可能还有已经打开的旧页面。
   - 编辑模式的自动保存改为修改后等约 3 秒再保存（防抖）。原来按分钟间隔推送的定时器，可以留作兜底，也可以直接删掉。

### 完成标准

- 场景 A、B 的测试通过；场景 C 有明确结论，如果确实存在就一并修复。
- 轮次和截止日期各只有一份实现，并且有单测。
- 有 PCF 的图纸，这四列只能由 PCF 修改。

## 阶段 2：PCF 改为 JSON 存储

### 方案

推荐**存成 JSON 文件**：

- 正式数据存在 `data/pcf/<projectId>/<drawingId>.json`，历史快照存在 `.history/<drawingId>/<rev>-<时间>-<uuid>.json`。
- 现有机制都保持不变：每张图的串行队列、原子写（先写临时文件再 rename）、索引事务、崩溃修复、历史保留策略。唯一的区别是单个文件从约 544 KB 降到约 12.5 KB。
- 幂等回执仍然放在文档里，这样能保证回执和数据一起原子落盘。现在即使是空操作，确认回执也要重写整个文件；文件变小之后，这点开销可以忽略。
- 符合设计决策第 1、2 条：数据库仍然只存指针和摘要。
- 发给船厂的导出件、收到的船厂回复，本来就是要原样留存的往来文件，继续存成 HTML。

备选方案是把数据放进 SQLite（建 `pcf_documents` 等表）。好处是数据、索引和回执可以在一个事务里完成，"先写文件、再写数据库"的两段式提交和读取时的修复逻辑都可以删掉。代价是要推翻决策第 1 条。只有当两段式提交真正成为负担时，再考虑这个方案。

### 预期收益

- 文档存储从 209 MB 降到约 5 MB，历史快照从 66 MB 降到约 3 MB（按平均 12.5 KB 估算）。
- 单次请求的读取量从约 544 KB 降到约 12.5 KB，也不再需要用正则扫描文件。
- 模板和数据彻底分开：升级模板只要替换一个文件，不再需要用 `hub:upgrade-pcf` 批量改写所有文档。

### 任务

1. **先给数据库迁移加上版本号**：用 `PRAGMA user_version` 加编号的迁移文件，替换现在拼接式的做法。现在的做法有三部分：
   - `init-local.sql` 以一行中文注释为界，切成两段分别执行（[database.ts:53](../hub-server/src/database.ts#L53)）；
   - 启动时手写 `ALTER TABLE`；
   - 对 `audit-journal.sql` 做正则替换。

   现有表结构作为 001 号迁移，之后每次变更依次编号。这一阶段的一次性数据迁移，也靠它记录"已执行"。
2. **改造存储层**：
   - `PcfStorage` 的读写从 `parseHTML`/`replaceData` 改为直接读写 JSON。
   - 历史快照也改存 JSON。
   - 意见汇总（`comments-register.ts`）改为读取 `.json`。
   - 同步更新 `pcf_index.file_path`。
3. **渲染**：
   - 模板在启动时读入内存；开发模式下，模板文件修改后重新加载。
   - 页面 = 模板 + 数据 + `pahub-context`，和现在 v6 的渲染方式一样。
   - 可选：把解析后的数据按（项目，图纸，rev）缓存起来，避免在线状态更新这类请求反复解析。
4. **迁移脚本**（`npm run hub:migrate-pcf-json`，支持 dry-run）：
   1. 停止 Hub，备份整个 `data/`。
   2. 逐个解析 `.html`，写出 rev 相同的 `.json`，并做两项校验：JSON 和原文件里的数据完全一致；用当前模板重新渲染后，能解析回相同的数据。`upgradeFile` 里已经有类似的校验（[pcf-template.ts:24](../hub-server/src/pcf-template.ts#L24)）。
   3. 用同样的方法转换历史快照。
   4. 更新 `pcf_index.file_path`。
   5. 把原来的 HTML 目录整体改名保留（例如 `pcf-html-backup-<日期>`），不要删除。
   6. 输出统计。按本地数据，应为 394 份文档、220 份快照。
5. **离线副本**：
   - 现状有个问题：页面上的「Download HTML copy」「Export JSON」（[PG-PCF-hub.html:1556](../pcf/template/PG-PCF-hub.html#L1556)）和服务端的 `/download`，用的都是外发白名单（[pcf-exchange.ts:17](../hub-server/src/pcf-exchange.ts#L17)）。导出的副本里没有流转记录、审批历史和已删除记录；把这样的副本整份导回，系统里的这些历史也会被清空。
   - 改为提供两种副本：
     - **完整副本**：自己离线使用，只去掉 hub 内部字段（实体时钟、回执、clientId、IP），其余全部保留。
     - **外发版**：给船厂或其他第三方，继续使用现有白名单。
   - 导出完整副本时，和船厂导出一样，记录一条导出记录并保存一份基线快照。导回时，用这份基线做三方合并，而不是整份覆盖。
   - 新增 `npm run hub:export-pcf`，把一个项目的全部文档导出为完整副本 ZIP，可以用来备份，也可以用来回滚。
6. **（可选，往后放）把 hub 专用代码移出模板**：
   - 现在模板里内联了 hub 适配代码，服务端还会往页面里注入工具栏脚本和意见定位脚本。把这些代码统一移到一个外部 hub 脚本里，模板只保留稳定的扩展钩子。
   - 这样一来，前后端两处用正则剥离代码的逻辑（[pcf-exchange.ts:31](../hub-server/src/pcf-exchange.ts#L31)，以及模板里的 `hubStripScript`）都可以去掉，注入的脚本也能做类型检查了。
7. **更新文档**：修订 PAHUB_DESIGN.md 的决策第 7 条和"架构"一节，以及 README、MANUAL 中的备份说明。

### 回滚

保留迁移前的 HTML 目录和 `data/` 备份。`hub:export-pcf` 随时可以从 JSON 重新生成 HTML。如果需要回退，恢复备份目录、部署旧版本即可。

### 完成标准

- `hub:test` 全部通过（与存储相关的断言按 JSON 格式调整）。
- 394 份文档都能正常打开、编辑、导出，Send All、导入船厂回复等往来流程不受影响。
- 完整副本离线编辑后导回，流转记录和审批历史都还在。

## 阶段 3：把旧 Worker 并入 hub-server

### 问题

[worker/src/index.ts](../worker/src/index.ts) 原本是 Cloudflare Worker 的代码：一个 1577 行的单文件，没有开启 TypeScript strict。现在它通过 `D1Adapter` 跑在 `node:sqlite` 上，带来了下面这些问题：

- **路由、鉴权和错误格式不统一。** 各有好几套写法，比如错误响应既有纯文本的 `PASSWORD_REQUIRED`，也有 JSON 的 `{error}`。
- **变更通知靠事后推断。** Worker 处理完请求后，[app.ts:162](../hub-server/src/app.ts#L162) 还要再解析一遍请求体，推断哪些图纸变了，才能发出通知。`/admin` 页面则是靠字符串替换来改写 URL（[app.ts:179](../hub-server/src/app.ts#L179)）。
- **读数据多绕了一层，还有额外开销。** 先由 SQL 兼容视图把规范化表拼成 JSON，再交给 Worker 解析。另外，`D1Adapter` 为了模拟 D1 的返回信息，每次调用 `all()` 或 `run()` 都要多执行 5～6 条查询（[d1.ts:60](../hub-server/src/d1.ts#L60)）。

### 任务

1. 在 hub 里建立统一的路由表和中间件，负责 JSON 解析、统一的 `{error}` 错误格式和请求日志。0.1 里的 Basic Auth 开关也挪到这里。
2. 按模块逐个迁移。每个模块都按这个流程走：先在 hub 里实现；再做对比测试，同一请求分别发给旧实现和新实现，结果要一致；然后切换过去；最后删掉 Worker 里对应的代码。建议顺序如下：
   1. 图纸与项目（阶段 1 已经开了头）
   2. review-tracker
   3. audit、heartbeat
   4. settings、health
   5. admin
3. 变更通知改由写入数据的代码直接发出，删掉 `app.ts` 里推断请求体的逻辑。
4. 读接口改为直接查询规范化表。全部迁完后，删除 SQL 兼容视图、`D1Adapter`、`worker/` 目录和 `worker.d.ts`。
5. 所有服务端代码都开启 TypeScript strict。

### 完成标准

- `worker/` 目录已删除，`app.ts` 里只剩路由注册。
- 所有接口使用同一种错误格式。

## 阶段 4：前端整理

1. **统一的 `apiClient`**：
   - 由它统一处理 base URL、可选的鉴权头、错误解析和请求取消，再按领域拆成 `projectsApi`、`pcfApi`、`commentsApi`、`builderRepliesApi`。
   - 用它替换掉组件、`store.ts` 和 `App.tsx` 里 12 处直接调用 `fetch()` 的地方，以及 `services/comments.ts` 和 `HubApiRepository`。
   - 删掉只做转发的 `AppRepository`。
2. **拆分 `store.ts`**（目前 1240 行）：按项目数据与保存、review tracker、界面状态、在线状态拆成四个 slice，纯计算函数移到 `lib/`。
3. **测试**：`lib/` 的单测放进 `hub:test`，它已经可以直接 import `lib/`。
4. **可选**：把前端源码移到一个独立目录（例如 `web/`），前端的 tsconfig 也开启 strict。

### 完成标准

- 组件里不再直接调用 `fetch()`。
- `store.ts` 拆分后，每个 slice 职责单一，核心规则都有单测。

## 不在本计划内

- 账号、会话、角色体系。
- 多进程或集群部署。
- 项目密码和编辑密码的改造。这两个密码继续作为防误操作的开关保留，不当作安全措施。

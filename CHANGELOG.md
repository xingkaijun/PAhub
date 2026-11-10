# PAhub 更新记录

本文件记录 2026 年 11 月 9 日（北京时间）对 PAhub 做的一次代码审查和随后的 5 轮修改：每轮的目的、具体改动、接口和命令的变化、对使用者的影响、迁移步骤、测试结果和提交号。时间均为北京时间（UTC+8）。以后的更新请按同样的格式续写在最上面。

## 项目大厅：去掉翻书，加载页直接淡出（2026-11-10）

### 目的

老板反馈翻书和磨砂扫过的效果偏重，和大厅简洁的文字、卡片风格不协调。保留卡片放大成加载页这一段，Inventory 准备好后加载页直接淡出，不再翻书。

### 具体修改

- **动效（`components/lobby/lobbyMotion.ts`）：** 点卡片后，其余卡片按距离依次退开，选中的卡片放大成铺满屏幕的加载页（PG 标志、项目名、进度条），这一段和原来一样（约 0.56 秒）。原来的封面沿书脊翻开（1100 毫秒）和磨砂扫过（1700 毫秒）整段删除，改成加载页 **420 毫秒**淡出（只动 opacity，缓动 `cubic-bezier(0.4, 0, 0.2, 1)`），露出下面已经渲染好的 Inventory。`MOTION` 常量里的 `coverOpen`、`frostClear`、`frostHold` 去掉，`bookDelay`/`bookGrow` 改名 `sheetDelay`/`sheetGrow`，新增 `fadeOut`。系统开了“减弱动画”时照旧 160 毫秒淡入、160 毫秒淡出。
- **加载层（`ProjectLobby.tsx`、`lobby.css`）：** 去掉三层磨砂（backdrop-filter）、封面阴影、书脊和 3D 透视，加载页改名 `.pl-l-sheet`，外观（网格底、标志、项目名、进度条）不变。大厅的卡片、文字和悬浮效果没动。
- **流程不变：** 有密码的项目仍是加载页铺满后才弹密码框，服务器在密码正确前不返回项目数据；取消、密码错后取消、打开失败都会收起加载页回到大厅。
- **测试（`lobby-browser-smoke.mjs`）：** 逐帧记录淡出过程，检查淡出开始时 Inventory 已经渲染在加载页下面、页面里没有书/封面/磨砂元素、淡出只动 opacity 且透明度只降不升；新增“打开失败”用例（项目接口返回 503：弹出错误提示，加载页收起，大厅可再点，第二次点击正常进入）；密码用例加了一条：弹密码框时服务器没有返回过该项目的数据。

### 对使用者的影响

- 点项目卡片到进入 Inventory，本机测试电脑宽度约 1.3 秒、手机宽度约 1.2 秒（原来约 2.8 / 2.5 秒）。

### 测试结果

- 前端 tsc：EXIT=0；hub:build：EXIT=0；hub:test：EXIT=0，tests 258，pass 258，fail 0，cancelled 0，skipped 0；hub:e2e：EXIT=0，e2e 12，pass 12，fail 0。
- `lobby-browser-smoke.mjs`：1440 宽度加载页铺满约 0.8 秒、淡出后进入 Inventory 约 1.26 秒；390 宽度约 0.69 秒 / 1.16 秒；两种宽度淡出开始时 Inventory 都已渲染，透明度从 1 单调降到 0；减弱动画约 0.58 秒进入；控制台 0 错误，除密码校验预期的 401 外没有 4xx/5xx。

## 项目大厅改用蓝图方案，翻书展开放慢（2026-11-10）

### 目的

项目选择页（Project Access Hall）原来做了 4 个候选方案（潮汐、深海、蓝图、舰桥），用 `?lobby=1..4` 预览。定下蓝图方案作为正式大厅，去掉其余方案；按老板的反馈，把点卡片后的翻书展开放慢一些。

### 具体修改

- **正式大厅（`components/lobby/`）：** 打开平台默认就是蓝图大厅（图纸图框式卡片，带标题栏），不再需要 `?lobby` 参数，参数也不再识别。原来的旧版项目选择页、项目配色表 `PROJECT_THEMES` 和其余三个方案的组件、样式、动效全部删除；`variants/` 目录去掉，蓝图组件移到 `components/lobby/LobbyBlueprint.tsx`；`lobby.css` 只留共用部分和蓝图方案（约 500 行减到约 210 行）。功能入口不变：项目卡片信息、刷新、手册书本图标、Create Workspace（管理员）、离线模式、项目密码。
- **翻书动效（`components/lobby/lobbyMotion.ts`）：** 时长集中在 `MOTION` 常量里。卡片变成合着的书铺满屏幕这一段不变（约 0.56 秒）；封面从左侧书脊翻开 760 → **1100 毫秒**，磨砂边扫过 1250 → **1700 毫秒**，磨砂在封面刚抬起时稍停（5%）再跟上，和封面边缘保持同一节奏。磨砂边改成三层固定遮罩、只用 transform 平移（原来是每帧改遮罩位置），动画只涉及 transform、opacity 和 backdrop-filter 图层。系统开了“减弱动画”时照旧直接淡入。
- **有密码的项目（`App.tsx` 的 `handleSelectProject`）：** 现在返回是否打开成功。点卡片后先出现合着的书，书铺满屏幕后才弹密码框；密码错会再问一次，取消或打开失败时大厅恢复原样，所有卡片可以再点。以前密码框会在动效中途弹出，且要重新点卡片。
- **测试：** 新增浏览器测试 `lobby-browser-smoke.mjs`（已加进 hub:e2e）；`round5-browser-smoke.mjs` 里判断“还在项目选择页”的写法改成按大厅标题查找。

### 对使用者的影响

- 打开平台看到的就是新大厅。点项目卡片到进入 Inventory，电脑上约 2.4 秒变成约 2.8 秒，手机上约 2.1 秒变成约 2.5 秒（本机实测）。
- 有密码的项目：书合着时输密码，输对后书再翻开。

### 测试结果

- 前端 tsc：EXIT=0；hub:build：EXIT=0；hub:test：EXIT=0，tests 258，pass 258，fail 0，cancelled 0，skipped 0；hub:e2e：EXIT=0，e2e 12，pass 12，fail 0。
- 新增 `lobby-browser-smoke.mjs`：1440 和 390 宽度下不带参数即显示大厅，PG 标志分别为 84px 和 60px，刷新、手册、离线入口都在，大厅和 Inventory 都没有横向溢出；点卡片后书铺满屏幕约 0.7 秒、进入 Inventory 约 2.8 秒（电脑）/ 2.5 秒（手机）；有密码的项目在书铺满后才弹密码框，错密码再问一次，取消后回到大厅，正确密码进入 Inventory；减弱动画时约 0.6 秒直接进入；控制台 0 错误，除密码校验预期的 401 外没有 4xx/5xx。

## 中文操作手册做成平台页面（2026-11-10）

### 目的

把按 62ca2a5 / 66ebd15 写好的中文操作说明（19 节、22 张截图）放进平台，替换 Guide 页原来的中文部分，从界面上直接能打开。

### 具体修改

- **手册页 `/manual/`：** 新增 `public/manual/index.html`，构建时原样进 `dist/manual/`。原来以 base64 内嵌的 22 张截图拆成 `public/manual/img/*.jpg`（按所在章节命名，如 `pcf-1.jpg`），页面从约 1.1MB 降到约 70KB，图片懒加载。样式用平台的青绿色和字体；表格包在可横向滚动的容器里，`ol.steps` 用普通的编号列表，不再出现把文字挤成一窄列的问题；打印时隐藏顶栏和目录。“Guide”一节改成介绍这个手册页本身，其余内容不变。
- **Guide 页（`components/Manual.tsx`）：** 默认显示“中文手册”，用 iframe 嵌入 `/manual/`（嵌入时手册自己的顶栏会隐藏）；上方可切到 **English**，显示原 Guide 页的英文部分，内容没删；“新标签页打开”单独打开 `/manual/`。原 Guide 页的中文栏删除，由新手册代替。
- **其他入口：** 项目选择页的顶栏右侧加了书本图标；手机上没有标签栏，主表顶栏加了一个书本图标，都在新标签页打开 `/manual/`。手册页顶栏的“返回平台”回到 `/`。
- **服务器静态文件（`hub-server/src/http.ts`）：** 目录下有 `index.html` 时（如 `/manual/`、`/manual`）返回那个页面，不再落到平台首页。`index.html` 照旧 `no-cache`，手册图片 `max-age=3600`。
- **文档：** README 和 MANUAL.md 开头加了指向 `/manual/` 的说明，MANUAL.md 内容保留。

### 对使用者的影响

- 点顶栏 Guide 看到的是新的中文手册；要英文点 English。
- 手册可以直接把 `https://<平台地址>/manual/` 发给同事，不用登录。

### 测试结果

- 前端 tsc：EXIT=0；hub:build：EXIT=0；hub:test：EXIT=0，tests 258，pass 258，fail 0，skipped 0；hub:e2e：EXIT=0，e2e 11，pass 11，fail 0。
- 新增浏览器测试 `manual-browser-smoke.mjs`（已加进 hub:e2e）：`/manual/` 和 `/manual` 返回手册，23 张图（22 张截图加标志）全部 200 且是图片，页面里没有 base64；390px 单独打开时所有图片加载成功、没有横向溢出、编号步骤最窄 337px；在平台里 Guide 显示手册 iframe、图片加载成功，390px 时页面和 iframe 都没有横向溢出；English 切换正常；控制台 0 错误、0 个 4xx/5xx。
- `known-issues-browser-smoke.mjs` 里检查 Guide 中文内容的部分改成检查新手册。

## 修复操作说明里的 7 个已知问题（2026-11-10）

### 目的

按 main 62ca2a5 写中文操作说明时，在“已知问题”一节记下了 7 处和现状不符或容易出事的地方。这一轮全部修掉。

### 具体修改

1. **测试数据脚本 `scripts/seed-test-project.mjs` 能用了：** 原来调用已删除的整项目 PUT，返回 405。现在：
   - 项目、设置、图纸和 Review Tracker 走 `PATCH /api/projects/:id`（主表保存用的同一个按字段写入接口，不带版本号即直接写入）；PCF 照旧走 `create` + `PUT document`（importJSON）。
   - 服务器设了 `ADMIN_PASSWORD` 时，先 `POST /api/session` 登录取管理员 cookie；用法 `ADMIN_PASSWORD=<管理员密码> node scripts/seed-test-project.mjs [baseUrl]`。没给密码会直接提示怎么运行。没设 `ADMIN_PASSWORD` 的 Hub 不用登录。
   - 图纸 id 改成 `demo2684-dwg-001` 这样带项目前缀，避免和库里别的项目的 `dwg-001` 撞 id。
   - 可以重复运行：同 id 覆盖写入，项目里不属于脚本的图纸会被删掉，第二次运行结果和第一次一样。
2. **Guide 页（`components/Manual.tsx`）按现在的代码改正：** 中英文第 1 节重写为“服务器数据、保存与登录”：访客 / 管理员两种身份、哪些操作要管理员、`ADMIN_PASSWORD` 登录 12 小时有效、没设时人人是管理员；停 3 秒自动保存（只发改过的字段）、定时同步（Config 的 Auto-Sync Interval，默认 3 分钟）、Unsaved Changes 卡片上的 Save Now；实时推送；同一字段冲突时的黄色提示条。另外改了：指令栏需要管理员、`c:` 和 `v:` 对有 PCF 的图纸不适用；状态流转的说明（Waiting Reply → Reviewing 进下一轮）；Tracker 的 APR 和 Send All；意见数来自 PCF 自动统计；去掉 “Version 4.0-Cloud” “Secure Cloud” 等旧说法。
3. **Bulk Load 标题含逗号不再被截断：** 解析抽到 `lib/bulk-load.ts`。格式仍是“ID, 图号, 专业, 标题”，第三个分隔符之后的内容全部归标题；支持英文逗号和中文逗号；兼容 CSV 引号写法（`"Hatch cover, ""No. 1"""`）；从 Excel 复制来的制表符分隔行只按制表符分。不满 4 列的行跳过，并弹提示列出被跳过的行（原来是悄悄跳过）。
4. **主表删图纸先确认：** 垃圾桶按钮点了先弹确认框，写明图号、标题和 ID；点取消什么都不删（`lib/drawing-delete.ts`）。主表没有批量删除入口，指令栏也没有删除指令，所以只有这一处。
5. **Log 页 Export PDF 不再依赖外网 CDN：** 原来运行时从 cdnjs 加载 html2canvas 和 jsPDF。现在改成 npm 依赖 `html2canvas-pro` + `jspdf`，点导出时按需动态 import，构建成单独的本地 chunk，不进主包。用 `html2canvas-pro` 而不是 `html2canvas`，是因为后者不认 Tailwind v4 的 oklch 颜色，生成 PDF 会直接报错。报表和页头用的 PG 标志原来是外链 `i.postimg.cc`，也改成本地的 `/pg-logo.jpg`（放在 `public/`），纯内网下页头和 PDF 里也有标志。
6. **Tracker 的 Export CSV：** Drawing No 列现在是真正的图号（原来放的是 ID），另加 ID 列放自定义编号。列为 `No, ID, Drawing No, Title, Discipline, Status, Overdue, Deadline, 各负责人`。生成逻辑抽到 `lib/tracker-csv.ts`。
7. **作废导出（Void）和历史快照恢复要管理员：** 服务器上 `POST /api/pcf/:p/:d/exports/:id/void` 和 `POST /api/pcf/:p/:d/history/:rev/restore` 未登录返回 403 `Administrator permission required`，和其他项目级写入一致；没设 `ADMIN_PASSWORD` 时照旧人人可用。在线 PCF 的 Shipyard correspondence 面板里，访客看到的 Void 按钮是灰的，悬停提示“需要管理员权限”，面板说明里也加了一句。历史快照恢复目前前端没有按钮，只改了接口。

### 接口与命令变化

- Void、历史快照恢复两个接口现在要管理员会话（或 `API_TOKEN`）。
- `scripts/seed-test-project.mjs` 支持 `ADMIN_PASSWORD` 环境变量（也认 `PAHUB_ADMIN_PASSWORD`），演示项目的图纸 id 改成 `demo2684-dwg-NNN`。
- 新增依赖 `html2canvas-pro`、`jspdf`；新增静态文件 `public/pg-logo.jpg`。

### 对使用者的影响

- 访客不能再作废船厂导出，要先登录管理员。
- 删图纸会多一步确认。
- 以前用旧脚本灌过演示项目的库，再跑新脚本时，旧的 `dwg-NNN` 图纸会被当成多余的删掉，换成新 id 的同一批图纸（旧 id 上的 PCF 文件不会自动删）。

### 测试

- 新增 `hub-server/test/known-issues.test.ts`（4 条）：Bulk Load 标题逗号、引号 / 制表符 / 短行；Tracker CSV 的 Drawing No 和 ID 列；删除确认（取消不删、确认才删、提示里有图号和标题）。
- `permissions.test.ts` 新增 2 条：访客调 Void 和历史恢复都返回 403 且数据不变、管理员可以；没设 `ADMIN_PASSWORD` 时两者都开放。
- 新增浏览器测试 `known-issues-browser-smoke.mjs`（已加进 `hub:e2e`），在设了 `ADMIN_PASSWORD` 的真服务器上：跑种子脚本两次（100 张图纸、300 条意见、0 条警告，两次结果一致），没密码时退出码 1 并提示；Guide 中英文内容；Bulk Load 含逗号的标题完整存进服务器；删除确认框取消后图纸还在、确认后服务器上已删；Tracker CSV 的图号列；屏蔽所有外网请求后 Log 的 Export PDF 仍能生成 PDF；访客 Void 按钮为灰、接口 403，管理员在页面上作废成功。控制台错误 0 个，意外的 4xx/5xx 0 个。
- 结果：前端 tsc EXIT=0；hub:build EXIT=0；hub:test EXIT=0，tests 258，pass 258，fail 0，cancelled 0，skipped 0；hub:e2e EXIT=0，e2e 10，pass 10，fail 0。

## 权限重整：管理员密码 + 审图人员只能处理 PCF（2026-11-09）

### 目的

编辑模式原来只是前端用构建期 `VITE_EDIT_PASSWORD` 比较（没配则任何人可解锁），服务端几乎不检查写权限；Import Builder Replies 完全没锁，Activity/Daily Log 反而要解锁才能看。现在改为两种身份、服务端强制：审图人员无密码、只能只读浏览并在 PCF 内审图；管理员用服务端 `ADMIN_PASSWORD` 登录后才能做项目级写操作。

### 权限矩阵（最终实现）

| 操作 | 审图人员 | 管理员 |
| --- | --- | --- |
| 浏览项目/图纸/Comments/Activity/Daily Log、导出 | 允许 | 允许 |
| PCF 内写/改/关闭意见、编辑轮次与认可（保存 PCF 文档、ops、上传图片） | 允许 | 允许 |
| 修改图纸字段（状态/负责人/期限/版本等）、CommandBar 批量命令、删除图纸 | 禁止 | 允许 |
| Review Tracker 修改、Send All、同步/覆盖到服务器（PATCH 项目、PUT tracker） | 禁止 | 允许 |
| Bulk Load、Team Setup、Import Builder Replies（列表菜单、拖放） | 禁止 | 允许 |
| PCF 内 JSON 替换导入、应用船厂回复（imports）、Send All 打包（exports/batch） | 禁止 | 允许 |
| Settings、`/api/admin` 与管理控制台 | 禁止 | 允许 |

未授权调用以上写接口返回 403 `Administrator permission required`。

### 具体修改

- 新增 `hub-server/src/admin-session.ts`：`POST /api/session` 用常量时间比较校验 `ADMIN_PASSWORD`，失败按客户端地址限速（10 分钟内 5 次后返回 429 与 Retry-After）；成功发 `pahub_admin` httpOnly + SameSite=Strict 会话 cookie（生产/HTTPS 加 Secure），12 小时有效；`GET` 查状态、`DELETE` 登出。会话 HMAC 密钥在内存中，服务器重启即失效。`API_TOKEN` 仍用于机器调用，并视为管理员；`PAHUB_BASIC_AUTH` 行为不变。
- 服务端强制：项目 PATCH、review-tracker PUT、图纸状态接口、heartbeat PUT、builder-replies 全部操作、PCF `PUT document`（仅 `importJSON:true` 的整份替换）、PCF `POST imports`、PCF `exports/batch` 要求管理员；PCF 的 ops/普通文档保存/导出下载对审图人员开放。PCF 页面注入 `PAHUB.admin`，供页内隐藏导入入口。
- 未设置 `ADMIN_PASSWORD` 时所有人视为管理员（本地开发便利），启动日志打印 `WARNING`。
- 前端：删除 `VITE_EDIT_PASSWORD`（`vite-env.d.ts`、`.env.example`、文档）。`isEditMode` 改为服务端会话的镜像：启动时 `GET /api/session`，登录/登出走服务端。Edit 按钮改为 “Admin Sign-in”（列表与 Tracker）及顶栏身份胶囊（Reviewer/Administrator，点击登录或退出），新增 `AdminLoginDialog`；未登录时 Sync、Team Setup、Bulk Load、Import Builder Replies、CommandBar、行内编辑均置灰并提示“需要管理员权限”。Activity Report、Daily Log 对所有人开放只读；Settings 仍需管理员。PCF 页内 Import Builder Reply、Import JSON 对非管理员禁用。

### 接口与命令变化

- 新增 `GET|POST|DELETE /api/session`。
- 管理员写接口未登录返回 403（此前不校验）。
- Builder 回复上传现在除 `API_TOKEN` 外还需要管理员会话；仅用 token 的脚本需先 `POST /api/session` 取得 cookie。
- 不再读取 `VITE_EDIT_PASSWORD`。

### 测试

- 新增 `hub-server/test/permissions.test.ts`（7 条）：未登录写接口 403、登录后 200、错误密码 401 与限速 429、`API_TOKEN` 视为管理员、PCF 文档保存对未登录开放而 JSON 导入/回复 apply/Send All 需管理员、会话过期与重启失效。
- 更新 store、drawing-state、integration、exchange、pcf-complete-api 及其余测试的环境/登录方式；浏览器 smoke 增加 `ADMIN_PASSWORD: ''` 隔离，save-conflict smoke 改用新按钮。
- 相关测试逐项通过；`npm run hub:build` 成功（不再有动态+静态导入同一模块的警告），`npm run hub:test` **251/251 通过**，`npm run hub:e2e` **9/9 通过**。
- 另用生产构建在临时数据/随机端口实测：审图人员页 Sync/Team Setup/Bulk Load/Config 置灰、Activity/Log 可开、行字段只读；错误密码提示；正确密码后解锁并跨刷新保持；登出恢复；PCF 页审图人员可加意见但导入入口禁用，管理员可导入。

### 部署

- 生产必须设置 `ADMIN_PASSWORD`（未设置即所有人都是管理员）；其余环境变量无需新增。`API_TOKEN`/`PAHUB_BASIC_AUTH` 配置不变。
- 拉取新代码后执行 `npm run hub:build` 再重启；重启会使旧管理员会话失效，需重新登录。

## 紧急修复：旧 HTML PCF 自动迁移与失败回退（2026-11-09）

### 根因与改动

架构阶段 2 改为 JSON 权威存储，但生产数据仍为 HTML；此前打开页面遇到旧文件会返回 `Legacy HTML storage: stop Hub and run hub:migrate-pcf-json`，未安排离线迁移的部署无法打开 PCF。

- Hub 在监听前检测旧 HTML/混合存储并复用离线迁移流程；先备份 PCF 与 SQLite/WAL/SHM 到数据目录下带时间戳的 `backups/before-pcf-json-*`。
- staging 校验、目录安装、索引与版本提交维持原有回滚保护；兼容版本 2 残留 HTML、相同内容的双格式文件及中断恢复。冲突的原件不覆盖。
- 自动迁移失败时记录具体原因并保留旧文件；PCF 可回退 HTML 读取、编辑和原子保存，旧历史可恢复，回执不生成冲突 JSON。运行期间出现的旧文件也能回退；修正故障后重启自动重试。
- 原离线 CLI 与 dry-run 仍可使用；JSON-only 重启不重复迁移/备份；往来 HTML 不转换。

### 验证与部署

- 新增启动/真实 HTTP 故障测试 9 条：旧格式、混合版本 2、重复启动、提交失败、损坏快照、运行时旧文件、备份失败、外置数据库、冲突原件与中断恢复（其中部分场景合并在同一条测试）。
- 相关 PCF/历史/图片/回执回归通过；一次全量 `npm run hub:build` 成功，`npm run hub:test` **243/243 通过，0 失败、0 跳过**。构建有 Recharts 循环 chunk 警告，不影响命令成功。
- 另以生产构建 `server.mjs` 在临时数据/随机端口冒烟：旧 HTML 自动迁移，页面与编辑请求均 200，保存落盘，重启内容保留且不重复备份。
- 未访问 SGP0/PAhub-preview、未触碰 8080/8081/8082 服务或本地原始 `data/`。
- 生产需拉取新代码、执行 `npm run hub:build` 再正常重启；不需要额外手动运行迁移。请保证单进程使用该数据目录、写权限与备份/staging 所需空间，首启等待迁移日志。详见 [迁移与回滚](docs/PCF_JSON_MIGRATION.md)。

## 总览

| 轮次 | 主题 | main 变化 | 完成时间 |
| --- | --- | --- | --- |
| 审查 | 找可优化的地方 | 70a01e3（不改代码） | 11-09 早上 |
| 第 1 轮 | 主表并发保存不再互相覆盖 | 70a01e3 → ba5deee | 11-09 08:44 |
| 第 2 轮 | 设置按键保存、前端类型检查、浏览器测试 | ba5deee → 48997f9 | 11-09 09:12 |
| 第 3 轮 | 加载优化：去重复刷新、按 id 取图纸、ETag、压缩缓存 | 48997f9 → 76e5d61 | 11-09 09:56 |
| 第 4 轮 | PCF 图片单独存储、历史保留规则 | 76e5d61 → ab77b5a | 11-09 10:36 |
| 第 5 轮 | 收尾：D1 残留、小 bug、手机布局、船厂按钮、图标 | ab77b5a → 6d01971 | 11-09 11:11 |

测试数量变化：hub:test 从 194 条（193 通过、1 跳过）到 234 条（234 通过、0 跳过）；浏览器测试从 5 个里只有 1 个能过、且不在任何脚本里，到 `npm run hub:e2e` 的 9 个全部通过；前端类型检查从 4 个错误、不在流程里，到 0 个错误并纳入 hub:build 和 hub:test。

---

## 第 5 轮：收尾（2026-11-09）

提交：6d01971（main ab77b5a → 6d01971，已推送到 origin）

### 目的

处理审查清单里剩下的问题：D1 退役后的残留代码和测试、服务器 404 时前端仍打开本地旧数据、仍然保留的整项目覆盖写入接口、package-lock 写死镜像地址、手机上主表和在线 PCF 横向溢出、船厂不容易找到“另存一份”、网站图标 404。

### 具体修改

**D1 残留**

- 删掉一直被跳过的测试 "same project requests match frozen Worker before route cutover"。
- `GET /api` 和健康检查里的服务名从 `papc-d1-api` 改成 `pahub-api`，阶段从 `read-first` 改成 `native-sqlite`，接口列表换成现在实际有的（新增 `PATCH /projects/:projectId`、`GET /projects/:projectId/drawings?ids=` 等）。
- D1 迁移工具不再随默认的 `hub:build` 打包，源码保留。新增命令 `npm run hub:import-d1`，运行时临时打包一次再执行。`docs/d1-migration.md` 已同步。

**项目不存在（404）**

- `loadProject` 收到 404 时不再把本地那份项目当成服务器返回，而是报“项目不存在”：页面顶部出现红色提示条（例如 `Project "PG-GONE-H0000" does not exist on the server…`），停在项目选择页，不打开本地那份。
- 正开着的项目被别人删掉时，提示写 "no longer exists"。Send All 保存后回读核对时，也会直接报项目不在服务器上。
- 例外：刚用 New project 建好、第一次保存还没到服务器的项目，照旧打开本地那份；第一次保存成功后按正常项目处理。

**整项目 PUT**

- 前端已没有任何地方调用 `PUT /api/projects/:id`；导入和管理后台导入走服务器内部的写入函数，不经过这个接口。因此删除了 HTTP 的 PUT，现在请求返回 405。写入函数保留给导入用，默认来源改为 `import`。

**npm 镜像**

- package-lock.json 里 36 条华为云地址改回 `registry.npmjs.org` 官方地址，校验值没有改动。
- 新增 `.npmrc`，默认指向华为云镜像，国内安装依赖仍走华为云。要用官方源：`npm ci --registry=https://registry.npmjs.org/`。两种方式都在干净目录里测过 `npm ci`，各装 184 个包，装完后 lock 文件没有被改动。

**手机布局**

- 主表工具栏改成和可视区域同宽、固定在左边、可以换行，搜索框占满一整行。Import Builder Replies、Print List、Team Setup、Bulk Load 四个按钮在手机上收进 "More" 菜单。桌面布局不变（搜索框仍是 288px，所有按钮直接显示）。
- 在线 PCF 收起的菜单不再占位置；展开时如果超出屏幕会自动挪回屏幕内。给船厂的离线 HTML 用同一个模板，一起修好。

**船厂主按钮**

- 船厂文件的黄色提示条旁边新增绿色主按钮 "Save copy to return"，作用同 "Save options > Save as"：Chrome、Edge 弹出保存对话框，其他浏览器直接下载。以前导出的船厂文件打开时也会自动补上这个按钮。打印时不显示；船东和平台模式下没有这个按钮。

**网站图标**

- 新增 `public/favicon.svg` 和 `public/favicon.ico`（绿色底加打勾的文件图标），`index.html` 中声明。`/favicon.ico` 现在返回 200。

### 接口和命令变化

- `PUT /api/projects/:id`：删除，返回 405。
- `GET /api`、`/api/health`：服务名 `pahub-api`，阶段 `native-sqlite`。
- 新增 `npm run hub:import-d1 -- <导出.sql 或 .json> --db <新目录>/papc.db`（需要 Node 24）。

### 对使用者的影响

- 在这次更新之前用 New project 建了项目、但一直没有保存成功的，现在打开会提示“不存在”（它没有新加的“新建未保存”标记）。本地数据不会丢，只是打不开。

### 测试和验证（main 6d01971）

- 前端 tsc：EXIT=0。
- hub:build：EXIT=0。
- hub:test：EXIT=0，tests 234，pass 234，fail 0，skipped 0。删掉了 1 条跳过的测试，新增 5 条（`project-not-found.test.ts`：404 报错、不存在提示、新建项目照常打开、Send All 回读、PUT 已删除）。
- hub:e2e：EXIT=0，e2e 9，pass 9。新增 `round5-browser-smoke.mjs`：390px 宽时主表、More 菜单、在线 PCF、船厂文件（含三个菜单分别展开）页面宽度都正好 390；1440px 宽时都是 1440；船厂主按钮可见且能另存；favicon 返回 200；项目不存在提示正常；控制台 0 个错误，意外的 4xx、5xx 为 0。
- 调整的旧测试：system-migration（检查新服务名）、api-client（404 期望改为报“项目不存在”）、send-all（改用按字段保存）、integration（PUT 返回 405）、drawing-state（直接调用导入用的写入函数）、exchange e2e（点新的主按钮）。

### 没有验证的

真手机、Safari、Windows 上的实际显示都没测过。推送 main 不会自动部署上线。

---

## 第 4 轮：PCF 图片单独存储和历史保留（2026-11-09）

提交：df5c02c、a6fe4ef、0599864、88a1770、fbca0bc、4906ca5、ab77b5a（main 76e5d61 → ab77b5a）。ab77b5a 只加了说明文档 `docs/PCF_IMAGE_STORAGE.md`。

### 目的

审查发现 PCF 图片以 base64 内嵌在 JSON 里：每次保存都要读写整份 JSON，并把整份旧文件复制进历史；历史保留最近 50 份，另外每天永久留一份。带图越多，保存越慢，历史目录涨得越快。

### 具体修改

**服务器存储**

- 新增 `hub-server/src/pcf-images.ts`：每张图按解码后字节的 sha256 存成一个文件，路径 `data/pcf/<项目>/.images/<哈希前两位>/<哈希>.<png|jpeg|webp>`。同一项目内同一张图只存一份，不同图纸共用。
- PCF JSON 和历史快照里只存引用 `{ id, name, mime, hash, width, height }`，不再有 base64。
- 旧格式（内嵌 base64）照常能读：读取时在内存里换成引用并补齐图片文件，下次保存时写成新格式；旧快照恢复也可以。

**在线 PCF 和接口**

- 新增取图接口 `GET /pcf/<项目>/<图纸>/images/<哈希>`，权限与页面相同（Bearer、页面 Cookie 或 `X-PCF-Token`），缓存头 `Cache-Control: private, max-age=31536000, immutable`。
- 粘贴或上传的新图仍以 data URL 随保存提交，服务器落成文件后换成引用；引用一个服务器上没有的哈希会被拒绝（400）。
- 模板 `pcf/template/PG-PCF-hub.html` 增加按引用显示图片；页面里的 Excel、打印版 Excel、外部版和 JSON 导出，先在浏览器里按哈希取回图片再内嵌（fbca0bc 修了 JSON 导出没有内嵌的问题）。

**船厂往来**

- 给船厂的离线 HTML 和完整副本导出时把图重新内嵌，文件仍然自包含。
- 导回时先把回传文件里的图落盘，再按引用比较，同一张船东图不会被误判为“船东内容被改”（ownerTampered）；船东图真被换掉时照样能查出来。

**历史保留规则**（按保存时间从新到旧，日期按项目时区）

1. 最近 50 份一律保留（`PCF_HISTORY_RECENT_LIMIT`）。
2. 30 天以内每天保留最后一份（`PCF_HISTORY_DAILY_DAYS`）。
3. 30 到 180 天每个 ISO 周（周一开始）保留最后一份（`PCF_HISTORY_WEEKLY_DAYS`）。
4. 180 天以前每个自然月保留最后一份。

### 新增命令和迁移步骤

新增 `npm run hub:migrate-pcf-images`，一次性把旧数据转成新格式。上线时：

1. 停掉 Hub，把整个 data 目录备份一份。
2. 试跑，只统计不写：`npm run hub:migrate-pcf-images -- --data-dir <数据目录> --dry-run`
3. 实跑：`npm run hub:migrate-pcf-images -- --data-dir <数据目录> --hub-stopped`
4. 启动 Hub，确认无误后可删除备份目录 `<数据目录>/pcf-image-migration-backup/<时间>/`。

迁移会扫描 `pcf/<项目>/*.json` 和 `pcf/<项目>/.history/<图纸>/*.json`，只处理含内嵌图片的文件：先原样复制到备份目录，再写图片文件，核对“换成引用再内嵌回去”与原文件完全一致，最后用临时文件加改名替换；快照文件名和修改时间不变。可以重跑，第二次转换数为 0，不再产生备份。

### 对使用者的影响

- 旧快照会被清理：以前每天永久留一份，现在 30 天以前改为每周一份、180 天以前每月一份。每张图纸下次保存时按新规则删除多出来的旧快照，所以上线前务必先备份 data 目录。
- 不再被引用的图片不会自动删除（这一轮没做回收）。
- 没迁移的旧文件每次打开都要在内存里转换一次，磁盘变小、打开变快要靠跑迁移。
- 页面里的导出要先从服务器取图，会慢一点。单次请求上限仍是 51MB。

### 改前改后对比

测试条件：20 张 1 到 3MB 的图（合计 41,943,040 字节），连续保存 10 次、每次只改一点文字、换不同的人保存。测速脚本 `hub-server/test/image-storage-measure.mjs`。

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 单次保存平均耗时 | 4,375 毫秒 | 7 毫秒 |
| 上传 20 张图（4 次请求合计） | 11,176 毫秒 | 1,001 毫秒 |
| PCF JSON 文件大小 | 55,935,135 字节 | 11,895 字节 |
| 历史目录（13 份快照） | 559,340,556 字节 | 108,156 字节 |
| 再次打开在线 PCF | 42,240,892 字节 | 253,163 字节 |

改后图片目录为 20 个文件、41,943,040 字节，只存一份。第一次打开在线 PCF 仍要下载全部图片（约 42MB），之后走浏览器缓存。

### 测试和验证（main 上）

- 前端 tsc：EXIT=0。hub:build：EXIT=0。
- hub:test：EXIT=0，tests 230，pass 229，fail 0，skipped 1。新增 5 条（`pcf-images.test.ts`）：落盘、去重、快照无 base64；旧格式兼容；迁移的备份、来回核对、重跑不改动；新保留规则（400 天、800 份快照）；取图接口和导出导回整条流程。exchange-edge 里船厂回复图的期望值从 data URL 改成引用。
- hub:e2e：EXIT=0，e2e 8，pass 8。新增 `images-browser-smoke.mjs`：在线 PCF 粘贴图片并保存为引用；重新打开按哈希取图、缓存头 immutable；打印版 Excel 含图；导出给船厂、离线打开看到图、船厂粘贴回复图；导回预览 2 条自动合并、0 条冲突、无误判；合并后两张图都显示，JSON 无 base64，页面报错 0 个。

### 没有验证的

用真的 Excel 或 WPS 打开导出文件、Safari、在线上真实数据上跑迁移都没测过；迁移只在测试数据和测速临时数据上跑过。

---

## 第 3 轮：加载优化（2026-11-09）

提交：76e5d61（main 48997f9 → 76e5d61）

### 目的

审查实测（3000 张图纸，每次完整项目约 2.9MB）：打开一个项目会完整拉取 3 次、读 Tracker 3 次；从 Tracker 切回 Drawings 又多拉 2 次；别人每保存一次 PCF，每个开着页面的人都要再拉一次整个项目。服务器不压缩，带哈希的 JS 只缓存 1 小时。本机感觉不到，但经 frp 走公网、多人同时用时会明显变慢。

### 具体修改

**前端**

- 实时连接不再依赖当前标签页，切 Tracker 和 Drawings 不会断开重连。
- 挂载时不再整拉项目，连接建立时只用 ETag 做一次“有没有变”的补拉；打开项目时这次一般返回 304。
- Tracker 每个项目只读一次，之后靠实时连接保持最新；Tracker 页的 Refresh 按钮仍会强制重读。
- 收到 `drawing-changed` 事件时只按 id 取变化的图纸，用原有合并逻辑（保留未保存的字段和 rev、base）合进页面。一次变化超过 200 张或按 id 取失败时，退回整拉一次（同样带 ETag）。
- `projectsApi` 带 `If-None-Match`，收到 304 时页面什么都不改；两份相同的请求同时发出时只发一次。

**服务器**

- 新增 `GET /api/projects/:id/drawings?ids=a,b,...`：一次最多 500 个 id，返回格式和版本号与整个项目读取一致，列出已删除的 id，附带这些图纸的 Tracker 数据；有项目密码时要在 `X-Project-Password` 里带密码。
- 读项目和读 Tracker 的接口加 ETag，数据没变时返回 304（新文件 `hub-server/src/etag.ts`）。
- `hub-server/src/http.ts`：JSON、HTML、JS、CSS 等文本 1KB 以上压缩，浏览器支持 br 用 br，否则 gzip，带 `Vary`；图片、xlsx、zip、字体和实时连接不压缩。静态文件只压缩一次后缓存在内存里。`/assets/` 下带哈希的文件改为 `public, max-age=31536000, immutable`，`index.html` 仍是 no-cache。
- 在线 PCF 只做了压缩，模板没有拆分。

### 改前改后对比

3000 张图纸的临时库，Chromium 实测，字节数含响应头。测速脚本 `hub-server/test/load-measure.mjs`。

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 打开项目 | 完整拉 3 次，全部接口 11 次、5,683,940 字节 | 完整拉 1 次 + 304 一次，全部接口 9 次、70,365 字节 |
| 切 Tracker 再切回 | 16 次请求、7,579,854 字节 | 0 次请求 |
| 别人保存 PCF | 整拉 1 次 1,893,483 字节 + 读 Tracker | 只取 `?ids=dwg-001`，1,488 字节 |

传输大小（不压缩 → gzip → br）：主 JS 362,283 → 108,059 → 92,666 字节，并改为缓存一年；CSS 105,033 → 15,743 → 12,586 字节；项目数据 1,893,136 → 100,547 → 66,708 字节；在线 PCF 610,724 → 259,054 → 249,928 字节（仍 no-store）。

### 测试和验证（main 76e5d61）

- 前端 tsc：EXIT=0。hub:build：EXIT=0。
- hub:test：EXIT=0，tests 225，pass 224，fail 0，skipped 1。新增 7 条（`load-optimization.test.ts`）：ETag 和 304；按 id 取图纸（密码、上限、已删 id）；压缩头；缓存头；按 id 合并与整拉合并结果一致；304 时页面不变；前端 If-None-Match 和请求合并。
- hub:e2e：EXIT=0，e2e 7，pass 7。新增 `load-browser-smoke.mjs`：打开项目完整拉 1 次 + 304 一次；切标签 0 次请求、实时连接保持 1 条；别人保存只取 `?ids=dwg-001` 且新标题出现；无变化补拉时项目和 Tracker 都是 304；主 JS 为 br 压缩加一年缓存。

### 遗留

- Tracker 打开时仍会读 2 次（每次约 792 字节）。
- 按 id 合并之后的下一次补拉会再完整拉一次项目（br 压缩后约 67KB），之后才是 304。
- 在线 PCF 每次打开仍要下载约 250KB；服务器 br 压缩的耗时、线上 Caddy 是否重复压缩都没测。

---

## 第 2 轮：设置按键保存、前端类型检查、浏览器测试（2026-11-09）

提交：ef64f25、aa1c899、48997f9（main ba5deee → 48997f9，第 1 轮的 ba5deee 随本轮一起快进进 main）

### 目的

审查发现：改任何一项设置都会把整份 conf 发上去，两人同时改不同设置项时后保存的会覆盖先保存的；删除备注按文字匹配，同一张图有两条相同文字的备注时会一起被删；前端类型检查不在任何流程里，已有 4 个错误；5 个浏览器测试只有 1 个能过，而且没有脚本运行它们。

### 具体修改

**项目设置按键保存（ef64f25）**

- 前端保存时只发改过的设置项（`conf`），同时带上它们改之前的值（`confBase`）。
- 服务器新增 `hub-server/src/project-config-merge.ts` 做三方比对：存储值仍等于改前值、或已等于新值时接受。专业默认审图人（`disciplineDefaults`）和专业默认分配（`defaultAssignees`）按专业逐个比对，两人改不同专业都保留。
- 改了同一项时返回 409 `CONFIG_CONFLICT`，整批（包括同一批里的图纸）都不写入。图纸和设置同时冲突时，`DRAWING_CONFLICT` 里会同时带 `confConflicts`，前端在一条提示里一起说明。
- 前端把冲突项换成服务器最新值，其他修改保留、下次自动保存再发；顶部黄色提示条写“保存冲突：项目设置（A 轮周期）……”。
- 删除备注改为按 id 删除，只删点中的那一条。命令栏里“去掉某个标签”的效果不变。
- 修掉前端 4 个类型错误（BuilderRepliesImport.tsx、DrawingList.tsx），前端 `tsc --noEmit -p tsconfig.json` 加进 `hub:build` 和 `hub:test`。

**样式和浏览器测试（aa1c899）**

- `index.tsx` 补上 `import './index.css'`：此前 main 构建出的页面里没有 Tailwind 样式。
- exchange：先打开 Save 旁的下拉再点 Save as。phase8：原工具栏已合进统一工具栏，改为检查新工具栏。phase9：不再需要 data-p9，默认用测试数据建库（原来用 `PAHUB_DATA_DIR` 指定数据副本、8082 端口的用法仍可用）；Comments 页现在跟着平台浅色主题，改为检查它不会变暗色。v26 等改用 Playwright 自带的 Chromium，不再要求装 Google Chrome。

**hub:e2e 和冲突浏览器测试（48997f9）**

- 新增 `npm run hub:e2e`：先构建，再依次运行全部浏览器测试。环境变量 `PAHUB_E2E_SKIP_BUILD=1` 复用现有构建，`PAHUB_BROWSER_CHANNEL=chrome` 改用本机 Chrome，可在参数里按名字挑选测试。新机器先执行一次 `npx playwright install chromium`。
- 新增 `save-conflict-browser-smoke.mjs`：两个真浏览器页面连真服务器。改同一字段时 B 返回 200、A 返回 409，黄色提示条出现，数据库保留 B 的值；改不同字段时两边都 200、两个值都保留、没有提示。

### 对使用者的影响

- 没带 `confBase` 的设置保存（从备份恢复、还没刷新的旧页面）照旧直接写入，不受冲突保护。

### 测试和验证（main 48997f9）

- 前端 tsc：EXIT=0（改前 EXIT=2，4 个错误）。hub:build：EXIT=0。
- hub:test：EXIT=0，tests 218，pass 217，fail 0，skipped 1。新增 11 条：6 条 API 测试（`config-conflict.test.ts`）、5 条前端测试（`config-conflict-store.test.ts`）。
- hub:e2e：EXIT=0，e2e 6，pass 6。
- 设置冲突只有 API 测试和前端模拟测试，没有在真浏览器里测过；图纸冲突在真浏览器里测过。

---

## 第 1 轮：主表并发保存不再互相覆盖（2026-11-09）

提交：ba5deee（分支 wip/save-conflict，基于 main 70a01e3；第 2 轮时快进进 main）

### 目的

审查时用接口复现了 P0 问题：B 改了 dwg-001 的标题并加了一条备注，A 拿着打开时的旧数据只改了专业，结果标题变回原样、B 的备注也没了，两次保存都返回 200，没有任何提示。原因是前端按字段记脏的 `_dirtyDrawingFields` 从未被写入，每次都把整张图纸的所有字段发给服务器；服务器 PATCH 不核对版本；备注整组删除再重写。

### 具体修改

**前端**

- 每张图纸只发改过的字段，并带上 `baseRev`（打开时服务器给的版本号）和这些字段改之前的值（`base`）。
- 备注改为按条发送 `remarkOps`：`add`、`update`、`remove`，不再整组发。
- 收到 409 时：冲突字段换成服务器最新值，其他修改保留、下次自动保存再发；顶部出现黄色提示条（例如“保存冲突：001（标题）已被其他人先修改……”），然后自动重新载入项目。

**服务器**

- 新增 `hub-server/src/drawing-revision.ts`：版本号 `rev` 由图纸字段、审图人和备注计算（sha1 取前 16 位），在线 PCF、管理后台、导入的写入都会让它变化，不需要改数据库结构。读项目接口每张图纸多返回一个 `rev` 字段。
- 一次 PATCH 里的所有图纸先全部加锁，在同一个 SQLite 事务里先查版本再写：版本没变直接写；版本变了但改的是别的字段（存储值仍等于 `base` 或已等于新值），两边都保留；改的是同一字段则返回 409 `DRAWING_CONFLICT`（附最新数据），整批回滚。图纸已被别人删掉时也返回 409，不会重新建出来。
- 备注逐条写入，没动的备注不受影响；改了别人已删除的备注、删除别人刚改过的备注，都算冲突。旧的整组发法现在只删除列表里没有的那几条。
- 4xx 错误响应保留结构化内容（`code`、`conflicts` 等）。

### 对使用者的影响

- 不带 `baseRev` 的保存（新建图纸、导入、旧版前端）照旧直接写入。上线后仍开着旧页面没刷新的人，保存时仍可能覆盖别人的改动，刷新一下即可。

### 测试和验证

- hub:build：EXIT=0。
- hub:test：EXIT=0，tests 207，pass 206，fail 0，skipped 1（改前 194 / 193 / 1）。
- 新增 13 条：9 条 API 测试（`save-conflict.test.ts`，含 A/B 复现：A 只改专业时 B 的标题和备注都在；A 像旧版那样整张发送则 409、数据库不变；同批一张冲突整批回滚；备注增删改；两人改不同备注能合并；改同一条备注 409；图纸被删后保存 409），4 条前端测试（`save-conflict-store.test.ts`）。
- 调整 1 条旧测试：读项目接口的格式对比先检查新增的 `rev` 存在且格式正确，再去掉它比较其余部分。
- 当时前端 tsc 仍是原有的 4 个错误（第 2 轮修复）。

---

## 审查：main 70a01e3（2026-11-09）

审查对象是当时 main 最新提交 70a01e3（北京时间 11 月 9 日 07:39，"docs: record phase 4 frontend cleanup verification"）。方式是读代码、跑构建和全部测试，再用本机 Chromium 和临时数据库跑主流程。审查本身没有改代码。按要求，安全相关问题不在这份清单内。

确认没问题的：PCF 和船厂往来的整条流程（在线 PCF 保存、导出给船厂、船厂离线填写、导回三方合并、只读内容校验）实际跑通，没有页面报错。后端已是 Node 加 SQLite、PCF 存为 JSON 文件，不再使用 Cloudflare D1。

发现的问题和处理轮次：

| 优先级 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 主表保存按整张图纸覆盖，并发编辑丢改动 | 第 1 轮 |
| P0 | 项目设置整份覆盖；删备注按文字匹配 | 第 2 轮 |
| P1 | 整个项目被反复全量重新拉取 | 第 3 轮 |
| P1 | 没有压缩，静态资源缓存太短 | 第 3 轮 |
| P1 | PCF 图片内嵌在 JSON 里，历史整份复制 | 第 4 轮 |
| P1 | 前端类型检查不在流程里，4 个错误 | 第 2 轮 |
| P1 | 浏览器测试大多失效、没有脚本 | 第 2 轮 |
| P1 | D1 退役后的残留 | 第 5 轮 |
| P1 | 404 时打开本地项目；整项目 PUT；lock 写死镜像 | 第 5 轮 |
| P2 | 手机主表横向溢出；在线 PCF 多出 34px 横向滚动 | 第 5 轮 |
| P2 | 船厂“另存一份”藏在下拉里；网站图标 404 | 第 5 轮 |

审查时的基线：hub:build EXIT=0；hub:test 194 条，193 通过，1 跳过；前端 tsc 4 个错误；浏览器测试 5 个里 1 个通过。

---

## 还没做的

- 在线 PCF 模板拆成可缓存的静态文件加单独的数据（现在每次打开约 250KB）。
- 不再被引用的 PCF 图片回收。
- Tracker 打开时读 2 次；按 id 合并后的下一次补拉仍会完整拉一次项目。
- 确认线上 Caddy 是否也开了压缩，以及 br 压缩的服务器耗时。
- 不带版本号或改前值的旧页面保存仍不受冲突保护。
- 登录和权限这几轮没有处理。
- 用真的 Excel、WPS 打开导出文件，在真实数据上跑图片迁移，真手机和 Safari 上的显示，都还没验证。

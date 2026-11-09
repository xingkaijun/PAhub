# PAhub 使用手册

> 完整的中文操作手册（19 节，带截图）已经放进平台：顶栏 Guide 默认显示，也可以直接打开 `/manual/`（源文件 `public/manual/index.html`，截图在 `public/manual/img/`）。本文件保留为部署和功能要点的简要说明。

## 启动

需要 Node.js 24。首次运行 npm ci，然后 npm run hub:build；设置服务端环境变量后运行 npm run hub:start。默认地址 http://localhost:8080，局域网用户使用主机 IP。服务器不会自动读取 .env；Vite 的 VITE_ 值在构建时读取。

建议设置 ADMIN_PASSWORD、API_TOKEN；前端 VITE_DATA_API_TOKEN 须与服务器一致后重新构建。ADMIN_PASSWORD 同时用于管理员登录、管理后台和需要管理员的 PCF 操作；未设置时所有人视为管理员（仅适合本地开发，启动日志会告警）；不设置 API_TOKEN 时所有接口匿名可用；公网暴露时可用 PAHUB_BASIC_AUTH 开启 Basic Auth（见 README）。共享 API token 不是个人账号，局域网 HTTP 不加密凭据。数据目录由 PAHUB_DATA_DIR 指定，默认 data；数据库默认为该目录的 papc.db。

## Comments：全项目意见汇总

选择项目后点击顶部 Comments，无需进入 Edit。统计卡片、专业/轮次/账龄图和意见清单只汇总已有 PCF 的图纸，正文仍以各 PCF JSON 为准，不另存入数据库。损坏文件会显示 drawing warnings，其他图纸仍可查看。

选择专业、图纸状态、意见状态、轮次、实际意见标签、未关闭天数，或输入全文关键词，然后点击 Apply filters；Reset 清除筛选。标签自动包含 Cost Affect 等新增值。全文搜索覆盖所有有效轮次；表格显示最新有效轮次及最近非空正文，Builder 回复摘要最多 200 字。点击列头排序，用 Rows per page 和翻页按钮查看更多意见。

点击整行、图号或意见编号，在新标签页打开 PCF 并高亮该意见。不存在的 ID 仍可正常打开 PCF；有鉴权的服务器仍使用原有 PCF token 登录流程。Export Excel 导出当前已应用筛选的全部结果及统计，不限当前页，也不包含托管凭据或图片内容。超长意见按 Record key / Part / Parts 续行保留完整文本。

收到项目变更通知只显示 Refresh 提示，不自动重载整张表。先 Refresh 再导出可确保看到最新意见。Comments 跟随操作系统深浅主题。

## 身份与权限

系统只有两种身份，不按人分账号：

- **审图人员**（无密码）：打开站点即为审图人员。可浏览项目、图纸列表、Comments、Activity Report、Daily Log（均只读），可导出报表；在 PCF 页面内可正常审图、写/改/关闭意见并保存。不能做任何批量或项目级写操作。
- **管理员**（输入管理员密码）：在页面右上角或列表、Tracker 的 Admin Sign-in 输入服务端 `ADMIN_PASSWORD`。登录成功由服务端设置 12 小时会话（httpOnly、SameSite=Strict），页面据此解锁；再次点击可退出登录。会话以服务端为准，刷新页面后仍然有效，服务器重启后失效。会话 cookie 仅在请求为 HTTPS 时附加 Secure：直连 HTTPS，或经反向代理且 `X-Forwarded-Proto` 首项为 `https`（不依据 `NODE_ENV` 判断）。

| 操作 | 审图人员 | 管理员 |
| --- | --- | --- |
| 浏览项目/图纸/Comments/Activity/Daily Log、导出 | 允许 | 允许 |
| PCF 内写/改/关闭意见、编辑轮次与认可（保存 PCF 文档） | 允许 | 允许 |
| 改图纸状态/负责人/期限/版本、CommandBar 批量命令、删除图纸 | 禁止 | 允许 |
| Review Tracker 修改、Send All、同步/覆盖到服务器 | 禁止 | 允许 |
| Bulk Load、Team Setup、Import Builder Replies（列表菜单、拖放） | 禁止 | 允许 |
| PCF 内 JSON 替换导入、应用船厂回复、Send All 打包 | 禁止 | 允许 |
| Settings、/api/admin 与管理控制台 | 禁止 | 允许 |

未登录时上述管理员按钮置灰并提示“需要管理员权限”。服务端同样强制：需要管理员的写接口在未授权时返回 403，不能靠前端绕过。未设置 `ADMIN_PASSWORD` 时所有人都是管理员（本地开发便利），启动日志会打印警告；对外部署务必设置。`API_TOKEN` 仍用于机器调用，视为管理员；`PAHUB_BASIC_AUTH` 行为不变（管的是能否进站）。

## 编辑锁与保存

选择项目后默认以审图人员身份只读；点击 Admin Sign-in 登录管理员后解锁上述写操作，退出即恢复只读。列表的修改先进入浏览器脏数据，再由手动同步或自动同步保存；不要将“界面已更新”当作“服务器已保存”。切换项目前处理未保存提示。

## 图纸列表

维护图号、标题、专业、责任人、版本、轮次、期限与状态；支持过滤、排序和历史记录。PCF 会同步总意见数、未关闭意见数、轮次、版本及项目更新时间，不直接覆盖图纸工作流状态。

## Review Tracker 与 Send All

Reviewing 图纸按责任人的完成检查分成 Ready 与待审。Ready 图纸的 APR 仅由手动点击设置，只读取 tracker 中的 `__approved__` 记录，与 PCF 认可状态无关。

Send All 点击时计算图纸目标状态，并读取一次 PCF /index 计算打包数量：APR 为真则 Approved，否则 Waiting Reply。确认框提示有 PCF 的数量及跳过数量。保存成功且回读校验通过后，才请求船厂版 ZIP；所有已有 tracker 记录（含 APR）置为 false，不删除 APR。操作期间按钮禁用，打包阶段显示 Packing...。

ZIP 含每张有 PCF 图纸的船厂版 HTML 和带 BOM 的 manifest.csv；无 PCF 跳过且注明 no PCF。图号非法文件名字符换成 -，同名加 _2 等后缀。导出取调用时服务器最新版本。打包失败不回滚已发送状态，顶部提示“状态已发送，但打包下载失败”，可点击“重新下载本次打包”。同一批次不会重复创建导出记录；重下载按钮仅保存在当前页面内存，刷新页面后不保留。没有自动发邮件。

## PCF 在线编辑

点击图纸标题在新标签页打开 PCF。在线编辑意见、轮次和认可状态；修改通过细粒度保存提交，冲突时比较双方内容后选择。在线人数与软锁是提示，不替代权限控制。离线或失败时按 PCF 页面提示恢复待提交内容，确认服务器回执后再关闭。

## 导出与导入船厂回复

单张或 Send All 导出均生成船厂版：Owner 和非可写内容锁定，只能填写当前轮次未关闭意见的 Builder 回复。船厂保存 HTML 后回传，系统不负责邮件发送。

在 PCF 的 Exchanges 中上传回传 HTML，先 Preview，检查自动合并、冲突和忽略项，再确认导入。Owner 不导入；只读内容被改会显示完整性警告，需要管理员确认才能忽略其改动。服务器在预览后改变会要求重新预览。不要打开不可信来信执行脚本，应直接上传解析。HMAC 是篡改检测，不是加密或身份签名。

## 备份与恢复

建议在无人编辑时停止 Hub，备份整个数据目录：数据库、权威 PCF JSON、JSON 历史、导出基线、导入回执及 .pcf-export-key。仅复制数据库不能完整恢复 PCF 往来。恢复时停止 Hub，再替换已核实的完整数据目录。密钥需与基线一起恢复；备份目录应限制访问。旧系统一次性迁移见 docs/d1-migration.md。

## 完整离线副本与外发版

PCF 的 Download HTML copy 与 Export JSON 用于自己的完整离线副本：保留流转记录、审批历史、已删除记录和其它业务字段，只移除协同时钟、回执、clientId、IP 等 Hub 内部字段。服务器记录导出及当时的基线；离线编辑后保留 documentId 和 export 元数据，经完整副本导入入口预览三方合并。服务器新增历史不会被离线旧版本清空，同字段双方都改动时必须明确选择。

发给第三方请用外发版；船厂往来使用 Exchanges / Send All 的锁 Owner 船厂版，仍只导入当前轮次未关闭意见的 Builder 回复。不要把外发白名单版本当作完整备份或整份替换原文档。

项目级离线文档备份：停服后执行 `npm run hub:export-pcf -- --project <项目ID> --data-dir <数据目录> --output <新ZIP路径> --hub-stopped`，生成全部已有 PCF 的完整 HTML ZIP 并保存导出基线。无 PCF 图纸列在 manifest 中，不会自动创建 PCF。此 ZIP 可作为离线副本导回；要回退整个部署版本仍须恢复完整 data 备份。

## 从旧 HTML 存储迁移

先停止 Hub，复制整个 data 到新的目录（含 DB/WAL、历史、往来基线和密钥）。先对副本执行 `npm run hub:migrate-pcf-json -- --data-dir <副本目录> --dry-run`，再加 `--hub-stopped` 实跑。查看文档/快照数及字节统计；检查页面、编辑、导出和船厂回复。原 HTML 目录保留为 `pcf-html-backup-*`，整体 data 备份位于数据目录同级。正式切换和回滚步骤见 [迁移说明](docs/PCF_JSON_MIGRATION.md)。认证开关仍默认关闭，不设置 API_TOKEN/Basic Auth 时内网匿名使用不变。

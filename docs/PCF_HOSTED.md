# PCF 托管模式（第 2 / 3 期）

每张图的完整 HTML 是权威数据；SQLite 只保存指针、意见数量、审批/轮次摘要及匿名变更元数据，不保存意见正文或图片。原始 PG-PCF-v1.9-source.html 不修改；PG-PCF-hub.html 检测 window.PAHUB 后启用托管适配，否则沿用独立文件保存、自动保存和导出。

## 存储和恢复

数据根目录 PAHUB_DATA_DIR 默认 data/，默认数据库位于其中的 papc.db，PAPC_DB_PATH 可独立覆盖。当前文件为 pcf/<projectId>/<drawingId>.html，旧版为 pcf/<projectId>/.history/<drawingId>/<rev>-<epoch毫秒>-<uuid>.html。ID 只允许 1–128 位字母、数字、下划线或短横线，不使用图号作文件名。

非 DOM 的 script 扫描器定位唯一 id=pcf-data、type=application/json 块，兼容属性顺序和空白；JSON 的 <、>、& 转义为 Unicode 转义，与模板 snapshotHTML 一致。每图 Promise 队列串行处理写入；先保存旧版，再同目录临时文件、fsync、rename。

pcf_index、pcf_changes、drawings、projects、audit_log 在同一个同步 SQLite SAVEPOINT 内写入，事务期间没有 await。文件和 SQLite 不是跨资源原子事务：常规异常会补偿还原文件；若 rename 后、SQLite 提交前进程崩溃，下一次读/meta/index 利用 HTML 中 hub.rev 和 hub.lastChange 修复索引、回写和审计。变更日志的图纸/rev 唯一约束避免重复审计。若数据库版本比文件新则明确报错，不静默覆盖。停服后一起备份数据库和全部 HTML；历史暂不自动清理。

## API 与身份

前缀 /api/pcf/:projectId/:drawingId：

| 方法/后缀 | 行为 |
| --- | --- |
| GET meta | 返回 pcf_index 行；无文件 404 |
| POST create | 空 body 可用；从 PAPC 预填项目名/图号/标题/版次/轮次，新 documentId；重复调用幂等 |
| GET data | 返回 {rev,data} |
| POST ops | 按最新文档应用不冲突的操作，返回 {rev,applied,conflicts,assigned,data} |
| PUT document | body 为 {clientId,clientName,baseRev,data} 或 html；documentId 必须一致，文档 rev 不匹配 409 |
| GET history | 旧版列表（rev、savedAt、filename） |
| POST history/:rev/restore | body 带 baseRev 和匿名身份；恢复产生新版本并提升全部实体 clocks |
| GET download | 当前独立 HTML 附件，无托管上下文/凭据 |
| POST session | Bearer 建立该图页面的 HttpOnly 会话 cookie |

额外 GET /api/pcf/:projectId/index 返回项目下所有摘要。GET /pcf/:projectId/:drawingId 自动 create，再在 head 尾注入 PAHUB（projectId、drawingId、rev、apiBase、credential）。页面和接口均禁止缓存。

未设置 API_TOKEN 时匿名访问；设置后支持原 Worker 相同的 Authorization: Bearer API_TOKEN。PCF 页面也可用 X-PCF-Token：HMAC 签名、限单张图、12 小时有效。页面本身不会公开绕过鉴权：PAPC 图名链接使用现有构建 token 调 session，或直接打开时要求输入共享 token。会话 cookie 是 HttpOnly/SameSite=Strict，API 不以 cookie 授权，而使用限图 header；全局 token 不放 URL/localStorage/PCF 文件。下载和模板另存均移除 pahub-context。PUT HTML 也移除该注入。

这不是个人账户系统。clientId 首次生成后存 localStorage；底栏可设昵称；服务器记录 IP（socket 地址，不信任任意 X-Forwarded-For）、时间及匿名身份。现有 PAPC 的 VITE_DATA_API_TOKEN 仍会公开在构建资源中，这是原认证机制的限制；局域网 HTTP 无加密，不能据此宣称具备公网安全。限图凭据过期后需重新打开页面。

## ops 和实体 rev

请求外层 baseRev 是页面看到的文档版本；允许陈旧值，拒绝未来值。每个已有实体的 op.baseRev 必须等于该实体 clock（首次为 0），不是外层文档版本。例如两个浏览器都基于文档 rev=3，分别修改不同 owner，只要各自实体 clock 匹配就都能成功。

    {
      "clientId": "browser-uuid", "clientName": "张工", "baseRev": 3,
      "ops": [{
        "type": "content.set", "commentId": "comment-uuid", "roundId": "round-uuid",
        "side": "owner", "baseRev": 2,
        "value": {"text": "意见正文", "html": "意见正文", "fill": "", "images": []}
      }]
    }

| type | 参数（另带实体 baseRev，新增除外） | 冲突实体 key |
| --- | --- | --- |
| comment.add | id、可选 roundIdNew；服务器分配 number/首轮 id | 新 UUID 不得重复 |
| round.add | commentId、id；服务器分配轮次 | 新 UUID 不得重复 |
| content.set | commentId、roundId、side=owner/reply、value={text,html,fill,images} | round:<id>:owner/reply |
| comment.status | commentId、value=open/closed | comment:<id>:status |
| comment.meta | commentId、value={page,tags} | comment:<id>:meta |
| round.meta | commentId、roundId、field、value | round:<id>:initiator/responder/minHeight |
| project.set | field、value | project:<field> |
| roundRegister.set | round、value | register:<round>（整行） |
| settings.set | field、value | settings:<field> |
| record.delete | commentId、可选 roundId/deleteId | comment/round:<id>:record（聚合） |
| record.restore | deleteId | deleted:<id> |

project 白名单：name、planNo、planTitle、revision、folder、approval、currentRound。roundRegister 白名单：revision、ownerRef、ownerDate、replyRef、replyDate。settings：fontSize、autoSaveSeconds。意见 meta 的 page/tags 共用 clock；轮次登记一行共用 clock，owner/reply 内容则独立。

所有 clocks 存在 HTML data.hub.entities[key]={rev,clientId,clientName,at}；rev 使用最后修改它的文档版本号，并镜像 comment.rev/statusRev/metaRev、round.rev/ownerRev/replyRev。子内容更改同时提升聚合 record clock，避免删除他人刚修改的内容。一次请求内所有 op 用请求开始时的 clocks 判定，支持先重开再编辑/编辑后删除；跨请求以最新文件为准。

冲突 op 不应用，返回 server 当前值、entityRev、updatedBy 和 commentNumber；其它 op 照常提交。空操作/全冲突不增加版本。成功批次文档 rev+1，assigned 按新增 UUID 返回服务器编号。删除使用 tombstone；关闭意见须重开才可编辑，有 Builder 回复的轮次不能删除。整意见删除/恢复按原模板实际函数重排显示编号，UUID 才是稳定身份（nextCommentNumber=现存意见数+1）。审批按模板 countOpen/reconcileApproval 自动 Approved/重新 Under review，保留手动覆盖语义。

pcf_changes.ops_json 只允许操作类型、实体 ID、字段名/side/轮次序号；不存 value、正文、图片。整份替换用于授权迁移/恢复，尚非船厂三方合并。

## PAPC 回写

| 表/列 | PAPC JSON / 规则 |
| --- | --- |
| drawings.manual_comments_count | manualCommentsCount：现存意见总数 |
| drawings.manual_open_comments_count | manualOpenCommentsCount：status=open 数 |
| drawings.current_round | currentRound：PCF 数字 1/2/3 转 A/B/C（含 AA 等） |
| drawings.version | version：PCF 当前 roundRegister 行的非空 revision；空则保留旧版次 |
| projects.last_updated | 每次写入更新时间 |

Worker 的 api_project_details 视图直接读取这些列，POST /api/projects/:id 刷新即可看到，无须改 Worker。PAPC status 不自动修改，PCF approval 独立保存在索引中。audit_log 用现有 COMMENTS 类型，detail 只存数量 from/to、source=PCF、rev、轮次/版次摘要；原统计查询只识别 STATUS/COMMENTS，保留类型可兼容报表。

手工 c:10/2 在该图已有 PCF 时弹确认提示，仍允许执行，下次 PCF 保存覆盖手工数。轮次登记日期/编号以 PCF 为准，但本期不自动填 PAPC 的送审/回复日期字段。

## 模板行为和验证

托管模板现为 PCF v2.6（meta v5），业务 UI 与独立保存流程以用户原件为基础。没有 PAHUB 时，Connect file、句柄记忆、自动保存、JSON 导入导出、Excel、Print 与原件保持一致；有 PAHUB 时，touch 标记脏实体，保存将基线与当前数据差异转为 ops，文件保存/自动保存不弹 picker，Connect file / restoreConnection / 句柄记忆隐藏或禁用。另存、JSON、Excel、Print 保留为副本输出，应用第四期白名单，不外发托管上下文、凭据、hub 元数据或内部 tombstone。响应包含最新 data，用三方合并保留 fetch 期间继续输入的本地修改，下一次再保存；成功分配号立即确认。底栏显示服务器 rev、昵称。第 3 期提供逐项富文本/文本差异/图片整体对比以及三种解决路径，详见下文；保留“载入服务器版本”（明确丢弃本地未保存修改）。

托管 Import JSON 先执行 validateJSON + cleanupLegacyImport，再显示整文档替换、当前 rev、在线人数和旧版 history 备份提示。他人 presence 处于编辑状态时默认阻止；确认提交携 baseRev，服务器在每图写队列内再次检查 presence 和 rev，变化则拒绝并要求刷新。保留 documentId；不经过独立版的暂停自动保存/断开连接路径。

v2.6 删除为永久删除并级联 pruneRounds，不提供恢复 UI，不向 data.deleted 写入墓碑。hub.tombstones 只存 ID/type/parentId/删除 clock/时间；删除 op 携 currentRound 与 roundRegister/circulation/approvalHistory 裁剪 ID，服务器重新计算并比对，不一致或受影响字段已更新即冲突。rounds.addAll 原子创建一组轮次；roundRegister.set 使用整行 clock，history.set 对 circulation/approvalHistory 分别使用字段 clock，禁止并发重复轮次和静默覆盖。

实际验证命令：npm run hub:build、npm run hub:test。原有 24 项全部保留，新增 6 项综合测试覆盖 C1–C7、业务函数 jsdom/服务器对照、新字体保存、实际独立 JSON 导出及两个历史字段并发。Chrome 临时服务验证双上下文协同、删除/离线冲突、并发加轮、JSON、船厂锁定与 Send All 解包；截图位于 hub-server/test/artifacts/v26-*.png。自动测试覆盖创建预填/页面 JSON、不同意见并发、同一 owner 冲突并不影响 reply、并发编号、PAPC POST 读回/全部 SQL 表和 DB/WAL 正文哨兵零匹配、历史恢复/整份替换 409、鉴权及崩溃修复、jsdom 离线 picker/保存和托管新增/编辑/登记/设置/轮次/永久删除及内部墓碑/保存期间输入/冲突载入/独立副本。

## 第 3 期：实时协同协议（2026-11-07）

### SSE 与凭据

新增 GET /api/pcf/:projectId/:drawingId/events。原 Bearer / X-PCF-Token 鉴权继续有效。原生 EventSource 使用查询参数 credential（页面已有的 HMAC 限图签名，12 小时有效），不使用全局 API_TOKEN；同时传 clientId、clientName、rev。查询凭据只在 events 路由接受，不能跨项目/跨图使用。页面与流均 no-store/no-referrer，流设置 X-Accel-Buffering: no；部署反向代理时仍须关闭 SSE 缓冲，并禁止记录完整查询字符串，以免访问日志保留 capability。HTTP 局域网不加密的原限制仍在。

事件使用标准 event/data/id 格式，changed 和 hello 的 id 为文档 rev；presence/ping 不改变 Last-Event-ID：

~~~json
{"event":"hello","id":3,"data":{"rev":3,"online":[{"clientId":"A","clientName":"张工","entity":null,"at":1794038400000}],"resync":true}}
{"event":"changed","id":4,"data":{"rev":4,"clientId":"A","clientName":"张工","replace":false,"entities":[{"entity":"round:r1:owner","clock":{"rev":4,"clientId":"A","clientName":"张工","at":"2026-11-07T12:00:00.000Z"}}],"ops":[{"type":"content.set","commentId":"c1","roundId":"r1","side":"owner","entity":"round:r1:owner","entityRev":4}]}}
{"event":"presence","data":{"online":[{"clientId":"A","clientName":"张工","entity":"round:r1:owner","at":1794038400000}]}}
{"event":"ping","data":{"at":1794038425000}}
~~~

线上没有 event 外层包装，上述 JSON 仅说明结构；具体帧为 event: changed / id: 4 / data: {...}，以空行结尾。changed 不包含富文本、正文或图片，仅发实体 clocks 和白名单操作摘要；客户端按需 GET data 获取快照并就地合并。取舍：多一次读取和完整快照流量，但避免 SSE 向每个在线用户重复发送图片，并不维护另一份实体补丁数据模型。将来可换成按实体 GET，而不改广播契约。

EventSource 原生重连带 Last-Event-ID，首次连接使用 rev 查询值。每次重连 hello 都给当前 rev，不维护无限事件回放；落后时读最新快照。客户端按串行队列处理通知，忽略自己的 clientId，不重复应用已经对齐的 rev。整份替换/历史恢复也发 changed（replace=true）；签名过期最迟下个 25 秒心跳关闭流，需重新打开页面领取凭据。

PcfRealtime 使用 DrawingBroadcast 接口，MemoryBroadcast 是当前单进程实现。多进程部署前必须同时替换广播、presence 存储及每图写入互斥，不能只接 Redis 广播就共享目录运行多个进程。

### presence、软锁与 PAPC

POST .../presence body 为 {clientId,clientName,entity:null|"round:<id>:owner/reply",leave?:true}。只能报告现存 owner/reply 栏；新建但尚未保存的实体暂不广播。页面打开即连接并上报，焦点进入/离开、输入时更新；有用户活动时随 ping 续期。客户端的无活动编辑焦点不因服务器心跳自动续期。

presence 每图按 clientId 去重；同 clientId 多个 SSE 连接只在最后一个连接断开时释放。断开立即释放；60 秒无活动移除，5 秒定时扫描（读取列表时也清理，因此后台最多延迟 5 秒）。没有强制锁，任何人都可继续编辑。自己不出现在自己的软锁提示/他人昵称列表；在线人数包含自己。提示为“某某正在编辑（软提示，不阻止编辑）”。

GET /api/pcf/:projectId/presence 返回 {drawings:{drawingId:[presence,...]}}，需项目级 Bearer（未配置 API_TOKEN 则匿名），限图签名不能读取整个项目。PAPC 初始拉取并在既有自动同步轮询中刷新，图名后显示 ● N；不新增 SSE、不强制更高频轮询。关闭自动同步后不持续轮询，数量可能暂时陈旧。

### 就地更新与冲突处理

以 UUID 而非显示编号匹配意见与轮次。快照三方合并保留未保存值；只有脏实体保留旧基线和旧 clock，干净兄弟实体接收新值/clock。对编辑中的格子保留同一个 DOM 节点和光标；没有本地修改但保持焦点的格子也暂缓更新，并保留旧 clock，离焦后读取最新值。远端删除编辑中的实体时保留本地内容用于冲突/副本留存，离焦/放弃后再移除。索引、意见数、分页、增删后的顺序和显示编号同步刷新。

同一脏实体遭远端更新显示“已被他人更新；保存时对比”，不提前把旧 baseRev 更新成新值以绕过冲突。保存 response 期间新增输入继续保留。

冲突对话框每项展示意见号、栏位、对方昵称/时间、双方富文本预览、纯文本差异以及双方图片文件名。差异采用线性公共前后缀比较，连续差异区红色删除/绿色新增，不做复杂文档或像素级 diff。可逐项选择用我的、用服务器的、手动编辑（内容栏为富文本，元数据为 JSON），提供全部用我的/全部用服务器的。图片作为整体选择保留我的或服务器图片。点击“应用选择并保存”执行；用我的/手动合并以已返回服务器 clock 为新 baseRev，期间若又被更新仍正常再冲突。删除或关闭导致的业务保护不会被“用我的”绕过，需采用服务器版本或先恢复/重新打开意见。

### 幂等与 IndexedDB

托管客户端每批生成 UUID batchId；未收到确认时重试同一 body 和 batchId。服务端兼容第二期无 batchId 的调用（不享受批次回执），验证 UUID；相同 ID 若 body 指纹不同返回 409。

回执保存在权威 HTML 的 hub.receipts，最近 1000 批且 24 小时内有效。回执包含请求 SHA-256 和返回的 rev/applied/conflicts/assigned，不保存整个 data 的重复快照。重复提交从当前 HTML 或该 rev 的历史 HTML 重建原 data，移除内部 receipts 后返回与首次完全相同的结果；即使其它人继续提交、进程重启也不再应用/广播。全冲突/空批回执原子写入同一 HTML，不增加 rev、不产生审计。正文与冲突值只在 HTML 中，不进入 SQLite；原 pcf_changes 仍仅记录白名单摘要。历史需要保留至少整个去重窗口（当前不清理）。

IndexedDB 数据库 pahub-pcf-offline / documents，以 documentId 为 key，保存旧基线、实体 clocks、当前脏本地数据、未确认批次 body/snapshot 和未处理冲突；不保存签名凭据。输入 touch 即持久化，发送前等待写入事务完成。网络失败保留原批次，点击保存重试；刷新/重开提示“有 N 项未同步修改”，可恢复重提或按文档丢弃。仅脏数据、尚未发请求的修改同样可恢复；恢复遇到服务器更新仍进入正常冲突处理。同步确认后清理本地记录；beforeunload 对脏值、在途/未确认批次及未处理冲突提示。存储禁用/配额不足会提示下载副本，但无法承诺浏览器被强杀/输入瞬间断电时最后一个尚未完成的 IndexedDB 事务已经持久化。

### 已有文件与部署边界

原 PG-PCF-v1.9-source.html 未改动，PG-PCF-hub.html 没有 PAHUB 时仍走原独立保存/自动保存/下载流程，副本移除协同 UI 和凭据。SQLite schema 不需要新增正文列。以前创建的完整 PCF HTML 仍带旧脚本，不会因仓库模板更新自动替换；升级已有图纸需要经备份/授权模板迁移保留 documentId 与数据（不在本期静默重写生产文件）。本期仍不含船厂锁 Owner、邮件三方合并、HTTPS/systemd/备份自动化。

验证：npm run hub:build、npm run hub:test；真实双 Chrome 冒烟 node hub-server/test/browser-smoke.mjs（可用 PAHUB_BROWSER_CHANNEL=edge 切换本机浏览器）。截图位于 hub-server/test/artifacts/，已加入 .gitignore。

## 第 4 期：船厂往来与模板升级（2026-11-07）

权威正文仍是每图一个完整 HTML。SQLite 新表 pcf_exports 仅记录 exportId、project/drawing/documentId、baseRev、导出轮次/时间、匿名 clientId/昵称/IP、文件名和 exported/imported/void 状态，不存意见或图片。

### 操作入口与接口

PAPC 图纸行与托管 PCF 均有 **Export to Builder**。托管 PCF 提供 **Import Builder replies** 和 **Shipyard correspondence**；PAPC 行仅显示最近 Rxx 的 Awaiting reply / Imported / Voided，沿用 presence 轮询刷新。导出按钮会先保存托管页未保存编辑；导入前必须解决本地脏编辑/队列/冲突。

| 方法及尾路径（/api/pcf/:projectId/:drawingId） | 功能 |
| --- | --- |
| POST /exports | 建立发出基线并返回 exportId、baseRev、round、filename |
| GET /exports | 本图导出元数据，倒序 |
| GET /exports/:exportId/download | 下载当时的英文独立 HTML（含 filename*） |
| POST /exports/:exportId/void | 作废；保留原文件和元数据，拒绝后续新导入 |
| POST /imports，step=preview | 上传 HTML 字符串，返回清单与签名 previewToken |
| POST /imports，step=apply | 携 token、同一 HTML、UUID batchId、冲突 choices 确认 |

鉴权沿用 Bearer / 限图 X-PCF-Token；写操作与在线 ops 共用每图 serial。上传 HTML 只抽取唯一 pcf-data JSON，不执行来信中的脚本。documentId、exportId 必须与本图、导出记录相符，mode 必须为 builder，否则拒绝。作废拒绝；已导入会提示，需 overwrite=true，仍正常三方合并。

### 基线文件、保留和剥离

基线：data/pcf/<project>/<drawing>/exports/<exportId>.html；外发文件名：<图号>_R<两位轮次>_PCF_<YYYY-MM-DD>.html。baseline 是外发白名单快照，Builder 部分及 Owner 部分都在该完整 HTML 中。

保留 schemaVersion/documentId、项目/图名/图号/版本/状态/当前轮次、全部现存意见和活动轮次的业务 ID/编号/属性/开闭/参与人姓名/Owner 与 Builder 正文及嵌入图片、业务创建/更新时间、登记编号/日期、白名单显示/保存设置、审批状态来源/原因，以及 export={exportId,documentId,baseRev,round,exportedAt,mode:'builder',ownerHmac}。

剥离 hub（rev、entity clocks、clientId/IP/编辑历史、幂等 receipts）、Owner/Builder rev、内部 folder 路径、旧 data.deleted 和内部 tombstone、发文历史、审批历史、自定义/未知字段；正文和图片也按现有 cleanContent 白名单输出。完整托管 adapter、会话注入和按钮都不外发。PCF 业务中用户手写的昵称、正文、图片或超链接不是秘密过滤器的识别范围，发送前仍须审阅；本工具不自动删除业务正文中的敏感信息。

### 只读与完整性

船厂页面为英文，顶部说明填写 Builder 回复、保存 HTML、邮件回传。仅导出时当前轮次、未关闭意见的 reply（text/html/fill/images）可写。Owner、意见属性/人员、开闭/结构、新增删除、过去轮次 Builder、登记（包括 replyDate/replyRef）、图纸控制、全局设置均只读。

UI 禁用/contenteditable=false，同时编辑/附件函数校验 scope；内存 state 的所有非可写属性 non-writable/non-configurable，数组索引和 length 锁定、对象禁止扩展，不能用普通控制台赋值/push/splice/defineProperty 绕过。updatedAt 保留为保存流程更新时间，不视为 Owner 改动。v2.6 新入口同样受保护：Import JSON、addRoundToAllOpen、round 登记、删除 Owner 内容禁用；roundRegister/approvalHistory 以及新增设置均受数据层锁定。字体工具栏只允许作用于当前开放 Builder reply；Excel、打印工作簿及 Print/PDF 可用。保存沿用 v2.6 File System Access API 或 Save as 下载副本流程，普通独立文件行为不变。

首次启动生成 data/.pcf-export-key（独立于 API_TOKEN，32 字节随机密钥的 hex）；HMAC-SHA256 签名规范化排序 JSON 的全部只读部分，并绑定导出标记。允许的 reply 与更新时间不计入签名。基线签名失败视为服务器文件损坏并拒绝；返回签名/只读内容变更列入 Integrity warning 与 Ignored changes。**Owner 永不导入**：管理员选 Ignore read-only changes 且以现有 ADMIN_PASSWORD 确认，才允许继续 Builder 合并。API_TOKEN 不等于管理员密码。

HMAC 是篡改检测，不是加密、船厂身份签名或恶意 HTML 沙箱。直接编辑 HTML/替换脚本仍可能改来信，但不能改变服务器忽略 Owner 的合并规则。勿打开不可信来信运行脚本；直接在 Hub 上传解析。密钥需与 data/ 一起备份，保护操作系统账户/ACL；Windows 的 mode=0600 不能替代 ACL。默认管理员密码沿用旧配置，部署时必须覆盖，HTTP 明文的凭据风险仍存在。

### 三方合并规则

按基线意见/轮次 UUID 匹配；正文/富文本/fill 为一个栏位，附图 images 为另一个整体栏位（不逐图拼接）。

| 基线→船厂 / 基线→当前服务器 | 处理 |
| --- | --- |
| 船厂变了、服务器该栏位没变 | 自动用船厂 |
| 船厂没变 | 保留服务器 |
| 双方变了但最终相同 | 保留相同值，不重复写入 |
| 双方同栏位变了、最终不同 | 冲突，选 Builder / Server / Manual merge |
| 服务器新增意见 | 保留；返回文件缺少不作删除 |
| 服务器删除意见/轮次、船厂没有新回复 | 忽略 |
| 服务器删除意见/轮次、船厂有新回复 | deleted 冲突；选 Builder 明确恢复 tombstone，再写回复；不能恢复则拒绝 |
| 船厂 Owner/属性/登记/结构等只读内容变了 | 显示已忽略改动和完整性警告，绝不应用 |
| 当前服务器意见已关闭 | 列冲突；用 Server 可忽略，接受 Builder 需先在服务器重新打开并重新预览 |

预览复用第三期富文本对比、红删绿增文本差异与图片文件名展示；有自动/冲突/忽略三份清单，All Builder / All Server 批量选择，正文可手动编辑，图片仍二选一整体集合。删除冲突明确显示 Use Builder and restore record。重复导入需勾选允许再次合并，篡改需管理员确认。确认失败保留同一 batchId 和 body 可重试；改决策生成新 UUID。

previewToken 以 HMAC 绑定项目/图纸/exportId、来信 HTML hash、serverRev、30 分钟期限；服务器在预览后改变时 409，须重预览。apply 先在副本 applyOps 校验整批，再交给 storage.opsBatch，带当前实体 clock，避免部分导入。提交者昵称为“船厂导入（exportId）”，真实 clientId/IP 仍追溯；历史可恢复、rev 有实际 ops 时递增、SSE 仅广播摘要、PAPC 同时回写意见数/未关闭数/轮次/版本。

导入 intent/receipt 位于 data/pcf/<project>/<drawing>/imports/<batchId>.json，不是正文权威，不进 SQLite，不保存管理员密码。先记录意图再提交，以 ops 幂等回执恢复进程中断；保存成功响应支持跨重启精确重试。相同 batchId 换内容/提交者会 409；成功状态为 imported。没有实际变化的重复覆盖不增加 rev，不额外广播。

### 模板升级

当前 meta pahub-template-version=4；旧文件打开仅小字提示 **Template upgrade available**。兼容提示由服务器注入，因此旧脚本也能显示；不自动改文件。要使用新页面入口需停服升级旧权威 HTML。

~~~powershell
# 先停止 Hub；按需设置 PAHUB_DATA_DIR（默认为仓库 data/）
npm run hub:upgrade-pcf -- --dry-run
npm run hub:upgrade-pcf -- --dry-run --project X --drawing Y
npm run hub:upgrade-pcf -- --project X --drawing Y
~~~

工具只扫描当前权威 pcf/<project>/<drawing>.html，排除 exports/imports/history/备份；抽取原 JSON，套当前模板，深比较不改变 documentId/数据/hub/receipts/自定义字段。正式先写 .bak-<时间> 原文件，再 fsync 临时文件、rename 原子替换；输出逐文件 JSON 报告 current/would-upgrade/upgraded 与 backup 路径。dry-run 不创建备份、不改权威文件。Node 24 通过内存 esbuild 执行 TS，启动器不生成临时脚本；不要求先 hub:build。

升级不是一次业务 ops，不改 rev、SQLite 摘要或审计。无跨进程维护锁，务必停服；失败保留已做的备份并报错，恢复时也需停服。未对用户生产目录执行正式升级。

### 语言和边界

### v2.6 移植映射

基线：pahub-main / 2faf98a；逐处比较 v1.9-source 与 hosted v4。以下为完整托管钩子清单，按函数名定位。v2.6 原件 SHA256：4b195e7adfedcf7fb699a77ba389f8d65fa2d8d222d8cbdf8a66009b05d994be。

| 完成 | 位置 / 钩子 | 目的 | v1.9 依赖 → v2.6 移植 |
| --- | --- | --- | --- |
| [x] | head/meta、state/uid | 版本与非 HTTPS UUID | state/crypto；v5，独立路径保留原件 |
| [x] | builderMode / builderWritable / builderProtect / builderUI | 船厂 UI 与数据防写 | getComment/getRound/render；登记/审批/导入/批量轮次全部锁定 |
| [x] | hubInit / hubHeaders / hubURL / hubMark | 会话、昵称、凭据、脏实体 | state/touch/save-state；原模块复用 |
| [x] | hubOps / hubClock / hubKey / hubMerge | entity clock、差异 op、保存期间输入 | deleted/restore/makeRound；永久删除级联与新字段 |
| [x] | hubSave / hubReload / hubConflicts / hubResolve / hubComparison | 批次保存与逐项冲突 | openModal/syncEditor/render；保留三种解决路径 |
| [x] | hubExchangeRequest / hubExportDownload / hubExport / hubExchangePanel / hubImportPreview / hubImportApply / hubExchangeInit | 第四期船厂往来 | snapshotHTML/writeFile/modal；永久删除不恢复；JSON 整体导入单独实现 |
| [x] | hubDB / hubPersist / hubQueue / hubDrain / hubRecovery / hubRebase / hubRetarget | 离线队列与幂等恢复 | dirty/editRevision/hubOps；原协议保留 |
| [x] | hubConnect / hubRemote / hubApplyRemote / hubFocus / hubPresence / hubCollaborationInit | SSE、presence、焦点 | getComment/getRound/render；就地刷新 |
| [x] | touch / updateSaveStatus | 脏标记、持久化、保存提示 | reconcileApproval/dirty；托管隐藏本地连接 |
| [x] | reconcileApproval / editable / autoHeightAll / setCommentStatus / addComment / restore | 船厂业务防写 | 同名函数；restore 已移除；永久删除受 editable 保护 |
| [x] | render | 重绘防写与软锁 | updateOverview/adjustAll；每次重施加 |
| [x] | syncEditor / restoreSelection / attach / click dispatch / paste | 字体、正文、附件范围 | editable/activeEditor；仅当前开放 Builder reply |
| [x] | snapshotHTML / suggestedName / hubDownload | 白名单副本与凭据剥离 | document.cloneNode/state；HTML/JSON/Excel/Print 一致 |
| [x] | writeFile / connectExisting / saveNew / downloadCopy / fileOptions | 保存接管与禁止本地写权限 | fileHandle/rememberHandle；Connect/restoreConnection/记忆增加 gate |
| [x] | restartAutoSave / beforeunload / init | 自动保存、退出提醒、禁止句柄回忆 | recallHandle 变 restoreConnection；独立路径原样 |

#### v5 收尾验证（2026-11-07）

- 移植映射 15/15 完成；沿用已完成的 hub:build、Chrome 冒烟及托管/船厂 Excel 与 Print 验证，下载副本不含托管凭据。
- hub:test：原有 24 项与新增 v2.6 6 项，共 30/30 通过，0 失败、0 跳过，正常退出（约 22 秒）。
- 挂起根因：Send All 浏览器打包测试中 React 异步 act() 创建的 Node MessageChannel 留下 4 个被引用 MessagePort；测试现在追踪自有 Channel，并在组件卸载后关闭两端端口。修复后 Send All 5/5 正常退出，诊断未见残留 MessagePort；未用 process.exit() 或延长超时掩盖。
- data/ 只读 upgrade-pcf --dry-run：扫描 5 个权威文件，均为 v4 → v5；将清理 deleted 0 条、将裁剪空轮次 0 条。未执行实际升级，未修改 data/、logs/，未停止 8080 服务。


沿 v1.9 英文 UI：托管保存/下载/presence/冲突/离线恢复、船厂 banner、往来与导入提示统一英文；匿名默认昵称 Editor-xxxx。用户正文/既有昵称不翻译，审计中上述中文提交者标识按需求保留。原 PG-PCF-v1.9-source.html 未修改。

本期仍为单 Node 进程、局域网部署；多进程写互斥、共享 presence、Ubuntu 部署及 HTTPS 运维属于后续。导出/基线/历史/导入回执尚无自动保留期清理，管理员可作废但不删除文件；备份应包含全部 data/。

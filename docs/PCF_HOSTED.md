# PCF 托管模式（第 2 期）

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

托管模式 touch 标记脏实体，保存将成功基线和当前数据的差异转为 ops；文件保存/自动保存不弹 picker，另存/下载得到独立副本。响应包含最新 data，用三方合并保留 fetch 期间继续输入的本地修改，下一次再保存；成功分配号立即确认。底栏显示服务器 rev、昵称。冲突提示意见编号和对方，提供本地副本下载和“载入服务器版本”（明确丢弃本地未保存修改），完整对比留第 3 期。

实际验证命令：npm run hub:build、npm run hub:test。自动测试覆盖创建预填/页面 JSON、不同意见并发、同一 owner 冲突并不影响 reply、并发编号、PAPC POST 读回/全部 SQL 表和 DB/WAL 正文哨兵零匹配、历史恢复/整份替换 409、鉴权及崩溃修复、jsdom 离线 picker/保存和托管新增/编辑/登记/设置/轮次/删除/恢复/保存期间输入/冲突载入/独立副本。

## 本期边界

单 Node 进程；不支持多实例共享文件目录。尚无 SSE、在线/软锁、完整冲突对比、持久离线 ops 队列或请求 ID 去重。网络失败保留内存本地修改，不宜直接刷新，可先下载副本；响应丢失重试的新增 UUID 不会重复创建，但会提示冲突，后续期可增加请求幂等确认。历史无自动清理，限图会话固定 12 小时。船厂 Owner 锁定、发出基线/导入三方合并、Ubuntu 运维部署另期实现。

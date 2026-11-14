# PAhub 统一登录切换手册

本文供负责人批准后在维护窗口执行；本 PR 不操作服务器。以负责人决定（2026-11-14）> v1.1 > v1.0 为准。身份、权限、审计、PCF 身份字段、目录和相关前端功能已按 T6 提交 `78177f8` 核对。

## 前置条件

- kjx-auth 已在 SGP0 运行，登录、健康检查、JWKS、真实客户端 IP 审计和签出已冒烟；PAhub 及认证服务 DNS、Cloudflare Tunnel ingress 与 HTTPS 入口正常。`/manual/` 也需登录。
- T2/T3/T6 与本手册已就绪，完整测试通过；上线前还须完成四角色浏览器验收。负责人确认版本、窗口、执行人与回滚负责人。已轮换泄露过的旧凭据；至少两个 PAhub admin 已开通。负责人已创建 audience `kjx-auth`、scope `directory:read` 的目录服务账号，并把凭据直接写入服务器受限配置。不得在文档、工单或日志中记录任何凭据。
- nginx 已安装 `snippets/kjx-auth.conf`、`conf.d/kjx-auth-map.conf` 和认证故障页面；核对站点与 kjx-auth 源码 `deploy/nginx/` 示例，不能直接覆盖现有站点。示例中的 `/health` 不适用于 PAhub，应仅将 `/api/health` 作为免登录健康检查。
- **PAhub 后端端口只能经 nginx 访问**：进程监听 `127.0.0.1`，或由等效防火墙隔离，不能让公网或 Tailnet 客户端绕过 nginx 直连。当前 listener 会读取而不会剥离客户端提供的 `X-Auth-Token`，安全边界依赖 nginx；每个 PAhub 反向代理 location 都必须用 `proxy_set_header X-Auth-Token $kjx_token` 覆盖客户端同名头。
- 公网和 Tailnet 分为独立 server；公网固定 `X-Forwarded-Proto https`，Tailnet 不信任客户端 `CF-Connecting-IP`，使用 `$remote_addr`。默认保留 Tailnet 运维入口、限 Tailnet 网段并提示使用域名登录，或由负责人决定移除；IP 入口无法取得域名 Cookie。
- 准备安全保存且可恢复的源码、环境配置、nginx、数据库及完整 PCF 数据目录备份（包含图片、历史、导出和离线交换密钥）；备份应限制访问。确认空间和恢复演练，不得把备份上传到仓库。

## 环境变量

下表按 T6 提交 `78177f8` 的实际配置读取与校验整理，不含真实密钥。

| 变量 | 用途 | 默认值 | 是否必填 |
|---|---|---|---|
| `AUTH_MODE` | 身份模式，仅 `legacy` / `kjx` | `legacy` | 切换时必须设为 `kjx`；非法值应拒绝启动 |
| `KJX_JWKS_URL` | 内网 JWKS 公钥地址 | `http://127.0.0.1:8090/.well-known/jwks.json` | 否，默认可达时 |
| `KJX_ISSUER` | 校验令牌签发方 | `https://auth.kjxing.com` | 否，须与认证服务一致 |
| `KJX_AUDIENCE` | 校验应用受众 | `pahub` | 否 |
| `KJX_PUBLIC_URL` | 登录、登出及改密链接 | `https://auth.kjxing.com` | 否 |
| `KJX_INTERNAL_URL` | 内网服务令牌和目录请求 | `http://127.0.0.1:8090` | 否；须为无凭据、query、fragment 的 HTTP(S) URL |
| `KJX_CLIENT_ID` | 目录服务账号 ID | 空 | 目录功能需要，与 secret 成对配置 |
| `KJX_CLIENT_SECRET` | 目录服务账号密钥 | 空 | 目录功能需要；由负责人安全配置 |
| `PAHUB_PUBLIC_ORIGIN` | 写请求 Origin / Referer 来源校验 | `https://pahub.kjxing.com` | 否；必须匹配实际公开来源 |
| `PCF_GRANT_SECRET` | 每图凭据和 SSE 凭据签名 | 空：回退 `API_TOKEN` 或进程随机值 | 否；配置时至少 32 字节；与离线交换 HMAC 密钥不同，随机回退在重启后使旧凭据失效 |
| `ALLOW_CORS_ORIGIN` | 显式允许的跨域来源 | 空 | 否；kjx 模式为空时不发 ACAO，legacy 保持原行为 |
| `ADMIN_PASSWORD` | legacy 管理员登录与数据库控制台 | 空 | legacy 对外部署需配置；空时 legacy 请求按管理员处理 |
| `API_TOKEN` | legacy 可选 API 访问凭据及 PCF 签名回退来源 | 空 | 否；kjx 不应将其作为用户身份 |

密钥只由负责人直接写入服务器受限配置；不打印配置或请求头，不把真实值放入命令历史。`AUTH_MODE=kjx` 会校验 URL、audience 和公开 origin；未配置 `ALLOW_CORS_ORIGIN` 时不发送 ACAO，legacy 仍发送配置值或 `*`。目录凭据缺失、配置无效、取令牌/目录失败或 5 秒总超时都不会阻止启动：接口返回 `{"ok":false,"fallback":true}`，失败后 60 秒再尝试；成功结果缓存 5 分钟。Team Setup 显示 “Directory unavailable, enter the name manually.”，手填人员使用 `manual-` 加随机 UUID 的本地键，只是姓名快照，不可作为 kjx 身份或 PCF 提出人。

## 上线前清理演示数据（负责人执行）

清理是破坏性操作，须在维护窗口停写、停止 PAhub 后执行；先用 SQLite 在线备份或停服一致性备份 `papc.db`（包括已提交 WAL），备份完整 PCF 目录及离线交换密钥，并在副本验证完整性和恢复。不得把生产在用数据库当作只读盘点副本。以下 SQL 已按集成版本核对：身份迁移新增 `kjx_users`，审计新增 `actor_id`、`actor_name`、`source`、`op_types`，均不引用演示项目或 reviewer；其余项目关联表与基线一致。仍须由负责人在数据库副本检查全部表、外键、触发器及关联，先试运行并核对差异，再批准在停服生产库执行；任何不符立即停止。

先查明项目实际 **id**，不要假定名称就是 id；记录选中结果并确认它是唯一的演示项目，且三个 reviewer 确为演示账号。若其他项目引用这些人，先请负责人处理，不能误删业务数据：

```sql
PRAGMA foreign_key_list('drawings');
SELECT id, name, storage_path FROM projects WHERE id LIKE 'TEST-100%' OR name LIKE 'TEST-100%';
SELECT id, display_name FROM reviewers WHERE id IN ('engineer_a','engineer_b','senior_eng_c');
SELECT project_id, reviewer_id FROM discipline_defaults WHERE reviewer_id IN ('engineer_a','engineer_b','senior_eng_c');
SELECT project_id, reviewer_id FROM discipline_default_assignees WHERE reviewer_id IN ('engineer_a','engineer_b','senior_eng_c');
SELECT project_id, reviewer_id FROM review_tracker WHERE reviewer_id IN ('engineer_a','engineer_b','senior_eng_c');
SELECT d.project_id, da.reviewer_id, COUNT(*) AS n FROM drawing_assignees da JOIN drawings d ON d.id=da.drawing_id WHERE da.reviewer_id IN ('engineer_a','engineer_b','senior_eng_c') GROUP BY d.project_id, da.reviewer_id;
```

以下 `<已核实的项目ID>` 必须由负责人替换为经核实的 SQL 字符串字面量（正确转义）；整段在同一 SQLite 连接执行。`foreign_keys` 在事务前开启；先在副本执行，检查各 DELETE 行数及事务内 `foreign_key_check`。生产执行时只有检查通过才手动 `COMMIT;`，否则 `ROLLBACK;`。示例明确清理未定义级联的项目数据；保留 `audit_log` 作为审计，若负责人要求删除演示审计，另行审定范围。新表必须先补入经审查的清理方案。

```sql
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
DELETE FROM review_tracker WHERE project_id = <已核实的项目ID>;
DELETE FROM discipline_default_assignees WHERE project_id = <已核实的项目ID>;
DELETE FROM discipline_defaults WHERE project_id = <已核实的项目ID>;
DELETE FROM pcf_changes WHERE project_id = <已核实的项目ID>;
DELETE FROM pcf_exports WHERE project_id = <已核实的项目ID>;
DELETE FROM pcf_export_batches WHERE project_id = <已核实的项目ID>;
DELETE FROM pcf_index WHERE project_id = <已核实的项目ID>;
DELETE FROM projects WHERE id = <已核实的项目ID>;
-- 仅在确认三个 ID 未被其他项目引用之后执行
DELETE FROM reviewers WHERE id IN ('engineer_a','engineer_b','senior_eng_c');
PRAGMA foreign_key_check;
SELECT id FROM projects WHERE id = <已核实的项目ID>;
SELECT id FROM reviewers WHERE id IN ('engineer_a','engineer_b','senior_eng_c');
-- 人工核对结果后，执行 COMMIT; 或 ROLLBACK;
```

项目删除会级联其 drawings、drawing_assignees、drawing_status_history、drawing_remarks、project_settings、project_passwords；不得依赖级联清除未声明外键的表。核对项目关联表与三个 reviewer 的引用均为空；保留的审计记录除外。PCF 文件不在数据库中：负责人核实 `storage_path` 和数据目录内属于该项目的文件、图片、历史及导入导出文件，确认备份可恢复后，将**仅该项目**的目录移至受限隔离备份位置，不碰共享文件或离线交换密钥；核对路径和项目列表不再显示演示数据。浏览器缓存可能仍有旧项目，通知用户刷新或清理其演示缓存。

## 切换步骤

1. 先以 `AUTH_MODE=legacy` 部署集成版本，按常规 predeploy 备份、构建、部署、重启、健康检查和记录版本；回归管理员登录、项目密码、PCF、SSE、导入导出，观察至少一个工作日。集成版本在两种模式下都把上传的 builder 回复文件接口改成 `application/octet-stream` 附件下载，并加 `nosniff` 与 CSP sandbox，避免同源执行不可信 HTML；这是相对 `fec6429` 唯一已批准的 legacy 行为变化。
2. 负责人按上节清理演示数据，重新确认备份和恢复点。预检 kjx-auth 健康及 JWKS、PAhub `/api/health`、nginx 共用片段、DNS/Tunnel 和未登录访问基线；保存当前环境配置与 nginx 站点副本，备份不放 `sites-enabled`。
3. 负责人安全配置上表变量及 `AUTH_MODE=kjx`，先不重启 PAhub。确认 PAhub 仅监听 `127.0.0.1`，或后端端口已被防火墙隔离，只允许 nginx 访问。合并 nginx 站点：`set $kjx_app pahub` 并 include 共用片段；每个转发 PAhub 的受保护 location 加 `auth_request /_kjx_verify`、捕获响应 token、401/403/500 错误处理，并用 `proxy_set_header X-Auth-Token $kjx_token` 覆盖客户端同名头。保留上传限制、缓冲、超时和 SSE/WebSocket 配置，不开启 `proxy_intercept_errors`。只有精确匹配 `/api/health` 放行；`/manual/` 与 `/pcf/` 不豁免。
4. 执行 `nginx -t`，通过后先 reload nginx，再重启 PAhub，检查服务状态与 `/api/health`。先 nginx 后 PAhub 的中间态是 legacy 前多一层登录，而非 kjx 缺少注入头。
5. 未登录页面应 302 跳认证登录并保留深层路径；未登录 `/api/` 返回 401 `unauthenticated` JSON；已登录但角色不足返回 403 `forbidden`（能力拒绝包含 `capability`，op 拒绝还包含 `op`）；写请求缺少或不匹配 Origin/Referer 返回 403 `bad_origin`；认证服务故障由 nginx 返回 503。验证公网伪造 `X-Auth-Token` 被覆盖；直接访问后端端口应不可达，若从获准的本机运维通道测试，则伪造令牌必须返回 401。确认真实 IP，且 kjx 模式没有配置 `ALLOW_CORS_ORIGIN` 时 API 不返回 ACAO。不要记录请求头、Cookie 或令牌。
6. 执行下列四角色验收，记录结果及脱敏日志；任一失败停止并按回滚流程处理。

## 切换后验收

项目已解锁为前提；按真实角色使用专用测试账号和测试数据，不在真实业务上做破坏性测试。

- [ ] **viewer**：登录、查看项目列表、PCF、Daily Log；不能新增或修改意见，也不能直接调用写接口。
- [ ] **reviewer**：新增意见和单条新轮，提出人自动为本人；编辑自己轮次 owner 内容和高度成功；只有整条意见的所有轮次都属于本人时才能修改状态、页码或标签；改他人/无 ID 历史轮次、reply、提出人、删除/恢复记录及图纸状态均被拒。
- [ ] **manager**：修改图纸状态、负责人和备注；编辑他人意见及 reply；批量导入/命令、导出与导回船厂回复；单张导出不改状态，导回仅 Waiting Reply → Reviewing；Team Setup、项目设置和创建被拒。
- [ ] **admin**：创建项目和修改 Settings；验证管理控制台仅 admin 可访问。Team Setup 从目录选择 admin/manager/reviewer 并保存 kjx sub 与姓名快照；目录不可用时出现固定提示，可手填且生成 `manual-` 本地键。
- [ ] **manager**：PCF 提出人下拉通过图纸级候选接口选择目录用户；Team Setup 目录接口仍被拒。提交指定时服务端还可验证项目团队或本地缓存用户。目录不可用时下拉只允许本人，既有其他提出人只保留不可选的显示快照。
- [ ] **所有角色**：受密码保护项目非 admin 仍须解锁，admin 绕过；姓名、角色和在线人员正确；深链登录返回原处、首次/重置后改密、退出后所有统一登录应用失效；停用或撤销 PAhub 角色后访问被拒。已建立的 SSE 连接可能持续到断开。Daily Log 在 kjx 模式显示 Actor 列和 All/按人筛选，历史/后台无 actor 行显示 `—`，Copy、CSV 和 PDF 均包含 Actor。
- [ ] 后端端口从用户网络不可达；公网伪造 `X-Auth-Token` 被 nginx 覆盖，本机获准直连伪造令牌返回 401。
- [ ] 保持旧轮次无 ID 时不误判为本人；测试完整与外部离线导出/导回保留身份字段；检查拒绝的混合写入批次没有部分落库。

## 回滚

1. 负责人决定回滚时，先记录现象和当前版本，保留当前数据库与完整 PCF 数据的新备份；不要覆盖切换后数据。
2. 对**同一个已部署 P4 版本**，将 `AUTH_MODE=legacy` 或恢复切换前环境配置，先重启 PAhub 并确认服务健康、legacy 管理员登录及项目解锁；再恢复备份的 nginx 站点，`nginx -t` 成功后 reload，检查公开入口与切换前基线一致。不要回滚 kjx-auth 或其他服务。
3. 集成测试已验证：新 round 的 `initiatorId` / `responderId` 是附加身份字段，legacy 模式不调用 kjx op 授权，也不写入或信任请求里的身份 ID；新增审计列是增量迁移。因此，同一集成版本切回 legacy 不需要回滚这些字段或审计列。builder 回复文件保持新的附件下载安全行为。
4. 若还要将代码降回 `fec6429`，集成测试已验证身份字段在完整及外部交换往返中保留，缺少身份字段的 legacy 投影保持兼容；但 `fec6429` 不包含后续安全与迁移代码，仍须先用新数据副本和旧代码做完整回滚演练。若演练不通过，由负责人决定恢复匹配的切换前数据库和 PCF 备份，并评估切换后数据丢失；绝不直接覆盖唯一副本。

## 遗留风险

- legacy 的 `/api/admin` 密码派生令牌固定且泄露密码前缀；切回 legacy 后风险仍存在，限制访问并由 P5-3 删除 legacy 时处理，不在此处复制其值或构造方式。
- kjx-auth 故障会阻断受保护访问；先按认证服务运维手册排障，必要时负责人决定临时回滚。会话过期时 `/pcf/` 图片可能因重定向显示破图，重新登录并刷新。
- T6 已实现 Team Setup 目录、Daily Log Actor 列/筛选/导出和提出人控件。PCF 持久模板保持版本 6：统一登录控件由 hosted kjx adapter 注入，不改 legacy/offline 模板字节；升级 dry-run 与 `fec6429` reader 兼容性已有执行测试。
- 后端端口若可被用户网络直连，客户端可自行提供 `X-Auth-Token`，绕过 nginx 的头覆盖边界；必须保持仅 nginx 可达并纳入每次部署验收。

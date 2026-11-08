import adminHtml from './admin.html';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface Env {
  PAPC_DB?: D1Database;
  API_TOKEN?: string;
  ALLOW_CORS_ORIGIN?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SQL?: (sql: string) => Record<string, unknown>[];
  DRAWING_WRITE?: (projectId: string, drawing: any) => Promise<any>;
}

interface ProjectListRow extends Record<string, unknown> {
  id: string;
  name: string;
  storage_path: string | null;
  last_updated: string | null;
}

interface ProjectDetailRow extends ProjectListRow {
  project_json: string | null;
  conf_json: string | null;
}

interface SettingsRow extends Record<string, unknown> {
  value: string | null;
  updated_at: string | null;
}

interface ReviewTrackerRow extends Record<string, unknown> {
  data_json: string | null;
  updated_at: string | null;
}

type SqlRow = Record<string, unknown>;

interface DrawingLogShape {
  id: string;
  version: string;
  receivedDate: string;
  dueDate: string;
  sentDate?: string;
  commentCount: number;
}

interface RemarkShape {
  id: string;
  content: string;
  createdAt: string;
  resolved?: boolean;
}

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
};

const readJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn('Failed to parse JSON from D1 row.', error);
    return fallback;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const pick = <T = unknown>(row: SqlRow, ...keys: string[]): T | undefined => {
  for (const key of keys) {
    if (key in row && row[key] !== undefined && row[key] !== null) {
      return row[key] as T;
    }
  }
  return undefined;
};

const toStringValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return String(value);
};

const toNumberValue = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBooleanValue = (value: unknown): boolean | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return undefined;
};

const hasColumn = (columns: string[], ...candidates: string[]) =>
  candidates.some(candidate => columns.includes(candidate));

const splitCsv = (value: string | undefined): string[] =>
  value
    ? value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    : [];

const withCors = (headers: Headers, env: Env): Headers => {
  headers.set('Access-Control-Allow-Origin', env.ALLOW_CORS_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return headers;
};

const json = (env: Env, status: number, body: JsonValue): Response => {
  const headers = withCors(new Headers(jsonHeaders), env);
  return new Response(JSON.stringify(body), { status, headers });
};

const text = (env: Env, status: number, body: string): Response => {
  const headers = withCors(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }), env);
  return new Response(body, { status, headers });
};

const requireDb = (env: Env): D1Database => {
  if (!env.PAPC_DB) {
    throw new Error('Missing D1 binding `PAPC_DB`.');
  }
  return env.PAPC_DB;
};

const isAuthorized = (request: Request, env: Env): boolean => {
  if (!env.API_TOKEN) {
    return true;
  }

  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.API_TOKEN}`;
};

const getObjectColumns = async (db: D1Database, objectName: string): Promise<string[]> => {
  const pragmaName = objectName.replace(/'/g, "''");
  const result = await db.prepare(`PRAGMA table_info("${pragmaName}")`).all<{ name?: string }>();
  return (result.results || []).map(row => row.name).filter((value): value is string => Boolean(value));
};

const objectExists = async (db: D1Database, objectName: string): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE name = ?
         AND type IN ('table', 'view')
       LIMIT 1`
    )
    .bind(objectName)
    .first<{ name?: string }>();

  return Boolean(row?.name);
};

const queryAll = async <T extends SqlRow = SqlRow>(db: D1Database, query: string, values: unknown[] = []) => {
  return (await db.prepare(query).bind(...values).all<T>()).results || [];
};

const queryFirst = async <T extends SqlRow = SqlRow>(db: D1Database, query: string, values: unknown[] = []) =>
  db.prepare(query).bind(...values).first<T>();

const buildSettingsFromRow = (row: SqlRow | null | undefined) => {
  if (!row) return {};

  const jsonSource =
    toStringValue(pick(row, 'value', 'settings_json', 'data_json', 'json', 'settings', 'data')) || null;

  if (jsonSource) {
    return readJson<Record<string, JsonValue>>(jsonSource, {});
  }

  return {
    reviewers: asArray(pick(row, 'reviewers')).map(item => asRecord(item)) as JsonValue[],
    disciplineDefaults: asRecord(pick(row, 'discipline_defaults', 'disciplineDefaults')) as JsonValue,
    holidays: asArray(pick(row, 'holidays')) as JsonValue[],
    roundACycle: toNumberValue(pick(row, 'round_a_cycle', 'roundACycle')),
    otherRoundsCycle: toNumberValue(pick(row, 'other_rounds_cycle', 'otherRoundsCycle')),
    displayName: toStringValue(pick(row, 'display_name', 'displayName')),
    autoSyncInterval: toNumberValue(pick(row, 'auto_sync_interval', 'autoSyncInterval')),
  };
};

const mapDrawingLog = (row: SqlRow): DrawingLogShape => ({
  id: toStringValue(pick(row, 'id', 'log_id')) || crypto.randomUUID(),
  version: toStringValue(pick(row, 'version')) || '',
  receivedDate: toStringValue(pick(row, 'received_date', 'receivedDate')) || '',
  dueDate: toStringValue(pick(row, 'due_date', 'dueDate', 'deadline')) || '',
  sentDate: toStringValue(pick(row, 'sent_date', 'sentDate')),
  commentCount: toNumberValue(pick(row, 'comment_count', 'commentCount'), 0),
});

const mapRemark = (row: SqlRow): RemarkShape => ({
  id: toStringValue(pick(row, 'id', 'remark_id')) || crypto.randomUUID(),
  content: toStringValue(pick(row, 'content', 'text', 'remark')) || '',
  createdAt: toStringValue(pick(row, 'created_at', 'createdAt', 'timestamp')) || new Date(0).toISOString(),
  resolved: toBooleanValue(pick(row, 'resolved', 'is_resolved')),
});

const mapDrawing = (
  row: SqlRow,
  logsByDrawingId: Map<string, DrawingLogShape[]>,
  remarksByDrawingId: Map<string, RemarkShape[]>,
  statusHistoryByDrawingId: Map<string, RemarkShape[]>
) => {
  const drawingId = toStringValue(pick(row, 'id', 'drawing_id')) || crypto.randomUUID();
  const receivedDate = toStringValue(pick(row, 'received_date', 'receivedDate'));
  const reviewDeadline = toStringValue(pick(row, 'review_deadline', 'reviewDeadline', 'due_date', 'deadline'));
  const assigneeCsv = splitCsv(toStringValue(pick(row, 'assignees_csv')));
  const assigneeList =
    assigneeCsv.length > 0 ? assigneeCsv : (asArray(pick(row, 'assignees')).map(item => String(item)) as string[]);

  return {
    id: drawingId,
    customId: toStringValue(pick(row, 'custom_id', 'customId')) || '',
    drawingNo: toStringValue(pick(row, 'drawing_no', 'drawingNo', 'number')) || '',
    title: toStringValue(pick(row, 'title', 'name')) || '',
    discipline: toStringValue(pick(row, 'discipline')) || '',
    assignees: assigneeList,
    status: toStringValue(pick(row, 'status')) || 'Pending',
    currentRound: toStringValue(pick(row, 'current_round', 'currentRound', 'round')) || 'A',
    version: toStringValue(pick(row, 'version')) || '',
    manualCommentsCount: toNumberValue(pick(row, 'manual_comments_count', 'manualCommentsCount', 'comment_count'), 0),
    manualOpenCommentsCount: toNumberValue(
      pick(row, 'manual_open_comments_count', 'manualOpenCommentsCount', 'open_comment_count'),
      0
    ),
    reviewDeadline,
    receivedDate,
    category: toStringValue(pick(row, 'category')) as 'A' | 'B' | 'C' | undefined,
    deadline: toStringValue(pick(row, 'deadline')),
    checked: toBooleanValue(pick(row, 'checked')),
    checkedSynced: toBooleanValue(pick(row, 'checked_synced', 'checkedSynced')),
    logs: logsByDrawingId.get(drawingId) || [],
    remarks: remarksByDrawingId.get(drawingId) || [],
    statusHistory: statusHistoryByDrawingId.get(drawingId) || [],
  };
};

const getProjectList = async (db: D1Database) => {
  const rows = await queryAll<ProjectListRow>(
    db,
    `SELECT id, name, storage_path, last_updated
     FROM api_projects
     ORDER BY name COLLATE NOCASE ASC`
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    storagePath: row.storage_path || undefined,
    lastUpdated: row.last_updated || undefined,
  }));
};

const getSettings = async (db: D1Database) => {
  const row = await queryFirst<SettingsRow>(db, 'SELECT value, updated_at FROM api_settings LIMIT 1');
  return readJson<Record<string, JsonValue>>(row?.value, {});
};

const getProjectDetail = async (db: D1Database, projectId: string) => {
  const row = await queryFirst<ProjectDetailRow>(
    db,
    `SELECT id, name, storage_path, last_updated, project_json, conf_json
     FROM api_project_details
     WHERE id = ?
     LIMIT 1`,
    [projectId]
  );

  if (!row) return null;

  const project = readJson<Record<string, JsonValue>>(row.project_json, {});
  const conf = readJson<Record<string, JsonValue>>(row.conf_json, {});
  const pcfRows = await queryAll(db, 'SELECT drawing_id FROM pcf_index WHERE project_id=?', [projectId]);
  const pcfIds = new Set(pcfRows.map(r => String(r.drawing_id)));
  if (Array.isArray(project.drawings)) project.drawings = project.drawings.map((d: any) => ({ ...d, hasPcf: pcfIds.has(String(d.id)) }));

  return {
    ...project,
    id: row.id,
    name: row.name,
    storagePath: row.storage_path || undefined,
    conf,
    lastUpdated: row.last_updated || undefined,
  };
};

// 语句分组执行：同一组（例如一张图纸的 DELETE + 随后的 INSERT）永远落在同一个 db.batch 事务里。
// 之前按固定 100 条切批，边界可能落在 DELETE 与 INSERT 之间，后一批失败会把关联数据清空后写不回来。
class StatementGroups {
  private groups: D1PreparedStatement[][] = [];
  private current: D1PreparedStatement[] = [];

  push(...stmts: D1PreparedStatement[]) {
    this.current.push(...stmts);
  }

  // 关闭当前组：此前累积的语句构成一个不可拆分的整体
  mark() {
    if (this.current.length > 0) {
      this.groups.push(this.current);
      this.current = [];
    }
  }

  get size() {
    return this.groups.reduce((n, g) => n + g.length, 0) + this.current.length;
  }

  all() {
    this.mark();
    return this.groups;
  }

  drain() {
    const groups = this.all();
    this.groups = [];
    return groups;
  }
}

// 按组打包执行，单批上限 chunkSize；单组超过上限时独立成批，保证组内原子性
const runStatementGroups = async (db: D1Database, groups: D1PreparedStatement[][], chunkSize = 100) => {
  let buffer: D1PreparedStatement[] = [];
  const flush = async () => {
    if (buffer.length > 0) {
      await db.batch(buffer);
      buffer = [];
    }
  };

  for (const group of groups) {
    if (group.length === 0) continue;
    if (group.length >= chunkSize) {
      await flush();
      await db.batch(group);
      continue;
    }
    if (buffer.length + group.length > chunkSize) await flush();
    buffer.push(...group);
  }
  await flush();
};

const getReviewTracker = async (db: D1Database, projectId: string) => {
  const row = await queryFirst<ReviewTrackerRow>(
    db,
    `SELECT data_json, updated_at
     FROM api_review_trackers
     WHERE project_id = ?
     LIMIT 1`,
    [projectId]
  );

  return readJson<Record<string, JsonValue>>(row?.data_json, {});
};

// ---------------------------------------------------------------------------
// 写入日志 + 回读校验：共用的行归一化
// ---------------------------------------------------------------------------

// drawings 的 upsert 实际绑定的那组值。客户端 payload（camelCase）与 D1 行
// （snake_case）都能喂进来，因此校验比的是「worker 真正写下去的值」而不是原始
// payload —— 否则 '' vs null、true vs 1 这类归一化差异会制造大量假失配。
interface NormalizedDrawing {
  customId: string;
  drawingNo: string;
  discipline: string;
  title: string;
  status: string;
  version: string;
  currentRound: string;
  reviewDeadline: string | null;
  manualCommentsCount: number;
  manualOpenCommentsCount: number;
  checked: number;
  checkedSynced: number;
  receivedDate: string | null;
  category: string | null;
  deadline: string | null;
}

const normalizeDrawingRow = (source: SqlRow): NormalizedDrawing => ({
  customId: toStringValue(pick(source, 'customId', 'custom_id')) || '',
  drawingNo: toStringValue(pick(source, 'drawingNo', 'drawing_no')) || '',
  discipline: toStringValue(pick(source, 'discipline')) || '',
  title: toStringValue(pick(source, 'title')) || '',
  status: toStringValue(pick(source, 'status')) || 'Pending',
  version: toStringValue(pick(source, 'version')) || '',
  currentRound: toStringValue(pick(source, 'currentRound', 'current_round')) || 'A',
  reviewDeadline: toStringValue(pick(source, 'reviewDeadline', 'review_deadline')) || null,
  manualCommentsCount: toNumberValue(pick(source, 'manualCommentsCount', 'manual_comments_count'), 0),
  manualOpenCommentsCount: toNumberValue(pick(source, 'manualOpenCommentsCount', 'manual_open_comments_count'), 0),
  checked: toBooleanValue(pick(source, 'checked')) ? 1 : 0,
  checkedSynced: toBooleanValue(pick(source, 'checkedSynced', 'checked_synced')) ? 1 : 0,
  receivedDate: toStringValue(pick(source, 'receivedDate', 'received_date')) || null,
  category: toStringValue(pick(source, 'category')) || null,
  deadline: toStringValue(pick(source, 'deadline')) || null,
});

const DRAWING_COMPARE_FIELDS: (keyof NormalizedDrawing)[] = [
  'customId', 'drawingNo', 'discipline', 'title', 'status', 'version', 'currentRound',
  'reviewDeadline', 'manualCommentsCount', 'manualOpenCommentsCount', 'checked',
  'checkedSynced', 'receivedDate', 'category', 'deadline',
];

const DRAWING_UPSERT_SQL =
  `INSERT INTO drawings (id, project_id, custom_id, drawing_no, discipline, title, status, version, current_round, review_deadline, manual_comments_count, manual_open_comments_count, checked, checked_synced, received_date, category, deadline)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     custom_id=excluded.custom_id, drawing_no=excluded.drawing_no, discipline=excluded.discipline, title=excluded.title,
     status=excluded.status,
     version=CASE WHEN EXISTS(SELECT 1 FROM pcf_index WHERE project_id=drawings.project_id AND drawing_id=drawings.id) THEN drawings.version ELSE excluded.version END,
     current_round=CASE WHEN EXISTS(SELECT 1 FROM pcf_index WHERE project_id=drawings.project_id AND drawing_id=drawings.id) THEN drawings.current_round ELSE excluded.current_round END,
     review_deadline=excluded.review_deadline,
     manual_comments_count=CASE WHEN EXISTS(SELECT 1 FROM pcf_index WHERE project_id=drawings.project_id AND drawing_id=drawings.id) THEN drawings.manual_comments_count ELSE excluded.manual_comments_count END,
     manual_open_comments_count=CASE WHEN EXISTS(SELECT 1 FROM pcf_index WHERE project_id=drawings.project_id AND drawing_id=drawings.id) THEN drawings.manual_open_comments_count ELSE excluded.manual_open_comments_count END,
     checked=excluded.checked, checked_synced=excluded.checked_synced,
     received_date=excluded.received_date, category=excluded.category, deadline=excluded.deadline`;

const drawingBindValues = (id: string, projectId: string, n: NormalizedDrawing): unknown[] => [
  id, projectId, n.customId, n.drawingNo, n.discipline, n.title, n.status, n.version,
  n.currentRound, n.reviewDeadline, n.manualCommentsCount, n.manualOpenCommentsCount,
  n.checked, n.checkedSynced, n.receivedDate, n.category, n.deadline,
];

const DRAWING_ROW_COLUMNS =
  `id, custom_id, drawing_no, discipline, title, status, version, current_round,
   review_deadline, manual_comments_count, manual_open_comments_count,
   checked, checked_synced, received_date, category, deadline`;

// 按项目整取，不用 IN (...)：绑定参数不会随图纸数量膨胀。
// 写前调 = 日志的 baseline，写后调 = 校验的对照。
const readDrawingRows = async (db: D1Database, projectId: string): Promise<Map<string, NormalizedDrawing>> => {
  const rows = await queryAll(
    db,
    `SELECT ${DRAWING_ROW_COLUMNS} FROM drawings WHERE project_id = ?`,
    [projectId]
  );

  const map = new Map<string, NormalizedDrawing>();
  for (const row of rows) {
    const id = toStringValue(row.id);
    if (id) map.set(id, normalizeDrawingRow(row));
  }
  return map;
};

// admin 面板按单行改，拿不到 projectId，所以单独一个按 id 的读取
const readDrawingRowById = async (db: D1Database, drawingId: string) => {
  const row = await queryFirst(
    db,
    `SELECT project_id, ${DRAWING_ROW_COLUMNS} FROM drawings WHERE id = ? LIMIT 1`,
    [drawingId]
  );
  if (!row) return null;
  return { projectId: toStringValue(row.project_id) || '', row: normalizeDrawingRow(row) };
};

// 每张子表一条分组计数，不是每图纸一条 —— 查询次数与图纸数量无关
const readChildCounts = async (db: D1Database, projectId: string) => {
  const countsFor = async (table: string) => {
    const rows = await queryAll(
      db,
      `SELECT drawing_id, COUNT(*) AS c FROM ${table}
       WHERE drawing_id IN (SELECT id FROM drawings WHERE project_id = ?)
       GROUP BY drawing_id`,
      [projectId]
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      const id = toStringValue(row.drawing_id);
      if (id) map.set(id, toNumberValue(row.c, 0));
    }
    return map;
  };

  const [assignees, statusHistory, remarks] = await Promise.all([
    countsFor('drawing_assignees'),
    countsFor('drawing_status_history'),
    countsFor('drawing_remarks'),
  ]);
  return { assignees, statusHistory, remarks };
};

const readTrackerRows = async (db: D1Database, projectId: string): Promise<Map<string, Map<string, number>>> => {
  const rows = await queryAll(
    db,
    `SELECT drawing_id, reviewer_id, done FROM review_tracker WHERE project_id = ?`,
    [projectId]
  );

  const map = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const drawingId = toStringValue(row.drawing_id);
    const reviewerId = toStringValue(row.reviewer_id);
    if (!drawingId || !reviewerId) continue;
    if (!map.has(drawingId)) map.set(drawingId, new Map());
    map.get(drawingId)!.set(reviewerId, toBooleanValue(row.done) ? 1 : 0);
  }
  return map;
};

// ---------------------------------------------------------------------------
// 写入日志：只记状态变更与意见增减，两者都在 drawings 表上
// ---------------------------------------------------------------------------

const JOURNAL_RETENTION_DAYS = 180;
const AUDIT_QUERY_LIMIT = 2000;

// created_at 显式绑定 ISO-8601：列默认的 datetime('now') 产出 "2026-08-21 14:30:00"
// （空格分隔），前端 date-fns 的 parseISO 不认这个格式
const auditStatement = (
  db: D1Database,
  projectId: string,
  rowId: string,
  action: string,
  detail: Record<string, unknown>
) =>
  db.prepare(
    `INSERT INTO audit_log (table_name, row_id, project_id, action, detail, created_at)
     VALUES ('drawings', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).bind(rowId, projectId, action, JSON.stringify(detail));

// customId / drawingNo 冗余进 detail：图纸日后改号或删除时日志仍可读，读取时也不必 JOIN。
// after 取自写入之后回读的真实行，不是客户端 payload —— 日志因此记录「数据库实际发生了什么」，
// 写入被截断或落库值与请求不符时，日志跟着真实结果走
const buildJournalStatements = (
  db: D1Database,
  projectId: string,
  baseline: Map<string, NormalizedDrawing>,
  actual: Map<string, NormalizedDrawing>,
  touchedIds: string[],
  source: string
): D1PreparedStatement[] => {
  const stmts: D1PreparedStatement[] = [];

  for (const id of touchedIds) {
    const before = baseline.get(id);
    // 新建图纸不记：批量导入几百张会把日志刷满。首次导入后的第一次变更照常记录
    if (!before) continue;

    const after = actual.get(id);
    if (!after) continue;

    if (before.status !== after.status) {
      const detail: Record<string, unknown> = {
        customId: after.customId,
        drawingNo: after.drawingNo,
        from: before.status,
        to: after.status,
        source,
      };
      // 轮次是状态迁移的副产品，并入同一条；只有轮次变、状态没变时不记
      if (before.currentRound !== after.currentRound) {
        detail.round = { from: before.currentRound, to: after.currentRound };
      }
      stmts.push(auditStatement(db, projectId, id, 'STATUS', detail));
    }

    if (
      before.manualCommentsCount !== after.manualCommentsCount ||
      before.manualOpenCommentsCount !== after.manualOpenCommentsCount
    ) {
      stmts.push(auditStatement(db, projectId, id, 'COMMENTS', {
        customId: after.customId,
        drawingNo: after.drawingNo,
        from: { total: before.manualCommentsCount, open: before.manualOpenCommentsCount },
        to: { total: after.manualCommentsCount, open: after.manualOpenCommentsCount },
        source,
      }));
    }
  }

  return stmts;
};

// 子查询限量：避免某次请求撞上一次巨型删除。
// 只清本模块写的行，不动 admin 路由已有的 INSERT/UPDATE/DELETE/SQL 审计记录
const journalPruneStatement = (db: D1Database) =>
  db.prepare(
    `DELETE FROM audit_log WHERE id IN (
       SELECT id FROM audit_log
       WHERE action IN ('STATUS','COMMENTS')
         AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now',?)
       LIMIT 500
     )`
  ).bind(`-${JOURNAL_RETENTION_DAYS} days`);

// 单独一批提交，绝不混进业务的 StatementGroups：
// 日志写失败不该让整张图纸的保存回滚
const writeJournal = async (db: D1Database, stmts: D1PreparedStatement[]) => {
  if (stmts.length === 0) return;
  try {
    await db.batch([...stmts, journalPruneStatement(db)]);
  } catch (error) {
    console.warn('Audit journal write failed; business write unaffected.', error);
  }
};

// ---------------------------------------------------------------------------
// L2 回读校验：写入之后同请求内再读一次，比对实际落库结果
// ---------------------------------------------------------------------------

interface WriteVerification {
  ok: boolean;
  checked: number;
  mismatched: Array<{ id: string; customId?: string; fields: string[] }>;
  error?: string; // 校验查询本身失败 = "无法确认"，不代表写入失败
}

const VERIFICATION_SKIPPED: WriteVerification = { ok: true, checked: 0, mismatched: [] };

const diffDrawing = (expected: NormalizedDrawing, actual: NormalizedDrawing | undefined): string[] => {
  if (!actual) return ['missing'];
  return DRAWING_COMPARE_FIELDS.filter(field => expected[field] !== actual[field]) as string[];
};

const verifyWrite = async (
  db: D1Database,
  projectId: string,
  drawings: any[],
  tracker: Record<string, any> | null,
  // 传入时，用回读到的真实行与 baseline 生成写入日志，与校验共用同一次读取
  journal?: { baseline: Map<string, NormalizedDrawing>; source: string }
): Promise<WriteVerification> => {
  const drawingList = Array.isArray(drawings) ? drawings.filter(d => toStringValue(d?.id)) : [];
  const trackerEntries = tracker && typeof tracker === 'object' ? Object.entries(tracker) : [];
  if (drawingList.length === 0 && trackerEntries.length === 0) return VERIFICATION_SKIPPED;

  try {
    const byId = new Map<string, { id: string; customId?: string; fields: string[] }>();
    const addFields = (id: string, customId: string | undefined, fields: string[]) => {
      if (fields.length === 0) return;
      const existing = byId.get(id);
      if (existing) existing.fields.push(...fields);
      else byId.set(id, { id, customId: customId || undefined, fields: [...fields] });
    };

    if (drawingList.length > 0) {
      const [actual, counts] = await Promise.all([
        readDrawingRows(db, projectId),
        readChildCounts(db, projectId),
      ]);

      if (journal) {
        const touchedIds = drawingList.map(d => toStringValue(d.id)!);
        await writeJournal(
          db,
          buildJournalStatements(db, projectId, journal.baseline, actual, touchedIds, journal.source)
        );
      }

      const pcfRows = await queryAll(db, 'SELECT drawing_id FROM pcf_index WHERE project_id=?', [projectId]);
      const pcfIds = new Set(pcfRows.map(r => String(r.drawing_id)));
      const pcfFields = new Set(['version', 'currentRound', 'manualCommentsCount', 'manualOpenCommentsCount']);
      for (const drawing of drawingList) {
        const id = toStringValue(drawing.id)!;
        const expected = normalizeDrawingRow(drawing.__expected || drawing);
        const fields = diffDrawing(expected, actual.get(id)).filter(field => !pcfIds.has(id) || !pcfFields.has(field));

        // 子表行数：捕捉「DELETE 成功、INSERT 没跟上」那一类故障
        const expectedDrawing = drawing.__expected || drawing;
        const expectedAssignees = new Set(
          (Array.isArray(expectedDrawing.assignees) ? expectedDrawing.assignees : [])
            .filter((a: unknown) => a != null)
            .map((a: unknown) => String(a))
        ).size;
        if ((counts.assignees.get(id) || 0) !== expectedAssignees) fields.push('assigneeCount');

        const expectedHistory = Array.isArray(drawing.statusHistory) ? drawing.statusHistory.length : 0;
        if ((counts.statusHistory.get(id) || 0) !== expectedHistory) fields.push('statusHistoryCount');

        const expectedRemarks = Array.isArray(expectedDrawing.remarks) ? expectedDrawing.remarks.length : 0;
        if ((counts.remarks.get(id) || 0) !== expectedRemarks) fields.push('remarkCount');

        addFields(id, expected.customId, fields);
      }
    }

    if (trackerEntries.length > 0) {
      const actualTracker = await readTrackerRows(db, projectId);
      for (const [drawingId, assignees] of trackerEntries) {
        if (!assignees || typeof assignees !== 'object') continue;
        const actualRow = actualTracker.get(drawingId);
        const fields: string[] = [];
        for (const [reviewerId, info] of Object.entries(assignees as Record<string, any>)) {
          const expectedDone = toBooleanValue(info?.done) ? 1 : 0;
          if ((actualRow?.get(reviewerId) ?? 0) !== expectedDone) fields.push(`tracker:${reviewerId}`);
        }
        addFields(drawingId, undefined, fields);
      }
    }

    const mismatched = Array.from(byId.values());
    return {
      ok: mismatched.length === 0,
      checked: drawingList.length + trackerEntries.length,
      mismatched,
    };
  } catch (error) {
    // 校验查询自身失败只说明「无法确认」，写入本身可能是成功的
    const message = error instanceof Error ? error.message : 'Verification query failed';
    console.warn('Write verification failed.', error);
    return { ok: false, checked: 0, mismatched: [], error: message };
  }
};

const saveProjectData = async (
  db: D1Database,
  projectId: string,
  project: any,
  reviewTracker: any,
  // 写入日志的来源标记：正常保存 / 整库导入 / 快照恢复，三者在 Log 页可区分
  source: string = 'app',
  drawingWrite?: Env['DRAWING_WRITE']
) => {
  if (!project || !Array.isArray(project.drawings)) return VERIFICATION_SKIPPED;
  const stmts = new StatementGroups();

  // Update/Insert projects table
  const projectName = toStringValue(project.name) || projectId;
  const storagePath = toStringValue(project.storagePath) || '';
  stmts.push(db.prepare(
    `INSERT INTO projects (id, name, storage_path, last_updated)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET 
       name=excluded.name, storage_path=excluded.storage_path, last_updated=excluded.last_updated`
  ).bind(projectId, projectName, storagePath));
  stmts.mark();

  if (drawingWrite) await runStatementGroups(db, stmts.drain());

  // Extract valid drawing IDs to delete removed ones
  // 这次读取同时兼作写入日志的 baseline —— 全量路径因此没有额外查询
  const validIds = new Set(project.drawings.map((d: any) => toStringValue(d.id)).filter(Boolean) as string[]);
  const baseline = await readDrawingRows(db, projectId);
  const toDelete = Array.from(baseline.keys()).filter(id => !validIds.has(id));

  for (const delId of toDelete) {
    // 清理关联数据：assignees、statusHistory、remarks、tracker
    stmts.push(db.prepare(`DELETE FROM drawing_assignees WHERE drawing_id = ?`).bind(delId));
    stmts.push(db.prepare(`DELETE FROM drawing_status_history WHERE drawing_id = ?`).bind(delId));
    stmts.push(db.prepare(`DELETE FROM drawing_remarks WHERE drawing_id = ?`).bind(delId));
    stmts.push(db.prepare(`DELETE FROM review_tracker WHERE project_id = ? AND drawing_id = ?`).bind(projectId, delId));
    stmts.push(db.prepare(`DELETE FROM drawings WHERE project_id = ? AND id = ?`).bind(projectId, delId));
    stmts.mark(); // 一张图纸的删除是一个整体
  }

  const writtenDrawings: any[] = [];
  // Upsert drawings and their relations
  for (const drawing of project.drawings) {
    if (drawingWrite) continue;
    const id = toStringValue(drawing.id) || crypto.randomUUID();
    stmts.push(db.prepare(DRAWING_UPSERT_SQL).bind(...drawingBindValues(id, projectId, normalizeDrawingRow(drawing))));

    // Assignees (dedupe and filter null/undefined to avoid PK conflict)
    stmts.push(db.prepare(`DELETE FROM drawing_assignees WHERE drawing_id = ?`).bind(id));
    if (Array.isArray(drawing.assignees)) {
      const seen = new Set<string>();
      for (const assignee of drawing.assignees) {
        if (assignee == null) continue;
        const s = String(assignee);
        if (seen.has(s)) continue;
        seen.add(s);
        stmts.push(db.prepare(`INSERT INTO drawing_assignees (drawing_id, reviewer_id) VALUES (?, ?)`).bind(id, s));
      }
    }

    // Status History
    stmts.push(db.prepare(`DELETE FROM drawing_status_history WHERE drawing_id = ?`).bind(id));
    if (Array.isArray(drawing.statusHistory)) {
      for (const history of drawing.statusHistory) {
        stmts.push(db.prepare(`INSERT INTO drawing_status_history (id, drawing_id, content, created_at) VALUES (?, ?, ?, ?)`).bind(
          toStringValue(history.id) || crypto.randomUUID(), id,
          toStringValue(history.content) || '', toStringValue(history.createdAt) || new Date().toISOString()
        ));
      }
    }

    // Remarks (Internal Notes)
    stmts.push(db.prepare(`DELETE FROM drawing_remarks WHERE drawing_id = ?`).bind(id));
    if (Array.isArray(drawing.remarks)) {
      for (const remark of drawing.remarks) {
        stmts.push(db.prepare(
          `INSERT INTO drawing_remarks (id, project_id, drawing_id, content, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          toStringValue(remark.id) || crypto.randomUUID(), projectId, id,
          toStringValue(remark.content) || '', toStringValue(remark.createdAt) || new Date().toISOString(),
          toBooleanValue(remark.resolved) ? 1 : 0
        ));
      }
    }

    stmts.mark(); // 一张图纸的 upsert + 关联表重建是一个整体
  }

  // Persist Project Configuration (conf)
  if (project.conf) {
    const conf = project.conf;

    // 1. project_settings
    const settingsMap: Record<string, any> = {
      displayName: conf.displayName,
      password: conf.password,
      holidays: Array.isArray(conf.holidays) ? JSON.stringify(conf.holidays) : '[]',
      roundACycle: conf.roundACycle,
      otherRoundsCycle: conf.otherRoundsCycle,
      autoSyncInterval: conf.autoSyncInterval,
      projectSummary: conf.projectSummary ? JSON.stringify(conf.projectSummary) : undefined
    };

    for (const [key, val] of Object.entries(settingsMap)) {
      if (val !== undefined && val !== null) {
        stmts.push(db.prepare(
          `INSERT INTO project_settings (project_id, setting_key, setting_value)
           VALUES (?, ?, ?)
           ON CONFLICT(project_id, setting_key) DO UPDATE SET setting_value=excluded.setting_value`
        ).bind(projectId, key, String(val)));
      }
    }
    stmts.mark();

    // 2. discipline_defaults
    if (conf.disciplineDefaults && typeof conf.disciplineDefaults === 'object') {
      stmts.push(db.prepare(`DELETE FROM discipline_defaults WHERE project_id = ?`).bind(projectId));
      for (const [discipline, reviewerId] of Object.entries(conf.disciplineDefaults)) {
        if (reviewerId) {
          stmts.push(db.prepare(
            `INSERT INTO discipline_defaults (project_id, discipline, reviewer_id)
             VALUES (?, ?, ?)`
          ).bind(projectId, discipline, String(reviewerId)));
        }
      }
      stmts.mark(); // 整表重建，不可拆
    }

    // 3. discipline_default_assignees
    if (conf.defaultAssignees && typeof conf.defaultAssignees === 'object') {
      stmts.push(db.prepare(`DELETE FROM discipline_default_assignees WHERE project_id = ?`).bind(projectId));
      for (const [discipline, reviewerIds] of Object.entries(conf.defaultAssignees)) {
        if (Array.isArray(reviewerIds)) {
          for (const revId of reviewerIds) {
            stmts.push(db.prepare(
              `INSERT INTO discipline_default_assignees (project_id, discipline, reviewer_id)
               VALUES (?, ?, ?)`
            ).bind(projectId, discipline, String(revId)));
          }
        }
      }
      stmts.mark(); // 整表重建，不可拆
    }

    // 4. Update global reviewers if provided (since they are shared)
    if (Array.isArray(conf.reviewers) && conf.reviewers.length > 0) {
      // Small optimization: only update if we have reviewers
      for (const rev of conf.reviewers) {
        if (rev.id) {
          stmts.push(db.prepare(
            `INSERT INTO reviewers (id, display_name)
             VALUES (?, ?)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name`
          ).bind(rev.id, rev.name || rev.id));
        }
      }
      stmts.mark();
    }
  }

  if (drawingWrite) {
    await runStatementGroups(db, stmts.drain());
    for (const drawing of project.drawings) writtenDrawings.push(await drawingWrite(projectId, drawing));
  }

  // Full save owns the entire tracker state for this project：按图纸逐张重建，
  // 每张的 DELETE + INSERT 同批提交。不再用一条项目级 DELETE + 全部 INSERT，
  // 否则那一大组要么超批次上限、要么被拆开后失败时整个项目的 check 全丢。
  const sanitizedTracker = sanitizeProjectReviewTracker(project, reviewTracker);

  // 先清掉已不属于任何现存图纸的残留行（子查询避免绑定参数随图纸数量膨胀）
  stmts.push(db.prepare(
    `DELETE FROM review_tracker
     WHERE project_id = ? AND drawing_id NOT IN (SELECT id FROM drawings WHERE project_id = ?)`
  ).bind(projectId, projectId));
  stmts.mark();

  for (const drawing of project.drawings) {
    const id = toStringValue(drawing.id);
    if (!id) continue;
    stmts.push(db.prepare(`DELETE FROM review_tracker WHERE project_id = ? AND drawing_id = ?`).bind(projectId, id));
    const entry = sanitizedTracker[id];
    if (entry && Object.keys(entry).length > 0) {
      stmts.push(...buildReviewTrackerStatements(db, projectId, { [id]: entry }));
    }
    stmts.mark();
  }

  await runStatementGroups(db, stmts.all());

  // tracker 用 sanitize 之后的版本比对：写下去的就是它，拿原始 payload 比会产生假失配
  return verifyWrite(db, projectId, drawingWrite ? writtenDrawings : project.drawings, sanitizedTracker, drawingWrite ? undefined : { baseline, source });
};

const buildReviewTrackerStatements = (db: D1Database, projectId: string, data: any): D1PreparedStatement[] => {
  const stmts: D1PreparedStatement[] = [];

  for (const [drawingId, assignees] of Object.entries(data)) {
    if (!assignees || typeof assignees !== 'object') continue;
    for (const [reviewerId, info] of Object.entries(assignees as Record<string, any>)) {
      stmts.push(db.prepare(
        `INSERT INTO review_tracker (project_id, drawing_id, raw_drawing_ref, reviewer_id, done, done_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, drawing_id, reviewer_id) DO UPDATE SET
           done=excluded.done, done_at=excluded.done_at`
      ).bind(
        projectId, drawingId, drawingId, reviewerId,
        toBooleanValue(info.done) ? 1 : 0, toStringValue(info.doneAt) || null
      ));
    }
  }
  return stmts;
};

const sanitizeProjectReviewTracker = (project: any, reviewTracker: any) => {
  const sanitized: Record<string, Record<string, any>> = {};
  if (!reviewTracker || typeof reviewTracker !== 'object' || !Array.isArray(project?.drawings)) return sanitized;

  for (const drawing of project.drawings) {
    const drawingId = toStringValue(drawing.id);
    if (!drawingId) continue;
    const incoming = reviewTracker[drawingId];
    if (!incoming || typeof incoming !== 'object') continue;

    const allowedReviewers = new Set((Array.isArray(drawing.assignees) ? drawing.assignees : []).map((item: any) => String(item)));
    allowedReviewers.add('__approved__');

    for (const [reviewerId, info] of Object.entries(incoming as Record<string, any>)) {
      if (allowedReviewers.has(reviewerId)) {
        if (!sanitized[drawingId]) sanitized[drawingId] = {};
        sanitized[drawingId][reviewerId] = info;
      }
    }
  }

  return sanitized;
};

const saveReviewTrackerData = async (db: D1Database, projectId: string, data: any) => {
  // 纯 upsert，没有 DELETE，按图纸分组只是为了让同一张图纸的多个负责人一起提交
  const groups = Object.entries(data || {})
    .map(([drawingId, assignees]) => buildReviewTrackerStatements(db, projectId, { [drawingId]: assignees }))
    .filter(g => g.length > 0);
  await runStatementGroups(db, groups);
  return verifyWrite(db, projectId, [], data || null);
};

const handleHealth = async (env: Env) => {
  const db = requireDb(env);
  const settingsSource = 'api_settings';
  const settingsCountRow = await db.prepare(`SELECT COUNT(*) AS count FROM ${settingsSource}`).first<{ count: number | string }>();

  return json(env, 200, {
    ok: true,
    service: 'papc-d1-api',
    database: 'connected',
    settingsSource,
    appSettingsRows: Number(settingsCountRow?.count || 0),
  });
};

const notImplemented = (env: Env, method: string, path: string) =>
  json(env, 501, {
    error: 'Not implemented in phase 2 scaffold.',
    method,
    path,
    supportedToday: [
      'GET /health',
      'GET /settings',
      'GET /projects',
      'POST /projects/:projectId',
      'GET /projects/:projectId/review-tracker',
      'GET /projects/:projectId/audit?from=&to=',
    ],
  });

const handleAdminRequest = async (request: Request, env: Env, url: URL): Promise<Response> => {
  // No default password: without ADMIN_PASSWORD the admin console is not served.
  const pwd = env.ADMIN_PASSWORD?.trim();
  if (!pwd) {
    if (url.pathname === '/admin') return text(env, 404, 'Not found');
    return json(env, 403, { error: 'Admin console is disabled: ADMIN_PASSWORD is not set' });
  }

  if (url.pathname === '/admin') {
    return new Response(adminHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const adminToken = 'admin_token_' + btoa(pwd).substring(0, 10);

  if (url.pathname === '/admin/auth' && request.method === 'POST') {
    const body = await request.json() as any;
    if (body.password === pwd) return json(env, 200, { token: adminToken });
    return json(env, 401, { error: 'Unauthorized' });
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${adminToken}`) return json(env, 401, { error: 'Unauthorized' });

  const db = requireDb(env);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments.length >= 3 && segments[1] === 'api' && segments[2] === 'tables') {
    if (segments.length === 3 && request.method === 'GET') {
      const tablesRaw = await queryAll(db, `SELECT name FROM sqlite_master WHERE type='table'`);
      const tables: any[] = [];
      for (const t of tablesRaw) {
        const name = toStringValue(t.name);
        if (!name || name.startsWith('sqlite_') || name.startsWith('d1_') || name.startsWith('_cf_') || name === 'sqlite_sequence') continue;
        const countRow = await db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).first<{ c: number }>();
        tables.push({ name, count: countRow?.c || 0 });
      }
      return json(env, 200, { tables });
    }

    const table = segments[3];
    if (!table) return json(env, 400, { error: 'Table required' });

    const ALLOWED_TABLES = [
      'projects', 'reviewers', 'drawings', 'drawing_assignees',
      'drawing_status_history', 'review_tracker', 'discipline_defaults',
      'discipline_default_assignees', 'project_settings', 'audit_log'
    ];
    if (!ALLOWED_TABLES.includes(table)) return json(env, 403, { error: 'Forbidden table' });

    if (segments.length === 5 && segments[4] === 'schema' && request.method === 'GET') {
      const schemaRows = await queryAll(db, `PRAGMA table_info(${table})`);
      return json(env, 200, { schema: schemaRows as any });
    }

    if (segments.length === 4 && request.method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const search = url.searchParams.get('search') || '';
      const pageSize = 50;
      const offset = (page - 1) * pageSize;

      const projectId = url.searchParams.get('projectId');

      let whereStr = '';
      const params: any[] = [];
      const schemaRows = await queryAll(db, `PRAGMA table_info(${table})`);
      const colNames = schemaRows.map(r => toStringValue(r.name)).filter(Boolean) as string[];

      if (search && colNames.length > 0) {
        let isCustomIdSearch = false;
        let idValue = '';

        const lowerSearch = search.toLowerCase();
        if (lowerSearch.startsWith('id:')) {
          isCustomIdSearch = true;
          idValue = search.substring(3).trim();
        } else if (lowerSearch.startsWith('customid:')) {
          isCustomIdSearch = true;
          idValue = search.substring(9).trim();
        }

        if (isCustomIdSearch && idValue) {
          if (colNames.includes('custom_id')) {
            whereStr = 'WHERE custom_id LIKE ?';
            params.push(`%${idValue}%`);
          } else if (colNames.includes('drawing_id')) {
            whereStr = 'WHERE drawing_id IN (SELECT id FROM drawings WHERE custom_id LIKE ?)';
            params.push(`%${idValue}%`);
          } else {
            // 回退到普通查询
            whereStr = 'WHERE (' + colNames.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ') + ')';
            colNames.forEach(() => params.push(`%${search}%`));
          }
        } else {
          whereStr = 'WHERE (' + colNames.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ') + ')';
          colNames.forEach(() => params.push(`%${search}%`));
        }
      }

      if (colNames.includes('_deleted')) {
        whereStr = (whereStr ? whereStr + ' AND ' : 'WHERE ') + `IFNULL(_deleted, 0) != 1`;
      }

      if (projectId) {
        if (table === 'projects') {
          whereStr = (whereStr ? whereStr + ' AND ' : 'WHERE ') + `id = ?`;
          params.push(projectId);
        } else if (colNames.includes('project_id')) {
          whereStr = (whereStr ? whereStr + ' AND ' : 'WHERE ') + `project_id = ?`;
          params.push(projectId);
        } else if (table === 'drawing_status_history' || table === 'drawing_assignees') {
          whereStr = (whereStr ? whereStr + ' AND ' : 'WHERE ') + `drawing_id IN (SELECT id FROM drawings WHERE project_id = ?)`;
          params.push(projectId);
        }
      }

      let selectClause = '*';
      if (colNames.includes('drawing_id') && colNames.includes('raw_drawing_ref')) {
        selectClause = `*, (SELECT custom_id FROM drawings d WHERE d.id = COALESCE(${table}.drawing_id, ${table}.raw_drawing_ref)) AS _custom_id`;
      } else if (colNames.includes('drawing_id')) {
        selectClause = `*, (SELECT custom_id FROM drawings d WHERE d.id = ${table}.drawing_id) AS _custom_id`;
      }

      const totalRow = await queryFirst(db, `SELECT COUNT(*) AS c FROM ${table} ${whereStr}`, params);
      const rows = await queryAll(db, `SELECT ${selectClause} FROM ${table} ${whereStr} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
      return json(env, 200, { rows: rows as any, total: Number(totalRow?.c) || 0, page, pageSize });
    }

    if (segments.length === 4 && request.method === 'POST') {
      const body = await request.json() as any;
      const cols = Object.keys(body);
      const vals = Object.values(body);
      const placeholders = cols.map(() => '?').join(',');
      await db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).bind(...vals).run();

      const auditDetails = JSON.stringify(body);
      await db.prepare(`INSERT INTO audit_log (table_name, action, detail) VALUES (?, ?, ?)`).bind(table, 'INSERT', auditDetails).run();
      return json(env, 200, { success: true });
    }

    if (segments.length === 5 && request.method === 'PUT') {
      const id = decodeURIComponent(segments[4]);
      const body = await request.json() as any;
      const cols = Object.keys(body);
      const vals = Object.values(body);

      const schemaRows = await queryAll(db, `PRAGMA table_info(${table})`);
      const colNames = schemaRows.map(r => toStringValue(r.name)).filter(Boolean) as string[];
      let pkCol = 'id';
      if (!colNames.includes('id') && colNames.includes('project_id')) pkCol = 'project_id';

      // Ensure pkCol is not updated
      const managed = table === 'drawings' && await queryFirst(db, 'SELECT 1 FROM pcf_index WHERE drawing_id=?', [id]);
      const protectedCols = new Set(['manual_comments_count','manual_open_comments_count','current_round','version']);
      const updateCols = cols.filter(c => c !== pkCol && (!managed || !protectedCols.has(c)));
      const updateVals = updateCols.map(c => body[c]);
      const setStr = updateCols.map(c => `${c}=?`).join(',');

      // drawings 表的手工改动也要进同一份写入日志，否则绕过应用逻辑的改动在 Log 页看不到
      const journalBefore = table === 'drawings' ? await readDrawingRowById(db, id) : null;

      if (updateCols.length) await db.prepare(`UPDATE ${table} SET ${setStr} WHERE ${pkCol} = ?`).bind(...updateVals, id).run();

      if (journalBefore) {
        const journalAfter = await readDrawingRowById(db, id);
        if (journalAfter) {
          await writeJournal(db, buildJournalStatements(
            db,
            journalBefore.projectId,
            new Map([[id, journalBefore.row]]),
            new Map([[id, journalAfter.row]]),
            [id],
            'admin'
          ));
        }
      }

      const auditDetails = JSON.stringify({ id, updates: body });
      await db.prepare(`INSERT INTO audit_log (table_name, row_id, action, detail) VALUES (?, ?, ?, ?)`).bind(table, id, 'UPDATE', auditDetails).run();
      return json(env, 200, { success: true });
    }

    if (segments.length === 5 && request.method === 'DELETE') {
      const id = decodeURIComponent(segments[4]);
      const schemaRows = await queryAll(db, `PRAGMA table_info(${table})`);
      const colNames = schemaRows.map(r => toStringValue(r.name)).filter(Boolean) as string[];
      let pkCol = 'id';
      if (!colNames.includes('id') && colNames.includes('project_id')) pkCol = 'project_id';

      if (colNames.includes('_deleted')) {
        await db.prepare(`UPDATE ${table} SET _deleted = 1 WHERE ${pkCol} = ?`).bind(id).run();
      } else {
        await db.prepare(`DELETE FROM ${table} WHERE ${pkCol} = ?`).bind(id).run();
      }

      await db.prepare(`INSERT INTO audit_log (table_name, row_id, action) VALUES (?, ?, ?)`).bind(table, id, 'DELETE').run();
      return json(env, 200, { success: true });
    }
  }

  if (segments.length === 3 && segments[1] === 'api' && segments[2] === 'sql' && request.method === 'POST') {
    const body = await request.json() as { query: string };
    const sql = String(body.query || '').trim();
    if (!sql) return json(env, 400, { error: 'Query required' });
    if (!env.ADMIN_SQL) return json(env, 503, { error: 'Read-only SQL console is not available' });
    // A separate read-only connection enforces this; statements cannot opt out via prefixes or comments.
    try {
      return json(env, 200, { results: env.ADMIN_SQL(sql) as unknown as JsonValue });
    } catch (error) {
      return json(env, 400, { error: error instanceof Error ? error.message : 'Query failed' });
    }
  }
  // 整库导出：GET /admin/api/export
  if (segments.length === 3 && segments[1] === 'api' && segments[2] === 'export' && request.method === 'GET') {
    const projectRows = await queryAll<ProjectListRow>(db,
      `SELECT id, name, storage_path, last_updated FROM projects ORDER BY name COLLATE NOCASE ASC`
    );

    const exportData: any[] = [];
    for (const proj of projectRows) {
      const detail = await getProjectDetail(db, proj.id);
      const reviewTracker = await getReviewTracker(db, proj.id);
      exportData.push({ project: detail, reviewTracker });
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      projectCount: exportData.length,
      projects: exportData,
    };

    const headers = withCors(new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="papc_db_export_${new Date().toISOString().slice(0, 10)}.json"`,
    }), env);
    return new Response(JSON.stringify(payload), { status: 200, headers });
  }

  // 整库导入：POST /admin/api/import
  if (segments.length === 3 && segments[1] === 'api' && segments[2] === 'import' && request.method === 'POST') {
    const body = await request.json() as any;
    if (!Array.isArray(body.projects)) {
      return json(env, 400, { error: '无效的导入格式，需要 { projects: [...] }' });
    }

    let imported = 0;
    for (const entry of body.projects) {
      const project = entry.project;
      const reviewTracker = entry.reviewTracker || {};
      if (!project || !project.id) continue;
      await saveProjectData(db, project.id, project, reviewTracker, 'import');
      imported++;
    }

    await db.prepare(`INSERT INTO audit_log (table_name, action, detail) VALUES (?, ?, ?)`)
      .bind('FULL_DB', 'IMPORT', `导入 ${imported} 个项目`).run();

    return json(env, 200, { success: true, imported });
  }

  return json(env, 404, { error: 'Admin API not found' });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors(new Headers(), env) });
    }

    // Admin 路由优先：使用自己的密码验证，不走全局 API Token
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env, url);
    }

    if (!isAuthorized(request, env)) {
      return json(env, 401, { error: 'Unauthorized' });
    }

    try {
      const path = url.pathname;

      const expectedToken = env.API_TOKEN?.trim() || '';
      const segments = path.split('/').filter(Boolean);

      if (path === '/') {
        return json(env, 200, {
          service: 'papc-d1-api',
          phase: 'read-first',
          endpoints: [
            'GET /health',
            'GET /settings',
            'GET /projects',
            'POST /projects/:projectId',
            'GET /projects/:projectId/review-tracker',
            'GET /projects/:projectId/audit?from=&to=',
          ],
        });
      }

      if (path === '/health' && request.method === 'GET') {
        return handleHealth(env);
      }

      const db = requireDb(env);

      if (path === '/settings' && request.method === 'GET') {
        return json(env, 200, await getSettings(db));
      }

      if (segments[0] === 'projects' && segments[1]) {
        const projectId = decodeURIComponent(segments[1]);

        if (segments.length === 3 && segments[2] === 'review-tracker') {
          if (request.method === 'GET') {
            return json(env, 200, await getReviewTracker(db, projectId));
          }
          if (request.method === 'PUT') {
            const data = await request.json() as any;
            const verification = await saveReviewTrackerData(db, projectId, data);
            return json(env, 200, { success: true, verification: verification as unknown as JsonValue });
          }
        }

        if (segments.length === 3 && segments[2] === 'audit' && request.method === 'GET') {
          // from / to 是完整 ISO 时刻而非日期：客户端把「本地日」边界折算成 UTC 传上来，
          // 否则 +08:00 的一天会被 UTC 日边界从早上 8 点切开
          const from = url.searchParams.get('from') || '';
          const to = url.searchParams.get('to') || '';
          if (!from || !to) {
            return json(env, 400, { error: 'Both `from` and `to` (ISO timestamps) are required.' });
          }

          const limit = AUDIT_QUERY_LIMIT;
          const rows = await queryAll(
            db,
            `SELECT id, row_id, action, detail, created_at
             FROM audit_log
             WHERE project_id = ?
               AND action IN ('STATUS','COMMENTS')
               AND created_at >= ? AND created_at < ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [projectId, from, to, limit]
          );

          const entries = rows.map(row => {
            const detail = readJson<Record<string, JsonValue>>(toStringValue(row.detail), {});
            return {
              id: toStringValue(row.id) || '',
              drawingId: toStringValue(row.row_id) || '',
              action: toStringValue(row.action) || '',
              createdAt: toStringValue(row.created_at) || '',
              customId: toStringValue(detail.customId) || '',
              drawingNo: toStringValue(detail.drawingNo) || '',
              source: toStringValue(detail.source) || 'app',
              detail: detail as JsonValue,
            };
          });

          // 命中上限时明确告知，不静默截断
          return json(env, 200, { entries: entries as unknown as JsonValue, truncated: rows.length >= limit });
        }

        if (segments.length === 3 && segments[2] === 'heartbeat') {
          if (request.method === 'PUT') {
            await db.prepare(
              `INSERT INTO project_settings (project_id, setting_key, setting_value)
               VALUES (?, 'admin_last_seen', ?)
               ON CONFLICT(project_id, setting_key) DO UPDATE SET setting_value=excluded.setting_value`
            ).bind(projectId, new Date().toISOString()).run();
            return json(env, 200, { success: true });
          }
          if (request.method === 'GET') {
            const row = await db.prepare(
              `SELECT setting_value FROM project_settings WHERE project_id = ? AND setting_key = 'admin_last_seen'`
            ).bind(projectId).first<{ setting_value: string }>();
            return json(env, 200, { adminLastSeen: row?.setting_value || null });
          }
        }

      }

      return notImplemented(env, request.method, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Worker request failed.', error);
      const status = message.includes('Missing D1 binding') ? 503 : 500;
      return text(env, status, message);
    }
  },
};

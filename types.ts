
export type DrawingStatus = 'Pending' | 'Reviewing' | 'Waiting Reply' | 'Approved';

export interface Remark {
  id: string;
  content: string;
  createdAt: string; // ISO Date
  resolved?: boolean;
}

export interface DrawingLog {
  id: string;
  version: string;
  receivedDate: string;
  dueDate: string;
  sentDate?: string;
  commentCount: number;
}

export interface Drawing {
  hasPcf?: boolean;
  id: string;
  customId: string;
  drawingNo: string;
  title: string;
  discipline: string;
  assignees: string[];
  status: DrawingStatus;
  currentRound: string;
  version: string;
  manualCommentsCount: number;
  manualOpenCommentsCount: number;
  reviewDeadline?: string;
  receivedDate?: string;
  category?: 'A' | 'B' | 'C';
  deadline?: string;
  checked?: boolean;
  checkedSynced?: boolean; // 标记 checked 状态是否已同步到服务器
  logs: DrawingLog[];
  remarks: Remark[];
  statusHistory: Remark[];
  rev?: string; // 服务端内容版本，保存时作为 baseRev 回传
}

export interface Reviewer {
  id: string;
  name: string;
}

export interface ShipMilestone {
  hullNumber: string;
  steelCutting?: string;  // ISO date
  keelLaying?: string;    // ISO date (入坞/Dock Entry)
  launching?: string;     // ISO date (下水)
  delivery?: string;      // ISO date (交船)
  contractDelivery?: string; // ISO date (合同交船期)
}

export interface ProjectSummaryConfig {
  shipOwner?: string;
  milestoneUpdateDate?: string; // ISO date (节点更新日期)
  ships: ShipMilestone[];
}

export interface ProjectConfig {
  reviewers: Reviewer[];
  disciplineDefaults: { [key: string]: string }; // Map discipline -> default reviewer ID
  holidays: string[]; // ISO Date strings YYYY-MM-DD
  roundACycle: number; // Days
  otherRoundsCycle: number; // Days
  /** Write-only password update. Never returned, persisted or exported by the client. */
  password?: string;
  passwordSet?: boolean;
  passwordVersion?: string; // Public concurrency token, not a credential
  displayName?: string; // Custom Project Display Name for Reports
  autoSyncInterval?: number; // Project-specific auto-sync interval
  lastUpdated?: string; // Last modification timestamp
  defaultAssignees?: Record<string, string[]>; // Map discipline -> default assignee names
  projectSummary?: ProjectSummaryConfig; // Ship milestones for Gantt chart
}

export interface Project {
  assigneeNames?: Record<string,string>;
  id: string;
  /** Set by "New project" until the server has the project; a 404 then opens the local copy instead of "project does not exist". */
  localOnly?: boolean;
  name: string;
  drawings: Drawing[];
  storagePath?: string;
  passwordProtected?: boolean;
  conf: ProjectConfig;
  lastUpdated?: string;
}



export interface AppSettings {
  reviewers: Reviewer[];
  disciplineDefaults: Record<string, string>;
  holidays: string[];
  roundACycle: number;
  otherRoundsCycle: number;
  pushPassword?: string; // Verification password for local sync UI
  displayName?: string; // Global default display name pattern (optional)
  autoSyncInterval?: number; // Auto-sync interval in minutes (default: 3)
}

export interface AppData {
  lastUpdated: string;
  settings: AppSettings;
  projects: Project[];
}

// 审核追踪：每个 assignee 的完成状态
export interface ReviewTrackerEntry {
  done: boolean;
  doneAt?: string; // ISO timestamp
}

// key = drawingId, value = { assigneeName: ReviewTrackerEntry }
export type ReviewTrackerData = Record<string, Record<string, ReviewTrackerEntry>>;

// 增量保存 payload
// 备注增量：按 id 新增、修改、删除，base 是本地开始改之前的内容
export interface RemarkOps {
  add?: Remark[];
  update?: Array<{ id: string; content?: string; resolved?: boolean; base?: { content: string; resolved?: boolean } }>;
  remove?: Array<{ id: string; base?: { content: string; resolved?: boolean } }>;
}

export interface DrawingPatch {
  id: string;
  changes: Partial<Drawing>;
  baseRev?: string;
  base?: Partial<Drawing>;
  remarkOps?: RemarkOps;
}

// 409 DRAWING_CONFLICT：别人先保存了同一张图纸的同一字段，整批没有写入
export interface DrawingConflict {
  id: string;
  customId?: string;
  fields: string[];
  current: Drawing | null;
}

// 409 里的项目设置冲突：key 被别人先改了；按专业分行存的 map 设置会带上 entry（专业名）
export interface ConfigConflict {
  key: string;
  entry?: string;
  current: unknown;
}

export interface DeltaPayload {
  saveRequestId?: string;
  projectName?: string;
  updatedDrawings?: (Drawing | DrawingPatch)[];
  deletedDrawingIds?: string[];
  // 只含改过的设置项；confBase 是这些项开始修改时的值，服务端据此判断是否被别人先改了
  conf?: Partial<ProjectConfig>;
  confBase?: Partial<Record<keyof ProjectConfig, unknown>>;
  reviewTracker?: ReviewTrackerData;
}

// 服务端回读校验结果：写入之后同请求内再读一次，比对实际落库结果
export interface WriteVerification {
  ok: boolean;
  checked: number;
  mismatched: Array<{ id: string; customId?: string; fields: string[] }>;
  error?: string; // 校验查询本身失败 =「无法确认」，不代表写入失败
}

export interface SaveResult {
  success: boolean;
  verification?: WriteVerification;
  drawings?: Drawing[];
  conf?: ProjectConfig;
}

// 服务端写入日志条目（audit_log 里 action 为 STATUS / COMMENTS 的行）
export interface AuditEntry {
  actorId?: string | null;
  actorName?: string | null;
  id: string;
  drawingId: string;
  action: 'STATUS' | 'COMMENTS' | 'BUILDER_REPLY';
  createdAt: string; // ISO-8601 UTC
  customId: string;
  drawingNo: string;
  source: string; // 'app' | 'admin'
  detail: {
    from?: unknown;
    to?: unknown;
    round?: { from: string; to: string };
    [key: string]: unknown;
  };
}

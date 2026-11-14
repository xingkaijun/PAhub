import type { RequestUser } from './identity.ts';

export const CAPABILITIES = {
  view: 'viewer', 'pcf.presence': 'viewer',
  'pcf.comment.create': 'reviewer', 'pcf.comment.edit_own': 'reviewer',
  'pcf.comment.status': 'reviewer', 'pcf.comment.meta': 'reviewer',
  'pcf.comment.edit_any': 'manager', 'pcf.document.write': 'manager', 'pcf.settings': 'manager',
  'drawing.update': 'manager', 'builder.export': 'manager', 'builder.import_reply': 'manager',
  'bulk.import': 'manager', 'bulk.command': 'manager', 'pcf.replace': 'manager',
  'team.setup': 'admin', 'settings.write': 'admin', 'project.create': 'admin',
  'project.delete': 'admin', 'drawing.void': 'admin', 'history.restore': 'admin',
  'cloud.sync': 'admin', 'admin.console': 'admin', 'admin.only': 'admin',
} as const;
export type Capability = keyof typeof CAPABILITIES;
const rank = { viewer: 0, reviewer: 1, manager: 2, admin: 3 };
export function hasPermission(user: RequestUser | null | undefined, capability: Capability): boolean {
  return Boolean(user && Object.hasOwn(CAPABILITIES, capability) && rank[user.role] >= rank[CAPABILITIES[capability]]);
}
export function permissionsFor(user: RequestUser): Capability[] {
  return (Object.keys(CAPABILITIES) as Capability[]).filter(cap => hasPermission(user, cap));
}
export function legacyPermissions(admin: boolean): Capability[] {
  return admin ? Object.keys(CAPABILITIES) as Capability[] : [
    'view', 'pcf.presence', 'pcf.comment.create', 'pcf.comment.edit_own', 'pcf.comment.edit_any',
    'pcf.comment.status', 'pcf.comment.meta', 'pcf.document.write', 'pcf.settings', 'builder.export',
  ];
}
export function forbidden(capability: string, op?: number): Response {
  return Response.json({ ok: false, error: 'forbidden', capability, ...(op === undefined ? {} : { op }) }, { status: 403 });
}
export function requirePermission(user: RequestUser | null | undefined, capability: Capability): Response | undefined {
  if (!hasPermission(user, capability)) return forbidden(capability);
}
export type RoutePolicy = { method: string; pattern?: RegExp; capability: Capability; sample?: string };
// Listener/static and preflight contracts participate in the independent route inventory too.
export const TRANSPORT_POLICIES: RoutePolicy[] = [
  { method: 'OPTIONS', pattern: /^\/api(?:\/|$)/, capability: 'view' },
  { method: 'GET', pattern: /^(?!\/api(?:\/|$)|\/pcf\/)/, capability: 'view' },
  { method: 'HEAD', pattern: /^(?!\/api(?:\/|$)|\/pcf\/)/, capability: 'view' },
];
// Subroutes are explicit: a broad PCF prefix must never imply view access to writes.
export const PCF_POLICIES: RoutePolicy[] = [
  { method: 'GET', pattern: /^\/api\/pcf\/[^/]+\/[^/]+\/initiators$/, capability: 'pcf.comment.edit_any', sample: '/api/pcf/P/D/initiators' },
  { method: 'GET', pattern: /^\/api\/pcf\/[^/]+\/(index|presence)$/, capability: 'view', sample: '/api/pcf/P/index' },
  { method: 'POST', pattern: /^\/api\/pcf\/[^/]+\/exports\/batch$/, capability: 'builder.export', sample: '/api/pcf/P/exports/batch' },
  ...['GET', 'HEAD'].flatMap(method => [
    { method, pattern: /^\/pcf\/[^/]+\/[^/]+$/, capability: 'view' as const, sample: '/pcf/P/D' },
    { method, pattern: /^\/pcf\/[^/]+\/[^/]+\/images\/[a-f0-9]{64}$/, capability: 'view' as const, sample: '/pcf/P/D/images/' + 'a'.repeat(64) },
  ]),
  ...Object.entries({
    'POST session': 'view', 'POST create': 'admin.only', 'POST presence': 'pcf.presence', 'POST ops': 'pcf.comment.create',
    'PUT document': 'pcf.replace', 'POST exports': 'builder.export', 'POST imports': 'builder.import_reply',
    'GET download': 'builder.export', 'GET events': 'view', 'GET meta': 'view', 'GET data': 'view',
    'GET presence': 'view', 'GET exports': 'view', 'GET history': 'view',
  } as Record<string, Capability>).map(([key, capability]) => {
    const [method, tail] = key.split(' ');
    return { method, pattern: new RegExp('^/api/pcf/[^/]+/[^/]+/' + tail + '$'), capability, sample: '/api/pcf/P/D/' + tail };
  }),
  { method: 'GET', pattern: /^\/api\/pcf\/[^/]+\/[^/]+\/exports\/[a-f0-9-]+\/download$/i, capability: 'builder.export', sample: '/api/pcf/P/D/exports/abcd/download' },
  { method: 'POST', pattern: /^\/api\/pcf\/[^/]+\/[^/]+\/exports\/[a-f0-9-]+\/void$/i, capability: 'drawing.void', sample: '/api/pcf/P/D/exports/abcd/void' },
  { method: 'POST', pattern: /^\/api\/pcf\/[^/]+\/[^/]+\/history\/\d+\/restore$/, capability: 'history.restore', sample: '/api/pcf/P/D/history/1/restore' },
];
export const BUILDER_POLICIES: RoutePolicy[] = [
  { method: 'GET', pattern: /^\/api\/projects\/[^/]+\/builder-replies\/pending$/, capability: 'builder.import_reply', sample: '/api/projects/P/builder-replies/pending' },
  { method: 'GET', pattern: /^\/api\/projects\/[^/]+\/builder-replies\/[^/]+\/file\/[^/]+$/, capability: 'builder.import_reply', sample: '/api/projects/P/builder-replies/S/file/F' },
  ...['preview', '[^/]+/apply', '[^/]+/skip'].map(tail => ({ method: 'POST', pattern: new RegExp('^/api/projects/[^/]+/builder-replies/' + tail + '$'), capability: 'builder.import_reply' as const, sample: '/api/projects/P/builder-replies/' + tail.replace('[^/]+', 'S') })),
];
export const ADMIN_POLICIES: RoutePolicy[] = [
  { method: 'GET', pattern: /^\/api\/admin$/, capability: 'admin.console', sample: '/api/admin' },
  { method: 'POST', pattern: /^\/api\/admin\/auth$/, capability: 'admin.console', sample: '/api/admin/auth' },
  ...[
    ['GET', 'tables'], ['GET', 'tables/[^/]+/schema'], ['GET', 'tables/[^/]+'], ['POST', 'tables/[^/]+'],
    ['PUT', 'tables/[^/]+/[^/]+'], ['DELETE', 'tables/[^/]+/[^/]+'], ['POST', 'sql'], ['GET', 'export'], ['POST', 'import'],
  ].map(([method, tail]) => ({ method, pattern: new RegExp('^/api/admin/api/' + tail + '$'), capability: 'admin.console' as const, sample: '/api/admin/api/' + tail.replaceAll('[^/]+', 'projects') })),
];

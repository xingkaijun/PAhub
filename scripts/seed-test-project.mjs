// 生成一个测试项目：100 张图纸 + 300 条意见（多轮次、多专业、多开关状态）
// 用法：node scripts/seed-test-project.mjs [baseUrl]
//       设了 ADMIN_PASSWORD 的 Hub：ADMIN_PASSWORD=<管理员密码> node scripts/seed-test-project.mjs [baseUrl]
// 前提：Hub 已在运行（npm run hub:dev 或 hub:start）。本脚本走 HTTP API，不直接改 SQLite / PCF HTML：
//   - 项目、设置、图纸、Review Tracker：PATCH /api/projects/:id（和主表保存同一个接口，按字段写入）
//   - PCF：POST /api/pcf/.../create，再 PUT .../document（importJSON，等同 PCF 页面的 Import JSON）
//   这些都是项目级写入，要管理员；没设 ADMIN_PASSWORD 的 Hub 人人都是管理员，不用登录。
// 可重复运行：同 id 的图纸覆盖写入，项目里多出来的（不属于本脚本的）图纸会被删掉。
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const PROJECT_ID = 'proj-demo-vlec-2684';
const PROJECT_NAME = 'PG-VLEC-H2684 演示项目';
const DRAWING_COUNT = 100;
const COMMENT_TARGET = 300;

// ---------- 确定性伪随机 ----------
let seed = 20261108;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const intBetween = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const shuffle = (list) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

// ---------- 基础主数据 ----------
const DISCIPLINES = [
  { code: 'H', name: 'Hull & Structure' },
  { code: 'P', name: 'Piping' },
  { code: 'O', name: 'Outfitting' },
  { code: 'M', name: 'Machinery' },
  { code: 'E', name: 'Electrical' },
  { code: 'V', name: 'HVAC' },
  { code: 'C', name: 'Coating' },
  { code: 'S', name: 'Safety & Lifesaving' },
];

// 审图人：id 与显示名一致，图纸 assignees 与 review_tracker 都用同一名字
const REVIEWERS = [
  { name: 'Zhang Wei', discipline: 'Hull & Structure' },
  { name: 'Li Na', discipline: 'Hull & Structure' },
  { name: 'Wang Qiang', discipline: 'Piping' },
  { name: 'Chen Jing', discipline: 'Piping' },
  { name: 'Liu Yang', discipline: 'Outfitting' },
  { name: 'Zhao Min', discipline: 'Outfitting' },
  { name: 'Sun Hao', discipline: 'Machinery' },
  { name: 'Wu Fang', discipline: 'Machinery' },
  { name: 'Zhou Bin', discipline: 'Electrical' },
  { name: 'Xu Lei', discipline: 'Electrical' },
  { name: 'Ma Lin', discipline: 'HVAC' },
  { name: 'Guo Tao', discipline: 'HVAC' },
  { name: 'He Ping', discipline: 'Coating' },
  { name: 'Lin Xia', discipline: 'Coating' },
  { name: 'Deng Yu', discipline: 'Safety & Lifesaving' },
  { name: 'Cao Rui', discipline: 'Safety & Lifesaving' },
];

// 船东（意见发起人）与船厂（回复人）
const OWNER_REPS = ['Capt. J. Miller', 'T. Andersen', 'M. Rossi', 'H. Tanaka', 'P. Novak', 'S. Okafor', 'A. Kowalski', 'R. Fernandes'];
const BUILDER_REPS = ['Kim Dae-jung', 'Park Sung-ho', 'Lee Jun-ho', 'Choi Min-su', 'Han Seo-yeon', 'Yoon Ji-hoon', 'Seo Min-jae', 'Jang Ha-neul'];

const TITLES = {
  'Hull & Structure': ['General Arrangement', 'Midship Section', 'Block Assembly Plan', 'Deck Structure Detail', 'Bulkhead Arrangement', 'Tank Top Structure', 'Hatch Coaming Detail'],
  'Piping': ['Piping Isometric', 'Valve Schedule', 'Pipe Support Standard', 'Manifold Arrangement', 'Cargo Piping Layout', 'Ballast Piping Diagram', 'Sea Chest Arrangement'],
  'Outfitting': ['Accommodation Layout', 'Stairway Detail', 'Deck Covering Plan', 'Furniture Arrangement', 'Door & Window Schedule', 'Ladder Arrangement'],
  'Machinery': ['Engine Room Arrangement', 'Shafting Arrangement', 'Pump Room Layout', 'Steering Gear Foundation', 'Main Engine Foundation', 'Auxiliary Machinery Layout'],
  'Electrical': ['Cable Tray Layout', 'Switchboard Arrangement', 'Lighting Layout', 'Navigation Equipment Layout', 'Cable Schedule', 'Generator Connection Diagram'],
  'HVAC': ['HVAC Duct Layout', 'Air Handling Unit Arrangement', 'Accommodation Ventilation', 'Engine Room Ventilation', 'Damper Schedule'],
  'Coating': ['Coating Specification', 'Tank Coating Plan', 'Surface Preparation Standard', 'Cathodic Protection Layout'],
  'Safety & Lifesaving': ['Life Saving Equipment Layout', 'Fire Main Diagram', 'Escape Route Plan', 'Fire Detection Layout', 'Emergency Lighting Plan'],
};

const TAGS = ['Cost Affect', 'Scheduling', 'Class', 'Safety', 'Owner', 'Specification'];

const COMMENT_TEXTS = [
  'Confirm the structural scantling at frame 45 against the approved class rule. The current detail appears to use a reduced web thickness.',
  'Clearance between the pipe run and the adjacent cable tray is below the required 100 mm. Relocate or re-route before the block is assembled.',
  'Please provide the updated vendor drawing for the air handling unit. The dimensions shown do not match the current purchase specification.',
  'The access opening in the inner bottom is too small for maintenance of the sounding device. Increase to 600 x 400 mm.',
  'Coating system for the ballast tanks shall be in accordance with PSPC requirements. Confirm the stripe coat procedure.',
  'Lighting fixture at the stairway landing conflicts with the handrail support. Adjust the bracket height.',
  'The valve numbering on this isometric does not match the approved valve list. Revise and reissue.',
  'Fire damper location at the accommodation boundary is missing from the drawing. Add and confirm the fire rating.',
  'Provide lifting arrangement details for the engine room hatch cover including the pad eye capacity.',
  'Drainage slope in the cargo hold is insufficient. Show the slope value and the drain positions.',
  'Confirm the material specification for the deck plating in way of the mooring equipment.',
  'The escape route width at frame 60 is reduced by the duct. Maintain a minimum clear width of 700 mm.',
  'Please clarify the revision history. Rev B and Rev C show conflicting arrangement for the aft bulkhead.',
  'Vibration analysis for the shafting line is required before approval. Submit the calculation report.',
  'The cable gland type at the watertight boundary is not suitable for the IP rating. Update the schedule.',
  'Add the insulation thickness note for the accommodation bulkhead in way of the galley.',
  'The davit foundation reinforcement is not shown. Provide the detail with the load case.',
  'Hatch cover cleat arrangement interferes with the coaming stiffener. Revise the detail.',
  'The coating stripe coat at weld seams shall be applied before the first full coat. Confirm the sequence.',
  'The emergency generator room ventilation is undersized for the specified ambient temperature. Recalculate the air flow.',
  'Provide the welding procedure specification reference for the high strength steel used in the hatch coaming.',
  'The sounding pipe of the fore peak tank terminates inside the chain locker. Re-route to an accessible location.',
  'The skylight above the staircase does not have the required fire rating. Replace with the approved type.',
  'Confirm the paint scheme for the underwater hull matches the owner specification and the antifouling warranty.',
  'The machinery space noise insulation is missing on the boundary to the accommodation. Add the insulation schedule.',
  'The position of the deck crane pedestal conflicts with the liferaft stowage. Revise the arrangement.',
  'The electrical panel located in the battery room is not explosion proof. Relocate or change the type.',
  'The inspection opening in the double bottom is blocked by the pipe support. Reposition the support.',
  'The HVAC duct passing through the A class bulkhead requires a fire damper. Add the damper to the layout.',
  'Please show the draining arrangement of the air line filter in the engine room.',
  'The stairway tread depth is below the minimum required by the accommodation arrangement standard.',
  'The lifeboat launching area is obstructed by the antenna mast. Verify the SOLAS visibility requirement.',
  'The bolt spacing on the hatch cover panel is inconsistent with the manufacturer recommendation.',
  'Details of the bilge keel connection to the shell plating are missing. Provide the weld detail.',
  'The cargo tank pressure relief valve capacity shall be verified against the maximum loading rate.',
  'The cable route crosses the engine room skylight. Re-route to avoid the opening.',
  'The fire main isolation valve is not accessible from the corridor. Relocate with an extended spindle.',
  'Confirm the surface preparation grade for the cargo hold and provide the salt test acceptance criteria.',
  'The unit cooler drain is connected to the accommodation drainage system. Provide a separate drain.',
  'Please update the load line mark position after the revised freeboard calculation.',
];

const BUILDER_REPLIES = [
  'Noted. The drawing will be revised and resubmitted in the next issue.',
  'We have checked against the class rule and confirm the current thickness is acceptable. Calculation sheet attached in the next submission.',
  'Agreed. The pipe route will be relocated to provide the required clearance.',
  'The vendor drawing has been requested and will be submitted within one week.',
  'The opening will be enlarged as requested. The structural reinforcement detail will be added.',
  'Coating procedure has been updated to include the stripe coat sequence. Revised specification attached.',
  'The bracket height will be adjusted. Revised drawing will follow.',
  'The valve numbering has been corrected and the isometric will be reissued.',
  'Fire damper has been added to the layout. Fire rating is confirmed as A-60.',
  'Lifting arrangement detail including pad eye capacity is under preparation.',
  'The slope will be corrected to the required value and drain positions shown.',
  'Material specification is confirmed as grade AH36. Note will be added.',
  'The duct will be rerouted to maintain the clear width.',
  'Revision B is the applicable issue. The conflict in Rev C is a drafting error and will be corrected.',
  'Vibration analysis is in progress and will be submitted with the next package.',
  'Cable glands will be changed to the watertight type. Schedule updated.',
  'Insulation thickness note will be added in the next revision.',
  'Davit foundation reinforcement detail is under design and will be submitted.',
  'The cleat arrangement will be revised to clear the stiffener.',
  'Stripe coat sequence is confirmed per the specification.',
  'Ventilation capacity will be recalculated and the air flow updated.',
  'WPS reference will be added to the drawing note.',
  'Sounding pipe will be rerouted to the accessible location.',
  'Skylight will be replaced with the approved fire rated type.',
  'Paint scheme is confirmed to match the owner specification and warranty.',
  'Noise insulation will be added to the boundary. Schedule to be revised.',
  'Deck crane pedestal will be repositioned to clear the liferaft stowage.',
  'Panel will be relocated out of the battery room.',
  'Pipe support will be repositioned to clear the inspection opening.',
  'Fire damper will be added and the layout revised.',
  'Drain arrangement will be shown in the next issue.',
  'Tread depth will be corrected to the standard.',
  'Antenna mast will be relocated to clear the launching area.',
];

const REMARKS = [
  'Sent to class for preliminary comment.',
  'Waiting for vendor data before closing.',
  'Internal check: dimension chain verified.',
  'Owner requested a joint review meeting.',
  'Related to change order CO-118.',
  'Superseded detail removed from the model.',
];

// ---------- 工具 ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (offset) => { const d = new Date(); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
const isoDate = (offset) => day(offset).toISOString().slice(0, 10);
const isoStamp = (offset, hour = 9) => { const d = day(offset); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const roundLetter = (n) => { let s = '', v = n; while (v > 0) { v -= 1; s = String.fromCharCode(65 + (v % 26)) + s; v = Math.floor(v / 26); } return s; };

let adminCookie = '';

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(adminCookie ? { Cookie: adminCookie } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  if (res.status === 403 && /Administrator permission required/.test(text)) {
    throw new Error(`${options.method || 'GET'} ${path} -> 403：这个 Hub 设了 ADMIN_PASSWORD，请用 ADMIN_PASSWORD=<管理员密码> 运行本脚本`);
  }
  if (!res.ok && !(options.allow || []).includes(res.status)) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// 设了 ADMIN_PASSWORD 的 Hub：先登录拿管理员会话（和页面上的管理员登录同一个接口）
async function loginAdmin() {
  const session = await api('/api/session');
  if (!session?.requiresPassword) return; // 没设 ADMIN_PASSWORD：人人都是管理员
  const password = process.env.ADMIN_PASSWORD || process.env.PAHUB_ADMIN_PASSWORD || '';
  if (!password) throw new Error('这个 Hub 设了 ADMIN_PASSWORD，请用 ADMIN_PASSWORD=<管理员密码> node scripts/seed-test-project.mjs 运行');
  const res = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!res.ok) throw new Error(`管理员登录失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  adminCookie = cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!adminCookie) throw new Error('管理员登录没有返回会话 Cookie');
  console.log('已登录管理员');
}

// ---------- 1. 构建图纸 ----------
// 阶段分布：Pending 15 / Reviewing 45 / Waiting Reply 25 / Approved 15
const STATUS_PLAN = [
  ...Array(15).fill('Pending'),
  ...Array(45).fill('Reviewing'),
  ...Array(25).fill('Waiting Reply'),
  ...Array(15).fill('Approved'),
];
shuffle(STATUS_PLAN);

// 轮次分布：A 40 / B 30 / C 20 / D 8 / E 2
const ROUND_PLAN = [
  ...Array(40).fill(1),
  ...Array(30).fill(2),
  ...Array(20).fill(3),
  ...Array(8).fill(4),
  ...Array(2).fill(5),
];
shuffle(ROUND_PLAN);

const reviewersByDiscipline = new Map();
for (const r of REVIEWERS) {
  if (!reviewersByDiscipline.has(r.discipline)) reviewersByDiscipline.set(r.discipline, []);
  reviewersByDiscipline.get(r.discipline).push(r.name);
}

const drawings = [];
for (let i = 0; i < DRAWING_COUNT; i++) {
  const disc = DISCIPLINES[i % DISCIPLINES.length];
  const status = STATUS_PLAN[i];
  const roundNum = ROUND_PLAN[i];
  const reviewers = reviewersByDiscipline.get(disc.name);
  const seq = String(i + 1).padStart(3, '0');
  const assignees = status === 'Pending' && i % 3 === 0 ? [] : reviewers.filter(() => rnd() < 0.65);
  if (status !== 'Pending' && assignees.length === 0) assignees.push(reviewers[0]);

  const receivedOffset = -intBetween(20, 120);
  drawings.push({
    id: `demo2684-dwg-${seq}`, // 图纸 id 全库唯一：加项目前缀，避免和别的项目里的 dwg-001 冲突
    customId: `H2684-${disc.code}-${seq}`,
    drawingNo: `PG-H2684-${disc.code}-${seq}`,
    discipline: disc.name,
    title: pick(TITLES[disc.name]),
    status,
    currentRound: roundLetter(roundNum),
    version: roundLetter(roundNum),
    assignees,
    manualCommentsCount: 0,
    manualOpenCommentsCount: 0,
    receivedDate: isoDate(receivedOffset),
    reviewDeadline: status === 'Reviewing' ? isoDate(intBetween(-6, 14)) : undefined,
    deadline: isoDate(receivedOffset + 30),
    category: pick(['A', 'B', 'C']),
    checked: rnd() < 0.42,
    checkedSynced: false,
    logs: [],
    remarks: [],
    statusHistory: [],
    _roundNum: roundNum,
    _receivedOffset: receivedOffset,
  });
}

// checked 同步状态：已 checked 的其中一半标记为已同步
for (const d of drawings) d.checkedSynced = d.checked && rnd() < 0.5;

// 状态历史 / 备注
for (const d of drawings) {
  const history = [];
  history.push({ id: randomUUID(), content: `Drawing received from builder (rev ${roundLetter(1)})`, createdAt: isoStamp(d._receivedOffset, 10) });
  if (d.status !== 'Pending') history.push({ id: randomUUID(), content: `Status: Pending -> Reviewing`, createdAt: isoStamp(d._receivedOffset + 2, 14) });
  if (['Waiting Reply', 'Approved'].includes(d.status)) history.push({ id: randomUUID(), content: `Status: Reviewing -> ${d.status}`, createdAt: isoStamp(-intBetween(3, 25), 11) });
  if (d._roundNum > 1) history.push({ id: randomUUID(), content: `Round: ${roundLetter(d._roundNum - 1)} -> ${roundLetter(d._roundNum)} | version ${roundLetter(d._roundNum)}`, createdAt: isoStamp(-intBetween(1, 18), 16) });
  d.statusHistory = history;
  if (rnd() < 0.28) d.remarks = [{ id: randomUUID(), content: pick(REMARKS), createdAt: isoStamp(-intBetween(1, 40), 15), resolved: rnd() < 0.5 }];
  if (rnd() < 0.22) d.remarks.push({ id: randomUUID(), content: pick(REMARKS), createdAt: isoStamp(-intBetween(1, 30), 9), resolved: rnd() < 0.4 });
}

// ---------- 2. 意见分配：合计正好 300 条 ----------
const commentable = drawings.filter((d) => d.status !== 'Pending');
const weights = commentable.map((d) => 1 + rnd() * 3 + d._roundNum * 0.4);
const weightSum = weights.reduce((a, b) => a + b, 0);
let allocated = 0;
commentable.forEach((d, i) => {
  d._commentCount = i === commentable.length - 1 ? Math.max(1, COMMENT_TARGET - allocated) : Math.max(1, Math.round(weights[i] / weightSum * COMMENT_TARGET));
  allocated += d._commentCount;
});
// 修正分配误差：多则从最多的图纸里减，少则给前几张加
let drift = commentable.reduce((sum, d) => sum + d._commentCount, 0) - COMMENT_TARGET;
let guard = 0;
while (drift !== 0 && guard++ < 10000) {
  const ordered = [...commentable].sort((a, b) => drift > 0 ? b._commentCount - a._commentCount : a._commentCount - b._commentCount);
  let moved = false;
  for (const d of ordered) {
    if (drift === 0) break;
    if (drift > 0 && d._commentCount > 1) { d._commentCount -= 1; drift -= 1; moved = true; }
    else if (drift < 0) { d._commentCount += 1; drift += 1; moved = true; }
  }
  if (!moved) break;
}
for (const d of drawings) d._commentCount = d._commentCount || 0;

const totalComments = drawings.reduce((sum, d) => sum + d._commentCount, 0);
console.log(`计划：${DRAWING_COUNT} 张图纸，${totalComments} 条意见`);

// ---------- 3. 写入项目（图纸 + 人员 + 配置 + 审图追踪） ----------
const conf = {
  reviewers: REVIEWERS.map((r) => ({ id: r.name, name: r.name })),
  disciplineDefaults: Object.fromEntries([...reviewersByDiscipline.entries()].map(([d, names]) => [d, names[0]])),
  defaultAssignees: Object.fromEntries([...reviewersByDiscipline.entries()].map(([d, names]) => [d, names])),
  holidays: ['2026-01-01', '2026-02-17', '2026-05-01', '2026-10-01'],
  roundACycle: 14,
  otherRoundsCycle: 7,
  displayName: PROJECT_NAME,
  autoSyncInterval: 3,
  projectSummary: {
    shipOwner: 'Pacific Gas Carriers',
    milestoneUpdateDate: isoDate(-10),
    ships: [{
      hullNumber: 'H2684',
      steelCutting: isoDate(-260),
      keelLaying: isoDate(-190),
      launching: isoDate(-40),
      delivery: isoDate(210),
      contractDelivery: isoDate(240),
    }],
  },
};

const reviewTracker = {};
for (const d of drawings) {
  if (!d.assignees.length) continue;
  const entry = {};
  let allDone = true;
  for (const a of d.assignees) {
    const done = d.status === 'Approved' ? true : rnd() < 0.55;
    if (!done) allDone = false;
    entry[a] = done ? { done: true, doneAt: isoStamp(-intBetween(1, 25), 16) } : { done: false };
  }
  entry.__approved__ = { done: d.status === 'Approved' && allDone };
  reviewTracker[d.id] = entry;
}

const payloadDrawings = drawings.map(({ _roundNum, _receivedOffset, _commentCount, ...rest }) => rest);
await loginAdmin();
console.log('写入项目与图纸…');
// 再次运行时：项目里不属于本脚本的图纸删掉，保证结果和第一次一样
const found = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}`, { method: 'POST', body: {}, allow: [404] });
const existing = Array.isArray(found?.drawings) ? found : null;
const seededIds = new Set(payloadDrawings.map((d) => d.id));
const staleIds = (existing?.drawings || []).map((d) => d.id).filter((id) => !seededIds.has(id));
// 按字段保存的接口（PATCH）：不带版本号和 base 值时直接写入，适合灌数据
const patched = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}`, {
  method: 'PATCH',
  body: { projectName: PROJECT_NAME, conf, updatedDrawings: payloadDrawings, deletedDrawingIds: staleIds, reviewTracker },
});
if (!patched?.success) throw new Error('写入项目失败：' + JSON.stringify(patched).slice(0, 400));
if (existing && existing.name !== PROJECT_NAME) console.warn(`注意：项目已存在，名称仍是“${existing.name}”（PATCH 不改已有项目的名称）`);
console.log(`  图纸：写入 ${patched.drawings.length} 张${staleIds.length ? `，删除旧图纸 ${staleIds.length} 张` : ''}`);

// ---------- 4. 为每张图纸生成 PCF 文档与意见 ----------
let written = 0;
let roundStats = new Map();
let tagStats = new Map();
let statusStats = new Map();

for (const drawing of drawings) {
  const count = drawing._commentCount;
  const roundNum = drawing._roundNum;

  // 4.1 创建 PCF 文档（每张图纸都有，即使暂时没有意见）
  const meta = await api(`/api/pcf/${PROJECT_ID}/${drawing.id}/create`, { method: 'POST', body: {} });
  const documentId = meta.document_id;
  const baseRev = meta.rev;

  // 4.2 每轮的业务日期登记：按轮次顺序递增
  const roundRegister = [];
  const baseOffset = -intBetween(50, 110);
  for (let r = 1; r <= roundNum; r++) {
    const ownerOffset = baseOffset + (r - 1) * intBetween(6, 14);
    const hasReply = r < roundNum || drawing.status !== 'Waiting Reply';
    roundRegister.push({
      id: randomUUID(),
      round: r,
      revision: roundLetter(r),
      ownerRef: `OWN-${drawing.customId}-R${roundLetter(r)}`,
      ownerDate: isoDate(ownerOffset),
      replyRef: `BLD-${drawing.customId}-R${roundLetter(r)}`,
      replyDate: hasReply ? isoDate(ownerOffset + 5) : '',
    });
  }

  const comments = [];
  const isApproved = drawing.status === 'Approved';
  const isWaiting = drawing.status === 'Waiting Reply';

  for (let c = 0; c < count; c++) {
    const commentId = randomUUID();
    // 轮数：第一条意见总是跟进到图纸当前轮，其余 1..当前轮
    const maxRound = c === 0 ? roundNum : Math.max(1, Math.min(roundNum, 1 + Math.floor(rnd() * roundNum)));
    const roundCount = maxRound;
    const raisedOffset = -intBetween(10, 80);
    const ownerName = pick(OWNER_REPS);
    const builderName = pick(BUILDER_REPS);

    const rounds = [];
    for (let r = 1; r <= roundCount; r++) {
      const isLatest = r === roundCount;
      const roundOffset = raisedOffset + (r - 1) * intBetween(4, 12);
      const ownerText = r === 1 ? pick(COMMENT_TEXTS) : pick([
        'Previous comment remains open. Please confirm the revised detail.',
        'Not fully addressed in the previous submission. Re-check and resubmit.',
        'The reply does not include the requested calculation.',
        'Same comment as previous round. Builder reply is still incomplete.',
      ]);
      // Waiting Reply 的最后轮次没有船厂回复
      const hasReply = !(isWaiting && isLatest) && rnd() < 0.82;
      const replyText = hasReply ? (r === 1 ? pick(BUILDER_REPLIES) : pick([
        'Revised as commented. Please review the attached detail.',
        'Calculation sheet will be submitted with the next package.',
        'The detail has been updated in this revision.',
        'Confirmed, the drawing will be reissued accordingly.',
      ])) : '';
      rounds.push({
        id: randomUUID(),
        number: r,
        initiator: ownerName,
        responder: hasReply ? builderName : '',        owner: { text: ownerText, html: esc(ownerText), fill: r === 1 && c % 5 === 0 ? '#f6edcc' : '', images: [] },
        reply: replyText ? { text: replyText, html: esc(replyText), fill: '', images: [] } : { text: '', html: '', fill: '', images: [] },
        minHeight: 0,
        createdAt: isoStamp(roundOffset, 10),
        updatedAt: isoStamp(roundOffset + (hasReply ? 2 : 0), 15),
      });
    }

    let status = 'open';
    if (isApproved) status = 'closed';
    else if (rounds[rounds.length - 1].reply.text) status = rnd() < 0.62 ? 'closed' : 'open';
    else status = 'open';

    const tags = rnd() < 0.45 ? [pick(TAGS)] : (rnd() < 0.2 ? [pick(TAGS), pick(TAGS)] : []);
    const uniqueTags = [...new Set(tags)];

    statusStats.set(status, (statusStats.get(status) || 0) + 1);
    roundStats.set(roundCount, (roundStats.get(roundCount) || 0) + 1);
    for (const t of uniqueTags) tagStats.set(t, (tagStats.get(t) || 0) + 1);

    comments.push({
      id: commentId,
      number: c + 1,
      page: '',
      tags: uniqueTags,
      status,
      createdAt: isoStamp(raisedOffset, 10),
      updatedAt: rounds[rounds.length - 1].updatedAt,
      rounds,
    });
  }

  const openCount = comments.filter((c) => c.status === 'open').length;
  let approval = 'Under review';
  let approvalControl = { lastOpen: openCount, source: 'auto', reason: 'Open comments added or reopened' };
  if (isApproved) {
    approval = 'Approved';
    approvalControl = { lastOpen: 0, source: 'manual', reason: 'Approved by owner' };
  } else if (!comments.length) {
    approval = 'Not submitted';
    approvalControl = { lastOpen: 0, source: 'auto', reason: 'New drawing — not submitted' };
  }

  const data = {
    schemaVersion: '1.0',
    documentId,
    updatedAt: isoStamp(0, 8),
    project: {
      name: PROJECT_NAME,
      planNo: drawing.drawingNo,
      planTitle: drawing.title,
      revision: roundLetter(roundNum),
      folder: '',
      approval,
      currentRound: roundNum,
    },
    circulation: [],
    comments,
    deleted: [],
    settings: { fontSize: 15, autoSaveSeconds: 60 },
    nextCommentNumber: comments.length + 1,
    roundRegister,
    approvalHistory: [],
    approvalControl,
  };

  await api(`/api/pcf/${PROJECT_ID}/${drawing.id}/document`, {
    method: 'PUT',
    body: { baseRev, importJSON: true, data },
  });

  written += 1;
  if (written % 20 === 0) console.log(`  已写入 PCF：${written}`);
}

// ---------- 5. 校验 ----------
console.log('校验…');
const list = await api('/api/projects');
const detail = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}`, { method: 'POST', body: {} });
const commentsResult = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}/comments`);

const summary = {
  项目: list.find((p) => p.id === PROJECT_ID)?.name,
  图纸数: detail.drawings.length,
  意见数: commentsResult.comments.length,
  人员数: detail.conf.reviewers.length,
  专业数: new Set(detail.drawings.map((d) => d.discipline)).size,
  专业列表: [...new Set(detail.drawings.map((d) => d.discipline))],
  按绘图状态: {},
  按当前轮次: {},
  按意见状态: Object.fromEntries([...statusStats].sort()),
  按最新轮次: Object.fromEntries([...roundStats].sort((a, b) => a[0] - b[0])),
  按标签: Object.fromEntries([...tagStats].sort()),
  已勾选图纸: detail.drawings.filter((d) => d.checked).length,
  已同步勾选: detail.drawings.filter((d) => d.checkedSynced).length,
  有备注图纸: detail.drawings.filter((d) => d.remarks?.length).length,
  意见筛选选项: {
    专业: commentsResult.options.disciplines.length,
    图纸状态: commentsResult.options.drawingStatuses,
    意见状态: commentsResult.options.commentStatuses,
    轮次: commentsResult.options.rounds,
    标签: commentsResult.options.tags,
  },
  统计: {
    总数: commentsResult.statistics.total,
    未关闭: commentsResult.statistics.open,
    已关闭: commentsResult.statistics.closed,
  },
  解析警告: commentsResult.warnings.length,
};
for (const d of detail.drawings) {
  summary.按绘图状态[d.status] = (summary.按绘图状态[d.status] || 0) + 1;
  summary.按当前轮次[d.currentRound] = (summary.按当前轮次[d.currentRound] || 0) + 1;
}

console.log(JSON.stringify(summary, null, 2));

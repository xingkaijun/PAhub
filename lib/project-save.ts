import type { DrawingConflict, WriteVerification } from '../types';

// 保存后应用服务端回读校验的结论。三种情形分开处理：
//   ok            → 按正常流程清脏标记
//   mismatched    → 只把没落库的图纸重新标脏，交给下次保存重试
//   error（无法确认）→ 按成功处理。校验查询若永久性损坏，重新标脏会和 3 分钟
//                     自动保存形成无限重试循环，代价远大于漏报
export const describeVerification = (verification: WriteVerification | undefined): string | null => {
  if (!verification || verification.ok) return null;
  if (verification.error) return null;
  const labels = verification.mismatched.slice(0, 5).map(m => m.customId || m.id);
  const suffix = verification.mismatched.length > labels.length ? ` 等 ${verification.mismatched.length} 张` : '';
  return `服务器写入校验未通过：${labels.join(', ')}${suffix}。已重新标记为待保存。`;
};


const CONFLICT_FIELD_LABELS: Record<string, string> = {
  customId: '编号', drawingNo: '图号', discipline: '专业', title: '标题', status: '状态', version: '版本', reviewDeadline: '审图期限',
  manualCommentsCount: '意见数', manualOpenCommentsCount: '未关闭意见数', checked: '勾选', checkedSynced: '勾选同步', receivedDate: '收图日期',
  category: '类别', deadline: '截止日期', assignees: '审图人', remarks: '备注', deleted: '已被删除',
};

// 409 冲突提示：哪几张图纸、哪些字段被别人先改了
export const describeDrawingConflicts = (conflicts: DrawingConflict[]): string => {
  const parts = conflicts.slice(0, 5).map(c => `${c.customId || c.id}（${c.fields.map(f => CONFLICT_FIELD_LABELS[f] || f).join('、')}）`);
  const suffix = conflicts.length > parts.length ? ` 等 ${conflicts.length} 张` : '';
  return `保存冲突：${parts.join('，')}${suffix} 已被其他人先修改。本次保存没有写入，冲突的字段已换成服务器上的最新内容，你在这些字段上的修改未保存；其他修改仍保留，会再次保存。`;
};

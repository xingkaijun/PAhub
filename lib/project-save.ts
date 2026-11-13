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
  const suffix = verification.mismatched.length > labels.length ? ` and others (${verification.mismatched.length} drawings)` : '';
  return `Server write check failed: ${labels.join(', ')}${suffix}. Marked as unsaved again.`;
};


const CONFLICT_FIELD_LABELS: Record<string, string> = {
  customId: 'ID', drawingNo: 'Drawing No.', discipline: 'Discipline', title: 'Title', status: 'Status', version: 'Version', reviewDeadline: 'Review Deadline',
  manualCommentsCount: 'Comments', manualOpenCommentsCount: 'Open Comments', checked: 'Checked', checkedSynced: 'Check Synced', receivedDate: 'Received Date',
  category: 'Category', deadline: 'Deadline', assignees: 'Assignees', remarks: 'Remarks', deleted: 'Deleted',
};

// 409 冲突提示：哪几张图纸、哪些字段被别人先改了
export const describeDrawingConflicts = (conflicts: DrawingConflict[]): string => {
  const parts = conflicts.slice(0, 5).map(c => `${c.customId || c.id} (${c.fields.map(f => CONFLICT_FIELD_LABELS[f] || f).join(', ')})`);
  const suffix = conflicts.length > parts.length ? ` and others (${conflicts.length} drawings)` : '';
  return `Save conflict: ${parts.join('; ')}${suffix} changed by someone else first. Nothing was saved this time. The conflicting fields now show the latest server values and your edits to them were not saved; your other edits are kept and will be saved again.`;
};

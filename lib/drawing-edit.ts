import type { Drawing, ProjectConfig } from '../types';
import { transitionReviewState } from './drawing-status';
import { PCF_MANAGED_FIELDS } from './drawing-fields';

export function editableDrawingUpdates(current: Drawing | undefined, input: Partial<Drawing>): Partial<Drawing> {
  const updates = { ...input };
  delete updates.currentRound;
  if (current?.hasPcf) for (const field of PCF_MANAGED_FIELDS) delete updates[field];
  return updates;
}

// Caller supplies the clock and ID: the calculation never mutates input or reads global state.
export function applyDrawingUpdates(d: Drawing, updates: Partial<Drawing>, conf: ProjectConfig, at: Date, historyId: string): Drawing {
  // Change Detection: Track important field changes
  const changedDrawing = { ...d, ...updates };
  const changeLogs: string[] = [];
  
  // Detect Status Change
  if (updates.status && d.status !== updates.status) {
    changeLogs.push(`Status: ${d.status} -> ${updates.status}`);
  
    const predicted = transitionReviewState(d, updates.status, conf, at);
    changedDrawing.currentRound = predicted.currentRound;
    changedDrawing.reviewDeadline = predicted.reviewDeadline || undefined;
    if (predicted.currentRound !== d.currentRound) changeLogs.push(`Round: ${d.currentRound} -> ${predicted.currentRound}`);
  
  }
  
  // Detect Version Change
  if (updates.version && d.version !== updates.version) {
    changeLogs.push(`Version: ${d.version} -> ${updates.version}`);
  }
  
  // Detect Round Change
  if (updates.currentRound && d.currentRound !== updates.currentRound) {
    changeLogs.push(`Round: ${d.currentRound} -> ${updates.currentRound}`);
  }
  
  // Detect Comments Count Change
  if (
    (updates.manualCommentsCount !== undefined && d.manualCommentsCount !== updates.manualCommentsCount) ||
    (updates.manualOpenCommentsCount !== undefined && d.manualOpenCommentsCount !== updates.manualOpenCommentsCount)
  ) {
    const oldTotal = d.manualCommentsCount || 0;
    const oldOpen = d.manualOpenCommentsCount || 0;
    const newTotal = updates.manualCommentsCount !== undefined ? updates.manualCommentsCount : oldTotal;
    const newOpen = updates.manualOpenCommentsCount !== undefined ? updates.manualOpenCommentsCount : oldOpen;
  
    if (oldTotal !== newTotal || oldOpen !== newOpen) {
      changeLogs.push(`Comments: ${oldTotal}/${oldOpen} -> ${newTotal}/${newOpen}`);
    }
  }
  
  // Write to statusHistory if there are changes
  if (changeLogs.length > 0) {
    const newLogString = changeLogs.join(' | ');
    const now = at;
    const nowStr = now.toISOString();
  
    // ------ 防抖与合并逻辑 (针对连续输入的 Comments 变化) ------
    // 如果 changeLogs 里只包含 Comments 的变化 (不影响其他 Status/Round 等)
    const isOnlyCommentsChange = changeLogs.every(log => log.startsWith('Comments:'));
    
    if (isOnlyCommentsChange && d.statusHistory && d.statusHistory.length > 0) {
      const lastEntry = d.statusHistory[d.statusHistory.length - 1];
      
      // 检查最后一条记录是否也是 Comments 变化
      if (lastEntry.content.startsWith('Comments:')) {
        const lastTime = new Date(lastEntry.createdAt);
        // 如果距离上一次 Comments 变化在 2 分钟以内，进行合并
        if (now.getTime() - lastTime.getTime() < 2 * 60 * 1000) {
          // 解析旧日志的起点 (例如 "Comments: 0/0 -> 2/0" 提取出 "0/0")
          const oldMatch = lastEntry.content.match(/Comments:\s*([\d\/]+)\s*->/);
          // 提取新日志的终点 (例如 "Comments: 2/0 -> 26/2" 提取出 "26/2")
          const newMatch = newLogString.match(/->\s*([\d\/]+)/);
          
          if (oldMatch && newMatch) {
            const originalStart = oldMatch[1];
            const finalEnd = newMatch[1];
            
            // 更新最后一条历史记录的内容和时间
            const mergedContent = `Comments: ${originalStart} -> ${finalEnd}`;
            
            // 替换数组最后一条
            const newHistory = [...d.statusHistory];
            newHistory[newHistory.length - 1] = {
              ...lastEntry,
              content: mergedContent,
              createdAt: nowStr // 刷新时间
            };
            
            changedDrawing.statusHistory = newHistory;
            return changedDrawing; // 短路返回，不需要新建记录
          }
        }
      }
    }
    // ------ 结束：防抖合并逻辑 ------
  
    const newHistoryEntry = {
      id: historyId,
      content: newLogString,
      createdAt: nowStr
    };
    changedDrawing.statusHistory = [...(d.statusHistory || []), newHistoryEntry];
  }
  
  return changedDrawing;
}

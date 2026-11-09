import { differenceInCalendarDays, format } from 'date-fns';
import type { Drawing, ReviewTrackerData } from '../types';

// CSV 字段转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍
export const csvCell = (value: string | number | null | undefined): string => {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Tracker 的 Export CSV：ID 列是图纸的自定义编号（customId），Drawing No 列是真正的图号（drawingNo）。
 * 收集导出范围内出现过的所有负责人，每人固定一列（列头=人名），方便按人筛选。
 */
export function buildReviewTrackerCsv(rows: Drawing[], reviewTracker: ReviewTrackerData, now: Date = new Date()): string {
    const assigneeNames = Array.from(
        new Set(rows.flatMap(d => d.assignees || []))
    ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const headers = ['No', 'ID', 'Drawing No', 'Title', 'Discipline', 'Status', 'Overdue', 'Deadline', ...assigneeNames];

    const dataRows = rows.map((d, i) => {
        const trackerEntry = reviewTracker[d.id] || {};
        const assignees = d.assignees || [];
        const doneCount = assignees.filter(a => trackerEntry[a]?.done).length;
        const allDone = assignees.length > 0 && doneCount === assignees.length;
        const days = d.reviewDeadline ? differenceInCalendarDays(new Date(d.reviewDeadline), now) : null;

        const statusText = allDone ? 'Ready' : `Reviewing ${doneCount}/${assignees.length}`;
        const overdueText = days === null ? '-' : (days < 0 ? `Overdue ${-days}d` : `${days}d left`);
        const deadline = d.reviewDeadline ? format(new Date(d.reviewDeadline), 'yyyy-MM-dd') : '-';

        // 每个负责人固定一列：归他负责则填状态(Done/Pending)，否则留空
        const assigneeCells = assigneeNames.map(name =>
            assignees.includes(name) ? (trackerEntry[name]?.done ? 'Done' : 'Pending') : ''
        );

        return [
            i + 1,
            d.customId || '',
            d.drawingNo || '',
            d.title || '',
            d.discipline || '-',
            statusText,
            overdueText,
            deadline,
            ...assigneeCells,
        ].map(csvCell).join(',');
    });

    return [headers.map(csvCell).join(','), ...dataRows].join('\r\n');
}

import type { Drawing } from '../types';

type DrawingLabel = Pick<Drawing, 'customId' | 'drawingNo' | 'title'>;

/** 删除图纸前的确认文字：写清图号和标题。 */
export function deleteDrawingPrompt(drawing: DrawingLabel): string {
  const no = (drawing.drawingNo || '').trim() || (drawing.customId || '').trim() || '(no drawing number)';
  const title = (drawing.title || '').trim() || '(untitled)';
  const id = (drawing.customId || '').trim();
  return [
    'Delete this drawing? 确定删除这张图纸？',
    '',
    `Drawing No: ${no}`,
    `Title: ${title}`,
    ...(id && id !== no ? [`ID: ${id}`] : []),
    '',
    'It is removed from the server on the next save. 下次保存时会从服务器上删除。',
  ].join('\n');
}

/** 先确认再删；取消就什么都不做。返回是否删了。 */
export function confirmAndDeleteDrawing(
  drawing: DrawingLabel & Pick<Drawing, 'id'>,
  deleteDrawing: (id: string) => void,
  confirmFn: (message: string) => boolean = message => window.confirm(message),
): boolean {
  if (!confirmFn(deleteDrawingPrompt(drawing))) return false;
  deleteDrawing(drawing.id);
  return true;
}

/** One row per comment, with its latest round and latest nonempty Owner text. */
export interface ProjectComment {
  drawingId: string;
  drawingNo: string;
  drawingTitle: string;
  discipline: string;
  drawingStatus: string;
  commentId: string;
  number: number;
  round: number;
  status: string;
  tags: string[];
  ownerName: string;
  ownerDate: string;
  ownerComment: string;
  builderReply: string;
  builderReplyDate: string;
  updatedAt: string;
  openDays: number | null;
  hasImages: boolean;
}

export interface CommentsStatistics {
  total: number;
  open: number;
  closed: number;
  byDiscipline: Array<{ discipline: string; status: string; count: number }>;
  byRound: Array<{ round: number; count: number }>;
  byDrawingStatus: Array<{ drawingStatus: string; count: number }>;
  ageing: Array<{ band: string; count: number }>;
  topDrawings: Array<{ drawingId: string; drawingNo: string; open: number; closed: number; total: number }>;
}

export interface CommentsOptions {
  disciplines: string[];
  drawingStatuses: string[];
  commentStatuses: string[];
  rounds: number[];
  tags: string[];
}

export interface CommentsResponse {
  comments: ProjectComment[];
  statistics: CommentsStatistics;
  options: CommentsOptions;
  warnings: Array<{ drawingId: string; drawingNo: string; message: string }>;
  generatedAt: string;
}

/** Blank values are omitted. Search is performed by the server across all rounds. */
export interface CommentsFilters {
  discipline?: string;
  drawingStatus?: string;
  commentStatus?: string;
  round?: number | string;
  tag?: string;
  q?: string;
  openOlderThanDays?: number | string;
}

export type CommentsStreamState = 'connecting' | 'live' | 'offline';

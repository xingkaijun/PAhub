import React from 'react';
import { format } from 'date-fns';

export const HEALTH_COLORS = ['#10b981', '#eab308', '#3b82f6', '#94a3b8'];
export const HEALTH_LABELS = ['Approved', 'Reviewing', 'Sent Out', 'Pending'];

export const PageHeader: React.FC<{ projectName: string; reportTitle?: string }> = ({ projectName, reportTitle }) => (
  <div className="border-b-2 border-slate-900 pb-5 mb-8 flex justify-between items-end shrink-0">
    <div className="flex items-center gap-5">
      <div className="bg-white p-1 rounded-lg shadow-sm border border-slate-100 overflow-hidden shrink-0">
        <img
          src="https://i.postimg.cc/7LVr6n5m/PG-Logo.jpg"
          alt="PG SHIPMANAGEMENT PTE. LTD. Logo"
          className="h-10 w-auto object-contain"
        />
      </div>
      <div>
        <div className="text-[9px] font-[1000] text-teal-600 uppercase tracking-[0.2em] mb-0.5">PG SHIPMANAGEMENT</div>
        <h1 className="text-2xl font-[1000] text-slate-900 uppercase tracking-tighter leading-none">Plan Approval Report</h1>
      </div>
    </div>
    <div className="text-right">
      <div className="bg-slate-100 px-3 py-1.5 rounded-lg inline-block mb-3 border border-slate-200">
        <div className="text-[12px] font-[1000] text-slate-800 uppercase tracking-widest leading-none">{projectName}</div>
      </div>
      <div className="text-[8px] font-black uppercase text-slate-400 mb-1 tracking-widest">Report Reference</div>
      <div className="text-[10px] font-black text-slate-900">{format(new Date(), 'yyyyMMdd-HHmm')}</div>
    </div>
  </div>
);

export const PageFooter: React.FC<{ pageNumber: number; totalPages: number; projectName: string }> = ({ pageNumber, totalPages, projectName }) => (
  <div className="mt-auto pt-6 border-t border-slate-100 flex justify-between items-center relative shrink-0">
    <div className="text-[7px] font-black text-slate-300 uppercase tracking-[0.4em]">
      {projectName} • ACTIVITY REPORT • INTERNAL USE ONLY
    </div>
    {pageNumber > 0 && totalPages > 0 && (
      <div className="text-[8px] font-black text-slate-400 uppercase tracking-widest">
        Page {pageNumber} of {totalPages}
      </div>
    )}
  </div>
);

export const ReportPage: React.FC<{ children: React.ReactNode; pageNumber?: number; totalPages?: number; projectName: string; hideFooter?: boolean; forceBreakAfter?: boolean }> = ({ children, pageNumber, totalPages, projectName, hideFooter, forceBreakAfter = true }) => (
  <div className={`mx-auto my-8 bg-white w-[210mm] h-[297mm] shadow-[0_0_50px_-12px_rgba(0,0,0,0.12)] border border-slate-200 p-[15mm] flex flex-col relative box-border ${forceBreakAfter ? 'break-after-page' : ''} print:m-0 print:border-none print:shadow-none mb-12 shrink-0`}>
    <PageHeader projectName={projectName} />
    <div className="flex-1 flex flex-col overflow-hidden min-h-0 print:overflow-visible print:h-auto print:flex-none print:block">
      {children}
    </div>
    {!hideFooter && <PageFooter pageNumber={pageNumber || 0} totalPages={totalPages || 0} projectName={projectName} />}
  </div>
);

import React from 'react';
import {
  BookOpen, Terminal, Cloud, FileText, Settings,
  HelpCircle, ChevronRight, Info, AlertCircle, Send,
  MousePointer2, Command, Shield, Sparkles, CheckCircle, RefreshCw
} from 'lucide-react';

// Move helper components to top to avoid hoisting issues and fix children prop type errors
const Section = ({ icon, title, children }: { icon: React.ReactNode, title: string, children?: React.ReactNode }) => (
  <section className="space-y-4">
    <div className="flex items-center gap-3">
      <div className="p-2 bg-slate-50 rounded-xl text-slate-900 border border-slate-100 shadow-sm">{icon}</div>
      <h3 className="text-[12px] font-black uppercase text-slate-900 tracking-widest">{title}</h3>
    </div>
    <div className="pl-2 border-l border-slate-100">
      {children}
    </div>
  </section>
);

const CommandItem = ({ code, desc }: { code: string, desc: string }) => (
  <div className="flex items-center justify-between group">
    <code className="text-[10px] font-black text-teal-600 bg-teal-50 px-2 py-0.5 rounded-lg border border-teal-100/50">{code}</code>
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight group-hover:text-slate-600 transition-colors">{desc}</span>
  </div>
);

const TipBadge = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-white/10 transition-colors cursor-default">
    <CheckCircle size={10} className="text-teal-400" />
    <span>{label}</span>
  </div>
);

export const Manual: React.FC = () => {
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200 bg-white p-8">
      <div className="max-w-6xl mx-auto space-y-12 pb-20">

        {/* Header Section */}
        <div className="border-b-2 border-slate-900 pb-8 flex justify-between items-end">
          <div>
            <h2 className="text-3xl font-[1000] text-slate-900 uppercase tracking-tighter leading-none mb-4">Operation Manual & Tips</h2>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.3em]">Plan Approval Intelligence Platform User Guide</p>
          </div>
          <div className="text-right hidden md:block">
            <div className="text-[10px] font-black text-teal-600 bg-teal-50 px-3 py-1 rounded-full uppercase tracking-widest inline-block">Version 4.0-Cloud</div>
          </div>
        </div>

        {/* Content Split: English / Chinese */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">

          {/* English Version */}
          <div className="space-y-10">
            <header className="flex items-center gap-3 border-l-4 border-slate-900 pl-4">
              <span className="text-lg font-black text-slate-900 uppercase tracking-tight">English Manual</span>
            </header>

            <Section icon={<Cloud size={18} />} title="1. Server-First Sync & Auto-Save">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Pure Real-time Cloud:</strong> Our system is entirely cloud-based. Every action is saved instantly to the database. There is no manual "save" button.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Collaboration Protection:</strong> Multiple users can access the system simultaneously. Use Edit Mode lock to prevent conflicts when making changes.</li>
              </ul>
            </Section>

            <Section icon={<Terminal size={18} />} title="2. Intelligence Command Bar">
              <div className="bg-slate-50 p-4 rounded-2xl space-y-3">
                <p className="text-[10px] font-bold text-slate-500 uppercase mb-2 italic tracking-tight">Powerful shortcuts for fast logging:</p>
                <div className="space-y-2">
                  <CommandItem code="@001 Content" desc="Add an internal note to drawing with ID 001." />
                  <CommandItem code="@001 c:12/3" desc="Set comments to 12 total, 3 open." />
                  <CommandItem code="@R 001, 002" desc="Batch update status to 'Reviewing'." />
                </div>
              </div>
            </Section>

            <Section icon={<MousePointer2 size={18} />} title="3. Workflow & Tracker">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Status Logic:</strong> Toggle statuses (Pending → Reviewing → Approved) by clicking the badge. Overdue items are flagged automatically.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Review Tracker:</strong> Cross-check assignee completion status. Use the APR (Approve) button to quickly finalize fully reviewed items. All tracker states are persistent.</li>
              </ul>
            </Section>

            <Section icon={<FileText size={18} />} title="4. Daily Log & Activity Reports">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Data Strictness:</strong> Chart calculations explicitly depend solely on the manual Total/Open comments values you log, guaranteeing accurate, transparent trend visualizations.</li>
              </ul>
            </Section>
          </div>

          {/* Chinese Version */}
          <div className="space-y-10">
            <header className="flex items-center gap-3 border-l-4 border-teal-600 pl-4">
              <span className="text-lg font-black text-slate-900 uppercase tracking-tight">中文操作规范</span>
            </header>

            <Section icon={<Cloud size={18} />} title="1. 完全云端与防冲突机制">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>实时存档：</strong> 系统基于云原生数据库驱动，我们在客户端所做的任何变更，都会被实时保存到云端服务器中。无需寻找或点击“保存”按钮。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>协作保护：</strong> 多用户可同时访问系统。使用编辑模式锁定功能，避免在修改数据时产生冲突。</li>
              </ul>
            </Section>

            <Section icon={<Terminal size={18} />} title="2. 智能指令栏 (Command Bar)">
              <div className="bg-slate-50 p-4 rounded-2xl space-y-6">
                <p className="text-[10px] font-bold text-slate-500 uppercase mb-2 italic tracking-tight">所有指令均以 <strong>@</strong> 开头（全局搜索除外），支持空格或逗号分隔多个图纸ID执行批量操作：</p>

                <div className="space-y-4">
                  <div>
                    <h4 className="text-[10px] font-black text-slate-700 uppercase mb-2 border-b border-slate-200 pb-1">1. 全局搜索/过滤 (无需 @)</h4>
                    <div className="space-y-1">
                      <CommandItem code="show : hull" desc="显示包含 'hull' 的图纸" />
                      <CommandItem code="ls : kevin" desc="显示分配给 'kevin' 的图纸" />
                      <CommandItem code="reset" desc="清除所有过滤条件" />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-[10px] font-black text-slate-700 uppercase mb-2 border-b border-slate-200 pb-1">2. 批量状态更新</h4>
                    <div className="space-y-1">
                      <CommandItem code="@R 001, 002" desc="批量改为 Reviewing (R)" />
                      <CommandItem code="@W 001" desc="改为 Waiting Reply (W)" />
                      <CommandItem code="@A 001" desc="改为 Approved (A)" />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-[10px] font-black text-slate-700 uppercase mb-2 border-b border-slate-200 pb-1">3. 内部备忘与意见总数</h4>
                    <div className="space-y-1">
                      <CommandItem code="@001 修改坐标" desc="添加纯内部备注 '修改坐标'" />
                      <CommandItem code="@001 c:10/2" desc="设置对外意见数: 总意见10条 / 未结2条" />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-[10px] font-black text-slate-700 uppercase mb-2 border-b border-slate-200 pb-1">4. 版本与分配人员</h4>
                    <div className="space-y-1">
                      <CommandItem code="@001 v:C" desc="更新版本为 C" />
                      <CommandItem code="@001 to:Kevin" desc="指派给 Kevin (覆盖)" />
                    </div>
                  </div>
                </div>
              </div>
            </Section>

            <Section icon={<MousePointer2 size={18} />} title="3. 流程跟踪与审核">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>矩阵化 Tracker：</strong> Tracker 视图帮助统筹全员审图进度。使用底部的 APR (Approve) 按钮可以直接确认该份图纸的整体发行状态。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>审计日志：</strong> 展开列表行可查看每个文件的详细流转操作记录。</li>
              </ul>
            </Section>

            <Section icon={<FileText size={18} />} title="船厂回复导入">
              <ol className="space-y-2 text-[11px] font-medium text-slate-600 leading-relaxed list-decimal pl-5">
                <li>入口在 Inventory 的 Drawings 列表工具栏中的 <strong>Import Builder Replies</strong>；也可将 ZIP 或 PCF HTML 文件拖到 Drawings 页面。单张 PCF 页的 <strong>Import Builder Reply</strong> 用于处理该图冲突回复。</li>
                <li>选择或拖入文件后点 Preview replies，检查图纸匹配和结果分类，再点 Apply all clean 应用无冲突回复；冲突项用 Resolve 单独核对后处理。</li>
                <li><strong>Ready to apply</strong> 可自动合并；<strong>Conflict</strong> 需人工选择；<strong>No changes</strong> 无新回复；<strong>Unable to match / Duplicate import</strong> 不会应用；<strong>Owner changed</strong> 表示船东只读字段被改动，该字段会忽略，回复仍按基线核对。</li>
                <li>有实际新回复被应用时，状态仅从 <strong>Waiting Reply</strong> 自动更新为 <strong>Reviewing</strong>；其它状态保持不变，绝不会自动设为 Approved。</li>
              </ol>
            </Section>

            <Section icon={<FileText size={18} />} title="Comments 意见汇总">
              <ol className="space-y-2 text-[11px] font-medium text-slate-600 leading-relaxed list-decimal pl-5">
                <li>打开当前项目的 <strong>Comments</strong>，跨图纸查看现存、未删除的 PCF 意见；每条意见一行，轮次显示最新轮次（A、B、…、AA），正文分别显示最近非空的船东意见和船厂回复，不计入内部备忘。</li>
                <li>全文搜索覆盖所有轮次的意见与回复；组合图纸、专业、轮次、Open / Closed 等筛选后，列表与统计使用同一结果集。搜索命中旧轮次时，列表仍显示最近非空正文；打开 PCF 可查看完整往来。</li>
                <li>点击意见链接打开托管 PCF，自动切换到对应意见所在页并高亮定位；被筛选隐藏时会重置 PCF 筛选。定位使用稳定的意见 ID，不依赖会重新编号的显示序号；意见已删除时不会报错。</li>
                <li>收到图纸变更通知后，当前汇总标记为过期；点击 <strong>Refresh</strong> 重新读取并更新列表和统计。导出前先刷新，避免使用旧结果。</li>
                <li><strong>Export Excel</strong> 导出当前筛选的完整结果（不只是当前页），包含 Comments 和 Statistics 两张表及读取警告。长正文通过同一 Record key 的 Part / Parts 续行完整保存，按 Part 顺序拼接各正文列即可还原；续行不是额外意见。</li>
              </ol>
            </Section>

            <Section icon={<FileText size={18} />} title={"4. \u65e5\u5fd7\u4e0e\u6d3b\u52a8\u62a5\u8868"}>
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>报表严谨性：</strong> Reports 中的总意见生成，严格基于你在表单或命令行（c:5/1）中填写的具体计数执行，不计入日常打卡记录的内部备注文本，保证数据一致。</li>
              </ul>
            </Section>
          </div>

        </div>

        {/* Footer Pro Tips */}
        <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden">
          <div className="relative z-10 flex flex-col md:flex-row gap-12 items-center">
            <div className="shrink-0">
              <div className="w-20 h-20 bg-teal-500 rounded-3xl flex items-center justify-center shadow-xl shadow-teal-500/20">
                <Shield size={40} />
              </div>
            </div>
            <div className="flex-1 space-y-4 text-center md:text-left">
              <h3 className="text-xl font-black uppercase tracking-widest">Platform Safety & Best Practices</h3>
              <p className="text-slate-400 text-[11px] font-bold leading-relaxed uppercase tracking-widest">
                Configure your <strong>Project Settings</strong> to customize auto-sync intervals. Ideally, one team member should act as the <strong>Administrator</strong> to manage bulk imports to avoid conflicts.
              </p>
              <div className="pt-4 flex flex-wrap gap-4 justify-center md:justify-start">
                <TipBadge label="Auto-Sync Enabled" />
                <TipBadge label="Review Logs Weekly" />
                <TipBadge label="Project Specific Config" />
                <TipBadge label="Secure Cloud" />
              </div>
            </div>
          </div>

          {/* Abstract BG Decorations */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full -mr-32 -mt-32 blur-3xl" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-teal-500/10 rounded-full -ml-24 -mb-24 blur-3xl" />
        </div>
      </div>
    </div>
  );
};

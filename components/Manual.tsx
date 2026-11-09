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
            <div className="text-[10px] font-black text-teal-600 bg-teal-50 px-3 py-1 rounded-full uppercase tracking-widest inline-block">PAhub · Self-hosted Server</div>
          </div>
        </div>

        {/* Content Split: English / Chinese */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">

          {/* English Version */}
          <div className="space-y-10">
            <header className="flex items-center gap-3 border-l-4 border-slate-900 pl-4">
              <span className="text-lg font-black text-slate-900 uppercase tracking-tight">English Manual</span>
            </header>

            <Section icon={<Cloud size={18} />} title="1. Server Data, Saving & Sign-in">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Server is the source of truth:</strong> All project data lives in the PAhub server database on your own network. Opening a project always loads it from the server.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Two roles:</strong> Everyone can view every page, export reports and edit PCFs online as a <strong>Reviewer</strong>. Project-wide changes (editing the drawing list, status changes, command bar, Config, Bulk Load, Team Setup, importing builder replies or JSON, Send All, voiding a shipyard export, restoring a PCF history snapshot) need an <strong>Administrator</strong>: click <strong>Reviewer</strong> in the toolbar and sign in with the server&apos;s <code>ADMIN_PASSWORD</code>. The sign-in lasts 12 hours. If the server has no <code>ADMIN_PASSWORD</code>, everyone is an administrator.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Auto-save + Save Now:</strong> As an administrator, your edits are saved automatically 3 seconds after the last change; only the fields you changed are sent. A scheduled sync also runs every few minutes (Config → Auto-Sync Interval, default 3 min; 0 turns it off). While changes are pending, an <strong>Unsaved Changes</strong> card shows the count and a <strong>Save Now</strong> button; <strong>Sync to Cloud</strong> also saves immediately.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Live updates:</strong> Changes saved by others arrive in real time; only the changed drawings are re-read and a teal &quot;Updated by others&quot; note appears. Your unsaved edits are kept.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Conflict protection:</strong> If someone else saved the same field first, your save is refused for that batch, the field shows the server value and a yellow <strong>save conflict</strong> banner names it. Edits to different fields of the same drawing are both kept. Reload old browser tabs after an update so they get this protection.</li>
              </ul>
            </Section>

            <Section icon={<Terminal size={18} />} title="2. Intelligence Command Bar">
              <div className="bg-slate-50 p-4 rounded-2xl space-y-3">
                <p className="text-[10px] font-bold text-slate-500 uppercase mb-2 italic tracking-tight">Shortcuts for fast logging (administrator only):</p>
                <div className="space-y-2">
                  <CommandItem code="@001 Content" desc="Add an internal note to drawing with ID 001." />
                  <CommandItem code="@001 c:12/3" desc="Set comments to 12 total, 3 open (not for drawings with a PCF)." />
                  <CommandItem code="@R 001, 002" desc="Batch update status to 'Reviewing'." />
                </div>
              </div>
            </Section>

            <Section icon={<MousePointer2 size={18} />} title="3. Workflow & Tracker">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Status Logic:</strong> Pick the status (Pending / Reviewing / Waiting Reply / Approved) from the Status column (administrator). Moving from Waiting Reply back to Reviewing starts the next round (A → B …) and sets a new deadline in working days (Config: round A cycle / other rounds cycle). Overdue items are flagged automatically.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Review Tracker:</strong> Shows drawings in Reviewing. Tick each assignee when done; when all are done the drawing is Ready. Mark Ready drawings with APR to send them as Approved, then <strong>Send All</strong> updates the statuses (Approved or Waiting Reply) and downloads the shipyard PCF package. Tracker states are saved on the server.</li>
              </ul>
            </Section>

            <Section icon={<FileText size={18} />} title="4. Daily Log & Activity Reports">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Data Strictness:</strong> Comment totals come from each drawing&apos;s PCF (counted automatically on every PCF save); drawings without a PCF use the Total/Open values entered by hand or with <code>c:12/3</code>. Internal notes are never counted.</li>
              </ul>
            </Section>
          </div>

          {/* Chinese Version */}
          <div className="space-y-10">
            <header className="flex items-center gap-3 border-l-4 border-teal-600 pl-4">
              <span className="text-lg font-black text-slate-900 uppercase tracking-tight">中文操作规范</span>
            </header>

            <Section icon={<Cloud size={18} />} title="1. 服务器数据、保存与登录">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>以服务器为准：</strong> 所有项目数据都存在部署在内网的 PAhub 服务器数据库里，打开项目时总是从服务器读取。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>两种身份：</strong> 不登录就是<strong>访客（Reviewer）</strong>，可以查看所有页面、导出报表、在线编辑 PCF。项目级的修改要<strong>管理员（Administrator）</strong>：主表编辑、状态流转、指令栏、Config、Bulk Load、Team Setup、导入船厂回复和 JSON、Send All、作废船厂导出（Void）、恢复 PCF 历史快照。点工具栏上的 <strong>Reviewer</strong>，输入服务器设置的 <code>ADMIN_PASSWORD</code> 登录，12 小时有效。服务器没设 <code>ADMIN_PASSWORD</code> 时，所有人都是管理员。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>自动保存 + Save Now：</strong> 管理员修改后停 3 秒自动保存，只发改过的字段；另外每隔几分钟还会定时同步一次（Config 里的 Auto-Sync Interval，默认 3 分钟，设成 0 关闭）。有没保存的改动时，右下角会出现 <strong>Unsaved Changes</strong> 卡片，显示条数，点 <strong>Save Now</strong> 立即保存；<strong>Sync to Cloud</strong> 按钮也能立即保存。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>实时推送：</strong> 别人保存的改动会实时推送过来，只重读变化的那几张图纸，并显示青色的 “Updated by others” 提示；你还没保存的修改会保留。</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>冲突保护：</strong> 如果别人先改了同一个字段，你这一批保存不会写入，这个字段换成服务器上的值，页面顶部黄色的<strong>保存冲突</strong>提示条会写明是哪一项。两个人改同一张图纸的不同字段，两边都保留。系统更新后请刷新还开着的旧页面，旧页面没有这层保护。</li>
              </ul>
            </Section>

            <Section icon={<Terminal size={18} />} title="2. 智能指令栏 (Command Bar)">
              <div className="bg-slate-50 p-4 rounded-2xl space-y-6">
                <p className="text-[10px] font-bold text-slate-500 uppercase mb-2 italic tracking-tight">指令栏需要管理员登录。所有指令均以 <strong>@</strong> 开头（全局搜索除外），支持空格或逗号分隔多个图纸ID执行批量操作：</p>

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
                      <CommandItem code="@001 c:10/2" desc="设置意见数: 总10条 / 未结2条（有 PCF 的图纸由 PCF 自动统计，不能手改）" />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-[10px] font-black text-slate-700 uppercase mb-2 border-b border-slate-200 pb-1">4. 版本与分配人员</h4>
                    <div className="space-y-1">
                      <CommandItem code="@001 v:C" desc="更新版本为 C（有 PCF 的图纸由 PCF 管理）" />
                      <CommandItem code="@001 to:Kevin" desc="指派给 Kevin (覆盖)" />
                    </div>
                  </div>
                </div>
              </div>
            </Section>

            <Section icon={<MousePointer2 size={18} />} title="3. 流程跟踪与审核">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>矩阵化 Tracker：</strong> 只显示 Reviewing 状态的图纸。每个负责人审完就点亮自己，全部点亮后图纸变成 Ready。Ready 的图纸点 APR 表示这次按 Approved 发出，再点 <strong>Send All</strong>：状态改成 Approved 或 Waiting Reply，并下载船厂版 PCF 压缩包。Tracker 状态保存在服务器上。</li>
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
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-600" /> <strong>报表严谨性：</strong> 意见数来自每张图纸的 PCF，每次保存 PCF 时自动统计；没有 PCF 的图纸才用手工填写或指令栏（c:5/1）录入的总数/未结数。内部备注不计入意见数。</li>
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
                Set the auto-sync interval in <strong>Config</strong>. Project-wide changes and bulk imports need the <strong>Administrator</strong> sign-in (server <code>ADMIN_PASSWORD</code>); keep a <strong>Local Backup</strong> before large imports.
              </p>
              <div className="pt-4 flex flex-wrap gap-4 justify-center md:justify-start">
                <TipBadge label="Auto-Sync Enabled" />
                <TipBadge label="Review Logs Weekly" />
                <TipBadge label="Project Specific Config" />
                <TipBadge label="Self-hosted Server" />
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

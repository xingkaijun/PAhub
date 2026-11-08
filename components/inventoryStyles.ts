// Shared Inventory presentation primitives. Comments consumes these instead of
// maintaining a second palette, button system, table header or badge shape.
export const inventoryStyles = {
  action: 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-[9px] font-black uppercase tracking-[0.18em] border shadow-sm transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
  secondary: 'bg-white/85 border-slate-200 text-slate-600 hover:bg-white hover:border-teal-200 hover:text-teal-700',
  primary: 'inventory-primary bg-[linear-gradient(135deg,#005c55_0%,#0f766e_100%)] text-white border-transparent hover:brightness-105',
  input: 'w-full px-3 py-2.5 bg-white/80 border border-slate-200 rounded-full outline-none focus:bg-white focus:border-teal-300 focus:ring-4 focus:ring-teal-500/10 transition-colors text-[10px] font-black tracking-tight shadow-sm',
  filterBar: 'px-5 py-3 border-b border-teal-100/70 flex flex-col gap-3 bg-white/80',
  metric: 'rounded-2xl border border-teal-200 bg-[linear-gradient(135deg,rgba(0,106,99,0.06),rgba(156,242,232,0.2))] px-4 py-3 text-teal-700 shadow-sm',
  header: 'inventory-table-head text-slate-400 uppercase text-[8px] font-black tracking-[0.1em] border-b border-slate-100 shadow-sm',
  row: 'group transition-colors duration-200 motion-reduce:transition-none',
  rowHover: 'hover:bg-slate-50/40',
  divider: 'divide-y divide-slate-50/50',
  badge: 'inline-flex items-center px-2 py-0.5 rounded-md text-[8px] font-black uppercase border tracking-tight leading-none',
};
export const inventoryStatusColors: Record<string,string> = {
  Pending: 'bg-slate-100 text-slate-500 border-slate-200',
  Reviewing: 'bg-amber-50 text-amber-700 border-amber-200/50',
  'Under Review': 'bg-amber-50 text-amber-700 border-amber-200/50',
  'Waiting Reply': 'bg-blue-50 text-blue-700 border-blue-200/50',
  Approved: 'bg-emerald-50 text-emerald-700 border-emerald-200/50',
};
export function inventoryBadgeClass(value: string, kind: 'status' | 'tag' | 'round' = 'status') {
  const neutral = inventoryStatusColors.Pending;
  const color = kind === 'tag' && value === 'Cost Affect' ? 'cost-affect-badge'
    : kind !== 'status' ? neutral
    : value.toLowerCase() === 'open' ? 'bg-amber-50 text-amber-700 border-amber-200/50'
    : value.toLowerCase() === 'closed' ? inventoryStatusColors.Approved
    : inventoryStatusColors[value] || neutral;
  return inventoryStyles.badge + ' ' + color;
}

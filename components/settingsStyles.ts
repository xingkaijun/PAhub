import { inventoryStyles } from './inventoryStyles';

// Settings uses the same compact control typography, palette and focus treatment
// as Inventory/Comments. Native options inherit it instead of the UA font.
export const settingsStyles = {
  control: inventoryStyles.input + ' min-w-0 font-sans text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed',
  label: 'text-[9px] font-black font-sans uppercase tracking-widest text-slate-500',
  range: 'flex-1 h-1.5 bg-slate-100 rounded-full appearance-none cursor-pointer accent-teal-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
};

import type { WriteVerification } from '../types';

// 保存后应用服务端回读校验的结论。三种情形分开处理：
//   ok            → 按正常流程清脏标记
//   mismatched    → 只把没落库的图纸重新标脏，交给下次保存重试
//   error（无法确认）→ 按成功处理。校验查询若永久性损坏，重新标脏会和 3 分钟
//                     自动保存形成无限重试循环，代价远大于漏报
export const describeVerification = (verification: WriteVerification | undefined): string | null => {
  if (!verification || verification.ok) return null;
  if (verification.error) return null;
  const labels = verification.mismatched.slice(0, 5).map(m => m.customId || m.id);
  const suffix = verification.mismatched.length > labels.length ? ` 等 ${verification.mismatched.length} 张` : '';
  return `服务器写入校验未通过：${labels.join(', ')}${suffix}。已重新标记为待保存。`;
};


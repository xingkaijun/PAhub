export function roundToLetters(value: number | string | null | undefined): string {
  if (typeof value === 'string' && /^[A-Z]{1,3}$/i.test(value)) return value.toUpperCase();
  let round = Number(value);
  if (!Number.isSafeInteger(round) || round < 1) return '';
  let label = '';
  while (round > 0) {
    round -= 1;
    label = String.fromCharCode(65 + round % 26) + label;
    round = Math.floor(round / 26);
  }
  return label;
}

export function lettersToRound(value: unknown): number {
  const label = String(value || '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(label)) return 1;
  return [...label].reduce((round, letter) => round * 26 + letter.charCodeAt(0) - 64, 0);
}

export function nextRoundLabel(value: unknown): string {
  return roundToLetters(lettersToRound(value) + 1);
}

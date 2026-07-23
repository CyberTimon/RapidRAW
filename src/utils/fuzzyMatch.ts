export interface FuzzyMatchResult {
  positions: Array<number>;
  score: number;
}

const WORD_SEPARATORS = new Set([' ', '-', '_', '.', '/', '\\', ':']);

/**
 * Small hand-rolled subsequence matcher in the spirit of fzf. Every character
 * of the query must appear in the target in order (case-insensitive).
 * Consecutive matches and matches at the start of a word score higher, so a
 * query like "imgset" prefers "image_settings" over scattered matches.
 * Returns null when the query is not a subsequence of the target, otherwise
 * the score and the matched character positions for highlighting.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (!query) {
    return { positions: [], score: 0 };
  }
  const loweredQuery = query.toLowerCase();
  const loweredTarget = target.toLowerCase();
  const positions: Array<number> = [];
  let score = 0;
  let searchFrom = 0;
  let previousIndex = -2;

  for (let i = 0; i < loweredQuery.length; i++) {
    const index = loweredTarget.indexOf(loweredQuery[i], searchFrom);
    if (index === -1) {
      return null;
    }
    let charScore = 1;
    if (index === previousIndex + 1) {
      charScore += 4;
    }
    if (index === 0 || WORD_SEPARATORS.has(loweredTarget[index - 1])) {
      charScore += 6;
    }
    score += charScore;
    positions.push(index);
    previousIndex = index;
    searchFrom = index + 1;
  }

  score += Math.max(0, 8 - positions[0]);
  score -= loweredTarget.length * 0.01;
  return { positions, score };
}

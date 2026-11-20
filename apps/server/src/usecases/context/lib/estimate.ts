import { AppError } from '../../../errors.js';
import type { ModelMessage } from '../../../infrastructure/model/client.js';

/** Fixed local text estimate; this is neither measured usage nor automatic calibration. */
export function estimateInputTokens(messages: readonly ModelMessage[]): number {
  let tokens = 64;
  for (const message of messages) {
    let thirds = 0;
    for (const char of message.content) {
      thirds += char.codePointAt(0)! <= 127 ? 1
        : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
          ? 3 : Buffer.byteLength(char, 'utf8') * 3;
    }
    tokens += 16 + Math.ceil(thirds / 3);
  }
  if (!Number.isSafeInteger(tokens)) throw new AppError('CONTEXT_BUDGET_EXCEEDED');
  return tokens;
}

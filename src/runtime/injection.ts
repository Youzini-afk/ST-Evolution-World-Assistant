import { injectReplyInstruction } from './compat/injection';

export function injectReplyInstructionOnce(replyInstruction: string) {
  const content = replyInstruction.trim();
  if (!content) {
    return;
  }

  injectReplyInstruction(content);
}

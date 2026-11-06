import type { TMessageContentParts } from './types/content';
import type { TMessage, TAttachment } from './schemas';

const ATTACHMENT_LIMIT_CODE = 'AGENT_ATTACHMENT_LIMIT_EXCEEDED';
const LEGACY_LIMIT =
  /^This turn exceeds the configured (?:attachment count|total attachment size|extracted document text) limit \(\d+ > \d+\)\. Remove some attachments or use smaller files and try again\.$/;

function isAttachmentRejection(text?: string): boolean {
  if (!text) return false;
  if (LEGACY_LIMIT.test(text)) return true;
  try {
    const error: { code?: string } = JSON.parse(text);
    return error?.code === ATTACHMENT_LIMIT_CODE;
  } catch {
    return false;
  }
}

/** Only a failed response on the selected branch can reject its parent attachments. */
export function getRejectedAttachmentParents(messages: readonly Partial<TMessage>[]): Set<string> {
  const rejected = new Set<string>();
  for (const message of messages) {
    if (message.isCreatedByUser !== false || !message.parentMessageId) continue;
    const rejectedText = message.error === true && isAttachmentRejection(message.text);
    const rejectedPart = message.content?.some(
      (part) => part.type === 'error' && isAttachmentRejection(part.error),
    );
    if (rejectedText || rejectedPart) rejected.add(message.parentMessageId);
  }
  return rejected;
}

/** Model-only projection. Never overwrite stored messages or delete uploaded files. */
export function prepareAttachmentReplayHistory<T extends Partial<TMessage>>(messages: T[]): T[] {
  const rejected = getRejectedAttachmentParents(messages);
  return messages.map((message) => {
    const allRejected = message.isCreatedByUser === true && rejected.has(message.messageId ?? '');
    const excluded = message.files?.some((file) => file.excludedFromContext === true);
    if (!allRejected && !excluded) return message;
    const decisions = new Map(
      message.files?.map((file) => [file.file_id, file.excludedFromContext]),
    );
    const keepFile = (file: { file_id?: string; excludedFromContext?: boolean } | TAttachment) => {
      const fileId =
        'file_id' in file && typeof file.file_id === 'string' ? file.file_id : undefined;
      const decision =
        ('excludedFromContext' in file ? file.excludedFromContext : undefined) ??
        decisions.get(fileId);
      return decision === false || (!allRejected && decision !== true);
    };
    return {
      ...message,
      files: message.files?.filter(keepFile),
      attachments: message.attachments?.filter(keepFile),
      // Regenerate extracted context from the remaining admitted references.
      fileContext: undefined,
      content: message.content?.flatMap<TMessageContentParts>((part) => {
        if (part.type === 'steer') return [{ ...part, files: part.files?.filter(keepFile) }];
        if (part.type === 'image_file' && !keepFile(part.image_file)) return [];
        return [part];
      }),
    };
  });
}

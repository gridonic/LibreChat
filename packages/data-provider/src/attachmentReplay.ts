import type { TMessageContentParts } from './types/content';
import type { TMessage, TAttachment } from './schemas';
import type { TFile } from './types/files';

export const ATTACHMENT_TEXT_LIMIT_CODE = 'AGENT_ATTACHMENT_TEXT_LIMIT_EXCEEDED';
const ATTACHMENT_LIMIT_CODE = 'AGENT_ATTACHMENT_LIMIT_EXCEEDED';
const LEGACY_LIMIT =
  /^This turn exceeds the configured (?:attachment count|total attachment size|extracted document text) limit \(\d+ > \d+\)\. Remove some attachments or use smaller files and try again\.$/;

export type AttachmentReplayState = { excluded: boolean; rejectionMessageId?: string };
export type AttachmentReplayStates = Record<string, Record<string, AttachmentReplayState>>;

function parseRejection(text?: string): { rejectedFileIds?: string[] } | undefined {
  if (!text) return undefined;
  if (LEGACY_LIMIT.test(text)) return {};
  try {
    const error: { code?: string; rejectedFileIds?: unknown } = JSON.parse(text);
    if (error?.code !== ATTACHMENT_LIMIT_CODE) return undefined;
    return {
      ...(Array.isArray(error.rejectedFileIds) &&
      error.rejectedFileIds.every((id) => typeof id === 'string')
        ? { rejectedFileIds: error.rejectedFileIds }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Select the visible/requested branch before calculating rejection state. */
export function selectAttachmentReplayBranch<
  T extends { messageId?: string; parentMessageId?: string | null },
>(messages: readonly T[], headMessageId: string | null | undefined): T[] {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const branch: T[] = [];
  const visited = new Set<string>();
  let id = headMessageId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const message = byId.get(id);
    if (!message) break;
    branch.push(message);
    id = message.parentMessageId;
  }
  return branch.reverse();
}

/** A retry opts in after one specific rejection, never after all future rejections. */
export function getAttachmentReplayStates(
  messages: readonly Partial<TMessage>[],
): AttachmentReplayStates {
  const states: AttachmentReplayStates = {};
  const refs = new Map<string, Array<{ messageId: string; file: Partial<TFile> }>>();
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  for (const message of messages) {
    if (message.messageId && message.files) {
      states[message.messageId] = {};
      for (const file of message.files) {
        if (!file?.file_id) continue;
        states[message.messageId][file.file_id] = { excluded: file.excludedFromContext === true };
        const entries = refs.get(file.file_id) ?? [];
        entries.push({ messageId: message.messageId, file });
        refs.set(file.file_id, entries);
      }
    }
    if (message.isCreatedByUser !== false || !message.parentMessageId || !message.messageId)
      continue;
    const errors = [
      ...(message.error === true ? [message.text] : []),
      ...(message.content ?? []).flatMap((part) => (part?.type === 'error' ? [part.error] : [])),
    ];
    for (const error of errors) {
      const rejection = parseRejection(error);
      if (!rejection) continue;
      const fileIds =
        rejection.rejectedFileIds ??
        byId
          .get(message.parentMessageId)
          ?.files?.flatMap((file) => (file?.file_id ? [file.file_id] : [])) ??
        [];
      for (const fileId of fileIds) {
        for (const ref of refs.get(fileId) ?? []) {
          states[ref.messageId][fileId] = {
            excluded:
              ref.file.excludedFromContext === true ||
              ref.file.replayAfterMessageId !== message.messageId,
            rejectionMessageId: message.messageId,
          };
        }
      }
    }
  }
  return states;
}

/** Model-only projection. Never overwrite stored messages or delete uploaded files. */
export function prepareAttachmentReplayHistory<T extends Partial<TMessage>>(messages: T[]): T[] {
  const states = getAttachmentReplayStates(messages);
  return messages.map((message) => {
    const fileStates = states[message.messageId ?? ''];
    if (!fileStates || !Object.values(fileStates).some((state) => state.excluded)) return message;
    const keepFile = (file: { file_id?: string } | TAttachment) =>
      !(
        'file_id' in file &&
        typeof file.file_id === 'string' &&
        fileStates[file.file_id]?.excluded
      );
    return {
      ...message,
      files: message.files?.filter(keepFile),
      attachments: message.attachments?.filter(keepFile),
      fileContext: undefined,
      content: message.content?.flatMap<TMessageContentParts>((part) => {
        if (!part) return [];
        if (part.type === 'steer') return [{ ...part, files: part.files?.filter(keepFile) }];
        if (part.type === 'image_file' && !keepFile(part.image_file)) return [];
        return [part];
      }),
    };
  });
}

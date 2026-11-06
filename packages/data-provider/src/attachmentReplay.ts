import type { TMessageContentParts } from './types/content';
import type { TMessage, TAttachment } from './schemas';
import type { TFile } from './types/files';

export const ATTACHMENT_TEXT_LIMIT_CODE = 'AGENT_ATTACHMENT_TEXT_LIMIT_EXCEEDED';
const ATTACHMENT_LIMIT_CODE = 'AGENT_ATTACHMENT_LIMIT_EXCEEDED';
const LEGACY_LIMIT =
  /^This turn exceeds the configured (?:attachment count|total attachment size|extracted document text) limit \(\d+ > \d+\)\. Remove some attachments or use smaller files and try again\.$/;

export type AttachmentReplayDecision = NonNullable<TMessage['attachmentReplay']>[number];
export type AttachmentReplayMessage = Pick<
  Partial<TMessage>,
  | 'messageId'
  | 'parentMessageId'
  | 'files'
  | 'content'
  | 'isCreatedByUser'
  | 'error'
  | 'text'
  | 'attachmentReplay'
>;
export type AttachmentReplayState = {
  excluded: boolean;
  reason?: 'manual' | 'rejected';
  rejectionMessageId?: string;
};

/** Replay policy belongs to the message, independently of canonical file display metadata. */
export function getMessageAttachmentRefs(
  message: Pick<Partial<TMessage>, 'files' | 'content'>,
): Partial<TFile>[] {
  return [
    ...(message.files ?? []),
    ...(message.content ?? []).flatMap((part) =>
      part?.type === 'steer' ? (part.files ?? []) : [],
    ),
  ];
}

/** Browser retries identify the existing user turn and the response branch being retried. */
export function getAttachmentReplayRequest(body?: {
  overrideParentMessageId?: unknown;
  responseMessageId?: unknown;
}) {
  if (typeof body?.overrideParentMessageId !== 'string' || !body.overrideParentMessageId)
    return undefined;
  return {
    messageId: body.overrideParentMessageId,
    headMessageId:
      typeof body.responseMessageId === 'string'
        ? body.responseMessageId.replace(/_+$/, '')
        : body.overrideParentMessageId,
  };
}

export function getReusedAttachmentReplayStates(
  messages: AttachmentReplayMessage[],
  request: { messageId: string; headMessageId: string },
) {
  const selected = selectAttachmentReplayBranch(messages, request.headMessageId);
  const branch = selected.some((message) => message.messageId === request.messageId)
    ? selected
    : selectAttachmentReplayBranch(messages, request.messageId);
  return getAttachmentReplayStates(branch)[request.messageId] ?? {};
}
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

const branchStates = new WeakMap<
  readonly AttachmentReplayMessage[],
  {
    head: string | null | undefined;
    policies: Readonly<Record<string, AttachmentReplayDecision[]>> | undefined;
    states: AttachmentReplayStates;
  }
>();

/** Message/cache arrays are immutable. All file rows share one projection per branch and policy revision. */
export function getBranchAttachmentReplayStates(
  messages: readonly AttachmentReplayMessage[],
  head: string | null | undefined,
  policies?: Readonly<Record<string, AttachmentReplayDecision[]>>,
): AttachmentReplayStates {
  const cached = branchStates.get(messages);
  if (cached && cached.head === head && cached.policies === policies) return cached.states;
  const states = getAttachmentReplayStates(selectAttachmentReplayBranch(messages, head), policies);
  branchStates.set(messages, { head, policies, states });
  return states;
}

/** A retry opts in after one specific rejection, never after all future rejections. */
export function getAttachmentReplayStates(
  messages: readonly AttachmentReplayMessage[],
  policies?: Readonly<Record<string, AttachmentReplayDecision[]>>,
): AttachmentReplayStates {
  const states: AttachmentReplayStates = {};
  const refs = new Map<string, Array<{ messageId: string; file: Partial<TFile> }>>();
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  for (const message of messages) {
    const messageRefs = getMessageAttachmentRefs(message);
    const decisions = new Map(
      (policies?.[message.messageId ?? ''] ?? message.attachmentReplay)?.map((decision) => [
        decision.fileId,
        decision,
      ]),
    );
    if (message.messageId && messageRefs.length > 0) {
      states[message.messageId] = {};
      for (const file of messageRefs) {
        if (!file?.file_id) continue;
        const decision = decisions.get(file.file_id);
        const excluded = decision?.excluded ?? file.excludedFromContext === true;
        states[message.messageId][file.file_id] = {
          excluded,
          ...(excluded ? { reason: 'manual' as const } : {}),
        };
        const entries = refs.get(file.file_id) ?? [];
        entries.push({
          messageId: message.messageId,
          file: {
            ...file,
            ...(decision
              ? {
                  excludedFromContext: decision.excluded,
                  replayAfterMessageId: decision.replayAfterMessageId,
                }
              : {}),
          },
        });
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
      const parentFileIds = getMessageAttachmentRefs(
        byId.get(message.parentMessageId) ?? {},
      ).flatMap((file) => (file?.file_id ? [file.file_id] : []));
      // Legacy rows lack an attempted-file snapshot. A text-only failure can still reject history.
      const fileIds =
        rejection.rejectedFileIds ??
        (parentFileIds.length > 0 ? parentFileIds : Array.from(refs.keys()));
      for (const fileId of fileIds) {
        for (const ref of refs.get(fileId) ?? []) {
          states[ref.messageId][fileId] = {
            excluded:
              ref.file.excludedFromContext === true ||
              ref.file.replayAfterMessageId !== message.messageId,
            reason: ref.file.excludedFromContext === true ? 'manual' : 'rejected',
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
        if (part.type === 'steer')
          return [{ ...part, files: part.files?.filter(keepFile), media: undefined }];
        if (part.type === 'image_file' && !keepFile(part.image_file)) return [];
        return [part];
      }),
    };
  });
}

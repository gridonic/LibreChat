import { Constants } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { DisconnectedRunRecovery } from './resumableRecovery';
import { hasStreamStartFailed } from '~/utils/messages';

export type RunRecoveryTarget = {
  userMessageId?: string;
  responseMessageId?: string;
};

export type PersistedRunState = {
  outcome?: 'completed' | 'error' | 'aborted';
  responseFound: boolean;
  userMessageFound: boolean;
};

export const newConversationPath = `/c/${Constants.NEW_CONVO}`;

export function recoveryOwnsCurrentRoute(routerPathname: string, conversationId: string): boolean {
  const recoveryPath = `/c/${conversationId}`;
  if (routerPathname === recoveryPath) {
    return true;
  }

  return (
    routerPathname === newConversationPath &&
    typeof window !== 'undefined' &&
    window.location.pathname === recoveryPath
  );
}

export function withCurrentSearch(pathname: string): string {
  return typeof window === 'undefined' ? pathname : `${pathname}${window.location.search}`;
}

export function submissionBelongsToConversation(
  submission: TSubmission | null,
  conversationId: string,
): boolean {
  return (
    submission?.conversation?.conversationId === conversationId ||
    submission?.userMessage?.conversationId === conversationId ||
    submission?.initialResponse?.conversationId === conversationId
  );
}

export function getUnreconciledAssistantTail(
  messages: TMessage[] | undefined,
): TMessage | undefined {
  const lastMessage = messages?.[messages.length - 1];
  if (!lastMessage || lastMessage.isCreatedByUser === true || hasStreamStartFailed(lastMessage)) {
    return undefined;
  }

  const messageId = lastMessage.messageId ?? '';
  const isUnreconciled =
    lastMessage.createdAt == null || lastMessage.updatedAt == null || messageId.endsWith('_');

  return isUnreconciled ? lastMessage : undefined;
}

export function getRunRecoveryTarget(
  disconnectedRun: DisconnectedRunRecovery | undefined,
  messages: TMessage[] | undefined,
): RunRecoveryTarget | undefined {
  const unreconciledResponse = getUnreconciledAssistantTail(messages);
  const userMessageId =
    disconnectedRun?.userMessageId ?? unreconciledResponse?.parentMessageId ?? undefined;
  const responseMessageId =
    disconnectedRun?.responseMessageId ?? unreconciledResponse?.messageId ?? undefined;

  if (!userMessageId && !responseMessageId) {
    return undefined;
  }

  return { userMessageId, responseMessageId };
}

function findRunResponse(messages: TMessage[], target: RunRecoveryTarget): TMessage | undefined {
  const responseMessageId = target.responseMessageId;
  const unpaddedResponseMessageId = responseMessageId?.replace(/_+$/, '');
  const canUseParentFallback = !responseMessageId || responseMessageId.endsWith('_');

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.isCreatedByUser === true) {
      continue;
    }
    if (
      responseMessageId &&
      (message.messageId === responseMessageId ||
        (!!unpaddedResponseMessageId && message.messageId === unpaddedResponseMessageId))
    ) {
      return message;
    }
    if (canUseParentFallback && target.userMessageId === message.parentMessageId) {
      return message;
    }
  }

  return undefined;
}

export function getPersistedRunState(
  messages: TMessage[] | undefined,
  target: RunRecoveryTarget | undefined,
): PersistedRunState {
  if (!messages?.length || !target) {
    return { responseFound: false, userMessageFound: false };
  }

  const userMessageFound = target.userMessageId
    ? messages.some(
        (message) => message.isCreatedByUser === true && message.messageId === target.userMessageId,
      )
    : false;
  const response = findRunResponse(messages, target);
  const isPersisted =
    response != null &&
    response.createdAt != null &&
    response.updatedAt != null &&
    !(response.messageId ?? '').endsWith('_');
  let outcome: PersistedRunState['outcome'];
  if (isPersisted) {
    if (response.error === true) {
      outcome = 'error';
    } else if (response.unfinished === true) {
      outcome = 'aborted';
    } else {
      outcome = 'completed';
    }
  }

  return {
    outcome,
    responseFound: response != null,
    userMessageFound,
  };
}

export function mergePersistedRunIntoMessages(
  currentMessages: TMessage[] | undefined,
  persistedMessages: TMessage[],
  target: RunRecoveryTarget,
): TMessage[] {
  const persistedResponse = findRunResponse(persistedMessages, target);
  const persistedState = getPersistedRunState(persistedMessages, target);
  if (!persistedResponse || !persistedState.outcome) {
    return currentMessages ?? [];
  }

  const mergedMessages = [...(currentMessages ?? [])];
  const persistedUser = target.userMessageId
    ? persistedMessages.find(
        (message) => message.isCreatedByUser === true && message.messageId === target.userMessageId,
      )
    : undefined;
  let userMessageIndex = target.userMessageId
    ? mergedMessages.findIndex(
        (message) => message.isCreatedByUser === true && message.messageId === target.userMessageId,
      )
    : -1;

  if (persistedUser) {
    if (userMessageIndex >= 0) {
      mergedMessages[userMessageIndex] = persistedUser;
    } else {
      mergedMessages.push(persistedUser);
      userMessageIndex = mergedMessages.length - 1;
    }
  }

  const responseMessage = findRunResponse(mergedMessages, target);
  const responseMessageIndex = responseMessage ? mergedMessages.indexOf(responseMessage) : -1;
  if (responseMessageIndex >= 0) {
    mergedMessages[responseMessageIndex] = persistedResponse;
  } else {
    mergedMessages.splice(
      userMessageIndex >= 0 ? userMessageIndex + 1 : mergedMessages.length,
      0,
      persistedResponse,
    );
  }

  return mergedMessages;
}

export function preserveMessagesAfterRecoveryTarget(
  refreshedMessages: TMessage[],
  messagesBeforeRefresh: TMessage[] | undefined,
  target: RunRecoveryTarget | undefined,
): TMessage[] {
  if (!messagesBeforeRefresh?.length || !target) {
    return refreshedMessages;
  }

  const responseMessageId = target.responseMessageId;
  const unpaddedResponseMessageId = responseMessageId?.replace(/_+$/, '');
  let responseIndex = -1;

  if (responseMessageId) {
    responseIndex = messagesBeforeRefresh.findIndex(
      (message) =>
        message.isCreatedByUser !== true &&
        (message.messageId === responseMessageId ||
          (!!unpaddedResponseMessageId && message.messageId === unpaddedResponseMessageId)),
    );
  }

  if (responseIndex === -1 && target.userMessageId) {
    for (let index = messagesBeforeRefresh.length - 1; index >= 0; index--) {
      const message = messagesBeforeRefresh[index];
      if (message.isCreatedByUser !== true && message.parentMessageId === target.userMessageId) {
        responseIndex = index;
        break;
      }
    }
  }
  if (responseIndex === -1 || responseIndex === messagesBeforeRefresh.length - 1) {
    return refreshedMessages;
  }

  const refreshedIds = new Set(refreshedMessages.map((message) => message.messageId));
  const localSuffix = messagesBeforeRefresh
    .slice(responseIndex + 1)
    .filter((message) => !message.messageId || !refreshedIds.has(message.messageId));
  return localSuffix.length > 0 ? [...refreshedMessages, ...localSuffix] : refreshedMessages;
}

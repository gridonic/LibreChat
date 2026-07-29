import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { PendingRunReconciliation } from '../resumableRecovery';
import type { RunRecoveryTarget } from '../terminal';
import type { TerminalRetryStatus } from './retry';
import {
  getPersistedRunState,
  mergePersistedRunIntoMessages,
  preserveMessagesAfterRecoveryTarget,
} from '../terminal';
import { runTerminalRetry } from './retry';
import { isNotFoundError } from '~/utils';

export type PersistedResponseRefresh = {
  messages: TMessage[] | undefined;
  succeeded: boolean;
  notFound: boolean;
  retryStatus: TerminalRetryStatus;
};

type RefreshPersistedResponseParams = {
  conversationId: string;
  getMessages: () => TMessage[] | undefined;
  recoveryTarget?: RunRecoveryTarget;
  acceptMissingResponse?: boolean;
  signal: AbortSignal;
  canContinue?: () => boolean;
};

type RefreshAttempt = {
  messages: TMessage[];
  notFound: boolean;
};

type PendingRefreshAttempt = RefreshAttempt & {
  reconciledTaskIds: string[];
};

export type PendingPersistedResponseRefresh = PersistedResponseRefresh & {
  reconciledTaskIds: string[];
};

export async function refreshPersistedResponse({
  conversationId,
  getMessages,
  recoveryTarget,
  acceptMissingResponse = false,
  signal,
  canContinue,
}: RefreshPersistedResponseParams): Promise<PersistedResponseRefresh> {
  const result = await runTerminalRetry<RefreshAttempt>({
    signal,
    canContinue,
    operation: async (attemptSignal) => {
      const messagesBeforeRefresh = getMessages();
      try {
        const persistedMessages = await dataService.getMessagesByConvoId(
          conversationId,
          attemptSignal,
        );
        return {
          messages: preserveMessagesAfterRecoveryTarget(
            persistedMessages,
            messagesBeforeRefresh,
            recoveryTarget,
          ),
          notFound: false,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return { messages: getMessages() ?? [], notFound: true };
        }
        throw error;
      }
    },
    isSuccess: ({ messages, notFound }) => {
      if (notFound) {
        return true;
      }
      if (!recoveryTarget) {
        return true;
      }
      const state = getPersistedRunState(messages, recoveryTarget);
      return (
        state.outcome != null ||
        (acceptMissingResponse && state.userMessageFound && !state.responseFound)
      );
    },
  });

  return {
    messages: result.value?.messages,
    succeeded: result.status === 'succeeded',
    notFound: result.value?.notFound === true,
    retryStatus: result.status,
  };
}

type RefreshPendingPersistedResponsesParams = {
  conversationId: string;
  getMessages: () => TMessage[] | undefined;
  queryClient: QueryClient;
  tasks: PendingRunReconciliation[];
  signal: AbortSignal;
  canContinue?: () => boolean;
};

export async function refreshPendingPersistedResponses({
  conversationId,
  getMessages,
  queryClient,
  tasks,
  signal,
  canContinue,
}: RefreshPendingPersistedResponsesParams): Promise<PendingPersistedResponseRefresh> {
  const result = await runTerminalRetry<PendingRefreshAttempt>({
    signal,
    canContinue,
    operation: async (attemptSignal) => {
      try {
        const persistedMessages = await dataService.getMessagesByConvoId(
          conversationId,
          attemptSignal,
        );
        let mergedMessages = getMessages() ?? [];
        const reconciledTaskIds: string[] = [];

        for (const task of tasks) {
          const target = {
            userMessageId: task.userMessageId,
            responseMessageId: task.responseMessageId,
          };
          if (getPersistedRunState(persistedMessages, target).outcome == null) {
            continue;
          }
          mergedMessages = mergePersistedRunIntoMessages(mergedMessages, persistedMessages, target);
          reconciledTaskIds.push(task.taskId);
        }

        return { messages: mergedMessages, notFound: false, reconciledTaskIds };
      } catch (error) {
        if (isNotFoundError(error)) {
          return {
            messages: getMessages() ?? [],
            notFound: true,
            reconciledTaskIds: [],
          };
        }
        throw error;
      }
    },
    isSuccess: (attempt) => attempt.notFound || attempt.reconciledTaskIds.length > 0,
  });
  const value = result.value;
  if (
    result.status === 'succeeded' &&
    value &&
    !value.notFound &&
    !signal.aborted &&
    (canContinue?.() ?? true)
  ) {
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, conversationId], value.messages);
  }

  return {
    messages: result.status === 'succeeded' ? (value?.messages ?? getMessages()) : getMessages(),
    succeeded: result.status === 'succeeded' && value?.notFound !== true,
    notFound: value?.notFound === true,
    reconciledTaskIds: value?.reconciledTaskIds ?? [],
    retryStatus: result.status,
  };
}

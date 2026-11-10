import { useLayoutEffect, useRef, useCallback, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  dataService,
  getAttachmentReplayStates,
  getBranchAttachmentReplayStates,
} from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult, QueryClient } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import { MessagesViewContext } from '~/Providers/MessagesViewContext';
import { isNotFoundError, logger } from '~/utils';

type StableMessagesParams = {
  pathname: string;
  result: t.TMessage[];
  isStreaming?: boolean;
  currentMessages?: t.TMessage[];
};

type ActiveJobs = {
  activeJobIds?: string[];
};

function isUnhydratedMessage(message: t.TMessage) {
  const messageId = message.messageId ?? '';
  return message.createdAt == null || message.updatedAt == null || messageId.endsWith('_');
}

function hasPendingAssistantTail(messages: t.TMessage[]) {
  const lastMessage = messages[messages.length - 1];
  const parentMessageId = lastMessage?.parentMessageId ?? '';
  return (
    lastMessage?.isCreatedByUser !== true &&
    parentMessageId !== '' &&
    parentMessageId !== Constants.NO_PARENT &&
    isUnhydratedMessage(lastMessage)
  );
}

function isMessagePrefix(result: t.TMessage[], currentMessages: t.TMessage[]) {
  return result.every((message, index) => message.messageId === currentMessages[index]?.messageId);
}

export function getStableMessages({
  pathname,
  result,
  isStreaming = false,
  currentMessages,
}: StableMessagesParams): t.TMessage[] {
  if (pathname.includes('/c/new') || !currentMessages?.length) {
    return result;
  }

  if (result.length >= currentMessages.length) {
    return result;
  }

  if (
    isStreaming &&
    hasPendingAssistantTail(currentMessages) &&
    isMessagePrefix(result, currentMessages)
  ) {
    return currentMessages;
  }

  return result;
}

export function shouldPreserveMessagesOnNotFound({
  pathname,
  isStreaming = false,
  currentMessages,
}: Pick<StableMessagesParams, 'pathname' | 'isStreaming' | 'currentMessages'>): boolean {
  if (!isStreaming || pathname.includes('/c/new') || !currentMessages?.length) {
    return false;
  }

  return hasPendingAssistantTail(currentMessages);
}

function hasActiveJob(queryClient: QueryClient, id: string) {
  if (!id) {
    return false;
  }
  const activeJobs = queryClient.getQueryData<ActiveJobs>([QueryKeys.activeJobs]);
  return activeJobs?.activeJobIds?.includes(id) === true;
}

export const useGetMessagesByConvoId = <TData = t.TMessage[]>(
  id: string,
  config?: UseQueryOptions<t.TMessage[], unknown, TData>,
  options?: { isStreaming?: boolean },
): QueryObserverResult<TData> => {
  const location = useLocation();
  const queryClient = useQueryClient();
  const isStreaming = options?.isStreaming === true;
  const isStreamingRef = useRef(isStreaming);

  useLayoutEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  return useQuery<t.TMessage[], unknown, TData>(
    [QueryKeys.messages, id],
    async () => {
      const queryKey = [QueryKeys.messages, id];
      const messagesAtRequestStart = queryClient.getQueryData<t.TMessage[]>(queryKey);

      if (id === Constants.NEW_CONVO) {
        return messagesAtRequestStart ?? [];
      }

      let result: t.TMessage[];
      try {
        result = await dataService.getMessagesByConvoId(id);
      } catch (error) {
        const currentMessages = queryClient.getQueryData<t.TMessage[]>(queryKey);
        if (
          messagesAtRequestStart != null &&
          currentMessages != null &&
          currentMessages !== messagesAtRequestStart
        ) {
          return currentMessages;
        }

        const hasLiveStream = isStreamingRef.current || hasActiveJob(queryClient, id);
        if (
          currentMessages &&
          isNotFoundError(error) &&
          shouldPreserveMessagesOnNotFound({
            pathname: location.pathname,
            currentMessages,
            isStreaming: hasLiveStream,
          })
        ) {
          logger.warn(
            'messages',
            `Messages query for convo ${id} returned 404 while cache has a pending assistant tail; path: "${location.pathname}"`,
            currentMessages,
          );
          return currentMessages;
        }

        throw error;
      }

      const currentMessages = queryClient.getQueryData<t.TMessage[]>(queryKey);
      if (
        messagesAtRequestStart != null &&
        currentMessages != null &&
        currentMessages !== messagesAtRequestStart
      ) {
        return currentMessages;
      }

      const stableMessages = getStableMessages({
        pathname: location.pathname,
        result,
        currentMessages,
        isStreaming: isStreamingRef.current || hasActiveJob(queryClient, id),
      });

      if (stableMessages === currentMessages) {
        logger.warn(
          'messages',
          `Messages query for convo ${id} returned fewer than cache; path: "${location.pathname}"`,
          result,
          currentMessages,
        );
      }

      if (stableMessages !== currentMessages) {
        queryClient.setQueryData(
          [QueryKeys.attachmentReplay, id],
          Object.fromEntries(
            result.flatMap((message) =>
              message.attachmentReplay ? [[message.messageId, message.attachmentReplay]] : [],
            ),
          ),
        );
      }
      return stableMessages;
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

export function useMessageAttachmentReplay(message?: t.TMessage) {
  const view = useContext(MessagesViewContext);
  const policies = useQuery<Record<string, t.AttachmentReplayDecision[]>>(
    [QueryKeys.attachmentReplay, message?.conversationId ?? ''],
    { enabled: false },
  ).data;
  const head = view?.latestMessageId ?? message?.messageId;
  const hasFiles = !!message?.files?.length;
  const select = useCallback(
    (messages: t.TMessage[]) =>
      !hasFiles
        ? {}
        : (getBranchAttachmentReplayStates(messages, head, policies)[message?.messageId ?? ''] ??
          {}),
    [head, message?.messageId, hasFiles, policies],
  );
  return (
    useQuery<t.TMessage[], unknown, Record<string, t.AttachmentReplayState>>(
      [QueryKeys.messages, message?.conversationId ?? ''],
      {
        enabled: false,
        select,
      },
    ).data ??
    (message ? getAttachmentReplayStates([message], policies)[message.messageId] : undefined)
  );
}

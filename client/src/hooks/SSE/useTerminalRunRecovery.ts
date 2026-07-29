import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, type TConversation, type TMessage } from 'librechat-data-provider';
import type { ActiveJobsResponse, StreamStatusResponse } from '~/data-provider';
import {
  clearDisconnectedRunRecovery,
  consumeTerminalEventSeen,
  disconnectedRunRecoveryQueryKey,
  getDisconnectedRunRecovery,
  getResumableRunEpoch,
  isResumableRunInProgress,
  resumableRunStartingQueryKey,
  setDisconnectedRunRecovery,
  terminalRecoveryRequestQueryKey,
  type DisconnectedRunRecovery,
} from './resumableRecovery';
import {
  getRunRecoveryTarget,
  getUnreconciledAssistantTail,
  newConversationPath,
  recoveryOwnsCurrentRoute,
  submissionBelongsToConversation,
  withCurrentSearch,
} from './terminal';
import { addConversationToAllConversationsQueries, removeConvoFromAllQueries } from '~/utils';
import { fetchStreamStatus, streamStatusQueryKey, useActiveJobs } from '~/data-provider';
import { usePendingRunReconciliation, useRecoveryWakeup } from './recovery/usePending';
import { refreshPersistedResponse } from './recovery/messages';
import { runTerminalRetry } from './recovery/retry';
import store from '~/store';

type TerminalRunRecoveryParams = {
  conversationId?: string;
  runIndex?: number;
  enabled?: boolean;
  messagesNotFound?: boolean;
};

export default function useTerminalRunRecovery({
  conversationId,
  runIndex = 0,
  enabled = true,
  messagesNotFound = false,
}: TerminalRunRecoveryParams) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [, setConversation] = useRecoilState(store.conversationByIndex(runIndex));
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const activePathnameRef = useRef(location.pathname);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const statusAbortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  activePathnameRef.current = location.pathname;

  const { data: activeJobs } = useActiveJobs(enabled);
  const isActive = useMemo(
    () => !!conversationId && (activeJobs?.activeJobIds ?? []).includes(conversationId),
    [activeJobs?.activeJobIds, conversationId],
  );

  const { data: disconnectedRun } = useQuery<DisconnectedRunRecovery | null>({
    queryKey: disconnectedRunRecoveryQueryKey(conversationId ?? ''),
    queryFn: async () => null,
    enabled: false,
    cacheTime: Infinity,
  });
  const { data: terminalRecoveryRequest = 0 } = useQuery<number>({
    queryKey: terminalRecoveryRequestQueryKey(conversationId ?? ''),
    queryFn: async () => 0,
    enabled: false,
    cacheTime: Infinity,
  });
  const { data: isRunStarting = false } = useQuery<boolean>({
    queryKey: resumableRunStartingQueryKey(conversationId ?? ''),
    queryFn: async () => false,
    enabled: false,
    cacheTime: Infinity,
  });

  const getMessages = useCallback(
    () =>
      conversationId
        ? queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId])
        : undefined,
    [conversationId, queryClient],
  );
  const hasUnreconciledResponse = getUnreconciledAssistantTail(getMessages()) != null;
  const hasCurrentRecovery = disconnectedRun != null || messagesNotFound || hasUnreconciledResponse;

  usePendingRunReconciliation({
    conversationId,
    enabled,
    isCurrentJobActive: isActive,
    hasCurrentRecovery,
    isRunStarting,
    terminalRecoveryRequest,
    getMessages,
  });
  useRecoveryWakeup({ conversationId, enabled });

  const ensureRecovery = useCallback((): DisconnectedRunRecovery | undefined => {
    if (!conversationId) {
      return undefined;
    }
    const existing = getDisconnectedRunRecovery(queryClient, conversationId);
    if (existing) {
      return existing;
    }
    const unreconciledResponse = getUnreconciledAssistantTail(getMessages());
    if (!unreconciledResponse && !messagesNotFound) {
      return undefined;
    }
    const recovery = {
      startedAsNewConvo: false,
      created: unreconciledResponse != null,
      userMessageId: unreconciledResponse?.parentMessageId ?? undefined,
      responseMessageId: unreconciledResponse?.messageId ?? undefined,
      routeMessagesNotFound: messagesNotFound || undefined,
    };
    setDisconnectedRunRecovery(queryClient, conversationId, recovery);
    return recovery;
  }, [conversationId, getMessages, messagesNotFound, queryClient]);

  const removeMissingOptimisticConversation = useCallback(
    (terminalConversationId: string, startedAsNewConvo: boolean) => {
      removeConvoFromAllQueries(queryClient, terminalConversationId);
      queryClient.removeQueries({
        queryKey: [QueryKeys.conversation, terminalConversationId],
      });
      queryClient.removeQueries({
        queryKey: [QueryKeys.messages, terminalConversationId],
      });
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);

      if (recoveryOwnsCurrentRoute(activePathnameRef.current, terminalConversationId)) {
        setConversation((current) =>
          current?.conversationId === terminalConversationId
            ? {
                ...current,
                conversationId: String(Constants.NEW_CONVO),
                title: 'New Chat',
                createdAt: '',
                updatedAt: '',
              }
            : current,
        );
        setSubmission((current) =>
          submissionBelongsToConversation(current, terminalConversationId) ||
          (startedAsNewConvo &&
            (!current?.conversation?.conversationId ||
              current.conversation.conversationId === Constants.NEW_CONVO ||
              current.conversation.conversationId === Constants.PENDING_CONVO))
            ? null
            : current,
        );
        navigate(withCurrentSearch(newConversationPath), { replace: true });
      }
      clearDisconnectedRunRecovery(queryClient, terminalConversationId);
    },
    [navigate, queryClient, setConversation, setSubmission],
  );

  const recoverInactiveResponse = useCallback(
    async (status: StreamStatusResponse, expectedEpoch?: number) => {
      if (
        !conversationId ||
        status.active ||
        inFlightRef.current ||
        isResumableRunInProgress(queryClient, conversationId)
      ) {
        return;
      }
      const recoveryEpoch = expectedEpoch ?? getResumableRunEpoch(queryClient, conversationId);
      if (getResumableRunEpoch(queryClient, conversationId) !== recoveryEpoch) {
        return;
      }
      if (consumeTerminalEventSeen(queryClient, conversationId)) {
        return;
      }

      const recovery = ensureRecovery();
      if (!recovery) {
        return;
      }
      const target = getRunRecoveryTarget(recovery, getMessages());
      recoveryAbortRef.current?.abort();
      const controller = new AbortController();
      recoveryAbortRef.current = controller;
      inFlightRef.current = true;

      try {
        const refreshed = await refreshPersistedResponse({
          conversationId,
          getMessages,
          recoveryTarget: target,
          acceptMissingResponse: status.status === 'error' || status.status === 'aborted',
          signal: controller.signal,
          canContinue: () =>
            mountedRef.current &&
            !activeRef.current &&
            !isResumableRunInProgress(queryClient, conversationId) &&
            getResumableRunEpoch(queryClient, conversationId) === recoveryEpoch,
        });
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          activeRef.current ||
          isResumableRunInProgress(queryClient, conversationId) ||
          getResumableRunEpoch(queryClient, conversationId) !== recoveryEpoch
        ) {
          return;
        }

        if (
          refreshed.notFound &&
          (recovery.startedAsNewConvo || recovery.routeMessagesNotFound === true)
        ) {
          removeMissingOptimisticConversation(conversationId, recovery.startedAsNewConvo);
          return;
        }
        if (refreshed.notFound) {
          return;
        }
        if (!refreshed.succeeded || !refreshed.messages) {
          return;
        }

        queryClient.setQueryData<TMessage[]>(
          [QueryKeys.messages, conversationId],
          refreshed.messages,
        );
        const ownsRoute = recoveryOwnsCurrentRoute(activePathnameRef.current, conversationId);
        if (recovery.startedAsNewConvo && ownsRoute) {
          queryClient.setQueryData<TMessage[]>(
            [QueryKeys.messages, Constants.NEW_CONVO],
            refreshed.messages,
          );
          const recoveredConversation = queryClient.getQueryData<TConversation>([
            QueryKeys.conversation,
            conversationId,
          ]);
          if (recoveredConversation) {
            addConversationToAllConversationsQueries(queryClient, recoveredConversation);
          }
          setConversation(
            (current) =>
              ({
                ...current,
                ...recoveredConversation,
                conversationId,
              }) as TConversation,
          );
          navigate(withCurrentSearch(`/c/${conversationId}`), { replace: true });
        }
        setSubmission((current) =>
          submissionBelongsToConversation(current, conversationId) ||
          (recovery.startedAsNewConvo &&
            ownsRoute &&
            (!current?.conversation?.conversationId ||
              current.conversation.conversationId === Constants.NEW_CONVO ||
              current.conversation.conversationId === Constants.PENDING_CONVO))
            ? null
            : current,
        );
        clearDisconnectedRunRecovery(queryClient, conversationId);
        queryClient.removeQueries({ queryKey: streamStatusQueryKey(conversationId) });
      } finally {
        if (recoveryAbortRef.current === controller) {
          recoveryAbortRef.current = null;
          inFlightRef.current = false;
        }
      }
    },
    [
      conversationId,
      ensureRecovery,
      getMessages,
      navigate,
      queryClient,
      removeMissingOptimisticConversation,
      setConversation,
      setSubmission,
    ],
  );

  const checkTerminalStatus = useCallback(async () => {
    if (
      !conversationId ||
      isActive ||
      isRunStarting ||
      inFlightRef.current ||
      isResumableRunInProgress(queryClient, conversationId)
    ) {
      return;
    }
    const expectedEpoch = getResumableRunEpoch(queryClient, conversationId);
    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    const result = await runTerminalRetry({
      signal: controller.signal,
      operation: (attemptSignal) => fetchStreamStatus(conversationId, attemptSignal),
      isSuccess: () => true,
      canContinue: () =>
        mountedRef.current &&
        !activeRef.current &&
        !isResumableRunInProgress(queryClient, conversationId) &&
        getResumableRunEpoch(queryClient, conversationId) === expectedEpoch,
    });
    if (
      result.status !== 'succeeded' ||
      controller.signal.aborted ||
      !mountedRef.current ||
      activeRef.current ||
      isResumableRunInProgress(queryClient, conversationId) ||
      getResumableRunEpoch(queryClient, conversationId) !== expectedEpoch
    ) {
      return;
    }
    if (result.value.active) {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (current) => ({
        activeJobIds: [...new Set([...(current?.activeJobIds ?? []), conversationId])],
      }));
      return;
    }
    await recoverInactiveResponse(result.value, expectedEpoch);
  }, [conversationId, isActive, isRunStarting, queryClient, recoverInactiveResponse]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryAbortRef.current?.abort();
      statusAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    recoveryAbortRef.current?.abort();
    recoveryAbortRef.current = null;
    statusAbortRef.current?.abort();
    statusAbortRef.current = null;
    inFlightRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    activeRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!enabled || !conversationId || isActive || isRunStarting || !hasCurrentRecovery) {
      return;
    }
    void checkTerminalStatus();
  }, [
    checkTerminalStatus,
    conversationId,
    disconnectedRun,
    enabled,
    getMessages,
    hasCurrentRecovery,
    isActive,
    isRunStarting,
    messagesNotFound,
    terminalRecoveryRequest,
  ]);

  return { recoverInactiveResponse };
}

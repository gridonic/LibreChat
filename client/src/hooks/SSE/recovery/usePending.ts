import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import type { PendingRunReconciliation } from '../resumableRecovery';
import {
  getDisconnectedRunRecovery,
  getPendingRunReconciliations,
  getResumableRunStarting,
  pendingRunReconciliationsQueryKey,
  removePendingRunReconciliations,
  requestTerminalRunRecovery,
} from '../resumableRecovery';
import { refreshPendingPersistedResponses } from './messages';

type UsePendingRunReconciliationParams = {
  conversationId: string | undefined;
  enabled: boolean;
  isCurrentJobActive: boolean;
  hasCurrentRecovery: boolean;
  isRunStarting: boolean;
  terminalRecoveryRequest: number;
  getMessages: () => TMessage[] | undefined;
};

export function usePendingRunReconciliation({
  conversationId,
  enabled,
  isCurrentJobActive,
  hasCurrentRecovery,
  isRunStarting,
  terminalRecoveryRequest,
  getMessages,
}: UsePendingRunReconciliationParams) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const attemptedBatchRef = useRef<{
    conversationId: string | undefined;
    request: number;
    taskIds: Set<string>;
  }>({
    conversationId,
    request: terminalRecoveryRequest,
    taskIds: new Set(),
  });
  const { data: pendingRuns = [] } = useQuery<PendingRunReconciliation[]>({
    queryKey: pendingRunReconciliationsQueryKey(conversationId ?? ''),
    queryFn: async () => [],
    enabled: false,
    initialData: [],
    cacheTime: Infinity,
  });

  useEffect(() => {
    if (
      attemptedBatchRef.current.conversationId !== conversationId ||
      attemptedBatchRef.current.request !== terminalRecoveryRequest
    ) {
      attemptedBatchRef.current = {
        conversationId,
        request: terminalRecoveryRequest,
        taskIds: new Set(),
      };
    }
    const unattemptedRuns = pendingRuns.filter(
      (task) => !attemptedBatchRef.current.taskIds.has(task.taskId),
    );
    if (
      !enabled ||
      !conversationId ||
      isCurrentJobActive ||
      hasCurrentRecovery ||
      isRunStarting ||
      unattemptedRuns.length === 0 ||
      abortRef.current != null
    ) {
      return;
    }

    const attemptedBatch = attemptedBatchRef.current;
    for (const task of unattemptedRuns) {
      attemptedBatch.taskIds.add(task.taskId);
    }
    const controller = new AbortController();
    abortRef.current = controller;

    void refreshPendingPersistedResponses({
      conversationId,
      getMessages,
      queryClient,
      tasks: unattemptedRuns,
      signal: controller.signal,
      canContinue: () =>
        !isCurrentJobActive &&
        !hasCurrentRecovery &&
        !getDisconnectedRunRecovery(queryClient, conversationId) &&
        !getResumableRunStarting(queryClient, conversationId),
    })
      .then((refreshed) => {
        if (controller.signal.aborted || refreshed.retryStatus === 'aborted') {
          for (const task of unattemptedRuns) {
            attemptedBatch.taskIds.delete(task.taskId);
          }
          return;
        }
        if (refreshed.notFound || refreshed.retryStatus === 'failed') {
          removePendingRunReconciliations(
            queryClient,
            conversationId,
            unattemptedRuns.map((task) => task.taskId),
          );
          return;
        }
        if (refreshed.reconciledTaskIds.length > 0) {
          const reconciledTaskIds = new Set(refreshed.reconciledTaskIds);
          for (const task of unattemptedRuns) {
            if (!reconciledTaskIds.has(task.taskId)) {
              attemptedBatch.taskIds.delete(task.taskId);
            }
          }
          removePendingRunReconciliations(queryClient, conversationId, refreshed.reconciledTaskIds);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      });

    return () => {
      controller.abort();
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    };
  }, [
    conversationId,
    enabled,
    getMessages,
    hasCurrentRecovery,
    isCurrentJobActive,
    isRunStarting,
    pendingRuns,
    queryClient,
    terminalRecoveryRequest,
  ]);
}

export function useRecoveryWakeup({
  conversationId,
  enabled,
}: {
  conversationId: string | undefined;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !conversationId) {
      return;
    }
    const requestRecovery = () => {
      if (
        getDisconnectedRunRecovery(queryClient, conversationId) ||
        getPendingRunReconciliations(queryClient, conversationId).length > 0
      ) {
        requestTerminalRunRecovery(queryClient, conversationId);
      }
    };
    const requestVisibleRecovery = () => {
      if (document.visibilityState === 'visible') {
        requestRecovery();
      }
    };
    window.addEventListener('focus', requestRecovery);
    window.addEventListener('online', requestRecovery);
    document.addEventListener('visibilitychange', requestVisibleRecovery);
    return () => {
      window.removeEventListener('focus', requestRecovery);
      window.removeEventListener('online', requestRecovery);
      document.removeEventListener('visibilitychange', requestVisibleRecovery);
    };
  }, [conversationId, enabled, queryClient]);
}

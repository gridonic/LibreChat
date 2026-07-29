import { QueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import {
  beginResumableRun,
  consumeTerminalEventSeen,
  getDisconnectedRunRecovery,
  getPendingRunReconciliations,
  getResumableRunEpoch,
  isResumableRunInProgress,
  markTerminalEventSeen,
  moveDisconnectedRunToPendingReconciliation,
  queuePendingRunReconciliation,
  setDisconnectedRunRecovery,
} from '../resumableRecovery';

const CONVERSATION_ID = 'recovery-conversation';
const RECOVERY = {
  startedAsNewConvo: false,
  created: true,
  userMessageId: 'recovery-user',
  responseMessageId: 'recovery-response_',
};

describe('resumable recovery state', () => {
  it('keeps recovery metadata for the browser session', () => {
    const queryClient = new QueryClient();

    setDisconnectedRunRecovery(queryClient, CONVERSATION_ID, RECOVERY);

    expect(getDisconnectedRunRecovery(queryClient, CONVERSATION_ID)).toEqual(RECOVERY);
    expect(queryClient.getQueryDefaults(['resumable-disconnected-run'])?.cacheTime).toBe(Infinity);
  });

  it('increments an epoch so stale recovery work cannot overwrite a newer run', () => {
    const queryClient = new QueryClient();

    expect(beginResumableRun(queryClient, CONVERSATION_ID)).toBe(1);
    expect(beginResumableRun(queryClient, CONVERSATION_ID)).toBe(2);
    expect(getResumableRunEpoch(queryClient, CONVERSATION_ID)).toBe(2);
  });

  it('reads live starting and active-job state from the query cache', () => {
    const queryClient = new QueryClient();

    expect(isResumableRunInProgress(queryClient, CONVERSATION_ID)).toBe(false);

    queryClient.setQueryData(['resumable-run-starting', CONVERSATION_ID], true);
    expect(isResumableRunInProgress(queryClient, CONVERSATION_ID)).toBe(true);

    queryClient.setQueryData(['resumable-run-starting', CONVERSATION_ID], false);
    queryClient.setQueryData([QueryKeys.activeJobs], { activeJobIds: [CONVERSATION_ID] });
    expect(isResumableRunInProgress(queryClient, CONVERSATION_ID)).toBe(true);
  });

  it('moves a disconnected run into an epoch-bound pending task', () => {
    const queryClient = new QueryClient();
    beginResumableRun(queryClient, CONVERSATION_ID);
    setDisconnectedRunRecovery(queryClient, CONVERSATION_ID, RECOVERY);

    const task = moveDisconnectedRunToPendingReconciliation(queryClient, CONVERSATION_ID);

    expect(task).toMatchObject({ ...RECOVERY, runEpoch: 1 });
    expect(getDisconnectedRunRecovery(queryClient, CONVERSATION_ID)).toBeUndefined();
    expect(getPendingRunReconciliations(queryClient, CONVERSATION_ID)).toEqual([task]);
  });

  it('deduplicates a task within one epoch but preserves later epochs', () => {
    const queryClient = new QueryClient();

    queuePendingRunReconciliation(queryClient, CONVERSATION_ID, RECOVERY, 1);
    queuePendingRunReconciliation(queryClient, CONVERSATION_ID, RECOVERY, 1);
    queuePendingRunReconciliation(queryClient, CONVERSATION_ID, RECOVERY, 2);

    expect(getPendingRunReconciliations(queryClient, CONVERSATION_ID)).toHaveLength(2);
  });

  it('clears disconnected recovery after a real terminal event', () => {
    const queryClient = new QueryClient();
    queuePendingRunReconciliation(queryClient, CONVERSATION_ID, RECOVERY, 1);
    setDisconnectedRunRecovery(queryClient, CONVERSATION_ID, RECOVERY);

    markTerminalEventSeen(queryClient, CONVERSATION_ID);

    expect(getDisconnectedRunRecovery(queryClient, CONVERSATION_ID)).toBeUndefined();
    expect(getPendingRunReconciliations(queryClient, CONVERSATION_ID)).toHaveLength(1);
    expect(consumeTerminalEventSeen(queryClient, CONVERSATION_ID)).toBe(true);
    expect(consumeTerminalEventSeen(queryClient, CONVERSATION_ID)).toBe(false);
  });
});

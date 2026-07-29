import { StrictMode, type PropsWithChildren } from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import {
  beginResumableRun,
  getDisconnectedRunRecovery,
  getPendingRunReconciliations,
  queuePendingRunReconciliation,
  setResumableRunStarting,
  setDisconnectedRunRecovery,
} from '../resumableRecovery';
import useTerminalRunRecovery from '../useTerminalRunRecovery';

const mockFetchStreamStatus = jest.fn();
const mockUseActiveJobs = jest.fn(() => ({ data: { activeJobIds: [] } }));
const mockGetMessagesByConvoId = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: unknown[]) => mockGetMessagesByConvoId(...args),
    },
  };
});

jest.mock('~/data-provider', () => ({
  fetchStreamStatus: (...args: unknown[]) => mockFetchStreamStatus(...args),
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
  useActiveJobs: () => mockUseActiveJobs(),
}));

jest.mock('~/utils', () => ({
  addConversationToAllConversationsQueries: jest.fn(),
  removeConvoFromAllQueries: jest.fn(),
  isNotFoundError: (error: unknown) =>
    (error as { response?: { status?: number } })?.response?.status === 404,
}));

const CONVERSATION_ID = 'recovery-conversation';
const USER_MESSAGE_ID = 'recovery-user';

const provisionalMessages = [
  {
    messageId: USER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    isCreatedByUser: true,
    text: 'Question',
  },
  {
    messageId: 'recovery-response_',
    parentMessageId: USER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    isCreatedByUser: false,
    text: 'Partial',
  },
] as TMessage[];

const persistedMessages = [
  provisionalMessages[0],
  {
    ...provisionalMessages[1],
    messageId: 'recovery-response',
    text: 'Final answer',
    createdAt: '2026-07-29T08:00:00.000Z',
    updatedAt: '2026-07-29T08:01:00.000Z',
  },
] as TMessage[];

function createWrapper(queryClient: QueryClient, initialPath = `/c/${CONVERSATION_ID}`) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
        </RecoilRoot>
      </QueryClientProvider>
    );
  };
}

function createStrictWrapper(queryClient: QueryClient) {
  const Wrapper = createWrapper(queryClient);
  return function StrictWrapper({ children }: PropsWithChildren) {
    return (
      <StrictMode>
        <Wrapper>{children}</Wrapper>
      </StrictMode>
    );
  };
}

describe('useTerminalRunRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchStreamStatus.mockResolvedValue({ active: false, status: 'complete' });
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('replaces a provisional response after an unobserved terminal transition', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], provisionalMessages);
    mockGetMessagesByConvoId.mockResolvedValue(persistedMessages);

    renderHook(
      () =>
        useTerminalRunRecovery({
          conversationId: CONVERSATION_ID,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(queryClient.getQueryData([QueryKeys.messages, CONVERSATION_ID])).toEqual(
        persistedMessages,
      );
    });
    expect(getDisconnectedRunRecovery(queryClient, CONVERSATION_ID)).toBeUndefined();
  });

  it('recovers after Strict Mode replays mount effects', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], provisionalMessages);
    mockGetMessagesByConvoId.mockResolvedValue(persistedMessages);

    renderHook(() => useTerminalRunRecovery({ conversationId: CONVERSATION_ID }), {
      wrapper: createStrictWrapper(queryClient),
    });

    await waitFor(() => {
      expect(queryClient.getQueryData([QueryKeys.messages, CONVERSATION_ID])).toEqual(
        persistedMessages,
      );
    });
  });

  it('does not claim a provisional tail while a new run is still starting', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], provisionalMessages);
    setResumableRunStarting(queryClient, CONVERSATION_ID, true);
    mockGetMessagesByConvoId.mockResolvedValue(persistedMessages);

    renderHook(
      () =>
        useTerminalRunRecovery({
          conversationId: CONVERSATION_ID,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchStreamStatus).not.toHaveBeenCalled();

    act(() => {
      setResumableRunStarting(queryClient, CONVERSATION_ID, false);
    });
    await waitFor(() => expect(mockFetchStreamStatus).toHaveBeenCalled());
  });

  it('does not let an old recovery overwrite a newer run', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], provisionalMessages);
    beginResumableRun(queryClient, CONVERSATION_ID);
    setDisconnectedRunRecovery(queryClient, CONVERSATION_ID, {
      startedAsNewConvo: false,
      created: true,
      userMessageId: USER_MESSAGE_ID,
      responseMessageId: 'recovery-response_',
    });

    let resolveMessages!: (messages: TMessage[]) => void;
    mockGetMessagesByConvoId.mockImplementation(
      () => new Promise<TMessage[]>((resolve) => (resolveMessages = resolve)),
    );

    renderHook(
      () =>
        useTerminalRunRecovery({
          conversationId: CONVERSATION_ID,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(mockGetMessagesByConvoId).toHaveBeenCalled());
    act(() => {
      beginResumableRun(queryClient, CONVERSATION_ID);
      resolveMessages(persistedMessages);
    });

    await waitFor(() => {
      expect(queryClient.getQueryData([QueryKeys.messages, CONVERSATION_ID])).toEqual(
        provisionalMessages,
      );
    });
    expect(getDisconnectedRunRecovery(queryClient, CONVERSATION_ID)).toBeDefined();
  });

  it('reconciles a displaced historical run without replacing newer turns', async () => {
    const newerUser = {
      ...provisionalMessages[0],
      messageId: 'newer-user',
      parentMessageId: 'recovery-response_',
    } as TMessage;
    const newerResponse = {
      ...persistedMessages[1],
      messageId: 'newer-response',
      parentMessageId: newerUser.messageId,
      text: 'Newer answer',
    } as TMessage;
    const currentMessages = [...provisionalMessages, newerUser, newerResponse];
    const allPersistedMessages = [
      persistedMessages[0],
      persistedMessages[1],
      newerUser,
      newerResponse,
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], currentMessages);
    queuePendingRunReconciliation(
      queryClient,
      CONVERSATION_ID,
      {
        startedAsNewConvo: false,
        created: true,
        userMessageId: USER_MESSAGE_ID,
        responseMessageId: 'recovery-response_',
      },
      1,
    );
    mockGetMessagesByConvoId.mockResolvedValue(allPersistedMessages);

    renderHook(
      () =>
        useTerminalRunRecovery({
          conversationId: CONVERSATION_ID,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(queryClient.getQueryData([QueryKeys.messages, CONVERSATION_ID])).toEqual(
        allPersistedMessages,
      );
    });
    expect(getPendingRunReconciliations(queryClient, CONVERSATION_ID)).toEqual([]);
  });

  it('does not reclaim the route after the user navigates away during recovery', async () => {
    window.history.replaceState({}, '', `/c/${CONVERSATION_ID}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, CONVERSATION_ID], provisionalMessages);
    setDisconnectedRunRecovery(queryClient, CONVERSATION_ID, {
      startedAsNewConvo: true,
      created: true,
      userMessageId: USER_MESSAGE_ID,
      responseMessageId: 'recovery-response_',
    });
    let resolveMessages!: (messages: TMessage[]) => void;
    mockGetMessagesByConvoId.mockImplementation(
      () => new Promise<TMessage[]>((resolve) => (resolveMessages = resolve)),
    );

    const { result } = renderHook(
      () => {
        const navigate = useNavigate();
        useTerminalRunRecovery({ conversationId: CONVERSATION_ID });
        return navigate;
      },
      { wrapper: createWrapper(queryClient, '/c/new') },
    );

    await waitFor(() => expect(mockGetMessagesByConvoId).toHaveBeenCalled());
    act(() => {
      result.current('/c/another');
      resolveMessages(persistedMessages);
    });

    await waitFor(() => {
      expect(queryClient.getQueryData([QueryKeys.messages, CONVERSATION_ID])).toEqual(
        persistedMessages,
      );
    });
    expect(queryClient.getQueryData([QueryKeys.messages, Constants.NEW_CONVO])).toBeUndefined();
  });
});

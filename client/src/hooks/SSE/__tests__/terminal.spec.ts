import { Constants } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import {
  getPersistedRunState,
  getRunRecoveryTarget,
  getUnreconciledAssistantTail,
  mergePersistedRunIntoMessages,
  preserveMessagesAfterRecoveryTarget,
  recoveryOwnsCurrentRoute,
  submissionBelongsToConversation,
  withCurrentSearch,
} from '../terminal';
import { isRetryableTerminalError } from '../recovery/retry';

const CONVERSATION_ID = 'conversation-1';
const USER_MESSAGE_ID = 'user-1';

const userMessage = {
  messageId: USER_MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: true,
  text: 'Hello',
} as TMessage;

const responseMessage = (overrides: Partial<TMessage> = {}) =>
  ({
    messageId: 'response-1',
    conversationId: CONVERSATION_ID,
    parentMessageId: USER_MESSAGE_ID,
    isCreatedByUser: false,
    text: 'Done',
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T08:00:00.000Z',
    ...overrides,
  }) as TMessage;

describe('terminal recovery policy', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('detects provisional assistant tails but ignores stream-start failures', () => {
    expect(
      getUnreconciledAssistantTail([
        responseMessage({ messageId: 'response-1_', updatedAt: undefined }),
      ]),
    ).toBeDefined();
    expect(
      getUnreconciledAssistantTail([
        responseMessage({
          updatedAt: undefined,
          metadata: { streamStartFailed: true },
        }),
      ]),
    ).toBeUndefined();
  });

  it('prefers stored run identity and matches its persisted response', () => {
    const target = getRunRecoveryTarget(
      {
        startedAsNewConvo: false,
        created: true,
        userMessageId: USER_MESSAGE_ID,
        responseMessageId: 'response-1_',
      },
      [],
    );

    expect(getPersistedRunState([userMessage, responseMessage()], target)).toEqual({
      outcome: 'completed',
      responseFound: true,
      userMessageFound: true,
    });
  });

  it('preserves unrelated local turns appended after the recovered response', () => {
    const laterUser = {
      ...userMessage,
      messageId: 'later-user',
      parentMessageId: 'response-1_',
    };

    expect(
      preserveMessagesAfterRecoveryTarget(
        [userMessage, responseMessage()],
        [
          userMessage,
          responseMessage({
            messageId: 'response-1_',
            createdAt: undefined,
            updatedAt: undefined,
          }),
          laterUser,
        ],
        { userMessageId: USER_MESSAGE_ID, responseMessageId: 'response-1_' },
      ),
    ).toEqual([userMessage, responseMessage(), laterUser]);
  });

  it('merges only a targeted historical run into newer local turns', () => {
    const oldResponse = responseMessage({
      messageId: 'response-1_',
      createdAt: undefined,
      updatedAt: undefined,
    });
    const newerUser = {
      ...userMessage,
      messageId: 'user-2',
      parentMessageId: oldResponse.messageId,
    };
    const newerResponse = responseMessage({
      messageId: 'response-2',
      parentMessageId: newerUser.messageId,
      text: 'Newer answer',
    });

    expect(
      mergePersistedRunIntoMessages(
        [userMessage, oldResponse, newerUser, newerResponse],
        [userMessage, responseMessage(), newerUser, newerResponse],
        { userMessageId: USER_MESSAGE_ID, responseMessageId: oldResponse.messageId },
      ),
    ).toEqual([userMessage, responseMessage(), newerUser, newerResponse]);
  });

  it.each([
    [undefined, true],
    [{ status: 408 }, true],
    [{ response: { status: 429 } }, true],
    [{ status: 503 }, true],
    [{ status: 404 }, false],
    [{ response: { status: 400 } }, false],
  ])('classifies retryability', (error, retryable) => {
    expect(isRetryableTerminalError(error)).toBe(retryable);
  });

  it('handles first-turn native URL adoption without claiming unrelated routes', () => {
    window.history.replaceState({}, '', `/c/${CONVERSATION_ID}?projectId=project-1`);

    expect(recoveryOwnsCurrentRoute('/c/new', CONVERSATION_ID)).toBe(true);
    expect(recoveryOwnsCurrentRoute('/c/another', CONVERSATION_ID)).toBe(false);
    expect(withCurrentSearch(`/c/${CONVERSATION_ID}`)).toBe(
      `/c/${CONVERSATION_ID}?projectId=project-1`,
    );
  });

  it('matches a submission through any conversation-bearing field', () => {
    const submission = {
      conversation: { conversationId: 'another' },
      userMessage: { conversationId: CONVERSATION_ID },
      initialResponse: { conversationId: 'third' },
    } as TSubmission;

    expect(submissionBelongsToConversation(submission, CONVERSATION_ID)).toBe(true);
    expect(submissionBelongsToConversation(submission, 'missing')).toBe(false);
  });
});

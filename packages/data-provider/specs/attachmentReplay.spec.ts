import {
  prepareAttachmentReplayHistory,
  getAttachmentReplayStates,
  selectAttachmentReplayBranch,
} from '../src/attachmentReplay';
import type { TMessage } from '../src/schemas';

const user = (
  id: string,
  files: TMessage['files'] = [{ file_id: 'large' }],
): Partial<TMessage> => ({
  messageId: id,
  isCreatedByUser: true,
  text: 'Keep my question',
  files,
});
const failure = (
  parentMessageId: string,
  text = JSON.stringify({ code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED' }),
): Partial<TMessage> => ({
  messageId: 'failure',
  parentMessageId,
  isCreatedByUser: false,
  error: true,
  text,
});

describe('attachment replay recovery', () => {
  it('omits rejected files from the next turn without mutating stored references or text', () => {
    const stored = [user('first'), failure('first'), user('next', [{ file_id: 'small' }])];
    const projected = prepareAttachmentReplayHistory(stored);
    expect(projected[0].files).toEqual([]);
    expect(projected[0].text).toBe('Keep my question');
    expect(projected[2].files).toEqual([{ file_id: 'small' }]);
    expect(stored[0].files).toEqual([{ file_id: 'large' }]);
  });
  it('recovers legacy persisted plain-text limit failures', () => {
    const text =
      'This turn exceeds the configured extracted document text limit (123 > 100). Remove some attachments or use smaller files and try again.';
    expect(
      prepareAttachmentReplayHistory([user('first'), failure('first', text)])[0].files,
    ).toEqual([]);
  });
  it('does not infer rejection from a user quoting an error or an unrelated provider error', () => {
    const quoted = { ...failure('first'), isCreatedByUser: true };
    expect(prepareAttachmentReplayHistory([user('first'), quoted])[0].files).toHaveLength(1);
    expect(
      prepareAttachmentReplayHistory([user('first'), failure('first', 'Rate limited')])[0].files,
    ).toHaveLength(1);
  });
  it('does not affect a branch without the rejected response', () => {
    expect(prepareAttachmentReplayHistory([user('first')])[0].files).toHaveLength(1);
  });
  it('omits only the selected file, including cached extracted context, and can restore it', () => {
    const stored = [
      {
        ...user('first', [{ file_id: 'omit', excludedFromContext: true }, { file_id: 'keep' }]),
        fileContext: 'previous combined text',
      },
    ];
    const projected = prepareAttachmentReplayHistory(stored);
    expect(projected[0].files).toEqual([{ file_id: 'keep' }]);
    expect(projected[0].fileContext).toBeUndefined();
    expect(stored[0].fileContext).toBe('previous combined text');
    expect(
      prepareAttachmentReplayHistory([
        user('first', [
          { file_id: 'restored', excludedFromContext: false, replayAfterMessageId: 'failure' },
        ]),
        failure('first'),
      ])[0].files,
    ).toHaveLength(1);
  });
  it('recognizes a typed error content part even without the legacy error flag', () => {
    const response: Partial<TMessage> = {
      ...failure('first'),
      error: false,
      text: '',
      content: [
        { type: 'error', error: JSON.stringify({ code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED' }) },
      ],
    };
    expect(prepareAttachmentReplayHistory([user('first'), response])[0].files).toEqual([]);
  });
});

describe('attachment retry scope', () => {
  const rejected = (id: string, parentMessageId: string, fileIds: string[]) => ({
    ...failure(
      parentMessageId,
      JSON.stringify({ code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED', rejectedFileIds: fileIds }),
    ),
    messageId: id,
  });
  it('acknowledges only one rejection, then recovers after a failed retry with no new files', () => {
    const stored = [
      user('upload', [
        { file_id: 'large', excludedFromContext: false, replayAfterMessageId: 'rejection-1' },
      ]),
      rejected('rejection-1', 'upload', ['large']),
      { ...user('retry', []), parentMessageId: 'rejection-1' },
    ];
    expect(prepareAttachmentReplayHistory(stored)[0].files).toHaveLength(1);
    const failedAgain = [...stored, rejected('rejection-2', 'retry', ['large'])];
    expect(prepareAttachmentReplayHistory(failedAgain)[0].files).toEqual([]);
    expect(getAttachmentReplayStates(failedAgain).upload.large).toEqual({
      excluded: true,
      rejectionMessageId: 'rejection-2',
    });
    expect(stored[0].files).toHaveLength(1);
  });
  it('does not allow a stored false flag to bypass a later rejection', () => {
    expect(
      prepareAttachmentReplayHistory([
        user('upload', [{ file_id: 'large', excludedFromContext: false }]),
        rejected('rejection', 'upload', ['large']),
      ])[0].files,
    ).toEqual([]);
  });
  it('keeps a newly attached reference active after an older rejection of the same upload', () => {
    const messages = [user('upload'), rejected('rejection', 'upload', ['large']), user('reattach')];
    const result = prepareAttachmentReplayHistory(messages);
    expect(result[0].files).toEqual([]);
    expect(result[2].files).toHaveLength(1);
  });
  it('ignores sibling rejections and cycles when selecting the next turn branch', () => {
    const upload = user('upload');
    const branch = { ...user('branch', []), parentMessageId: 'upload' };
    const sibling = rejected('sibling', 'upload', ['large']);
    const selected = selectAttachmentReplayBranch([upload, sibling, branch], 'branch');
    expect(selected.map((m) => m.messageId)).toEqual(['upload', 'branch']);
    expect(prepareAttachmentReplayHistory(selected)[0].files).toHaveLength(1);
    expect(
      selectAttachmentReplayBranch([{ messageId: 'cycle', parentMessageId: 'cycle' }], 'cycle'),
    ).toHaveLength(1);
  });
});

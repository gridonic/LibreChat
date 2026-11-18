import { createMessageFileExclusionHandler } from './attachments';

describe('message attachment exclusion handler', () => {
  const setMessageFileExcluded = jest.fn();
  const rejectSubagentThreadWrite = jest.fn().mockResolvedValue(false);
  const handler = createMessageFileExclusionHandler({
    setMessageFileExcluded,
    rejectSubagentThreadWrite,
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = {
    user: { id: 'owner' },
    config: { fileConfig: { allowMessageFileExclusion: true } },
    params: { conversationId: 'chat', messageId: 'message', fileId: 'file' },
    body: { excluded: true },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    rejectSubagentThreadWrite.mockResolvedValue(false);
  });
  it('passes only the authenticated scope and requested boolean to the atomic mutation', async () => {
    setMessageFileExcluded.mockResolvedValue({
      messageId: 'message',
      fileId: 'file',
      excluded: true,
    });
    await handler(req as never, res as never);
    expect(setMessageFileExcluded).toHaveBeenCalledWith({
      userId: 'owner',
      ...req.params,
      excluded: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it('respects the deployment capability switch', async () => {
    await handler({ ...req, config: undefined } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(setMessageFileExcluded).not.toHaveBeenCalled();
  });
  it('rejects invalid values without writing', async () => {
    await handler({ ...req, body: { excluded: 'false' } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(setMessageFileExcluded).not.toHaveBeenCalled();
  });
  it('rejects child-thread writes', async () => {
    rejectSubagentThreadWrite.mockResolvedValue(true);
    await handler(req as never, res as never);
    expect(setMessageFileExcluded).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing or unauthorized attachment', async () => {
    setMessageFileExcluded.mockResolvedValue(null);
    await handler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
  });
  it('does not disclose database errors', async () => {
    setMessageFileExcluded.mockRejectedValue(new Error('private database payload'));
    await handler(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private database');
  });

  it('persists the rejection acknowledged by an explicit retry', async () => {
    const setMessageFileExcluded = jest.fn().mockResolvedValue({
      messageId: 'm',
      fileId: 'f',
      excluded: false,
      replayAfterMessageId: 'rejection',
    });
    const handler = createMessageFileExclusionHandler({
      setMessageFileExcluded,
      rejectSubagentThreadWrite: jest.fn().mockResolvedValue(false),
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler(
      {
        user: { id: 'owner' },
        config: { fileConfig: { allowMessageFileExclusion: true } },
        params: { conversationId: 'c', messageId: 'm', fileId: 'f' },
        body: { excluded: false, replayAfterMessageId: 'rejection' },
      } as never,
      res as never,
    );
    expect(setMessageFileExcluded).toHaveBeenCalledWith({
      userId: 'owner',
      conversationId: 'c',
      messageId: 'm',
      fileId: 'f',
      excluded: false,
      replayAfterMessageId: 'rejection',
    });
  });
});

import { logger } from '@librechat/data-schemas';
import type { MessageMethods } from '@librechat/data-schemas';
import type { Response, Request } from 'express';

type AttachmentRequest = Request<
  { conversationId: string; messageId: string; fileId: string },
  unknown,
  { excluded?: boolean }
> & { user?: { id: string }; config?: { fileConfig?: { allowMessageFileExclusion?: boolean } } };

/** Authentication and conversation/child-thread authorization are supplied by the route. */
export function createMessageFileExclusionHandler(
  deps: Pick<MessageMethods, 'setMessageFileExcluded'> & {
    rejectSubagentThreadWrite: (
      req: AttachmentRequest,
      res: Response,
      conversationId: string,
    ) => Promise<boolean>;
  },
) {
  return async (req: AttachmentRequest, res: Response): Promise<Response> => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.config?.fileConfig?.allowMessageFileExclusion !== true) {
      return res.status(403).json({ error: 'Attachment exclusion is disabled' });
    }
    if (typeof req.body?.excluded !== 'boolean') {
      return res.status(400).json({ error: 'Invalid attachment exclusion' });
    }
    try {
      if (await deps.rejectSubagentThreadWrite(req, res, req.params.conversationId)) return res;
      const result = await deps.setMessageFileExcluded({
        userId: req.user.id,
        conversationId: req.params.conversationId,
        messageId: req.params.messageId,
        fileId: req.params.fileId,
        excluded: req.body.excluded,
      });
      return result == null
        ? res.status(404).json({ error: 'Attachment not found' })
        : res.status(200).json(result);
    } catch {
      logger.error('[attachments] Could not update attachment exclusion');
      return res.status(500).json({ error: 'Attachment update failed' });
    }
  };
}

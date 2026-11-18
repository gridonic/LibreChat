import { memo } from 'react';
import { Button } from '@librechat/client';
import { MessageFiles } from '@librechat/chat/components';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import {
  useGetFileConfig,
  useSetMessageFileExcluded,
  useMessageAttachmentReplay,
} from '~/data-provider';
import { useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import '~/Providers/MessagePartsHostContext';

const Files = ({ message }: { message?: TMessage }) => {
  const localize = useLocalize();
  const exclusion = useSetMessageFileExcluded();
  const replay = useMessageAttachmentReplay(message);
  const { shareId, isSharedConvo } = useShareContext();
  const { data: fileConfig } = useGetFileConfig({ enabled: !shareId && !isSharedConvo });
  const attachmentControl = (file: Partial<TFile>) => {
    if (
      shareId ||
      isSharedConvo ||
      !fileConfig?.allowMessageFileExclusion ||
      !message?.isCreatedByUser ||
      isAssistantsEndpoint(message.endpoint) ||
      !message.conversationId ||
      !file.file_id
    )
      return null;
    const state = replay?.[file.file_id];
    const excluded = state?.excluded ?? file.excludedFromContext === true;
    const automaticallyExcluded = excluded && state?.reason === 'rejected';
    return (
      <div className="flex max-w-56 flex-col items-start gap-1">
        {excluded && (
          <span className="text-text-secondary text-xs">
            {localize(
              automaticallyExcluded ? 'com_ui_attachment_rejected' : 'com_ui_attachment_excluded',
            )}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={exclusion.isLoading}
          aria-label={`${localize(excluded ? 'com_ui_attachment_include' : 'com_ui_attachment_exclude')}: ${file.filename ?? ''}`}
          onClick={() =>
            exclusion.mutate({
              conversationId: message.conversationId!,
              messageId: message.messageId,
              fileId: file.file_id!,
              excluded: !excluded,
              ...(excluded && state?.rejectionMessageId
                ? { replayAfterMessageId: state.rejectionMessageId }
                : {}),
            })
          }
        >
          {localize(excluded ? 'com_ui_attachment_include' : 'com_ui_attachment_exclude')}
        </Button>
      </div>
    );
  };

  return (
    <>
      <MessageFiles files={message?.files} renderFileActions={attachmentControl} />
      {exclusion.isError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_ui_attachment_update_failed')}
        </p>
      )}
    </>
  );
};

export default memo(Files);

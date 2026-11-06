import { useMemo, useState, useCallback, memo } from 'react';
import { Button } from '@librechat/client';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import { useGetFileConfig, useSetMessageFileExcluded } from '~/data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { usesImagePreview, hydrateFileDeliveryMetadata } from '~/utils';
import { useFileMapContext, useShareContext } from '~/Providers';
import FilePreviewDialog from './FilePreviewDialog';
import { useLocalize } from '~/hooks';
import Image from './Image';

const Files = ({ message }: { message?: TMessage }) => {
  const fileMap = useFileMapContext();
  const localize = useLocalize();
  const exclusion = useSetMessageFileExcluded();
  const { shareId, isSharedConvo } = useShareContext();
  const { data: fileConfig } = useGetFileConfig({ enabled: !shareId && !isSharedConvo });
  const files = useMemo(
    () => hydrateFileDeliveryMetadata(message?.files, undefined, shareId ? undefined : fileMap),
    [message?.files, fileMap, shareId],
  );
  const imageFiles = useMemo(() => {
    return files?.filter(usesImagePreview) || [];
  }, [files]);

  const otherFiles = useMemo(() => {
    return files?.filter((file) => !usesImagePreview(file)) || [];
  }, [files]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

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
    return (
      <div className="flex max-w-56 flex-col items-start gap-1">
        {file.excludedFromContext && (
          <span className="text-xs text-text-secondary">
            {localize('com_ui_attachment_excluded')}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={exclusion.isLoading}
          aria-label={`${localize(file.excludedFromContext ? 'com_ui_attachment_include' : 'com_ui_attachment_exclude')}: ${file.filename ?? ''}`}
          onClick={() =>
            exclusion.mutate({
              conversationId: message.conversationId!,
              messageId: message.messageId,
              fileId: file.file_id!,
              excluded: !file.excludedFromContext,
            })
          }
        >
          {localize(
            file.excludedFromContext ? 'com_ui_attachment_include' : 'com_ui_attachment_exclude',
          )}
        </Button>
      </div>
    );
  };

  return (
    <>
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <div key={file.file_id} className="flex flex-col items-start gap-1">
            <FileContainer file={file as TFile} onClick={() => setSelectedFile(file)} />
            {attachmentControl(file)}
          </div>
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <div key={file.file_id} className="flex flex-col items-start gap-1">
            <Image
              alignRight
              imagePath={file.preview ?? file.filepath ?? ''}
              height={file.height ?? 1920}
              width={file.width ?? 1080}
              altText={file.filename ?? 'Uploaded Image'}
            />
            {attachmentControl(file)}
          </div>
        ))}
      {exclusion.isError && (
        <p role="alert" className="text-sm text-text-destructive">
          {localize('com_ui_attachment_update_failed')}
        </p>
      )}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSource={selectedFile?.source}
        fileSize={(selectedFile as TFile)?.bytes}
        deliveryPath={selectedFile?.llmDeliveryPath}
      />
    </>
  );
};

export default memo(Files);

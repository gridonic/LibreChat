import { memo, useMemo, useState, useCallback } from 'react';
import { useLocalize } from '@librechat/client';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode } from 'react';
import { hydrateFileDeliveryMetadata, usesImagePreview } from '../../core/files';
import FileContainer from '../composer/files/FileContainer';
import { useMessagePartsHost } from '../../react/host';

type MessageFilesProps = {
  files?: TMessage['files'];
  renderFileActions?: (file: Partial<TFile>) => ReactNode;
};

const MessageFiles: NamedExoticComponent<MessageFilesProps> = memo(function MessageFiles({
  files,
  renderFileActions,
}: MessageFilesProps) {
  const localize = useLocalize();
  const { useFileMap, useShare, renderImage, renderFilePreview } = useMessagePartsHost();
  const fileMap = useFileMap();
  const { shareId } = useShare();
  const hydratedFiles = useMemo(
    () => hydrateFileDeliveryMetadata(files, undefined, shareId ? undefined : fileMap),
    [files, fileMap, shareId],
  );
  const imageFiles = useMemo(() => hydratedFiles?.filter(usesImagePreview) ?? [], [hydratedFiles]);
  const otherFiles = useMemo(
    () => hydratedFiles?.filter((file) => !usesImagePreview(file)) ?? [],
    [hydratedFiles],
  );
  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);
  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {otherFiles.map((file) => (
        <div key={file.file_id} className="flex max-w-full flex-col items-start gap-1">
          <FileContainer
            file={file}
            buttonClassName="border-surface-user-message max-w-full bg-transparent"
            containerClassName="max-w-full"
            onClick={() => setSelectedFile(file)}
          />
          {renderFileActions?.(file)}
        </div>
      ))}
      {imageFiles.map((file) => (
        <div key={file.file_id} className="flex max-w-full flex-col items-start gap-1">
          {renderImage({
            alignRight: true,
            className: 'border-surface-user-message mt-0 shadow-none',
            imagePath: file.preview ?? file.filepath ?? '',
            height: file.height ?? 1920,
            width: file.width ?? 1080,
            altText: file.filename ?? localize('com_ui_attached_image'),
          })}
          {renderFileActions?.(file)}
        </div>
      ))}
      {otherFiles.length > 0 &&
        renderFilePreview({
          open: selectedFile !== null,
          onOpenChange: handleClose,
          fileName: selectedFile?.filename ?? '',
          fileId: selectedFile?.file_id,
          filePath: selectedFile?.filepath,
          fileType: selectedFile?.type ?? undefined,
          fileSource: selectedFile?.source,
          fileSize: selectedFile?.bytes,
          deliveryPath: selectedFile?.llmDeliveryPath,
        })}
    </>
  );
});

export default MessageFiles;

/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage, AttachmentReplayState } from 'librechat-data-provider';
import { setAppPartRenderers } from '../Parts/slots';
import FilePreviewDialog from '../FilePreviewDialog';
import Image from '../Image';
import Files from '../Files';

const mockMutate = jest.fn();
let mockExclusionState = { isLoading: false, isError: false };
let mockReplay: Record<string, AttachmentReplayState> | undefined;
let mockShareId: string | undefined;
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useSetMessageFileExcluded: () => ({ mutate: mockMutate, ...mockExclusionState }),
  useMessageAttachmentReplay: () => mockReplay,
  useGetFileConfig: () => ({ data: { allowMessageFileExclusion: true } }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
}));
jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useShareContext: () => ({ shareId: mockShareId }),
}));
jest.mock(
  '../Image',
  () =>
    ({ alignRight, className }: { alignRight?: boolean; className?: string }) => (
      <div
        data-testid="image-preview"
        data-aligned-right={String(alignRight)}
        className={className}
      >
        image preview
      </div>
    ),
);
jest.mock(
  '../FilePreviewDialog',
  () =>
    ({ open, deliveryPath }: { open: boolean; deliveryPath?: string }) =>
      open ? <div>preview: {deliveryPath}</div> : null,
);

setAppPartRenderers({
  renderMarkdown: () => null,
  renderAgentIcon: () => null,
  renderImage: (props) => <Image {...props} />,
  renderFilePreview: (props) => <FilePreviewDialog {...props} />,
});

it('exposes extracted image text without changing ordinary image previews', () => {
  render(
    <Files
      message={
        {
          files: [
            {
              file_id: 'text-image',
              filename: 'extracted.png',
              type: 'image/png',
              llmDeliveryPath: 'text',
            },
            { file_id: 'image', type: 'image/png' },
          ],
        } as TMessage
      }
    />,
  );
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  expect(screen.getByRole('button', { name: 'extracted.png' })).toHaveClass(
    'border-surface-user-message',
    'max-w-full',
    'bg-transparent',
  );
  expect(screen.getByTestId('image-preview')).toHaveClass(
    'border-surface-user-message',
    'mt-0',
    'shadow-none',
  );
  fireEvent.click(screen.getByRole('button', { name: 'extracted.png' }));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
});

it('shows the persisted snippet after reload without the owner file cache', () => {
  const saved = JSON.parse(
    JSON.stringify({
      files: [
        {
          file_id: 'stored-paste',
          type: 'text/plain',
          filename: 'pasted-text.txt',
          textPreview: 'An excerpt retained on the saved message.',
        },
      ],
    }),
  ) as TMessage;
  render(<Files message={saved} />);
  expect(screen.getByText('An excerpt retained on the saved message.')).toBeInTheDocument();
});

const message = {
  messageId: 'message',
  conversationId: 'chat',
  isCreatedByUser: true,
  files: [{ file_id: 'file', filename: 'data.csv', type: 'text/csv' }],
} as TMessage;
beforeEach(() => {
  mockMutate.mockReset();
  mockReplay = undefined;
  mockShareId = undefined;
  mockExclusionState = { isLoading: false, isError: false };
});
it('excludes one attachment while keeping its preview action available', () => {
  render(<Files message={message} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_attachment_exclude: data.csv' }));
  expect(mockMutate).toHaveBeenCalledWith({
    conversationId: 'chat',
    messageId: 'message',
    fileId: 'file',
    excluded: true,
  });
  expect(screen.getByRole('button', { name: 'data.csv' })).toBeInTheDocument();
});
it('restores an excluded file without deleting its original', () => {
  render(
    <Files
      message={{ ...message, files: [{ ...message.files![0], excludedFromContext: true }] }}
    />,
  );
  expect(screen.getByText('com_ui_attachment_excluded')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_attachment_include: data.csv' }));
  expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ excluded: false }));
  expect(screen.getByRole('button', { name: 'data.csv' })).toBeInTheDocument();
});
it('disables the control while saving and reports a failure', () => {
  mockExclusionState = { isLoading: true, isError: true };
  render(<Files message={message} />);
  expect(
    screen.getByRole('button', { name: 'com_ui_attachment_exclude: data.csv' }),
  ).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_attachment_update_failed');
});
it('does not offer mutation controls on shared conversations', () => {
  mockShareId = 'shared';
  render(<Files message={message} />);
  expect(
    screen.queryByRole('button', { name: /com_ui_attachment_exclude/ }),
  ).not.toBeInTheDocument();
});

it('does not claim to remove context already held by a provider-managed Assistant thread', () => {
  render(<Files message={{ ...message, endpoint: 'assistants' }} />);
  expect(
    screen.queryByRole('button', { name: /com_ui_attachment_exclude/ }),
  ).not.toBeInTheDocument();
});

it('shows the effective skipped state after a failed retry and offers Include directly', () => {
  mockReplay = {
    file: { excluded: true, reason: 'rejected', rejectionMessageId: 'latest-rejection' },
  };
  render(
    <Files
      message={{
        ...message,
        files: [
          {
            ...message.files![0],
            excludedFromContext: false,
            replayAfterMessageId: 'older-rejection',
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('com_ui_attachment_rejected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_attachment_include: data.csv' }));
  expect(mockMutate).toHaveBeenCalledWith({
    conversationId: 'chat',
    messageId: 'message',
    fileId: 'file',
    excluded: false,
    replayAfterMessageId: 'latest-rejection',
  });
  expect(screen.getByRole('button', { name: 'data.csv' })).toBeInTheDocument();
});

it('labels a manual exclusion correctly after canonical file hydration', () => {
  mockReplay = { file: { excluded: true, reason: 'manual' } };
  render(<Files message={message} />);
  expect(screen.getByText('com_ui_attachment_excluded')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_attachment_rejected')).not.toBeInTheDocument();
});

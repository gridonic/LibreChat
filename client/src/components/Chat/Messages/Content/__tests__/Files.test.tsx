/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage, AttachmentReplayState } from 'librechat-data-provider';
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
  '~/components/Chat/Input/Files/FileContainer',
  () =>
    ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>file action</button>,
);
jest.mock('../Image', () => ({ alignRight }: { alignRight?: boolean }) => (
  <div data-testid="image-preview" data-aligned-right={String(alignRight)}>
    image preview
  </div>
));
jest.mock(
  '../FilePreviewDialog',
  () =>
    ({ open, deliveryPath }: { open: boolean; deliveryPath?: string }) =>
      open ? <div>preview: {deliveryPath}</div> : null,
);

it('exposes extracted image text without changing ordinary image previews', () => {
  render(
    <Files
      message={
        {
          files: [
            { file_id: 'text-image', type: 'image/png', llmDeliveryPath: 'text' },
            { file_id: 'image', type: 'image/png' },
          ],
        } as TMessage
      }
    />,
  );
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  fireEvent.click(screen.getByText('file action'));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
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
  expect(screen.getByText('file action')).toBeInTheDocument();
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
  expect(screen.getByText('file action')).toBeInTheDocument();
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
  expect(screen.getByText('file action')).toBeInTheDocument();
});

it('labels a manual exclusion correctly after canonical file hydration', () => {
  mockReplay = { file: { excluded: true, reason: 'manual' } };
  render(<Files message={message} />);
  expect(screen.getByText('com_ui_attachment_excluded')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_attachment_rejected')).not.toBeInTheDocument();
});

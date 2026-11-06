import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { TFile, TMessage } from 'librechat-data-provider';
import {
  fetchJson,
  MOCK_ENDPOINTS,
  requestJson,
  getAccessToken,
  selectMockEndpoint,
  isAgentGenerationStart,
  uploadViaLegacyOption,
  sendMessageAndWaitForCompletion,
} from './helpers';
import { deleteConversations, deleteMessagesByConversation, withMongo } from './db';

test('attachment decisions survive generation, regenerate, continue and steer rejection', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let conversationId: string | undefined;
  let file: TFile | undefined;
  const marker = `ATTACHMENT_BODY_${randomUUID()}`;
  const assertion = (expected: string) => `E2E_ASSERT_ATTACHMENT:${expected}:${marker}`;
  await page.goto('/c/new');
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const token = await getAccessToken(page);
  try {
    const upload = await uploadViaLegacyOption(page, 'Upload as Text', {
      name: 'replay.txt',
      mimeType: 'text/plain',
      content: marker,
    });
    expect(upload.ok()).toBeTruthy();
    file = (await upload.json()) as TFile;
    expect(file.llmDeliveryPath).toBe('text');
    const start = await sendMessageAndWaitForCompletion(page, assertion('present'));
    conversationId = (await start.json()).conversationId;
    expect(conversationId).toBeTruthy();
    const readMessages = () =>
      fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
    await expect
      .poll(async () =>
        (await readMessages()).some(
          (message) =>
            message.isCreatedByUser && message.files?.some((ref) => ref.file_id === file!.file_id),
        ),
      )
      .toBe(true);
    const user = (await readMessages()).find((message) => message.isCreatedByUser)!;
    // Reuse an already durable user turn so the policy mutation can run while its
    // regenerated response is streaming, before the stale terminal re-save.
    await Promise.all([
      page.waitForResponse(isAgentGenerationStart),
      page.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
    ]);
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await page.getByRole('button', { name: 'Exclude from future messages: replay.txt' }).click();
    await expect(
      page.getByRole('button', { name: 'Include in future messages: replay.txt' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop generating' })).not.toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole('button', { name: 'Include in future messages: replay.txt' }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await readMessages()).find((message) => message.messageId === user.messageId)
            ?.attachmentReplay?.[0]?.excluded,
      )
      .toBe(true);
    // Change only the question's assertion, retaining the original reference and its policy.
    await requestJson(page, {
      path: `/api/messages/${conversationId}/${user.messageId}`,
      token,
      method: 'PUT',
      body: { text: assertion('absent') },
    });
    await page.reload();
    await expect(page.getByText('Excluded from future messages.', { exact: false })).toBeVisible();
    const before = new Set((await readMessages()).map((message) => message.messageId));
    await Promise.all([
      page.waitForResponse(isAgentGenerationStart),
      page.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
    ]);
    await expect
      .poll(async () =>
        (await readMessages()).some(
          (message) =>
            !before.has(message.messageId) &&
            !message.isCreatedByUser &&
            !message.error &&
            !message.unfinished &&
            JSON.stringify(message).includes('E2E attachment replay assertion passed'),
        ),
      )
      .toBe(true);
    let messages = await readMessages();
    let response = messages.filter((message) => !message.isCreatedByUser).at(-1)!;
    await withMongo(async (db) => {
      await db
        .collection('messages')
        .updateOne(
          { conversationId, messageId: response.messageId },
          { $set: { finish_reason: 'length', unfinished: true } },
        );
    });
    await page.reload();
    await Promise.all([
      page.waitForResponse(isAgentGenerationStart),
      page.getByTestId('continue-generation-button').click(),
    ]);
    await expect
      .poll(async () => {
        const latest = (await readMessages()).filter((message) => !message.isCreatedByUser).at(-1);
        return (
          latest != null && !latest.error && !latest.unfinished && latest.finish_reason !== 'length'
        );
      })
      .toBe(true);
    messages = await readMessages();
    response = messages.filter((message) => !message.isCreatedByUser).at(-1)!;
    expect(
      messages
        .find((message) => message.messageId === user.messageId)
        ?.files?.map((ref) => ref.file_id),
    ).toEqual([file.file_id]);
    expect(
      messages.find((message) => message.messageId === user.messageId)?.attachmentReplay?.[0]
        ?.excluded,
    ).toBe(true);
    // Persist the representation produced by a mid-run steer and a subsequent size rejection.
    await withMongo(async (db) => {
      const parent = await db
        .collection('messages')
        .findOne({ conversationId, messageId: response.messageId });
      const base = {
        conversationId,
        user: parent!.user,
        endpoint: parent!.endpoint,
        model: parent!.model,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const steerId = randomUUID();
      const nextId = randomUUID();
      await db.collection('messages').insertMany([
        {
          ...base,
          messageId: steerId,
          parentMessageId: response.messageId,
          isCreatedByUser: false,
          text: '',
          content: [{ type: 'steer', steer: 'read this', files: [{ file_id: file!.file_id }] }],
        },
        {
          ...base,
          messageId: nextId,
          parentMessageId: steerId,
          isCreatedByUser: true,
          text: 'continue',
        },
        {
          ...base,
          messageId: randomUUID(),
          parentMessageId: nextId,
          isCreatedByUser: false,
          error: true,
          text: JSON.stringify({
            code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
            rejectedFileIds: [file!.file_id],
          }),
        },
      ]);
    });
    await page.reload();
    await sendMessageAndWaitForCompletion(page, assertion('absent'));
    await expect(
      page.getByText('E2E attachment replay assertion passed', { exact: true }).last(),
    ).toBeVisible();
  } finally {
    if (conversationId) {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
    if (file)
      await requestJson(page, {
        path: '/api/files',
        token,
        method: 'DELETE',
        body: { files: [file] },
      });
  }
});

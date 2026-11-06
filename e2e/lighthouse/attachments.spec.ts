import { expect, test } from '@playwright/test';
import { seedConversations, seedMessages, withMongo } from '../specs/mock/db';
import { getE2EUser } from '../setup/user';

for (const theme of ['light', 'dark']) {
  test(`attachment exclusions survive reload and preserve the file (${theme})`, async ({
    page,
  }, testInfo) => {
    const conversationId =
      theme === 'light'
        ? '26390000-0000-4000-8000-000000000001'
        : '26390000-0000-4000-8000-000000000002';
    const messageId = `${conversationId}-upload`;
    const fileId = `${theme}-attachment`;
    const email = getE2EUser().email;
    await seedConversations(email, [
      { conversationId, title: 'Attachment recovery', updatedAt: new Date() },
    ]);
    await seedMessages(email, conversationId, [
      {
        messageId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Review this keyword sample.',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: `${conversationId}-answer`,
        parentMessageId: messageId,
        text: 'You can exclude this attachment from future messages while keeping the original available.',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    ]);
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email });
      const file = {
        file_id: fileId,
        filename: 'keyword-sample.csv',
        type: 'text/csv',
        bytes: 30,
        filepath: `/uploads/${user!._id}/${fileId}.csv`,
        source: 'text',
        llmDeliveryPath: 'text',
        text: 'Keyword,Clicks\ntribune hire,12',
        user: user!._id.toString(),
      };
      await db.collection('files').insertOne(file);
      await db.collection('messages').updateOne({ messageId }, { $set: { files: [file] } });
    });
    await page.addInitScript((value) => localStorage.setItem('color-theme', value), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/c/${conversationId}`);
    await page
      .getByRole('button', { name: 'Exclude from future messages: keyword-sample.csv' })
      .click();
    const restore = page.getByRole('button', {
      name: 'Include in future messages: keyword-sample.csv',
    });
    await expect(restore).toBeVisible();
    await page.reload();
    await expect(restore).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`attachment-controls-${theme}.png`) });
    await page.getByRole('button', { name: 'keyword-sample.csv', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await restore.click();
    await expect(
      page.getByRole('button', { name: 'Exclude from future messages: keyword-sample.csv' }),
    ).toBeVisible();
    await withMongo(async (db) => {
      const row = await db.collection('messages').findOne({ messageId });
      expect(row?.files[0].excludedFromContext).toBe(false);
      expect(await db.collection('files').findOne({ file_id: fileId })).not.toBeNull();
    });
  });
}

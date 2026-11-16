import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, ResourceType, PermissionBits } from 'librechat-data-provider';
import type { AllMethods } from './index';
import { createSkillSharingMethods } from './skillSharing';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '../models';
import { createMethods } from './index';

let server: MongoMemoryServer;
let db: AllMethods;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await db.seedDefaultRoles();
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function imported(name: string) {
  return (
    await db.createSkill({
      name,
      description: 'Synthetic sharing fixture',
      body: 'Instructions',
      author: new Types.ObjectId(),
      authorName: 'Fixture',
      source: 'github',
    })
  ).skill;
}

it('retains ownership of partial grants until a later pass removes them', async () => {
  const first = await db.createGroup({ name: 'retry-a', source: 'local' });
  const second = await db.createGroup({ name: 'retry-b', source: 'local' });
  const manual = await db.createGroup({ name: 'retry-manual', source: 'local' });
  const skill = await imported('retry-sharing');
  await db.grantPermission(
    PrincipalType.GROUP,
    manual._id,
    ResourceType.SKILL,
    skill._id,
    PermissionBits.VIEW,
  );
  const grant = jest
    .fn(db.grantPermission)
    .mockImplementationOnce(db.grantPermission)
    .mockRejectedValueOnce(new Error('Synthetic interrupted write'));
  const methods = createSkillSharingMethods(mongoose, {
    grantPermission: grant,
    revokePermission: db.revokePermission,
  });
  await expect(
    methods.reconcileSkillSyncSharing({
      skillId: String(skill._id),
      groups: ['retry-a', 'retry-b'],
    }),
  ).rejects.toThrow('Synthetic interrupted write');
  expect((await db.getSkillById(skill._id))?.syncSharingGroupIds?.sort()).toEqual(
    [String(first._id), String(second._id)].sort(),
  );
  await methods.reconcileSkillSyncSharing({ skillId: String(skill._id), groups: [] });
  expect((await db.getSkillById(skill._id))?.syncSharingGroupIds).toEqual([]);
  const entries = await db.findEntriesByResource(ResourceType.SKILL, skill._id);
  expect(entries.map((entry) => String(entry.principalId))).toEqual([String(manual._id)]);
});

it('does not resolve a same-named group from another tenant', async () => {
  await db.createGroup({ name: 'foreign-only', source: 'local', tenantId: 'another-tenant' });
  const skill = await imported('tenant-sharing');
  await expect(
    db.reconcileSkillSyncSharing({ skillId: String(skill._id), groups: ['foreign-only'] }),
  ).rejects.toThrow('missing or ambiguous');
  expect(await db.findEntriesByResource(ResourceType.SKILL, skill._id)).toEqual([]);
});

it('resolves the global viewer role while executing inside a source tenant', async () => {
  await tenantStorage.run({ tenantId: 'sharing-source-tenant' }, async () => {
    const group = await db.createGroup({ name: 'tenant-readers', source: 'local' });
    const skill = await imported('scoped-sharing');
    await db.reconcileSkillSyncSharing({ skillId: String(skill._id), groups: ['tenant-readers'] });
    expect(
      await db.hasPermission(
        [{ principalType: PrincipalType.GROUP, principalId: group._id }],
        ResourceType.SKILL,
        skill._id,
        PermissionBits.VIEW,
      ),
    ).toBe(true);
  });
});

import { ResourceType, PrincipalType, AccessRoleIds } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { ISkill, IAclEntry, IAccessRole } from '~/types';
import type { AclEntryMethods } from './aclEntry';
import { runAsSystem } from '~/config/tenantContext';

export type SkillSharingMethods = {
  reconcileSkillSyncSharing: (params: { skillId: string; groups: string[] }) => Promise<void>;
};

/** Database boundary for group grants owned by native skill sync. */
export function createSkillSharingMethods(
  mongoose: typeof import('mongoose'),
  acl: Pick<AclEntryMethods, 'grantPermission' | 'revokePermission'>,
): SkillSharingMethods {
  return {
    async reconcileSkillSyncSharing({
      skillId,
      groups,
    }: {
      skillId: string;
      groups: string[];
    }): Promise<void> {
      const Skill = mongoose.models.Skill as Model<ISkill>;
      const Group = mongoose.models.Group as Model<{ name: string; source: string }>;
      const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
      const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
      const skill = await Skill.findById(skillId)
        .select('source author tenantId syncSharingGroupIds')
        .lean();
      if (!skill || skill.source !== 'github') throw new Error('Synced skill unavailable');
      const matches = await Group.find(
        { source: 'local', tenantId: skill.tenantId ?? null, name: { $in: groups } },
        { _id: 1, name: 1 },
      ).lean();
      const desired = groups
        .map((name) => {
          const found = matches.filter((group) => group.name === name);
          if (found.length !== 1)
            throw new Error('Configured skill sharing group missing or ambiguous');
          return String(found[0]._id);
        })
        .sort();
      const role = await runAsSystem(() =>
        AccessRole.findOne({ accessRoleId: AccessRoleIds.SKILL_VIEWER, tenantId: null }).lean(),
      );
      if (!role) throw new Error('Skill viewer role unavailable');
      const previous = skill.syncSharingGroupIds ?? [];
      const pending = [...new Set([...previous, ...desired])].sort();
      const save = async (ids: string[]) => {
        const result = await Skill.updateOne(
          { _id: skillId, source: 'github' },
          { $set: { syncSharingGroupIds: ids } },
          { timestamps: false },
        );
        if (!result.matchedCount) throw new Error('Synced skill unavailable');
      };
      // Record ownership before ACL writes so a failed pass can remove partially
      // applied grants even if the configuration changes before the retry.
      if (JSON.stringify(previous) !== JSON.stringify(pending)) await save(pending);
      for (const id of previous) {
        if (!desired.includes(id))
          await acl.revokePermission(PrincipalType.GROUP, id, ResourceType.SKILL, skillId);
      }
      await acl.revokePermission(PrincipalType.PUBLIC, null, ResourceType.SKILL, skillId);
      const entries = await AclEntry.find({
        resourceType: ResourceType.SKILL,
        resourceId: skillId,
        principalType: PrincipalType.GROUP,
      }).lean();
      for (const id of desired) {
        const existing = entries.find((entry) => String(entry.principalId) === id);
        if (
          existing?.permBits === role.permBits &&
          String(existing.roleId) === String(role._id) &&
          (!existing.expiredAt || existing.expiredAt > new Date())
        )
          continue;
        // Replacing a temporary grant with a configured permanent grant also
        // clears its expiry; grantPermission intentionally preserves omitted fields.
        await acl.revokePermission(PrincipalType.GROUP, id, ResourceType.SKILL, skillId);
        await acl.grantPermission(
          PrincipalType.GROUP,
          id,
          ResourceType.SKILL,
          skillId,
          role.permBits,
          skill.author,
          undefined,
          role._id,
        );
      }
      if (JSON.stringify(pending) !== JSON.stringify(desired)) await save(desired);
    },
  };
}

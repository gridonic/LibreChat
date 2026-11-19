import { useCallback, useEffect, useMemo } from 'react';
import { useSetAtom } from 'jotai';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { showSkillsPopoverFamily } from '@librechat/chat/react';
import {
  DEFAULT_COMPOSER_TRIGGERS,
  PermissionTypes,
  Permissions,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { ComposerTriggers } from 'librechat-data-provider';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import useAgentCapabilities from '~/hooks/Agents/useAgentCapabilities';
import useGetAgentsConfig from '~/hooks/Agents/useGetAgentsConfig';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import store from '~/store';

/** Event keys that shouldn't trigger a command */
const invalidKeys = {
  Escape: true,
  Backspace: true,
  Enter: true,
  ArrowUp: true,
  ArrowLeft: true,
  ArrowRight: true,
  ArrowDown: true,
  Home: true,
  End: true,
  Delete: true,
};

/**
 * Determines if a command popover should trigger.
 * Uses `startPos === 1` for normal typing speed (cursor right after the command char)
 * and a short text-length fallback for fast typists whose keyup fires after the cursor
 * has already moved past position 1. The length cap prevents false triggers from
 * pasted content that happens to start with a command character.
 */
const MAX_COMMAND_TRIGGER_LENGTH = 5;

/**
 * Custom hook for handling key up events with command triggers.
 */
const useHandleKeyUp = ({
  index,
  textAreaRef,
  triggers = DEFAULT_COMPOSER_TRIGGERS,
}: {
  index: number;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  triggers?: ComposerTriggers;
}) => {
  const hasPromptsAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const hasMultiConvoAccess = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });
  const hasSkillsAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const { agentsConfig } = useGetAgentsConfig();
  const { skillsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);
  const getLatestMessage = useGetLatestMessage(index);
  const endpoint = useRecoilValue(store.effectiveEndpointByIndex(index));
  const setShowMentionPopover = useSetRecoilState(store.showMentionPopoverFamily(index));
  const setShowPlusPopover = useSetRecoilState(store.showPlusPopoverFamily(index));
  const setShowPromptsPopover = useSetRecoilState(store.showPromptsPopoverFamily(index));
  const setShowSkillsPopover = useSetAtom(showSkillsPopoverFamily(index));

  const atCommandEnabled = useRecoilValue(store.atCommand);
  const plusCommandEnabled = useRecoilValue(store.plusCommand);
  const slashCommandEnabled = useRecoilValue(store.slashCommand);
  const dollarCommandEnabled = useRecoilValue(store.dollarCommand);

  useEffect(() => {
    if (isAssistantsEndpoint(endpoint)) {
      setShowPlusPopover(false);
      setShowSkillsPopover(false);
    }
  }, [endpoint, setShowPlusPopover, setShowSkillsPopover]);

  const canAddParallelResponse =
    hasMultiConvoAccess && plusCommandEnabled && !isAssistantsEndpoint(endpoint);
  const canPickSkill =
    hasSkillsAccess && skillsEnabled && dollarCommandEnabled && !isAssistantsEndpoint(endpoint);
  const canPickPrompt = hasPromptsAccess && slashCommandEnabled;

  const commandHandlers = useMemo(
    () => ({
      [triggers.modelSwitch]: atCommandEnabled ? setShowMentionPopover : undefined,
      [triggers.parallelResponse]: canAddParallelResponse ? setShowPlusPopover : undefined,
      [triggers.prompts]: canPickPrompt ? setShowPromptsPopover : undefined,
      [triggers.skills]: canPickSkill ? setShowSkillsPopover : undefined,
    }),
    [
      triggers,
      atCommandEnabled,
      canAddParallelResponse,
      canPickPrompt,
      canPickSkill,
      setShowMentionPopover,
      setShowPlusPopover,
      setShowPromptsPopover,
      setShowSkillsPopover,
    ],
  );

  const handleUpArrow = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const latestMessage = getLatestMessage();
      if (!latestMessage) {
        return;
      }

      const element = document.getElementById(`edit-${latestMessage.parentMessageId}`);
      if (!element) {
        return;
      }
      event.preventDefault();
      element.click();
    },
    [getLatestMessage],
  );

  /**
   * Main key up handler.
   */
  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const text = textAreaRef.current?.value;
      if (event.key === 'ArrowUp' && text?.length === 0) {
        handleUpArrow(event);
        return;
      }
      if (typeof text !== 'string' || text.length === 0) {
        return;
      }

      if (invalidKeys[event.key as keyof typeof invalidKeys]) {
        return;
      }

      const startPos = textAreaRef.current?.selectionStart;
      const afterTrigger = startPos === 1;
      const afterShortQuery = startPos === text.length && text.length <= MAX_COMMAND_TRIGGER_LENGTH;
      if (afterTrigger || afterShortQuery) {
        commandHandlers[text[0]]?.(true);
      }
    },
    [textAreaRef, commandHandlers, handleUpArrow],
  );

  return handleKeyUp;
};

export default useHandleKeyUp;

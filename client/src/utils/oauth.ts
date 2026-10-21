import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

export const isOAuthToolCallName = (name?: string) =>
  typeof name === 'string' && name.startsWith(`oauth${Constants.mcp_delimiter}`);

export const isOAuthToolCallContent = (part?: Partial<TMessageContentParts>) => {
  if (part?.type !== ContentTypes.TOOL_CALL || !('tool_call' in part)) {
    return false;
  }
  const { tool_call: toolCall } = part;
  const name = toolCall != null && 'name' in toolCall ? toolCall.name : undefined;
  return isOAuthToolCallName(name);
};

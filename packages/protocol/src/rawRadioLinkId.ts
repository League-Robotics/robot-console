export function rawRadioChildLinkId(relayLinkId: string, channel: number, group: number): string {
  return `radio-ch${channel}-g${group}-via-${relayLinkId}`;
}

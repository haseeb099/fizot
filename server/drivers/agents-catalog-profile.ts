// The OMB_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a turn is shown. Presentation only: the server still authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on. Absent means off. */
  xResearch?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Written into start_thread's schema: the only bot_id it accepts. */
  botId: string;
  /** features.chiefEscalations: raise_escalation is mounted. */
  escalations?: boolean;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's Fizot with a Chief's powers: its notification tools are mounted. */
  mausbot?: boolean;
  /** A person's own request that may pick its computer: select_computer is mounted. Every other turn (a hand-off, a
   * routine, a room, a continuation) is refused a selection, so it is not shown the tool. */
  computerSelection?: boolean;
  /** A room's turn: the widget and page tools and wait_until and cancel_wait, which rooms refuse, are not mounted. */
  room?: boolean;
  /** The bot has a wait in this chat that has not ended: list_waits and cancel_wait, which act only on this chat's
   * waits, are mounted. Without one they still answer a call (agents-catalog.ts callableTools), but are not listed. */
  activeWaits?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.OMB_SKILL_AUTHORING_ENABLED === "1",
    sharedComputers: env.OMB_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.OMB_VOICE_NOTES === "1",
    xResearch: env.OMB_X_RESEARCH === "1",
    cloudHome: env.OMB_CLOUD_HOME === "1",
    memoryEnabled: env.OMB_MEMORY_ENABLED !== "0",
    chief: env.OMB_CHIEF_OF_STAFF === "1",
    botId: env.OMB_BOT_ID ?? "",
    escalations: env.OMB_ESCALATIONS === "1",
    team: env.OMB_TEAM_PEOPLE === "1",
    mausbot: env.OMB_MAUSBOT === "1",
    computerSelection: env.OMB_COMPUTER_SELECTION === "1",
    room: env.OMB_ROOM === "1",
    activeWaits: env.OMB_ACTIVE_WAITS === "1",
  };
}

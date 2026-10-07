// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { handleAimState } from './handlers/aim';
import { handleNpcState, handleNpcClosed } from './handlers/npc';
import { handleQuestMarkers, handleQuestProgress, handleQuestState } from './handlers/quest';
import { handleAchievementUnlocked, handleProgressState, handleProgressUpdate } from './handlers/progress';
import type { NetEventBus } from './events';
import { handleTradeState, handleTradeClosed } from './handlers/trade';
import { handleDamageIndicator, handleExplosionShake } from './handlers/combat';
import { handleContentManifest, handleContentPatch, handleContentTable } from './handlers/content';
import { handleBlueprint, handleCraftStarted } from './handlers/craft';
import {
  handleContainerContents,
  handleInteractionCancelled,
  handleStationClosed,
  handleStationFuel,
  handleStationOpened,
  handleInteractionStarted,
  handleWrongTool,
} from './handlers/interaction';
import {
  handleInventory,
  handleInventorySlot,
  handleItemMods,
  handleSelectedItem,
} from './handlers/inventory';
import {
  handleAlert,
  handleDisconnectReason,
  handleHandshake,
  handleSessionTaken,
} from './handlers/lifecycle';
import {
  handleSkillUnlocked,
  handleCountdown,
  handleGaugeDirections,
  handleGaugeValues,
  handleLapadoneActive,
  handleGaugeRates,
  handleOverheadAlert,
  handlePlayerAte,
  handlePlayerHealed,
  handlePlayerHit,
  handleStamina,
  handleXp,
  handleLevelState,
  handlePoisoned,
  handleRepellentActive,
  handleDrugReset,
} from './handlers/player';
import {
  handleWorstKarmaPlayer,
  handleChatLine,
  handleServerLog,
  handleStatusMessage,
  handleChatAccess,
  handleGroups,
  handleKarma,
  handleLeaderboard,
  handlePlayerNames,
  handlePlayerDied,
  handleYouDied,
  handlePlayerInfo,
  handleScore,
  handleBlockedPlayers,
} from './handlers/social';
import {
  handleTeamMemberJoined,
  handleTeamDeleted,
  handleTeamJoinRequest,
  handleTeamMemberLeft,
  handleTeamCreated,
  handleTeamInvite,
  handleTeamLocked,
  handleTeamNames,
  handlePlayerPositions,
} from './handlers/team';
import {
  handleCityLocations,
  handleMapSize,
  handleEntityUpdates,
  handleWorldTime,
} from './handlers/world';
import { ServerOpcode } from './opcodes';
import { handleAccountRun, handleAccountClans } from './handlers/account-community';

export function dispatchServerMessage(bytes: Uint8Array, bus: NetEventBus): void {
  if (bytes.length === 0) return;
  const op = bytes[0]!;

  switch (op) {
    case ServerOpcode.ACCOUNT_RUN: handleAccountRun(bytes, bus); break;
    case ServerOpcode.ACCOUNT_CLANS: handleAccountClans(bytes, bus); break;
    case ServerOpcode.NPC_STATE: handleNpcState(bytes, bus); break;
    case ServerOpcode.NPC_CLOSED: handleNpcClosed(bytes, bus); break;
    case ServerOpcode.QUEST_STATE: handleQuestState(bytes, bus); break;
    case ServerOpcode.QUEST_PROGRESS: handleQuestProgress(bytes, bus); break;
    case ServerOpcode.QUEST_MARKERS: handleQuestMarkers(bytes, bus); break;
    case ServerOpcode.PROGRESS_STATE: handleProgressState(bytes, bus); break;
    case ServerOpcode.PROGRESS_UPDATE: handleProgressUpdate(bytes, bus); break;
    case ServerOpcode.ACHIEVEMENT_UNLOCKED: handleAchievementUnlocked(bytes, bus); break;
    case ServerOpcode.TRADE_STATE: handleTradeState(bytes, bus); break;
    case ServerOpcode.TRADE_CLOSED: handleTradeClosed(bytes, bus); break;
    case ServerOpcode.ENTITY_UPDATES:
      handleEntityUpdates(bytes, bus);
      break;
    case ServerOpcode.YOU_DIED:
      handleYouDied(bytes, bus);
      break;
    case ServerOpcode.PLAYER_DIED:
      handlePlayerDied(bytes, bus);
      break;
    case ServerOpcode.SESSION_TAKEN:
      handleSessionTaken(bytes, bus);
      break;
    case ServerOpcode.LEADERBOARD:
      handleLeaderboard(bytes, bus);
      break;
    case ServerOpcode.HANDSHAKE:
      handleHandshake(bytes, bus);
      break;
    case ServerOpcode.GAUGE_VALUES:
      handleGaugeValues(bytes, bus);
      break;
    case ServerOpcode.SCORE:
      handleScore(bytes, bus);
      break;
    case ServerOpcode.PLAYER_HIT:
      handlePlayerHit(bytes, bus);
      break;
    case ServerOpcode.OVERHEAD_ALERT:
      handleOverheadAlert(bytes, bus);
      break;
    case ServerOpcode.INVENTORY:
      handleInventory(bytes, bus);
      break;
    case ServerOpcode.SELECTED_ITEM:
      handleSelectedItem(bytes, bus);
      break;
    case ServerOpcode.PLAYER_HEALED:
      handlePlayerHealed(bytes, bus);
      break;
    case ServerOpcode.STAMINA:
      handleStamina(bytes, bus);
      break;
    case ServerOpcode.INTERACTION_STARTED:
      handleInteractionStarted(bytes, bus);
      break;
    case ServerOpcode.INTERACTION_CANCELLED:
      handleInteractionCancelled(bytes, bus);
      break;
    case ServerOpcode.BLUEPRINT:
      handleBlueprint(bytes, bus);
      break;
    case ServerOpcode.XP:
      handleXp(bytes, bus);
      break;
    case ServerOpcode.LEVEL_STATE:
      handleLevelState(bytes, bus);
      break;
    case ServerOpcode.SKILL_UNLOCKED:
      handleSkillUnlocked(bytes, bus);
      break;
    case ServerOpcode.CRAFT_STARTED:
      handleCraftStarted(bytes, bus);
      break;
    case ServerOpcode.STATION_CLOSED:
      handleStationClosed(bytes, bus);
      break;
    case ServerOpcode.STATION_OPENED:
      handleStationOpened(bytes, bus);
      break;
    case ServerOpcode.STATION_FUEL:
      handleStationFuel(bytes, bus);
      break;
    case ServerOpcode.WRONG_TOOL:
      handleWrongTool(bytes, bus);
      break;
    case ServerOpcode.CONTAINER_CONTENTS:
      handleContainerContents(bytes, bus);
      break;
    case ServerOpcode.TEAM_MEMBER_JOINED:
      handleTeamMemberJoined(bytes, bus);
      break;
    case ServerOpcode.TEAM_MEMBER_LEFT:
      handleTeamMemberLeft(bytes, bus);
      break;
    case ServerOpcode.TEAM_DELETED:
      handleTeamDeleted(bytes, bus);
      break;
    case ServerOpcode.TEAM_JOIN_REQUEST:
      handleTeamJoinRequest(bytes, bus);
      break;
    case ServerOpcode.PLAYER_POSITIONS:
      handlePlayerPositions(bytes, bus);
      break;
    case ServerOpcode.KARMA:
      handleKarma(bytes, bus);
      break;
    case ServerOpcode.WORST_KARMA_PLAYER:
      handleWorstKarmaPlayer(bytes, bus);
      break;
    case ServerOpcode.GAUGE_RATES:
      handleGaugeRates(bytes, bus);
      break;
    case ServerOpcode.EXPLOSION_SHAKE:
      handleExplosionShake(bytes, bus);
      break;
    case ServerOpcode.PLAYER_ATE:
      handlePlayerAte(bytes, bus);
      break;
    case ServerOpcode.CITY_LOCATIONS:
      handleCityLocations(bytes, bus);
      break;
    case ServerOpcode.POISONED:
      handlePoisoned(bytes, bus);
      break;
    case ServerOpcode.REPELLENT_ACTIVE:
      handleRepellentActive(bytes, bus);
      break;
    case ServerOpcode.LAPADONE_ACTIVE:
      handleLapadoneActive(bytes, bus);
      break;
    case ServerOpcode.DRUG_RESET:
      handleDrugReset(bytes, bus);
      break;
    case ServerOpcode.COUNTDOWN:
      handleCountdown(bytes, bus);
      break;
    case ServerOpcode.MAP_SIZE:
      handleMapSize(bytes, bus);
      break;
    case ServerOpcode.CHAT_LINE:
      handleChatLine(bytes, bus);
      break;
    case ServerOpcode.SERVER_LOG:
      handleServerLog(bytes, bus);
      break;
    case ServerOpcode.STATUS_MESSAGE:
      handleStatusMessage(bytes, bus);
      break;
    case ServerOpcode.CHAT_ACCESS:
      handleChatAccess(bytes, bus);
      break;
    case ServerOpcode.PLAYER_INFO:
      handlePlayerInfo(bytes, bus);
      break;
    case ServerOpcode.PLAYER_NAMES:
      handlePlayerNames(bytes, bus);
      break;
    case ServerOpcode.ALERT:
      handleAlert(bytes, bus);
      break;
    case ServerOpcode.DISCONNECT_REASON:
      handleDisconnectReason(bytes, bus);
      break;
    case ServerOpcode.TEAM_CREATED:
      handleTeamCreated(bytes, bus);
      break;
    case ServerOpcode.TEAM_NAMES:
      handleTeamNames(bytes, bus);
      break;
    case ServerOpcode.TEAM_INVITE:
      handleTeamInvite(bytes, bus);
      break;
    case ServerOpcode.TEAM_LOCKED:
      handleTeamLocked(bytes, bus);
      break;
    case ServerOpcode.BLOCKED_PLAYERS:
      handleBlockedPlayers(bytes, bus);
      break;
    case ServerOpcode.GROUPS:
      handleGroups(bytes, bus);
      break;
    case ServerOpcode.PONG:
      bus.emit('pong', undefined as unknown as void);
      break;
    case ServerOpcode.GAUGE_DIRECTIONS:
      handleGaugeDirections(bytes, bus);
      break;
    case ServerOpcode.INVENTORY_SLOT:
      handleInventorySlot(bytes, bus);
      break;
    case ServerOpcode.ITEM_MODS:
      handleItemMods(bytes, bus);
      break;
    case ServerOpcode.AIM_STATE:
      handleAimState(bytes, bus);
      break;
    case ServerOpcode.WORLD_TIME:
      handleWorldTime(bytes, bus);
      break;
    case ServerOpcode.DAMAGE_INDICATOR:
      handleDamageIndicator(bytes, bus);
      break;
    case ServerOpcode.CONTENT_MANIFEST:
      handleContentManifest(bytes, bus);
      break;
    case ServerOpcode.CONTENT_TABLE:
      handleContentTable(bytes, bus);
      break;
    case ServerOpcode.CONTENT_PATCH:
      handleContentPatch(bytes, bus);
      break;
    default:
      // Unknown or retired opcode ignored safely
      break;
  }
}

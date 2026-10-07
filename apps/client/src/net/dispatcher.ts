// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { handleAimState } from './handlers/aim';
import { handleNpcState, handleNpcClosed } from './handlers/npc';
import { handleQuestMarkers, handleQuestProgress, handleQuestState } from './handlers/quest';
import { handleAchievementUnlocked, handleProgressState, handleProgressUpdate } from './handlers/progress';
import type { NetEventBus } from './events';
import { handleTradeState, handleTradeClosed } from './handlers/trade';
import { handleDamageIndicator, handleShakeExplosionState } from './handlers/combat';
import { handleContentManifest, handleContentPatch, handleContentTable } from './handlers/content';
import { handleBlueprint, handleStartCraft } from './handlers/craft';
import {
  handleFullChest,
  handleInterruptInteraction,
  handleLostBuilding,
  handleNewFuelValue,
  handleOpenBuilding,
  handleStartInteraction,
  handleWrongTool,
} from './handlers/interaction';
import {
  handleFullInventory,
  handleInventorySlot,
  handleItemMods,
  handleSelectedItem,
} from './handlers/inventory';
import {
  handleAlert,
  handleDisconnectReason,
  handleFailRestoreSession,
  handleFull,
  handleHandshake,
  handleKickInactivity,
  handleMute,
  handleOldVersion,
  handleStoleYourSession,
  handleWrongPassword,
} from './handlers/lifecycle';
import {
  handleBoughtSkill,
  handleDramaticChrono,
  handleGaugeState,
  handleGauges,
  handleLapadoine,
  handleModdedGaugesValues,
  handleNotification,
  handlePlayerEat,
  handlePlayerHeal,
  handlePlayerHit,
  handlePlayerLife,
  handlePlayerStamina,
  handlePlayerXp,
  handlePlayerXpSkill,
  handlePoisoned,
  handleRepellent,
  handleResetDrug,
} from './handlers/player';
import {
  handleBadKarma,
  handleChatChannel,
  handleServerLog,
  handleStatusMessage,
  handleChatAccess,
  handleGroups,
  handleKarma,
  handleLeaderboard,
  handleNicknames,
  handleOtherDie,
  handlePlayerDie,
  handlePlayerInfo,
  handleScore,
  handleBlockedPlayers,
} from './handlers/social';
import {
  handleAcceptedTeam,
  handleDeleteTeam,
  handleJoinTeam,
  handleKickedTeam,
  handleTeamCreated,
  handleTeamInvite,
  handleTeamLocked,
  handleTeamNames,
  handleTeamPosition,
} from './handlers/team';
import {
  handleAreas,
  handleCitiesLocation,
  handleMapSize,
  handleUnits,
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
    case ServerOpcode.UNITS:
      handleUnits(bytes, bus);
      break;
    case ServerOpcode.OLD_VERSION:
      handleOldVersion(bytes, bus);
      break;
    case ServerOpcode.FULL:
      handleFull(bytes, bus);
      break;
    case ServerOpcode.PLAYER_DIE:
      handlePlayerDie(bytes, bus);
      break;
    case ServerOpcode.OTHER_DIE:
      handleOtherDie(bytes, bus);
      break;
    case ServerOpcode.FAIL_RESTORE_SESSION:
      handleFailRestoreSession(bytes, bus);
      break;
    case ServerOpcode.STOLE_YOUR_SESSION:
      handleStoleYourSession(bytes, bus);
      break;
    case ServerOpcode.MUTE:
      handleMute(bytes, bus);
      break;
    case ServerOpcode.LEADERBOARD:
      handleLeaderboard(bytes, bus);
      break;
    case ServerOpcode.HANDSHAKE:
      handleHandshake(bytes, bus);
      break;
    case ServerOpcode.KICK_INACTIVITY:
      handleKickInactivity(bytes, bus);
      break;
    case ServerOpcode.GAUGES:
      handleGauges(bytes, bus);
      break;
    case ServerOpcode.SCORE:
      handleScore(bytes, bus);
      break;
    case ServerOpcode.PLAYER_HIT:
      handlePlayerHit(bytes, bus);
      break;
    case ServerOpcode.NOTIFICATION:
      handleNotification(bytes, bus);
      break;
    case ServerOpcode.FULL_INVENTORY:
      handleFullInventory(bytes, bus);
      break;
    case ServerOpcode.PLAYER_LIFE:
      handlePlayerLife(bytes, bus);
      break;
    case ServerOpcode.SELECTED_ITEM:
      handleSelectedItem(bytes, bus);
      break;
    case ServerOpcode.PLAYER_HEAL:
      handlePlayerHeal(bytes, bus);
      break;
    case ServerOpcode.PLAYER_STAMINA:
      handlePlayerStamina(bytes, bus);
      break;
    case ServerOpcode.START_INTERACTION:
      handleStartInteraction(bytes, bus);
      break;
    case ServerOpcode.INTERRUPT_INTERACTION:
      handleInterruptInteraction(bytes, bus);
      break;
    case ServerOpcode.BLUEPRINT:
      handleBlueprint(bytes, bus);
      break;
    case ServerOpcode.PLAYER_XP:
      handlePlayerXp(bytes, bus);
      break;
    case ServerOpcode.PLAYER_XP_SKILL:
      handlePlayerXpSkill(bytes, bus);
      break;
    case ServerOpcode.BOUGHT_SKILL:
      handleBoughtSkill(bytes, bus);
      break;
    case ServerOpcode.START_CRAFT:
      handleStartCraft(bytes, bus);
      break;
    case ServerOpcode.LOST_BUILDING:
      handleLostBuilding(bytes, bus);
      break;
    case ServerOpcode.OPEN_BUILDING:
      handleOpenBuilding(bytes, bus);
      break;
    case ServerOpcode.NEW_FUEL_VALUE:
      handleNewFuelValue(bytes, bus);
      break;
    case ServerOpcode.WRONG_TOOL:
      handleWrongTool(bytes, bus);
      break;
    case ServerOpcode.FULL_CHEST:
      handleFullChest(bytes, bus);
      break;
    case ServerOpcode.ACCEPTED_TEAM:
      handleAcceptedTeam(bytes, bus);
      break;
    case ServerOpcode.KICKED_TEAM:
      handleKickedTeam(bytes, bus);
      break;
    case ServerOpcode.DELETE_TEAM:
      handleDeleteTeam(bytes, bus);
      break;
    case ServerOpcode.JOIN_TEAM:
      handleJoinTeam(bytes, bus);
      break;
    case ServerOpcode.TEAM_POSITION:
      handleTeamPosition(bytes, bus);
      break;
    case ServerOpcode.KARMA:
      handleKarma(bytes, bus);
      break;
    case ServerOpcode.BAD_KARMA:
      handleBadKarma(bytes, bus);
      break;
    case ServerOpcode.AREAS:
      handleAreas(bytes, bus);
      break;
    case ServerOpcode.WRONG_PASSWORD:
      handleWrongPassword(bytes, bus);
      break;
    case ServerOpcode.MODDED_GAUGES_VALUES:
      handleModdedGaugesValues(bytes, bus);
      break;
    case ServerOpcode.SHAKE_EXPLOSION_STATE:
      handleShakeExplosionState(bytes, bus);
      break;
    case ServerOpcode.PLAYER_EAT:
      handlePlayerEat(bytes, bus);
      break;
    case ServerOpcode.CITIES_LOCATION:
      handleCitiesLocation(bytes, bus);
      break;
    case ServerOpcode.POISONED:
      handlePoisoned(bytes, bus);
      break;
    case ServerOpcode.REPELLENT:
      handleRepellent(bytes, bus);
      break;
    case ServerOpcode.LAPADOINE:
      handleLapadoine(bytes, bus);
      break;
    case ServerOpcode.RESET_DRUG:
      handleResetDrug(bytes, bus);
      break;
    case ServerOpcode.DRAMATIC_CHRONO:
      handleDramaticChrono(bytes, bus);
      break;
    case ServerOpcode.MAP_SIZE:
      handleMapSize(bytes, bus);
      break;
    case ServerOpcode.CHAT_CHANNEL:
      handleChatChannel(bytes, bus);
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
    case ServerOpcode.NICKNAMES:
      handleNicknames(bytes, bus);
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
    case ServerOpcode.GAUGE_STATE:
      handleGaugeState(bytes, bus);
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

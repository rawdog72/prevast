// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/game.h"

// Clans and teams: creation, membership, the join/kick/leave flow, and the
// per-tick team position broadcast. A self-contained social layer -- it touches
// players and the protocol but nothing in the world simulation -- lifted out of
// game.cpp (2026-08-03) for the same reason as game_admin.cpp.

#include "content/configmanager.h"
#include "gameplay/creature.h"
#include "core/scheduler.h"
#include "network/outputmessage.h"

#include <algorithm>

// Semantic rate-limit check with a 150ms grace period to accommodate network jitter, clock skew, and tick boundaries.
static bool clanDelayElapsed(uint64_t lastTime, uint64_t now)
{
	uint64_t delay = ConfigManager::getNumber(ConfigManager::CLAN_ACTION_DELAY);
	constexpr uint64_t kJitterTolerance = 150;
	if (delay > kJitterTolerance) {
		delay -= kJitterTolerance;
	} else {
		delay = 0;
	}
	return now - lastTime >= delay;
}

bool Game::playerCreateClan(uint32_t playerId, const std::string& name)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return false;

	const GameMode* mode = getActiveMode();
	if (!mode || !mode->clansEnabled || !mode->clansCanCreate) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(player->lastClanCreateTime, now)) return false;

	if (player->clanId != -1) {
		Clan* currentClan = getClanById(player->clanId);
		if (!currentClan || currentClan->members.find(player->getGUID()) == currentClan->members.end()) {
			player->clanId = -1;
			player->isClanLeader = false;
		} else {
			return false;
		}
	}

	if (name.empty() || name.length() > 5) return false;

	std::string upperName;
	for (char c : name) {
		if (std::isalnum(static_cast<unsigned char>(c))) {
			upperName += std::toupper(static_cast<unsigned char>(c));
		} else {
			return false;
		}
	}

	for (const auto& [id, clan] : clans) {
		if (clan.name == upperName) return false;
	}

	if (clans.size() >= mode->clansMaxClans) return false;

	uint8_t freeId = 0;
	while (freeId < mode->clansMaxClans) {
		if (clans.find(freeId) == clans.end()) {
			break;
		}
		freeId++;
	}
	if (freeId >= mode->clansMaxClans) return false;

	Clan newClan;
	newClan.id = freeId;
	newClan.name = upperName;
	newClan.leaderGuid = player->getGUID();
	newClan.members.insert(player->getGUID());
	newClan.locked = false;
	clans[freeId] = newClan;

	player->clanId = freeId;
	player->isClanLeader = true;
	player->lastClanCreateTime = now;
	player->lastClanActionTime = now;

	// Cross-clan hygiene: purge player's GUID from all pending join requests
	forgetClanApplications(player->getGUID());

	// Broadcast new team
	NetworkMessage newTeamMsg;
	ProtocolGame::buildTeamCreatedMessage(freeId, player->getGUID(), upperName, newTeamMsg);
	broadcastPacket(newTeamMsg);
	broadcastServerLog(ServerLogKind::CLAN_CREATED, static_cast<uint8_t>(player->getGUID()), 0, upperName);

	// Broadcast accepted team
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::ACCEPTED_TEAM));
	msg.addByte(static_cast<uint8_t>(player->getGUID()));
	msg.addByte(freeId);
	broadcastPacket(msg);

	if (player->client) {
		player->client->flushOutputBatch();
	}

	return true;
}

bool Game::playerDeleteClan(uint32_t playerId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(player->lastClanDeleteTime, now)) return false;

	if (player->clanId == -1 || !player->isClanLeader) return false;

	uint8_t cid = static_cast<uint8_t>(player->clanId);
	player->lastClanDeleteTime = now;
	player->lastClanActionTime = now;
	disbandClan(cid);
	return true;
}

void Game::disbandClan(uint8_t clanId)
{
	auto it = clans.find(clanId);
	if (it == clans.end()) return;

	Clan clan = it->second; // copy since we erase
	clans.erase(it);
	broadcastServerLog(ServerLogKind::CLAN_DISBANDED, 0, 0, clan.name);

	// Send delete team packet to everyone first so client can reset teamLeader status
	NetworkMessage deleteMsg;
	deleteMsg.addByte(static_cast<uint8_t>(ServerOpcode::DELETE_TEAM));
	deleteMsg.addByte(clanId);
	broadcastPacket(deleteMsg);

	for (uint32_t mGuid : clan.members) {
		forgetClanApplications(mGuid);
		Player* m = getPlayerByGUID(mGuid);
		if (m) {
			m->clanId = -1;
			m->isClanLeader = false;
		}
		// Send kicked team packet for all members to everyone
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::KICKED_TEAM));
		msg.addByte(static_cast<uint8_t>(mGuid));
		broadcastPacket(msg);
	}
}

// Clan lookup that never creates entries: clans[] with a stale id would
// silently insert a phantom empty clan.
Clan* Game::getClanById(int16_t clanId)
{
	if (clanId < 0) return nullptr;
	auto it = clans.find(static_cast<uint8_t>(clanId));
	return it != clans.end() ? &it->second : nullptr;
}

// getClanById already rejects a negative (clanless) id.
bool Game::sharesClanWith(const Player* player, uint32_t otherGuid)
{
	if (!player) {
		return false;
	}
	const Clan* clan = getClanById(player->clanId);
	return clan && clan->members.find(otherGuid) != clan->members.end();
}

bool Game::playerRequestJoinClan(uint32_t playerId, uint8_t clanId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(player->lastClanJoinRequestTime, now)) return false;

	if (player->clanId != -1) {
		Clan* currentClan = getClanById(player->clanId);
		if (!currentClan || currentClan->members.find(player->getGUID()) == currentClan->members.end()) {
			// Stale clan state: player is not actually in this clan's member list
			player->clanId = -1;
			player->isClanLeader = false;
		} else if (player->clanId == clanId) {
			// Player is already in this clan; re-send ACCEPTED_TEAM to resync client state
			if (player->client) {
				NetworkMessage msg;
				msg.addByte(static_cast<uint8_t>(ServerOpcode::ACCEPTED_TEAM));
				msg.addByte(static_cast<uint8_t>(player->getGUID()));
				msg.addByte(static_cast<uint8_t>(clanId));
				player->client->writeToOutputBuffer(msg);
			}
			return true;
		} else {
			return false;
		}
	}

	auto it = clans.find(clanId);
	if (it == clans.end()) return false;

	const GameMode* mode = getActiveMode();
	const uint32_t maxMembers = mode ? mode->clansMaxMembers : 9;

	Clan& clan = it->second;
	if (clan.locked) {
		sendStatus(player, "That clan takes members by invitation only.", StatusKind::FAILURE);
		return false;
	}
	if (clan.members.size() >= maxMembers) {
		sendStatus(player, "That clan is full.", StatusKind::FAILURE);
		return false;
	}

	clan.joinRequests.insert(player->getGUID());
	player->lastClanJoinRequestTime = now;
	player->lastClanActionTime = now;

	Player* leader = getPlayerByGUID(clan.leaderGuid);
	if (leader && leader->client) {
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::JOIN_TEAM));
		msg.addByte(static_cast<uint8_t>(player->getGUID()));
		leader->client->writeToOutputBuffer(msg);
		leader->client->flushOutputBatch();
	}
	return true;
}

bool Game::playerAcceptJoinClan(uint32_t playerId, uint32_t applicantGuid)
{
	Player* leader = getPlayerByID(playerId);
	if (!leader) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(leader->lastClanManageTime, now)) return false;

	if (leader->clanId == -1 || !leader->isClanLeader) return false;

	Clan* clanPtr = getClanById(leader->clanId);
	if (!clanPtr) return false;
	Clan& clan = *clanPtr;

	const GameMode* mode = getActiveMode();
	const uint32_t maxMembers = mode ? mode->clansMaxMembers : 9;
	if (clan.members.size() >= maxMembers) return false;

	auto rit = clan.joinRequests.find(applicantGuid);
	if (rit == clan.joinRequests.end()) return false;

	Player* applicant = getPlayerByGUID(applicantGuid);
	if (!applicant || applicant->clanId != -1) {
		clan.joinRequests.erase(rit);
		return false;
	}

	clan.joinRequests.erase(rit);
	leader->lastClanManageTime = now;
	leader->lastClanActionTime = now;
	joinClan(clan, applicant, now);
	if (leader->client) {
		leader->client->flushOutputBatch();
	}

	return true;
}

bool Game::playerKickClanMember(uint32_t playerId, uint32_t memberGuid)
{
	Player* leader = getPlayerByID(playerId);
	if (!leader) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(leader->lastClanManageTime, now)) return false;

	if (leader->clanId == -1 || !leader->isClanLeader) return false;

	Clan* clanPtr = getClanById(leader->clanId);
	if (!clanPtr) return false;
	Clan& clan = *clanPtr;

	if (clan.members.find(memberGuid) == clan.members.end()) return false;
	if (memberGuid == leader->getGUID()) return false;

	clan.members.erase(memberGuid);
	leader->lastClanManageTime = now;
	leader->lastClanActionTime = now;

	Player* member = getPlayerByGUID(memberGuid);
	if (member) {
		member->clanId = -1;
		member->isClanLeader = false;
		member->lastClanActionTime = now;
	}

	forgetClanApplications(memberGuid);

	// Broadcast kicked team
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::KICKED_TEAM));
	msg.addByte(static_cast<uint8_t>(memberGuid));
	broadcastPacket(msg);
	broadcastServerLog(ServerLogKind::CLAN_KICKED, static_cast<uint8_t>(memberGuid), 0, clan.name);
	return true;
}

bool Game::playerLeaveClan(uint32_t playerId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(player->lastClanLeaveTime, now)) return false;

	const uint32_t guid = player->getGUID();

	// Clean up any pending join requests across all clans
	forgetClanApplications(guid);

	if (player->clanId == -1 || player->isClanLeader) return false;

	Clan* clanPtr = getClanById(player->clanId);
	if (!clanPtr) {
		// Stale clan id: clean up the player state without touching the map
		player->clanId = -1;
		player->isClanLeader = false;
		return false;
	}
	Clan& clan = *clanPtr;

	clan.members.erase(guid);
	player->clanId = -1;
	player->isClanLeader = false;
	player->lastClanLeaveTime = now;
	player->lastClanActionTime = now;

	// Broadcast kicked team
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::KICKED_TEAM));
	msg.addByte(static_cast<uint8_t>(guid));
	broadcastPacket(msg);
	broadcastServerLog(ServerLogKind::CLAN_LEFT, static_cast<uint8_t>(guid), 0, clan.name);
	return true;
}

bool Game::playerLockClan(uint32_t playerId)
{
	Player* leader = getPlayerByID(playerId);
	if (!leader) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(leader->lastClanManageTime, now)) return false;

	if (leader->clanId == -1 || !leader->isClanLeader) return false;

	Clan* clan = getClanById(leader->clanId);
	if (!clan) return false;
	clan->locked = true;
	leader->lastClanManageTime = now;
	NetworkMessage msg;
	ProtocolGame::buildTeamLockedMessage(clan->id, true, msg);
	broadcastPacket(msg);
	return true;
}

bool Game::playerUnlockClan(uint32_t playerId)
{
	Player* leader = getPlayerByID(playerId);
	if (!leader) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(leader->lastClanManageTime, now)) return false;

	if (leader->clanId == -1 || !leader->isClanLeader) return false;

	Clan* clan = getClanById(leader->clanId);
	if (!clan) return false;
	clan->locked = false;
	leader->lastClanManageTime = now;
	NetworkMessage msg;
	ProtocolGame::buildTeamLockedMessage(clan->id, false, msg);
	broadcastPacket(msg);
	return true;
}

bool Game::playerInviteToClan(uint32_t playerId, uint8_t targetGuid)
{
	Player* leader = getPlayerByID(playerId);
	if (!leader) return false;

	uint64_t now = OTSYS_TIME();
	if (!clanDelayElapsed(leader->lastClanManageTime, now)) return false;

	if (leader->clanId == -1 || !leader->isClanLeader) return false;
	Clan* clan = getClanById(leader->clanId);
	if (!clan) return false;

	Player* target = getPlayerByGUID(targetGuid);
	if (!target || target == leader || target->isGhoul()) return false;
	if (target->clanId != -1) {
		sendStatus(leader, target->getName() + " is already in a clan.", StatusKind::FAILURE);
		return false;
	}
	const GameMode* mode = getActiveMode();
	const uint32_t maxMembers = mode ? mode->clansMaxMembers : 9;
	if (clan->members.size() >= maxMembers) {
		sendStatus(leader, "Your clan is full.", StatusKind::FAILURE);
		return false;
	}
	if (target->hasBlocked(leader->getGUID())) {
		sendStatus(leader, target->getName() + " is not accepting your invitations.", StatusKind::FAILURE);
		return false;
	}

	clan->invites.insert(target->getGUID());
	leader->lastClanManageTime = now;
	leader->lastClanActionTime = now;

	if (target->client) {
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::TEAM_INVITE));
		msg.addByte(clan->id);
		msg.addByte(static_cast<uint8_t>(leader->getGUID()));
		target->client->writeToOutputBuffer(msg);
		target->client->flushOutputBatch();
	}
	sendStatus(leader, "Invitation sent to " + target->getName() + ".");
	return true;
}

bool Game::playerAcceptClanInvite(uint32_t playerId, uint8_t clanId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return false;
	if (player->clanId != -1) return false;

	auto it = clans.find(clanId);
	if (it == clans.end() || !it->second.invites.contains(player->getGUID())) {
		sendStatus(player, "That invitation is no longer open.", StatusKind::FAILURE);
		return false;
	}
	Clan& clan = it->second;
	const GameMode* mode = getActiveMode();
	const uint32_t maxMembers = mode ? mode->clansMaxMembers : 9;
	if (clan.members.size() >= maxMembers) {
		clan.invites.erase(player->getGUID());
		sendStatus(player, "That clan is full.", StatusKind::FAILURE);
		return false;
	}

	joinClan(clan, player, OTSYS_TIME());
	return true;
}

void Game::forgetClanApplications(uint32_t guid)
{
	for (auto& [cid, c] : clans) {
		c.joinRequests.erase(guid);
		c.invites.erase(guid);
	}
}

void Game::joinClan(Clan& clan, Player* newcomer, uint64_t now)
{
	const uint32_t guid = newcomer->getGUID();
	clan.members.insert(guid);
	newcomer->clanId = clan.id;
	newcomer->isClanLeader = false;
	newcomer->lastClanActionTime = now;

	// Cross-clan hygiene: a member asks and is invited nowhere else.
	forgetClanApplications(guid);

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::ACCEPTED_TEAM));
	msg.addByte(static_cast<uint8_t>(guid));
	msg.addByte(clan.id);
	broadcastPacket(msg);
	broadcastServerLog(ServerLogKind::CLAN_JOINED, static_cast<uint8_t>(guid), 0, clan.name);

	if (newcomer->client) {
		newcomer->client->flushOutputBatch();
	}
}

void Game::removePlayerFromClan(Player* player)
{
	if (!player) return;

	const uint32_t guid = player->getGUID();

	// Clean up any pending join requests across all clans
	forgetClanApplications(guid);

	if (player->clanId == -1) return;

	uint8_t cid = static_cast<uint8_t>(player->clanId);
	auto it = clans.find(cid);
	if (it == clans.end()) {
		player->clanId = -1;
		player->isClanLeader = false;
		return;
	}

	Clan& clan = it->second;
	if (clan.leaderGuid == guid) {
		disbandClan(cid);
	} else {
		clan.members.erase(guid);
		player->clanId = -1;
		player->isClanLeader = false;
		player->lastClanActionTime = OTSYS_TIME();

		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::KICKED_TEAM));
		msg.addByte(static_cast<uint8_t>(guid));
		broadcastPacket(msg);
	}
}

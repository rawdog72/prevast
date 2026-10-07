// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/game.h"
#include "gameplay/agent.h"
#include "gameplay/npc.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "network/opcodes.h"

// Right-click > Look on something in the world: one line on the looker's
// status line ("You see a wooden wall. It has 2400/3000 health."). Read-only
// and answered to the looker alone. The wire budget (ProtocolGame) and the
// screen-sized range below keep it from being a remote scanner or a flood.

namespace {
// About a screen: what the looker can see anyway, no further.
constexpr int32_t LOOK_RANGE = 1200;

std::string humanize(std::string key) {
    std::replace(key.begin(), key.end(), '_', ' ');
    return key;
}

std::string withArticle(const std::string& name) {
    if (name.empty()) return "something";
    const char first = static_cast<char>(std::tolower(static_cast<unsigned char>(name[0])));
    return (std::string("aeiou").find(first) != std::string::npos ? "an " : "a ") + name;
}

std::string healthLine(uint32_t health, uint32_t healthMax) {
    if (healthMax == 0) return "";
    return " It has " + std::to_string(std::min(health, healthMax)) + "/" + std::to_string(healthMax) + " health.";
}
}

void Game::sendStatus(Player* player, const std::string& text, StatusKind kind) {
    if (!player || text.empty()) return;
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::STATUS_MESSAGE));
    msg.addByte(static_cast<uint8_t>(kind));
    msg.addString(text);
    player->sendNetworkMessage(msg);
}

std::string Game::describeObject(const Player* looker, const Object& obj, bool admin) {
    const ObjectData* od = obj.getData();
    if (!od) return "";
    const ItemData* item = ItemManager::getInstance().getItemData(od->key);
    std::string text = "You see " + withArticle(item && !item->name.empty() ? item->name : humanize(od->key)) + ".";
    text += healthLine(obj.getHealth(), obj.getMaxHealth());

    // Who placed it is the owner's clan's business (and an admin's), not a
    // raider's. An owner who is offline cannot be named: clans and names are
    // only known for players online.
    const uint32_t ownerGuid = obj.getOwnerPid();
    if (ownerGuid == std::numeric_limits<uint32_t>::max()) {
        if (admin) text += " Its owner is offline.";
    } else if (ownerGuid != 0 && (admin || isOwnerOrClanmate(ownerGuid, looker))) {
        if (ownerGuid == looker->getGUID()) text += " You placed it.";
        else if (const Player* owner = getPlayerByGUID(ownerGuid)) text += " Placed by " + owner->getName() + ".";
    }
    return text;
}

void Game::playerLook(uint32_t playerId, ClientEntityId entityId, uint8_t targetGuid) {
    Player* player = getPlayerByID(playerId);
    if (!player) return;
    const bool admin = player->getAuthorityRank() > 0;

    // entityId 0 is a player, addressed by guid like every player on the wire.
    // Everything else is a world entity, addressed by its id16.
    Position where;
    std::string text;
    uint32_t uid = 0;
    if (entityId == 0) {
        Player* target = getPlayerByGUID(targetGuid);
        if (!target || target->isGhostMode()) return;
        where = target->getPosition();
        uid = target->getID();
        // A guest may join without a name.
        const std::string who = target->getName().empty() ? std::string("a player without a name") : target->getName();
        text = "You see " + (target == player ? std::string("yourself") : who) + (target->isGhoul() ? ", a ghoul." : ".");
        // Staff say so (tutor, gamemaster, admin); an ordinary player's group
        // is rank 0 and goes unmentioned.
        const Group& group = target->getGroup();
        if (group.rank > 0 && !group.name.empty()) {
            const std::string subject = target == player ? std::string("You are ")
                : target->getName().empty() ? std::string("This player is ") : target->getName() + " is ";
            text += " " + subject + withArticle(humanize(group.name)) + ".";
        }
        if (target->clanId >= 0) {
            const auto clan = clans.find(static_cast<uint8_t>(target->clanId));
            if (clan != clans.end()) text += " Member of [" + clan->second.name + "].";
        }
    } else {
        uid = map.fullIdForId16(entityId);
        Thing* thing = uid ? map.getThingByID(uid) : nullptr;
        if (!thing) return;
        where = thing->getPosition();
        if (const Object* obj = thing->getObject()) {
            text = describeObject(player, *obj, admin);
        } else if (const Agent* agent = thing->getAgent()) {
            const AgentData* data = agent->getData();
            const std::string name = !agent->getName().empty() ? agent->getName() : humanize(data ? data->key : "creature");
            text = "You see " + withArticle(name) + "." + healthLine(agent->getHealth(), data ? data->health : 0);
        } else if (const Npc* npc = thing->getNpc()) {
            text = "You see " + npc->definition->name + ".";
        } else if (const Resource* resource = thing->getResource()) {
            const ResourceData* data = g_resources.getResourceData(resource->getResourceId());
            text = "You see " + withArticle(humanize(data ? data->key : "resource")) + ".";
        }
    }
    if (text.empty()) return;

    const Position& from = player->getPosition();
    if (std::abs(int32_t(from.x) - int32_t(where.x)) > LOOK_RANGE ||
        std::abs(int32_t(from.y) - int32_t(where.y)) > LOOK_RANGE) return;

    if (admin) {
        text += " [" + std::to_string(where.x) + ", " + std::to_string(where.y) +
            " | tile " + std::to_string(where.x / TILE_SIZE) + ", " + std::to_string(where.y / TILE_SIZE) +
            " | id " + std::to_string(uid) + "]";
    }
    sendStatus(player, text);
}

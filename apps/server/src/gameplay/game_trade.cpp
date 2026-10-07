// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/game.h"
#include "gameplay/loot.h"
#include "network/opcodes.h"

namespace {
bool tradeParticipantReady(const Player* p) {
    return p && p->getProtocolGame() && p->getHealth() > 0 && !p->isGhoul();
}
bool tradeInRange(const Player* a, const Player* b) {
    const auto& x = a->getPosition();
    const auto& y = b->getPosition();
    return std::abs(int(x.x) - int(y.x)) <= TRADE_RANGE_TILES * TILE_SIZE &&
           std::abs(int(x.y) - int(y.y)) <= TRADE_RANGE_TILES * TILE_SIZE;
}
void tradeNotice(Player* p, const std::string& text) {
    if (!p) return;
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::ALERT));
    msg.addString(text);
    p->sendNetworkMessage(msg);
}
void tradeWriteOffer(NetworkMessage& msg, const std::vector<TradeItem>& items) {
    msg.addByte(static_cast<uint8_t>(items.size()));
    for (const auto& item : items) {
        msg.addByte(static_cast<uint8_t>(item.uid));
        msg.add<uint16_t>(item.iid);
        msg.addByte(item.count);
        msg.addByte(item.state.ammo);
        appendWeaponMods(msg, item.state.mods);
    }
}
}

void Game::sendTradeState(const TradeSession& trade) {
    for (int side = 0; side < 2; ++side) {
        Player* p = getPlayerByID(trade.players[side]);
        Player* peer = getPlayerByID(trade.players[1 - side]);
        if (!p || !peer) continue;
        NetworkMessage msg;
        msg.addByte(static_cast<uint8_t>(ServerOpcode::TRADE_STATE));
        msg.add<uint32_t>(trade.id);
        msg.add<uint32_t>(trade.revision);
        msg.addByte(static_cast<uint8_t>(peer->getGUID()));
        msg.addByte(trade.open ? 2 : static_cast<uint8_t>(side));
        msg.addByte((trade.accepted[side] ? 1 : 0) | (trade.accepted[1 - side] ? 2 : 0));
        msg.addByte(TRADE_RANGE_TILES);
        tradeWriteOffer(msg, trade.offers[side]);
        tradeWriteOffer(msg, trade.offers[1 - side]);
        p->sendNetworkMessage(msg);
    }
}

bool Game::isOfferedInTrade(uint32_t playerId, uint32_t uid) const
{
	const auto it = trades.find(playerId);
	if (it == trades.end()) return false;
	const TradeSession& trade = *it->second;
	const int side = trade.players[0] == playerId ? 0 : 1;
	for (const TradeItem& item : trade.offers[side]) {
		if (item.uid == uid) return true;
	}
	return false;
}

void Game::cancelTrade(uint32_t playerId, const std::string& reason) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    trades.erase(trade->players[0]);
    trades.erase(trade->players[1]);
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::TRADE_CLOSED));
    msg.add<uint32_t>(trade->id);
    msg.addString(reason);
    for (uint32_t id : trade->players) {
        if (Player* p = getPlayerByID(id)) p->sendNetworkMessage(msg);
    }
}

bool Game::validateTrade(const TradeSession& trade) {
    Player* a = getPlayerByID(trade.players[0]);
    Player* b = getPlayerByID(trade.players[1]);
    std::string reason;
    if (!tradeParticipantReady(a) || !tradeParticipantReady(b)) reason = "Trade cancelled: player unavailable.";
    else if (!tradeInRange(a, b)) reason = "Trade cancelled: stay within 2 tiles of each other.";
    else if (OTSYS_TIME() >= trade.expiresAt) reason = "Trade request or idle trade expired.";
    else {
        for (int side = 0; side < 2; ++side) {
            auto& inv = (side == 0 ? a : b)->inventory;
            for (const auto& offered : trade.offers[side]) {
                int8_t slot = inv.findItemByUidSlot(offered.uid, offered.iid);
                Item* item = slot < 0 ? nullptr : inv.getItem(static_cast<uint8_t>(slot));
                if (!item || item->getUID() != offered.uid || item->getCount() != offered.inventoryCount ||
                    item->getAmmo() != offered.state.ammo || item->getMods() != offered.state.mods ||
                    offered.count > item->getCount()) {
                    reason = "Trade cancelled: an offered item changed.";
                    break;
                }
            }
        }
    }
    if (reason.empty()) return true;
    cancelTrade(trade.players[0], reason);
    return false;
}

void Game::updateTrades() {
    // validateTrade may erase both entries; shared ownership keeps the current session alive.
    std::vector<std::shared_ptr<TradeSession>> pending;
    for (const auto& entry : trades) {
        if (entry.first == entry.second->players[0]) pending.push_back(entry.second);
    }
    for (const auto& trade : pending) validateTrade(*trade);
}

void Game::tradeInventoryChanged(uint32_t playerId, uint32_t uid, uint16_t iid, uint8_t count, uint8_t ammo) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    const int side = trade->players[0] == playerId ? 0 : 1;
    for (auto& item : trade->offers[side]) {
        if (item.uid != uid || (item.iid == iid && item.inventoryCount == count && item.state.ammo == ammo)) continue;
        // A perishable's ammo byte is its freshness: the stage moving is the
        // item ageing on its own, not the owner changing the deal, so the offer
        // follows it and both windows are told.
        const auto* data = ItemManager::getInstance().getItemData(iid);
        if (item.iid == iid && item.inventoryCount == count && data && data->decayTimeMs > 0) {
            item.state.ammo = ammo;
            ++trade->revision;
            sendTradeState(*trade);
            return;
        }
        cancelTrade(playerId, "Trade cancelled: an offered item changed.");
        return;
    }
}

void Game::tradeItemReplaced(uint32_t playerId, uint32_t oldUid, uint16_t newIid, uint32_t newUid, uint8_t count, uint8_t ammo) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    auto& offers = trade->offers[trade->players[0] == playerId ? 0 : 1];
    auto offer = std::find_if(offers.begin(), offers.end(), [oldUid](const TradeItem& item) { return item.uid == oldUid; });
    if (offer == offers.end()) return;
    if (newIid == 0) {
        offers.erase(offer);
    } else {
        offer->iid = newIid;
        offer->uid = newUid;
        offer->state = ItemState::withAmmo(ammo);
        offer->inventoryCount = count;
        offer->count = std::min(offer->count, count);
        offer->decayProgress = 0;
    }
    // The goods are not what was agreed to (an orange is now a rotten orange),
    // so both sides confirm again.
    trade->accepted[0] = trade->accepted[1] = false;
    ++trade->revision;
}

void Game::resendTrade(uint32_t playerId) {
    auto it = trades.find(playerId);
    if (it != trades.end()) sendTradeState(*it->second);
}

void Game::playerRequestTrade(uint32_t playerId, uint8_t targetGuid) {
    Player* p = getPlayerByID(playerId);
    Player* peer = getPlayerByGUID(targetGuid);
    if (!tradeParticipantReady(p)) return;
    if (!tradeParticipantReady(peer) || p == peer) { tradeNotice(p, "That player is unavailable for trading."); return; }
    if (!tradeInRange(p, peer)) { tradeNotice(p, "Move within 2 tiles to trade."); return; }
    if (g_npcs.active(playerId) || g_npcs.active(peer->getID()) || trades.count(playerId) || trades.count(peer->getID())) { tradeNotice(p, "A player is already trading or has a pending request."); return; }
    auto trade = std::make_shared<TradeSession>();
    if (++nextTradeId == 0) ++nextTradeId;
    trade->id = nextTradeId;
    trade->players[0] = playerId;
    trade->players[1] = peer->getID();
    trade->expiresAt = OTSYS_TIME() + 30000;
    trades[playerId] = trades[peer->getID()] = trade;
    sendTradeState(*trade);
}

void Game::playerReplyTrade(uint32_t playerId, uint32_t sessionId, bool accept) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    if (trade->id != sessionId || trade->open || trade->players[1] != playerId) return;
    if (!accept) { cancelTrade(playerId, "Trade request declined."); return; }
    if (!validateTrade(*trade)) return;
    trade->open = true;
    ++trade->revision;
    trade->expiresAt = OTSYS_TIME() + 300000;
    for (uint32_t id : trade->players) {
        playerCloseContainer(id);
        Player* p = getPlayerByID(id);
        p->handleMouseUp();
        p->cancelAction();
        p->cancelReload();
        p->cancelModChange();
    }
    sendTradeState(*trade);
}

void Game::playerOfferTrade(uint32_t playerId, uint32_t sessionId, uint32_t revision, uint16_t iid, uint8_t uid, uint8_t count) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    if (trade->id != sessionId || !trade->open || !validateTrade(*trade)) return;
    if (trade->revision != revision) { sendTradeState(*trade); return; }
    const int side = trade->players[0] == playerId ? 0 : 1;
    auto& offers = trade->offers[side];
    auto existing = std::find_if(offers.begin(), offers.end(), [uid, iid](const TradeItem& item) {
        return static_cast<uint8_t>(item.uid) == uid && item.iid == iid;
    });
    if (count == 0) {
        if (existing == offers.end()) return;
        offers.erase(existing);
    } else {
        Player* p = getPlayerByID(playerId);
        int8_t slot = p->inventory.findItemByUidSlot(uid, iid);
        Item* item = slot < 0 ? nullptr : p->inventory.getItem(static_cast<uint8_t>(slot));
        if (!item || count > item->getCount()) { sendTradeState(*trade); return; }
        // Offering the gun, or the mod being fitted, ends a timed mod change on it.
        p->cancelModChangeFor(item->getUID());
        if (existing != offers.end() && existing->count == count) { sendTradeState(*trade); return; }
        TradeItem offer{ iid, item->getUID(), count, ItemState::of(*item), item->getCount(), item->getDecayProgress() };
        if (existing != offers.end()) *existing = offer;
        else {
            if (offers.size() >= TRADE_MAX_OFFERS) { tradeNotice(p, "Trade offer limit reached (32 stacks)."); sendTradeState(*trade); return; }
            offers.push_back(offer);
        }
    }
    trade->accepted[0] = trade->accepted[1] = false;
    ++trade->revision;
    trade->expiresAt = OTSYS_TIME() + 300000;
    sendTradeState(*trade);
}

void Game::playerAcceptTrade(uint32_t playerId, uint32_t sessionId, uint32_t revision) {
    auto it = trades.find(playerId);
    if (it == trades.end()) return;
    const auto trade = it->second;
    if (trade->id != sessionId || !trade->open || !validateTrade(*trade)) return;
    if (trade->revision != revision) { sendTradeState(*trade); return; }
    if (trade->offers[0].empty() && trade->offers[1].empty()) return;
    trade->accepted[trade->players[0] == playerId ? 0 : 1] = true;
    if (trade->accepted[0] && trade->accepted[1]) completeTrade(*trade);
    else sendTradeState(*trade);
}

void Game::playerCancelTrade(uint32_t playerId, uint32_t sessionId) {
    auto it = trades.find(playerId);
    if (it != trades.end() && it->second->id == sessionId) cancelTrade(playerId, "Trade cancelled.");
}

void Game::completeTrade(const TradeSession& trade) {
    if (!validateTrade(trade)) return;
    Player* p[2] = { getPlayerByID(trade.players[0]), getPlayerByID(trade.players[1]) };
    // Refresh sub-byte decay elapsed since the offer, while retaining the displayed ammo byte.
    auto offers = std::array<std::vector<TradeItem>, 2>{ trade.offers[0], trade.offers[1] };
    for (int side = 0; side < 2; ++side) for (auto& offer : offers[side]) {
        auto slot = p[side]->inventory.findItemByUidSlot(offer.uid, offer.iid);
        offer.decayProgress = p[side]->inventory.getItem(static_cast<uint8_t>(slot))->getDecayProgress();
    }
    Inventory::ExchangePlan plans[2];
    for (int side = 0; side < 2; ++side) {
        if (!p[side]->inventory.prepareExchange(offers[side], offers[1-side], plans[side])) {
            cancelTrade(trade.players[0], "Trade cancelled: inventory could not be prepared.");
            return;
        }
    }
    std::vector<Loot*> prepared;
    auto discard = [&]() {
        for (Loot* loot : prepared) {
            if (map.getThingByID(loot->getID()) == loot) map.removeThing(loot);
            else { map.releaseEntityId(loot->getID()); delete loot; }
        }
        cancelTrade(trade.players[0], "Trade cancelled: no room for overflow loot. Items kept.");
    };
    for (int side = 0; side < 2; ++side) {
        // One burst per side: nothing is placed until every pile exists, so
        // spots picked one item at a time could not see each other.
        const auto from = p[side]->getPosition();
        const auto spots = findBurstLootPositions(from, plans[side].overflow.size());
        for (size_t i = 0; i < plans[side].overflow.size(); ++i) {
            const auto& item = plans[side].overflow[i];
            const auto* data = ItemManager::getInstance().getItemData(item.iid);
            if (!data || data->lootId == 0) { discard(); return; }
            Loot* loot = LootManager::getInstance().createLoot(data->lootId, item.iid, item.count, item.state, from, spots[i]);
            if (!loot) { discard(); return; }
            prepared.push_back(loot);
        }
    }
    // Internal placement publishes no packets. A failed placement rolls back all
    // prepared loot while both original inventories still exist unchanged.
    for (Loot* loot : prepared) if (!internalPlaceThing(loot, loot->getPosition())) { discard(); return; }
    trades.erase(trade.players[0]);
    trades.erase(trade.players[1]);
    for (int side = 0; side < 2; ++side) p[side]->inventory.commitExchange(std::move(plans[side]));
    for (Loot* loot : prepared) {
        EntityUpdate update;
        loot->buildUpdate(update);
        broadcastSurgicalUpdate(update, loot->getPosition());
    }
    for (int side = 0; side < 2; ++side) {
        NetworkMessage msg;
        msg.addByte(static_cast<uint8_t>(ServerOpcode::TRADE_CLOSED));
        msg.add<uint32_t>(trade.id);
        msg.addString(prepared.empty() ? "Trade completed." : "Trade completed. Items that did not fit were dropped near their recipient.");
        p[side]->sendNetworkMessage(msg);
    }
}

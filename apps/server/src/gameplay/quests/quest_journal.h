// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/quests/quest_engine.h"
#include <string>

// The QUEST_STATE journal entry for one quest, as JSON (shared/typescript/
// quest-protocol.ts is the other half). Only what the player has reached is
// in it: finished stages from the history, then the current stage with its
// objectives. Stages not yet reached and branches not taken are never sent.
// When the entry would exceed maxBytes the oldest history records are dropped.
std::string questJournalJson(const QuestDefinition& quest, const QuestProgress& progress, size_t maxBytes);

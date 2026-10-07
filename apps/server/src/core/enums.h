// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_ENUMS_H
#define FS_ENUMS_H

enum ThreadState
{
	THREAD_STATE_RUNNING,
	THREAD_STATE_CLOSING,
	THREAD_STATE_TERMINATED,
};

// Only these two exist in this game: Player and Agent (bots/ghouls).
enum CreatureType_t : uint8_t
{
	CREATURETYPE_PLAYER = 0,
	CREATURETYPE_MONSTER = 1,
};


#endif // FS_ENUMS_H
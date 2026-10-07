// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef PREVAST_DISCONNECT_REASON_H
#define PREVAST_DISCONNECT_REASON_H

#include "network/opcodes.h"

#include <string_view>

class NetworkMessage;

// Appends a DISCONNECT_REASON frame: [99][u8 reason][str detail].
void writeDisconnectReason(NetworkMessage& msg, DisconnectReason reason, std::string_view detail);

// Checks the frame layout; part of prevast_server --selftest. 0 when every case passes.
int runDisconnectReasonSelfTest();

#endif

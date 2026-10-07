// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_OTSERV_H
#define FS_OTSERV_H

#include <string>

// Export content XML to JSON without starting the server.
int exportContent(const std::string& outDir);

void printServerVersion();
void startServer();

// --validate: load config.lua and every content file, report what the boot
// would report, and exit. Returns 0 when nothing warned, 1 otherwise, so it can
// gate a build. Binds no port, opens no database and generates no world.
int validateContent();

// --validate-scenario <file>: parse and structurally validate a World & Mode
// Editor project, then resolve its content against a full content load.
// Prints diagnostics and the gameplay hash; 0 when it could run, 1 otherwise.
int validateScenario(const std::string& file);

#endif
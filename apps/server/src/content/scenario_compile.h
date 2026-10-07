// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_COMPILE_H
#define FS_SCENARIO_COMPILE_H

// The content half of scenario validation: every placement must name content
// this server actually has, and every override must be one this kind of object
// supports. Needs the content managers loaded (g_objects, g_resources,
// g_agents, g_npcs); the structural half is scenario_project.h.

#include "content/scenario_project.h"

#include <string>
#include <vector>

namespace scenario {

// Resolves content and grid occupancy. Appends diagnostics; never modifies the
// project. Nothing here trusts the browser's own compile.
std::vector<Diagnostic> compileCheck(const Project& project);

// Features this server build can run, as a project lists them in
// requiredFeatures. Anything else blocks a run with a visible reason.
const std::vector<std::string>& supportedFeatures();

} // namespace scenario

#endif // FS_SCENARIO_COMPILE_H

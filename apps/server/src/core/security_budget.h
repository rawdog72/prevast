// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef PREVAST_SECURITY_BUDGET_H
#define PREVAST_SECURITY_BUDGET_H
#include <algorithm>
#include <chrono>

// Dispatcher-owned action budget, independent of transport messages/second.
class ActionBudget {
public:
    bool consume(double rate, double burst) {
        const auto now = std::chrono::steady_clock::now();
        if (!started) { tokens = burst; started = true; }
        else tokens = std::min(burst, tokens + std::chrono::duration<double>(now - previous).count() * rate);
        previous = now;
        if (tokens < 1.0) return false;
        tokens -= 1.0;
        return true;
    }
private:
    bool started = false;
    double tokens = 0;
    std::chrono::steady_clock::time_point previous{};
};
#endif

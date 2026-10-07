// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describeAccountStore } from './store-contract';
import { MemoryAccountStore } from './memory-store';

describeAccountStore('memory', async () => new MemoryAccountStore());

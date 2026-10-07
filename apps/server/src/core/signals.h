// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SIGNALS_H
#define FS_SIGNALS_H

class Signals
{
	boost::asio::signal_set set;

public:
	explicit Signals(boost::asio::io_context& ioc);

private:
	void asyncWait();
};

#endif // FS_SIGNALS_H

// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/server.h"
#include "network/protocol.h"

#include "content/configmanager.h"
#include "core/scheduler.h"
#include "core/tools.h"

namespace {

	struct ConnectBlock
	{
		uint64_t lastAttempt;
		uint64_t blockTime = 0;
		uint32_t count = 1;
	};

	bool acceptConnection(const Connection::Address& clientIP)
	{
		// A stress fleet connects every bot from one IP as fast as it can, which
		// is exactly the burst the rest of this function exists to stop.
		if (!getBoolean(ConfigManager::CONNECT_THROTTLE)) {
			return true;
		}

		static std::recursive_mutex mu;
		std::lock_guard lock{ mu };

		uint64_t currentTime = OTSYS_TIME();

		static std::map<Connection::Address, ConnectBlock> ipConnectMap;
		auto it = ipConnectMap.find(clientIP);
		if (it == ipConnectMap.end()) {
			if (ipConnectMap.size() >= 8192) {
				std::erase_if(ipConnectMap, [currentTime](const auto& entry) { return currentTime > entry.second.lastAttempt + 60000 && currentTime > entry.second.blockTime; });
				if (ipConnectMap.size() >= 8192) return false;
			}
			ipConnectMap.emplace(clientIP, ConnectBlock{ .lastAttempt = currentTime });
			return true;
		}

		ConnectBlock& connectBlock = it->second;
		if (connectBlock.blockTime > currentTime) {
			// A rejected attempt never extends the block.
			return false;
		}

		int64_t timeDiff = currentTime - connectBlock.lastAttempt;
		connectBlock.lastAttempt = currentTime;
		if (timeDiff <= 5000) {
			if (++connectBlock.count > 5) {
				connectBlock.count = 0;
				if (timeDiff <= 500) {
					connectBlock.blockTime = currentTime + 3000;
					return false;
				}
			}
		}
		else {
			connectBlock.count = 1;
		}
		return true;
	}

	boost::asio::ip::address getListenAddress()
	{
		if (getBoolean(ConfigManager::BIND_ONLY_GLOBAL_ADDRESS)) {
			return boost::asio::ip::make_address(getString(ConfigManager::IP));
		}
		return boost::asio::ip::address_v6::any();
	}

	void openAcceptor(std::weak_ptr<ServicePort> weak_service, uint16_t port)
	{
		if (auto service = weak_service.lock()) {
			service->open(port);
		}
	}

} // namespace

ServiceManager::~ServiceManager() { stop(); }

void ServiceManager::die() { io_context.stop(); }

// Number of threads to run io_context on. All socket I/O used to be serialised
// on one thread; measured, the delay between posting a write and the io thread
// starting it grew linearly with player count (0.16ms at 9 players to 1.5ms at
// 150, with 17ms spikes) while other cores sat idle.
static size_t resolveNetworkThreads()
{
	const int32_t configured = ConfigManager::getNumber(ConfigManager::NETWORK_THREADS);
	if (configured > 0) {
		return static_cast<size_t>(configured);
	}

	// Auto: leave a core for the dispatcher, which runs the game tick and every
	// packet handler and is the one thread that must never be starved.
	const unsigned hw = std::thread::hardware_concurrency();
	return hw > 2 ? std::min<size_t>(hw - 1, 4) : 1;
}

void ServiceManager::run()
{
	assert(!running);
	running = true;

	const size_t threadCount = resolveNetworkThreads();
	fmt::print(">> Network I/O running on {} thread{}\n", threadCount, threadCount == 1 ? "" : "s");

	ioThreads.reserve(threadCount - 1);
	for (size_t i = 1; i < threadCount; ++i) {
		ioThreads.emplace_back([this]() { io_context.run(); });
	}

	io_context.run(); // this thread joins the pool

	for (std::thread& t : ioThreads) {
		if (t.joinable()) {
			t.join();
		}
	}
	ioThreads.clear();
}

void ServiceManager::stop()
{
	if (!running) {
		return;
	}

	running = false;

	for (auto& servicePortIt : acceptors) {
		try {
			boost::asio::post(io_context, [servicePort = servicePortIt.second]() { servicePort->onStopServer(); });
		}
		catch (boost::system::system_error& e) {
			std::cout << "[ServiceManager::stop] Network Error: " << e.what() << std::endl;
		}
	}

	acceptors.clear();

	death_timer.expires_after(std::chrono::seconds(3));
	death_timer.async_wait([this](const boost::system::error_code&) { die(); });
}

void ServiceManager::abandon()
{
	// Nothing runs the io_context yet, so closing directly cannot race a handler.
	for (auto& servicePortIt : acceptors) servicePortIt.second->close();
	acceptors.clear();
	// Each port had an accept pending with a Connection already registered in
	// ConnectionManager. Closing aborts those accepts, but only running their
	// completions (onAccept -> FORCE_CLOSE) releases the connections; left
	// queued, they outlived this io_context and crashed the process at exit.
	io_context.restart();
	io_context.poll();
}

ServicePort::~ServicePort() { close(); }

bool ServicePort::is_single_socket() const { return !services.empty() && services.front()->is_single_socket(); }

std::string ServicePort::get_protocol_names() const
{
	if (services.empty()) {
		return std::string();
	}

	std::string str = services.front()->get_protocol_name();
	for (size_t i = 1; i < services.size(); ++i) {
		str.push_back(',');
		str.push_back(' ');
		str.append(services[i]->get_protocol_name());
	}
	return str;
}

void ServicePort::accept()
{
	if (!acceptor) {
		return;
	}

	auto connection = ConnectionManager::getInstance().createConnection(io_context, shared_from_this());
	acceptor->async_accept(connection->getSocket(), boost::asio::bind_executor(strand,
		[=, thisPtr = shared_from_this()](const boost::system::error_code& error) {
			thisPtr->onAccept(connection, error);
		}));
}

void ServicePort::onAccept(Connection_ptr connection, const boost::system::error_code& error)
{
	if (!error) {
		if (services.empty()) {
			connection->close(Connection::FORCE_CLOSE);
			accept();
			return;
		}

		boost::system::error_code endpointError;
		const auto endpoint = connection->getSocket().remote_endpoint(endpointError);
		connection->remoteAddress = endpoint.address();
		const auto& remote_ip = connection->getIP();
		if (!endpointError && acceptConnection(remote_ip) && ConnectionManager::getInstance().admit(connection, remote_ip)) {
			Service_ptr service = services.front();
			if (service->is_single_socket()) {
				connection->accept(service->make_protocol(connection));
			}
			else {
				connection->accept();
			}
		}
		else {
			connection->close(Connection::FORCE_CLOSE);
		}

		accept();
	}
	else if (error != boost::asio::error::operation_aborted) {
		connection->close(Connection::FORCE_CLOSE);
		if (!pendingStart) {
			close();
			pendingStart = true;
			g_scheduler.addEvent(createSchedulerTask(
				15000, [serverPort = this->serverPort, service = std::weak_ptr<ServicePort>(shared_from_this())]() {
					openAcceptor(service, serverPort);
				}));
		}
	}
	else {
		connection->close(Connection::FORCE_CLOSE);
	}
}

Protocol_ptr ServicePort::make_text_protocol(const Connection_ptr& connection) const
{
	for (const auto& service : services) {
		auto candidate = service->make_protocol(connection);
		if (candidate->acceptsTextFrames()) return candidate;
	}
	return nullptr;
}

Protocol_ptr ServicePort::make_protocol(NetworkMessage& msg, const Connection_ptr& connection) const
{
	uint8_t protocolID = msg.getByte();
	for (auto& service : services) {
		if (protocolID != service->get_protocol_identifier()) {
			continue;
		}
		return service->make_protocol(connection);
	}
	fmt::print("[ServicePort] No protocol matched for byte 0x{:02x} from {}\n", protocolID, connection->getIP().to_string());
	return nullptr;
}

// Posted to the strand so it cannot run concurrently with an accept completion
// on another io thread.
void ServicePort::onStopServer()
{
	boost::asio::post(strand, [thisPtr = shared_from_this()]() { thisPtr->close(); });
}

void ServicePort::open(uint16_t port)
{
	namespace ip = boost::asio::ip;

	close();

	serverPort = port;
	pendingStart = false;

	try {
		auto address = getListenAddress();

		// The acceptor sets SO_REUSEADDR by default. On POSIX that only lets a
		// restart rebind past TIME_WAIT; on Windows it lets a second server bind
		// a port another one is listening on, and Windows then deals the
		// connections out between them -- a stale copy left running swallows
		// some joins. Without it the second server fails to bind (and retries
		// below) instead.
#ifdef _WIN32
		constexpr bool reuseAddress = false;
#else
		constexpr bool reuseAddress = true;
#endif
		acceptor = std::make_unique<ip::tcp::acceptor>(io_context, ip::tcp::endpoint{ address, serverPort }, reuseAddress);
		if (address.is_v6()) {
			ip::v6_only option;
			acceptor->get_option(option);
			if (option) {
				boost::system::error_code err;
				acceptor->set_option(ip::v6_only{ false }, err);
				if (err) {
					std::cout << "[Warning - ServicePort::open] Enabling IPv4 support failed: " << err.message()
						<< std::endl;
				}
			}
		}
		acceptor->set_option(ip::tcp::no_delay{ true });

		accept();
	}
	catch (boost::system::system_error& e) {
		std::cout << "[ServicePort::open] Error: " << e.what() << std::endl;
		if (e.code() == boost::asio::error::address_in_use || e.code() == boost::asio::error::access_denied) {
			std::cout << "[ServicePort::open] Port " << port
				<< " is taken -- is another prevast_server still running? Retrying every 15 s." << std::endl;
		}

		pendingStart = true;
		g_scheduler.addEvent(createSchedulerTask(
			15000,
			[port, service = std::weak_ptr<ServicePort>(shared_from_this())]() { openAcceptor(service, port); }));
	}
}

void ServicePort::close()
{
	if (acceptor && acceptor->is_open()) {
		boost::system::error_code error;
		acceptor->close(error);
	}
}

bool ServicePort::add_service(const Service_ptr& new_svc)
{
	if (std::any_of(services.begin(), services.end(), [](const Service_ptr& svc) { return svc->is_single_socket(); })) {
		return false;
	}

	services.push_back(new_svc);
	return true;
}

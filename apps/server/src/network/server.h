// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SERVER_H
#define FS_SERVER_H

#include "network/connection.h"
#include "core/signals.h"

class ServiceBase
{
public:
	virtual ~ServiceBase() = default;

	virtual bool is_single_socket() const = 0;
	virtual bool is_checksummed() const = 0;
	virtual uint8_t get_protocol_identifier() const = 0;
	virtual const char* get_protocol_name() const = 0;

	virtual Protocol_ptr make_protocol(const Connection_ptr& c) const = 0;
};

template <typename ProtocolType>
class Service final : public ServiceBase
{
public:
	bool is_single_socket() const override { return ProtocolType::server_sends_first; }
	bool is_checksummed() const override { return ProtocolType::use_checksum; }
	uint8_t get_protocol_identifier() const override { return ProtocolType::protocol_identifier; }
	const char* get_protocol_name() const override { return ProtocolType::protocol_name(); }

	Protocol_ptr make_protocol(const Connection_ptr& c) const override { return std::make_shared<ProtocolType>(c); }
};

class ServicePort : public std::enable_shared_from_this<ServicePort>
{
public:
	explicit ServicePort(boost::asio::io_context& io_context) :
		io_context(io_context), strand(boost::asio::make_strand(io_context))
	{}
	~ServicePort();

	// non-copyable
	ServicePort(const ServicePort&) = delete;
	ServicePort& operator=(const ServicePort&) = delete;

	void open(uint16_t port);
	void close();
	bool is_single_socket() const;
	std::string get_protocol_names() const;

	bool add_service(const Service_ptr& new_svc);
	Protocol_ptr make_protocol(NetworkMessage& msg, const Connection_ptr& connection) const;
	Protocol_ptr make_text_protocol(const Connection_ptr& connection) const;

	void onStopServer();
	void onAccept(Connection_ptr connection, const boost::system::error_code& error);

private:
	void accept();

	boost::asio::io_context& io_context;
	// Serialises everything touching `acceptor` now that several threads run
	// the io_context: accept completions against each other, and against the
	// close() that shutdown posts.
	boost::asio::strand<boost::asio::io_context::executor_type> strand;
	std::unique_ptr<boost::asio::ip::tcp::acceptor> acceptor;
	std::vector<Service_ptr> services;

	uint16_t serverPort = 0;
	bool pendingStart = false;
};

class ServiceManager
{
public:
	ServiceManager() = default;
	~ServiceManager();

	// non-copyable
	ServiceManager(const ServiceManager&) = delete;
	ServiceManager& operator=(const ServiceManager&) = delete;

	void run();
	void stop();
	// Startup failed after ports were registered but before run(): closes every
	// listening socket at once so the process reports itself offline and exits
	// instead of accepting connections into a world that was never built.
	void abandon();

	template <typename ProtocolType>
	bool add(uint16_t port);

	bool is_running() const { return !acceptors.empty(); }

private:
	void die();

	std::unordered_map<uint16_t, ServicePort_ptr> acceptors;

	boost::asio::io_context io_context;
	Signals signals{ io_context };
	boost::asio::steady_timer death_timer{ io_context };
	bool running = false;

	// io_context.run() on more than one thread; every Connection binds its
	// handlers to a per-connection strand so this stays safe.
	std::vector<std::thread> ioThreads;
};

template <typename ProtocolType>
bool ServiceManager::add(uint16_t port)
{
	if (port == 0) {
		std::cout << "ERROR: No port provided for service " << ProtocolType::protocol_name() << ". Service disabled."
			<< std::endl;
		return false;
	}

	ServicePort_ptr service_port;

	auto foundServicePort = acceptors.find(port);

	if (foundServicePort == acceptors.end()) {
		service_port = std::make_shared<ServicePort>(io_context);
		service_port->open(port);
		acceptors[port] = service_port;
	}
	else {
		service_port = foundServicePort->second;

		if (service_port->is_single_socket() || ProtocolType::server_sends_first) {
			std::cout << "ERROR: " << ProtocolType::protocol_name() << " and " << service_port->get_protocol_names()
				<< " cannot use the same port " << port << '.' << std::endl;
			return false;
		}
	}

	return service_port->add_service(std::make_shared<Service<ProtocolType>>());
}

#endif // FS_SERVER_H

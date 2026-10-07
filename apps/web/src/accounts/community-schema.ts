// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
const table = (name: string, columns: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
export const COMMUNITY_SCHEMA = [
  table(
    'account_wallets',
    `account_id INT UNSIGNED PRIMARY KEY, balance BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_joined_at BIGINT NOT NULL DEFAULT 0, FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'wallet_transactions',
    `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, account_id INT UNSIGNED NOT NULL,
    receipt VARCHAR(200) NOT NULL, amount BIGINT NOT NULL, reason VARCHAR(160) NOT NULL, at BIGINT NOT NULL,
    UNIQUE KEY wallet_receipt(account_id,receipt), KEY wallet_history(account_id,id),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'account_clans',
    `id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL,
    name_key VARCHAR(40) NULL, tag VARCHAR(5) NOT NULL, tag_key VARCHAR(5) NULL, created_at BIGINT NOT NULL,
    deleted_at BIGINT NULL, UNIQUE KEY clan_name(name_key), UNIQUE KEY clan_tag(tag_key)`,
  ),
  table(
    'clan_members',
    `account_id INT UNSIGNED PRIMARY KEY, clan_id INT UNSIGNED NOT NULL,
    role VARCHAR(8) NOT NULL, joined_at BIGINT NOT NULL, KEY clan_roster(clan_id,account_id),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(clan_id) REFERENCES account_clans(id)`,
  ),
  table(
    'clan_membership_history',
    `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, account_id INT UNSIGNED NOT NULL,
    clan_id INT UNSIGNED NOT NULL, joined_at BIGINT NOT NULL, left_at BIGINT NULL,
    KEY historical_membership(account_id,joined_at,left_at), KEY clan_history(clan_id),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(clan_id) REFERENCES account_clans(id)`,
  ),
  table(
    'clan_invitations',
    `clan_id INT UNSIGNED NOT NULL, account_id INT UNSIGNED NOT NULL, expires_at BIGINT NOT NULL,
    PRIMARY KEY(clan_id,account_id), KEY account_invites(account_id),
    FOREIGN KEY(clan_id) REFERENCES account_clans(id), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'clan_audit',
    `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, clan_id INT UNSIGNED NOT NULL,
    actor_id INT UNSIGNED NOT NULL, target_id INT UNSIGNED NULL, action VARCHAR(24) NOT NULL, at BIGINT NOT NULL,
    KEY clan_audit_history(clan_id,id), FOREIGN KEY(clan_id) REFERENCES account_clans(id)`,
  ),
  table(
    'clan_requests',
    `account_id INT UNSIGNED NOT NULL, request_id CHAR(36) NOT NULL, clan_id INT UNSIGNED NOT NULL,
    PRIMARY KEY(account_id,request_id), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'survivor_runs',
    `id VARCHAR(96) PRIMARY KEY, server_id VARCHAR(64) NOT NULL, boot_id VARCHAR(80) NOT NULL,
    account_id INT UNSIGNED NOT NULL, mode VARCHAR(64) NOT NULL, rules_version INT UNSIGNED NOT NULL,
    started_at BIGINT NOT NULL, reported_at BIGINT NOT NULL, ended_at BIGINT NULL,
    ending VARCHAR(12) NOT NULL DEFAULT 'alive', revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    event_seq BIGINT UNSIGNED NOT NULL DEFAULT 0, score BIGINT UNSIGNED NOT NULL DEFAULT 0,
    earned_score BIGINT UNSIGNED NOT NULL DEFAULT 0, kills BIGINT UNSIGNED NOT NULL DEFAULT 0,
    survived_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0, paid_caps BIGINT UNSIGNED NOT NULL DEFAULT 0,
    reward_caps BIGINT UNSIGNED NOT NULL DEFAULT 0, eligible BOOLEAN NOT NULL DEFAULT 0,
    KEY account_runs(account_id,started_at), KEY server_runs(server_id,boot_id,ending),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'account_rank_scores',
    `account_id INT UNSIGNED NOT NULL, season VARCHAR(7) NOT NULL,
    score BIGINT UNSIGNED NOT NULL DEFAULT 0, kills BIGINT UNSIGNED NOT NULL DEFAULT 0,
    completed BIGINT UNSIGNED NOT NULL DEFAULT 0, final_score BIGINT UNSIGNED NOT NULL DEFAULT 0,
    best_score BIGINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY(account_id,season),
    KEY player_standings(season,score), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'clan_contributions',
    `clan_id INT UNSIGNED NOT NULL, account_id INT UNSIGNED NOT NULL,
    season VARCHAR(7) NOT NULL, score BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY(clan_id,account_id,season), KEY clan_standings(season,clan_id),
    FOREIGN KEY(clan_id) REFERENCES account_clans(id), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
  ),
  table(
    'clan_trophies',
    `clan_id INT UNSIGNED NOT NULL, season VARCHAR(7) NOT NULL,
    rank_value INT UNSIGNED NOT NULL, score BIGINT UNSIGNED NOT NULL, PRIMARY KEY(clan_id,season)`,
  ),
  table('community_seasons', `season VARCHAR(7) PRIMARY KEY, settled_at BIGINT NULL`),
];

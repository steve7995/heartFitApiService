-- Create database manually if not exists:
-- CREATE DATABASE fit_heart CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Users store Google identity + tokens (keep tokens server-side only)
CREATE TABLE IF NOT EXISTS users (
  id               BIGINT UNSIGNED PRIMARY KEY,
  email            VARCHAR(255) NOT NULL UNIQUE,
  google_user_id   VARCHAR(255) NOT NULL UNIQUE,
  access_token     TEXT NOT NULL,
  refresh_token    TEXT NOT NULL,
  token_expiry     DATETIME NOT NULL,
  name             VARCHAR(255),
  picture          TEXT,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 20-minute workout windows (start/end are UTC)
CREATE TABLE IF NOT EXISTS sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT UNSIGNED NOT NULL,
  start_time     DATETIME NOT NULL,
  end_time       DATETIME NOT NULL,
  status         ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
  fetch_status   ENUM('not_fetched','retry','fetched','failed') NOT NULL DEFAULT 'not_fetched',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_user (user_id),
  INDEX idx_sessions_end_fetch (end_time, fetch_status)
) ENGINE=InnoDB;

-- Raw heart rate readings (timestamps UTC)
CREATE TABLE IF NOT EXISTS heart_rate (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  session_id  BIGINT UNSIGNED NOT NULL,
  bpm         INT NOT NULL,
  timestamp   DATETIME NOT NULL,
  source      VARCHAR(100) DEFAULT 'google_fit',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_hr_session_ts (session_id, timestamp),
  INDEX idx_hr_user_ts (user_id, timestamp),
  UNIQUE KEY uq_hr_dedupe (session_id, timestamp, bpm)
) ENGINE=InnoDB;

-- Per-session result (mean of raw HR)
CREATE TABLE IF NOT EXISTS results (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  session_id  BIGINT UNSIGNED NOT NULL UNIQUE,
  mean_bpm    DECIMAL(5,2) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_results_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_results_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_results_user (user_id)
) ENGINE=InnoDB;

-- Track each fetch attempt (6h, 12h, 24h, or manual)
CREATE TABLE IF NOT EXISTS fetch_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id     BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  attempt_number INT NOT NULL,  -- 1=6h, 2=12h, 3=24h, 99=manual
  attempt_time   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status         ENUM('success','failed','no_data') NOT NULL,
  message        TEXT,
  CONSTRAINT fk_fetch_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_fetch_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_fetch_session_attempt (session_id, attempt_number)
) ENGINE=InnoDB;

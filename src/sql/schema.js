  // updated-schema.js
  import mysql from "mysql2/promise";

  // configure your DB connection
  const connectionConfig = {
    host: "localhost",
    user: "root",       // change if needed
    password: "7995", // replace with your MySQL password
    port: 3306,
    database: "latenigth", // make sure this DB exists
  };

  async function createSchema() {
    const conn = await mysql.createConnection(connectionConfig);
      
    // Run schema creation queries
    
    // Users table - enhanced with additional fields from server
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(255) PRIMARY KEY,  
        google_id VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255),
        picture TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expiry DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    // Sessions table - enhanced with fetch tracking
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        status ENUM('pending', 'active', 'completed', 'failed') DEFAULT 'pending',
        fetch_status ENUM('not_fetched', 'retry', 'fetched', 'failed') DEFAULT 'not_fetched',
        score DECIMAL(6,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        INDEX idx_user_status (user_id, status),
        INDEX idx_fetch_status (fetch_status),
        INDEX idx_end_time (end_time)
      );
    `);

    // Heart rate table - enhanced with source tracking
    await conn.query(`
      CREATE TABLE IF NOT EXISTS heart_rate (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        session_id INT NOT NULL,
        bpm INT NOT NULL,
        timestamp DATETIME NOT NULL,
        source VARCHAR(255) DEFAULT 'google_fit',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE KEY unique_user_session_timestamp (user_id, session_id, timestamp),
        INDEX idx_session_timestamp (session_id, timestamp),
        INDEX idx_user_timestamp (user_id, timestamp)
      );
    `);
    // Fetch logs table - enhanced with attempt tracking
    await conn.query(`
      CREATE TABLE IF NOT EXISTS fetch_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        user_id VARCHAR(255) NOT NULL ,
        attempt_number INT NOT NULL DEFAULT 1,
        fetch_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status ENUM('pending', 'success', 'failed', 'no_data' ,'error', 'auth_failed') DEFAULT 'pending',
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        INDEX idx_session_attempt (session_id, attempt_number),
        INDEX idx_status_time (status, fetch_time)
      );
    `);

    // Results table - for storing calculated session results
    await conn.query(`
      CREATE TABLE IF NOT EXISTS results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL ,
        session_id INT NOT NULL UNIQUE,
        mean_bpm DECIMAL(6,2),
        min_bpm INT,
        max_bpm INT,
        heart_rate_zones JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_user_session (user_id, session_id)
      );
    `);

    
    console.log("✅ Enhanced schema created successfully with:");
    console.log("   - Users table (enhanced with name, picture, updated_at)");
    console.log("   - Sessions table (enhanced with fetch_status, updated_at)"); 
    console.log("   - Heart rate table (enhanced with source field)");
    console.log("   - Fetch logs table (enhanced with user_id, attempt_number)");
    console.log("   - Results table (for calculated session metrics)");
    
    
    await conn.end();
  }

  createSchema().catch((err) => {
    console.error("❌ Error creating schema:", err);
  });
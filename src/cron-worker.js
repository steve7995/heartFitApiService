import "dotenv/config";
import cron from "node-cron";
import pool from "./db/pool.js";

const FETCH_BUFFER_MINUTES = Number(process.env.FETCH_BUFFER_MINUTES || 15);

// Simplified helper functions
async function getUserById(userId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [userId]);
  return rows[0] || null;
}


async function getValidAccessToken(userId) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");

  if (!user.refresh_token) {
    throw new Error(`No refresh token for user ${userId}. Re-authentication required.`);
  }

  const now = Date.now();
  const expiry = user.token_expiry ? new Date(user.token_expiry).getTime() : 0;

  console.log(`Token expiry for ${userId}: ${user.token_expiry} (${expiry}) now: ${new Date(now).toISOString()}`);

  // refresh if expiring within 10 minutes
  if (now >= expiry - 10 * 60 * 1000 || expiry === 0) {
    console.log(`Refreshing token for user ${userId} (expires: ${user.token_expiry || 'unknown'})`);
    return await refreshAccessToken(user);
  }

  return user.access_token;
}


async function refreshAccessToken(user) {
  console.log(`Attempting to refresh token for user: ${user.user_id}`);

  const payload = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: user.refresh_token,
    grant_type: "refresh_token"
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString()
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`Token refresh HTTP ${resp.status}: ${text}`);
    if (resp.status === 400 && text.includes("invalid_grant")) {
      // clear tokens so user must re-auth
      await pool.query(
        "UPDATE users SET access_token = '', refresh_token = '', token_expiry = NULL WHERE user_id = ?",
        [user.user_id]
      );
      throw new Error(`Refresh token invalid for user ${user.user_id}. User needs to re-authenticate.`);
    }
    throw new Error(`Token refresh failed: ${resp.status} ${text}`);
  }

  const json = JSON.parse(text);
  console.log('token refresh response:', json);

  const newToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);
  const newExpiryMs = Date.now() + expiresIn * 1000;

  // If Google returned a new refresh_token, store it
  if (json.refresh_token) {
    await pool.query(
      "UPDATE users SET access_token = ?, refresh_token = ?, token_expiry = FROM_UNIXTIME(?) WHERE user_id = ?",
      [newToken, json.refresh_token, Math.floor(newExpiryMs / 1000), user.user_id]
    );
  } else {
    await pool.query(
      "UPDATE users SET access_token = ?, token_expiry = FROM_UNIXTIME(?) WHERE user_id = ?",
      [newToken, Math.floor(newExpiryMs / 1000), user.user_id]
    );
  }

  console.log(`Updated access_token for user ${user.user_id}, expiry ${new Date(newExpiryMs).toISOString()}`);
  return newToken;
}

async function fetchHeartRateData(accessToken, startMs, endMs) {
  const startNs = (BigInt(startMs) * 1000000n).toString();
  const endNs = (BigInt(endMs) * 1000000n).toString();
  const datasetId = `${startNs}-${endNs}`;
  
  const dataSourceId = "derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm";
  const url = `https://www.googleapis.com/fitness/v1/users/me/dataSources/${encodeURIComponent(dataSourceId)}/datasets/${datasetId}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Fit API ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  return json.point || [];
}

async function saveHeartRateData(userId, sessionId, points, sessionStart, sessionEnd) {
  if (!points.length) return 0;

  let inserted = 0;
  for (const point of points) {
    const timestampMs = Number(point.startTimeNanos) / 1e6;
    
    // Only save points within actual session time (not buffer time)
    if (timestampMs < sessionStart || timestampMs > sessionEnd) continue;
    
    const bpm = point.value?.[0]?.fpVal;
    if (typeof bpm !== "number") continue;

    await pool.query(
      "INSERT IGNORE INTO heart_rate (user_id, session_id, bpm, timestamp, source) VALUES (?, ?, ?, FROM_UNIXTIME(?/1000), ?)",
      [userId, sessionId, Math.round(bpm), timestampMs, point.originDataSourceId || "google_fit"]
    );
    inserted++;
  }
  return inserted;
}

async function calculateAndSaveResults(userId, sessionId) {
  const [[row]] = await pool.query(
    "SELECT AVG(bpm) AS mean_bpm FROM heart_rate WHERE user_id = ? AND session_id = ?",
    [userId, sessionId]
  );
  
  const meanBpm = row?.mean_bpm;
  if (!meanBpm) return 0;

  await pool.query(
    `INSERT INTO results (user_id, session_id, mean_bpm)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE mean_bpm = VALUES(mean_bpm), updated_at = CURRENT_TIMESTAMP`,
    [userId, sessionId, meanBpm]
  );
  
  return Number(meanBpm);
}

async function logAttempt(sessionId, userId, attemptNumber, status, message) {
  await pool.query(
    "INSERT INTO fetch_logs (session_id, user_id, attempt_number, status, message) VALUES (?, ?, ?, ?, ?)",
    [sessionId, userId, attemptNumber, status, message?.slice(0, 1000) || null]
  );
}

// Simplified retry thresholds (in minutes after session end)
function getRetryDelay(attemptNumber) {
  const delays = [15, 30, 60, 360, 720]; // 15min, 30min, 1hr, 6hr, 12hr
  return delays[attemptNumber - 1] || 720;
}

// MAIN PROCESSING FUNCTION - Simplified and with proper token handling
async function processSession(session, attemptNumber) {
  const sessionStart = new Date(session.start_time).getTime();
  const sessionEnd = new Date(session.end_time).getTime();
  const bufferMs = FETCH_BUFFER_MINUTES * 60 * 1000;

  try {
    console.log(`Processing session ${session.id}, attempt ${attemptNumber}`);

    // CRITICAL FIX: Always get fresh token before API call
    const accessToken = await getValidAccessToken(session.user_id);
    
    // Fetch data with buffer time around session
    const points = await fetchHeartRateData(
      accessToken,
      sessionStart - bufferMs,
      sessionEnd + bufferMs
    );

    // Save only data points within actual session time
    const inserted = await saveHeartRateData(
      session.user_id, 
      session.id, 
      points, 
      sessionStart, 
      sessionEnd
    );

    if (inserted > 0) {
      // Success - calculate results and mark complete
      const meanBpm = await calculateAndSaveResults(session.user_id, session.id);
      
      await pool.query(
        "UPDATE sessions SET fetch_status = 'fetched', status = 'completed' WHERE id = ?",
        [session.id]
      );

      await logAttempt(session.id, session.user_id, attemptNumber, "success", 
        `Inserted ${inserted} points, mean BPM: ${meanBpm}`);
      
      console.log(`✓ Session ${session.id} completed: ${inserted} points, mean BPM: ${meanBpm}`);
      return { success: true, inserted, meanBpm };

    } else {
      // No data found
      const isFinalAttempt = attemptNumber >= 5;
      const newStatus = isFinalAttempt ? 'failed' : 'retry';
      
      await pool.query(
        `UPDATE sessions SET fetch_status = ?, ${isFinalAttempt ? "status = 'failed'," : ""} updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newStatus, session.id]
      );

      await logAttempt(session.id, session.user_id, attemptNumber, "no_data", 
        `No heart rate data found. ${isFinalAttempt ? 'Final attempt.' : 'Will retry.'}`);
      
      console.log(`⚠ Session ${session.id}: No data found (attempt ${attemptNumber}/5)`);
      return { success: false, reason: 'no_data', finalAttempt: isFinalAttempt };
    }

  } catch (error) {
    console.error(`✗ Session ${session.id} failed:`, error.message);


if (error.message && (error.message.includes("401") || error.message.includes("invalid_token") || error.message.includes("403"))) {
  await pool.query("UPDATE sessions SET fetch_status = 'failed', status = 'failed' WHERE id = ?", [session.id]);
  await logAttempt(session.id, session.user_id, attemptNumber, "auth_failed", error.message);
  return { success: false, reason: 'auth_required' };
}
    // Handle other errors
    const isFinalAttempt = attemptNumber >= 5;
    const newStatus = isFinalAttempt ? 'failed' : 'retry';
    
    await pool.query(
      `UPDATE sessions SET fetch_status = ?, ${isFinalAttempt ? "status = 'failed'," : ""} updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newStatus, session.id]
    );

    await logAttempt(session.id, session.user_id, attemptNumber, "error", error.message);
    return { success: false, reason: 'error', error: error.message };
  }
}




async function getAttemptCount(sessionId) {
  const [[row]] = await pool.query(
    "SELECT MAX(attempt_number) AS max_attempt FROM fetch_logs WHERE session_id = ? AND attempt_number BETWEEN 1 AND 5",
    [sessionId]
  );
  return Number(row.max_attempt || 0);
}


// MAIN CRON JOB - Simplified logic
async function runSyncCheck() {
  try {
    console.log(`\n--- Sync Check Started: ${new Date().toISOString()} ---`);
    
    // Get sessions that need processing
    const [sessions] = await pool.query(
      `SELECT * FROM sessions 
       WHERE fetch_status IN ('not_fetched', 'retry') 
       AND end_time IS NOT NULL 
       AND end_time <= NOW()
       ORDER BY end_time ASC`
    );
    
    console.log(`Found ${sessions.length} sessions to check`);

    for (const session of sessions) {
      try {
        const sessionEndMs = new Date(session.end_time).getTime();
        const attemptCount = await getAttemptCount(session.id);
        const nextAttempt = attemptCount + 1;

        if (nextAttempt > 5) {
          console.log(`Session ${session.id} already exhausted all attempts`);
          continue;
        }

        const delayMinutes = getRetryDelay(nextAttempt);
        const dueTime = sessionEndMs + (delayMinutes * 60 * 1000);
        const now = Date.now();

        if (now >= dueTime) {
          console.log(`⏰ Processing session ${session.id} (attempt ${nextAttempt}/${5})`);
          await processSession(session, nextAttempt);
        } else {
          const minutesRemaining = Math.ceil((dueTime - now) / (60 * 1000));
          console.log(`⏳ Session ${session.id} not due yet (${minutesRemaining} minutes remaining)`);
        }

      } catch (sessionError) {
        console.error(`Error processing session ${session.id}:`, sessionError.message);
      }
    }

    console.log(`--- Sync Check Completed: ${new Date().toISOString()} ---\n`);

  } catch (error) {
    console.error("CRON ERROR:", error.message);
  }
}

// Export for manual sync in server.js
export { processSession };

// Run every 5 minutes
cron.schedule("*/5 * * * *", runSyncCheck);

// Initial check after startup
setTimeout(runSyncCheck, 5000);

console.log("✓ Cron worker started - checking for syncs every 5 minutes...");
import "dotenv/config";
import express from "express";
import session from "express-session";
import pool from "./db/pool.js";
import { google } from "googleapis";
import { processSession } from "./cron-worker.js"; // Import from cron worker
import "./cron-worker.js"; // This will start the cron jobs
const app = express();
const PORT = Number(process.env.PORT || 5000);

// Middleware
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true in production with HTTPS
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

// Config
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/fitness.heart_rate.read",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid"
];

const SESSION_DEFAULT_MINUTES = Number(process.env.SESSION_DEFAULT_MINUTES || 20);

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || "45946153604-kkpr1i9t3pvkinhf624h0d4bhbui7u72.apps.googleusercontent.com",
    process.env.GOOGLE_CLIENT_SECRET || "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",
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/auth/google/callback"
  );
}

// Simplified helper functions
async function getUserById(userId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [userId]);
  return rows[0] || null;
}

// Auth routes
app.get("/auth/google", (req, res) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code");

  const oauth2Client = createOAuthClient();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiryMs = tokens.expiry_date || (Date.now() + 3600 * 1000);

    await pool.query(
      `INSERT INTO users (user_id, email, google_id, access_token, refresh_token, token_expiry, name, picture)
       VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, ?)
       ON DUPLICATE KEY UPDATE
         email = VALUES(email),
         access_token = VALUES(access_token),
         refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
         token_expiry = VALUES(token_expiry),
         name = VALUES(name),
         picture = VALUES(picture),
         updated_at = CURRENT_TIMESTAMP`,
      [profile.id, profile.email, profile.id, accessToken, refreshToken || "", expiryMs, profile.name || null, profile.picture || null]
    );

    req.session.userId = profile.id;
    req.session.email = profile.email;

    res.redirect("/dashboard");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Authentication failed");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ message: "Logged out" });
});

app.post("/auth/disconnect", async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const user = await getUserById(userId);
    if (user?.refresh_token) {
      // Revoke tokens with Google
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: user.refresh_token })
      });
    }

    await pool.query(
      "UPDATE users SET access_token='', refresh_token='', token_expiry=NULL WHERE user_id=?",
      [userId]
    );

    req.session.destroy(() => {});
    res.json({ message: "Disconnected from Google" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

app.get("/dashboard", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send(`<h2>Not authenticated</h2><p><a href="/auth/google">Login with Google</a></p>`);
  }
  res.send(`
    <h1>Heart Rate Monitor</h1>
    <p>Signed in as ${req.session.email}</p>
    <p><a href="/sessions/create">Create Session</a></p>
    <p><a href="/debug/fetch-24h">View Recent Data</a></p>
  `);
});

// Session management - simplified
app.post("/sessions", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });

    const minutes = Number(req.query.minutes || SESSION_DEFAULT_MINUTES);
    const now = new Date();
    const end = new Date(now.getTime() + minutes * 60 * 1000);

    const [result] = await pool.query(
      "INSERT INTO sessions (user_id, start_time, end_time, status, fetch_status) VALUES (?, ?, ?, 'pending', 'not_fetched')",
      [req.session.userId, now, end]
    );
    
    res.json({
      sessionId: result.insertId,
      start_time: now.toISOString(),
      end_time: end.toISOString(),
      duration_minutes: minutes
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.post("/sessions/:id/end", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });

    const now = new Date();
    const [result] = await pool.query(
      "UPDATE sessions SET end_time = ?, status = 'completed' WHERE id = ? AND user_id = ?",
      [now, req.params.id, req.session.userId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    res.json({ message: "Session ended", end_time: now.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// Manual sync - simplified using shared function
app.post("/sessions/:id/sync-now", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });

    const [[session]] = await pool.query(
      "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    
    if (!session) return res.status(404).json({ error: "Session not found" });

    console.log(`Manual sync requested for session ${session.id}`);
    const result = await processSession(session, 99); // Use 99 for manual attempts
    
    res.json({ 
      message: "Manual sync completed", 
      success: result.success,
      ...(result.success ? { inserted: result.inserted, meanBpm: result.meanBpm } : { reason: result.reason })
    });
  } catch (e) {
    console.error("Manual sync error:", e);
    res.status(500).json({ error: "Manual sync failed", details: e.message });
  }
});

app.get("/results/:sessionId", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
    
    const [[row]] = await pool.query(
      "SELECT * FROM results WHERE session_id = ? AND user_id = ?",
      [req.params.sessionId, req.session.userId]
    );
    
    if (!row) return res.status(404).json({ error: "No results available yet" });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch results" });
  }
});

// Browser-friendly endpoints
app.get("/sessions/create", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).send(`<h2>Not authenticated</h2><p><a href="/auth/google">Login with Google</a></p>`);
    }

    const minutes = Number(req.query.minutes || SESSION_DEFAULT_MINUTES);
    const now = new Date();
    const end = new Date(now.getTime() + minutes * 60 * 1000);

    const [result] = await pool.query(
      "INSERT INTO sessions (user_id, start_time, end_time, status, fetch_status) VALUES (?, ?, ?, 'pending', 'not_fetched')",
      [req.session.userId, now, end]
    );

    res.send(`
      <h2>Session Created!</h2>
      <p><strong>Session ID:</strong> ${result.insertId}</p>
      <p><strong>Duration:</strong> ${minutes} minutes</p>
      <p><strong>Ends at:</strong> ${end.toLocaleString()}</p>
      <p>Heart rate data will be automatically synced after the session ends.</p>
      <p><a href="/sessions/${result.insertId}">View Session</a> | <a href="/sessions/create">Create Another</a></p>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to create session");
  }
});

app.get("/sessions/:id", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).send(`<h2>Not authenticated</h2><p><a href="/auth/google">Login with Google</a></p>`);
    }

    const [[session]] = await pool.query(
      "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );

    if (!session) return res.status(404).send("Session not found");

    // Get results if available
    const [[result]] = await pool.query(
      "SELECT * FROM results WHERE session_id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );

    // Get recent logs
    const [logs] = await pool.query(
      "SELECT * FROM fetch_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 5",
      [req.params.id]
    );

    res.send(`
      <h2>Session ${session.id}</h2>
      <p><strong>Status:</strong> ${session.status}</p>
      <p><strong>Fetch Status:</strong> ${session.fetch_status}</p>
      <p><strong>Start:</strong> ${new Date(session.start_time).toLocaleString()}</p>
      <p><strong>End:</strong> ${new Date(session.end_time).toLocaleString()}</p>
      
      ${result ? `
        <h3>Results</h3>
        <p><strong>Mean Heart Rate:</strong> ${Math.round(result.mean_bpm)} BPM</p>
      ` : '<p><em>No results available yet</em></p>'}
      
      <h3>Actions</h3>
      <button onclick="syncNow()">Sync Now</button>
      
      ${logs.length > 0 ? `
        <h3>Recent Activity</h3>
        <ul>
          ${logs.map(log => `<li>${new Date(log.created_at).toLocaleString()}: ${log.status} - ${log.message || 'No message'}</li>`).join('')}
        </ul>
      ` : ''}
      
      <script>
        async function syncNow() {
          try {
            const response = await fetch('/sessions/${session.id}/sync-now', { method: 'POST' });
            const data = await response.json();
            alert(data.message);
            location.reload();
          } catch (e) {
            alert('Sync failed: ' + e.message);
          }
        }
      </script>
      
      <p><a href="/sessions/create">Create New Session</a></p>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to load session");
  }
});

// Keep your debug routes - they're useful
app.get("/debug/fetch-24h", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });

    const user = await getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const [heartRateData] = await pool.query(
      `SELECT DATE(timestamp) as date, 
              COUNT(*) as readings,
              ROUND(AVG(bpm)) as avg_bpm,
              MIN(bpm) as min_bpm,
              MAX(bpm) as max_bpm
       FROM heart_rate 
       WHERE user_id = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY DATE(timestamp)
       ORDER BY date DESC`,
      [req.session.userId]
    );

    res.json({
      summary: `${heartRateData.length} days with data in last 24 hours`,
      data: heartRateData
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.send(`
    <h1>Heart Rate Monitor API</h1>
    <p><a href="/auth/google">Login with Google</a></p>
    <p><a href="/dashboard">Dashboard</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
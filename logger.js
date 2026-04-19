// =============================================
//  logger.js — Structured logger
//  Writes to console AND service_log.txt
//  with timestamps and HTTP status context
// =============================================
const fs   = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "service_log.txt");

// Keep log file under 10MB — rotate if too large
function rotateLogs() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 10 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE.replace(".txt", "_old.txt"));
    }
  } catch (_) {}
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function write(level, message) {
  const line = `[${timestamp()}] [${level}] ${message}`;
  console.log(line);
  try {
    rotateLogs();
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

const logger = {
  info:  (msg) => write("INFO ", msg),
  warn:  (msg) => write("WARN ", msg),
  error: (msg) => write("ERROR", msg),
  sync:  (msg) => write("SYNC ", msg),
  poll:  (msg) => write("POLL ", msg),

  /**
   * Logs HRMS API errors with specific messages per HTTP status code.
   * This tells the IT department exactly why sync stopped.
   */
  apiError(status, message, url) {
    const reasons = {
      401: "API token expired or invalid — update HRMS_API_TOKEN in .env",
      403: "Access forbidden — check API permissions",
      404: "API endpoint not found — URL may have changed, check HRMS_API_URL in .env",
      429: "Too many requests — API rate limited, reduce POLL_INTERVAL_MS",
      500: "HRMS server internal error",
      502: "HRMS server bad gateway — server may be restarting",
      503: "HRMS server under maintenance or overloaded",
    };
    const reason = reasons[status] || `Unexpected HTTP ${status}`;
    write("ERROR", `HRMS API call failed — ${reason} | ${message} | URL: ${url}`);
  },
};

module.exports = logger;
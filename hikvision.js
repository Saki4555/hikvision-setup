// =============================================
//  hikvision.js — Calls Hikvision device API
// =============================================
const axios = require("axios");

/**
 * Fetches attendance events from a Hikvision device.
 * Uses Digest Authentication (same as the original PHP curl code).
 *
 * @param {string} apiUrl   - Full API URL of the device
 * @param {string} startTime - ISO start time  e.g. "2024-01-01T00:00:00+06:00"
 * @param {string} endTime   - ISO end time
 * @returns {Array|null}     - Array of attendance events, or null if no data
 */
async function getDataFromApi(apiUrl, startTime, endTime) {
  // ---- Determine device password (same logic as original PHP) ----
  const specialIps = ["192.168.9.217", "192.168.6.209"];
  const ipMatch = apiUrl.match(/http:\/\/([\d.]+)\//);
  const deviceIp = ipMatch ? ipMatch[1] : "";

  const username = "admin";
  const password = specialIps.includes(deviceIp) ? "Genesis@564" : "hik12345";

  // ---- Request body (same as original PHP) ----
  const body = {
    AcsEventCond: {
      searchID: "3166590d-cdb3-43f3-b25e-f6e98a05d359",
      searchResultPosition: 0,
      maxResults: 1000,
      major: 0,
      minor: 0,
      startTime: startTime,
      endTime: endTime,
      thermometryUnit: "celcius",
      currTemperature: 1,
    },
  };

  try {
    // ---- First request to get the Digest challenge ----
    let digestHeader = "";
    try {
      await axios.post(apiUrl, body, { timeout: 8000 });
    } catch (err) {
      if (err.response && err.response.status === 401) {
        // Parse WWW-Authenticate header to build Digest response
        const wwwAuth = err.response.headers["www-authenticate"];
        digestHeader = buildDigestHeader(
          wwwAuth,
          username,
          password,
          apiUrl,
          "POST"
        );
      } else {
        // Device unreachable or timeout
        return null;
      }
    }

    // ---- Second request with Digest credentials ----
    const response = await axios.post(apiUrl, body, {
      timeout: 8000,
      headers: {
        Authorization: digestHeader,
        "Content-Type": "application/json",
      },
    });

    const data = response.data;

    if (data && data.AcsEvent && data.AcsEvent.InfoList) {
      return data.AcsEvent.InfoList; // Array of attendance events
    }

    return null;
  } catch (err) {
    console.error(`  [API ERROR] ${apiUrl} — ${err.message}`);
    return null;
  }
}

/**
 * Builds a Digest Authorization header manually.
 * (Replicates what CURLOPT_HTTPAUTH = CURLAUTH_DIGEST does in PHP)
 */
function buildDigestHeader(wwwAuth, username, password, url, method) {
  const crypto = require("crypto");

  const realm = (wwwAuth.match(/realm="([^"]+)"/) || [])[1] || "";
  const nonce = (wwwAuth.match(/nonce="([^"]+)"/) || [])[1] || "";
  const qop = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1] || "";

  const uri = new URL(url).pathname + new URL(url).search;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  const ha1 = crypto
    .createHash("md5")
    .update(`${username}:${realm}:${password}`)
    .digest("hex");
  const ha2 = crypto
    .createHash("md5")
    .update(`${method}:${uri}`)
    .digest("hex");

  const response = qop
    ? crypto
        .createHash("md5")
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest("hex")
    : crypto
        .createHash("md5")
        .update(`${ha1}:${nonce}:${ha2}`)
        .digest("hex");

  return (
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", algorithm=MD5, ` +
    (qop ? `qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` : "") +
    `response="${response}"`
  );
}

module.exports = { getDataFromApi };
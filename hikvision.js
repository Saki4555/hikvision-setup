// =============================================
//  hikvision.js — Calls Hikvision device API
//  Uses manual Digest Auth (RFC 2617)
//  Supports pagination for large data sets
// =============================================
const axios = require("axios");
const crypto = require("crypto");

// How many records to fetch per API request
const PAGE_SIZE = 1000;

/**
 * Fetches ALL attendance events from a Hikvision device
 * between startTime and endTime.
 *
 * Handles pagination automatically — keeps requesting
 * until all records are fetched, even if there are
 * tens of thousands of records (e.g. after a long offline period).
 *
 * @param {string} apiUrl    - Full API URL of the device
 * @param {string} startTime - ISO time e.g. "2024-01-01T00:00:00+06:00"
 * @param {string} endTime   - ISO time e.g. "2024-12-31T00:00:00+06:00"
 * @returns {Array|null}     - Full array of all attendance events, or null
 */
async function getDataFromApi(apiUrl, startTime, endTime) {

  // ---- Determine device credentials ----
  const specialIps = ["192.168.9.217", "192.168.6.209"];
  const ipMatch = apiUrl.match(/http:\/\/([\d.]+)\//);
  const deviceIp = ipMatch ? ipMatch[1] : "";
  const username = "admin";
  const password = specialIps.includes(deviceIp) ? "Genesis@564" : "hik12345";

  // ---- Get Digest credentials on first request ----
  // We do one initial call to get the WWW-Authenticate challenge,
  // then reuse the same digest header for all paginated requests
  let digestHeader;
  try {
    digestHeader = await getDigestHeader(apiUrl, username, password);
  } catch (err) {
    console.error(`  [API ERROR] Could not reach device ${apiUrl} — ${err.message}`);
    return null;
  }

  if (!digestHeader) {
    console.error(`  [API ERROR] Failed to authenticate with device ${apiUrl}`);
    return null;
  }

  // ---- Paginate through all records ----
  let allEvents = [];
  let position = 0;
  let totalMatches = null; // will be set after first response

  while (true) {
    const body = buildRequestBody(startTime, endTime, position, PAGE_SIZE);

    let data;
    try {
      const response = await axios.post(apiUrl, body, {
        timeout: 15000,
        headers: {
          Authorization: digestHeader,
          "Content-Type": "application/json",
        },
      });
      data = response.data;
    } catch (err) {
      // If digest expired mid-pagination, refresh and retry once
      if (err.response && err.response.status === 401) {
        console.log(`  [API] Digest expired, refreshing credentials...`);
        try {
          digestHeader = await getDigestHeader(apiUrl, username, password);
          const response = await axios.post(apiUrl, body, {
            timeout: 15000,
            headers: {
              Authorization: digestHeader,
              "Content-Type": "application/json",
            },
          });
          data = response.data;
        } catch (retryErr) {
          console.error(`  [API ERROR] Retry failed — ${retryErr.message}`);
          break;
        }
      } else {
        console.error(`  [API ERROR] Page fetch failed at position ${position} — ${err.message}`);
        break;
      }
    }

    // ---- Parse response ----
    const acsEvent = data && data.AcsEvent;
    if (!acsEvent) break;

    // Set total on first page
    if (totalMatches === null) {
      totalMatches = acsEvent.totalMatches || 0;
      if (totalMatches === 0) {
        break; // No records at all
      }
      const pages = Math.ceil(totalMatches / PAGE_SIZE);
      if (pages > 1) {
        console.log(`  [API] ${totalMatches} total records found — fetching ${pages} pages...`);
      }
    }

    const infoList = acsEvent.InfoList;
    if (!infoList || infoList.length === 0) break;

    allEvents = allEvents.concat(infoList);
    position += infoList.length;

    // Stop when we have fetched everything
    if (position >= totalMatches) break;
  }

  return allEvents.length > 0 ? allEvents : null;
}

/**
 * Sends a blank request to get the 401 challenge,
 * then builds and returns the Digest Authorization header.
 */
async function getDigestHeader(apiUrl, username, password) {
  try {
    // Intentional first request — expects 401
    await axios.post(apiUrl, {}, { timeout: 8000 });
    // If it didn't 401, device has no auth (unlikely but handle it)
    return "";
  } catch (err) {
    if (err.response && err.response.status === 401) {
      const wwwAuth = err.response.headers["www-authenticate"];
      if (!wwwAuth) throw new Error("No WWW-Authenticate header in 401 response");
      return buildDigestHeader(wwwAuth, username, password, apiUrl, "POST");
    }
    throw err; // device unreachable, timeout, etc.
  }
}

/**
 * Builds the Hikvision AcsEvent request body.
 * searchResultPosition enables pagination.
 */
function buildRequestBody(startTime, endTime, position, maxResults) {
  return {
    AcsEventCond: {
      searchID: "3166590d-cdb3-43f3-b25e-f6e98a05d359",
      searchResultPosition: position,
      maxResults: maxResults,
      major: 0,
      minor: 0,
      startTime: startTime,
      endTime: endTime,
      thermometryUnit: "celcius",
      currTemperature: 1,
    },
  };
}

/**
 * Builds a Digest Authorization header manually (RFC 2617).
 * Replicates PHP's CURLOPT_HTTPAUTH = CURLAUTH_DIGEST.
 */
function buildDigestHeader(wwwAuth, username, password, url, method) {
  const realm = (wwwAuth.match(/realm="([^"]+)"/) || [])[1] || "";
  const nonce = (wwwAuth.match(/nonce="([^"]+)"/) || [])[1] || "";
  const qop   = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1] || "";

  const uri    = new URL(url).pathname + new URL(url).search;
  const nc     = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  const responseHash = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  return (
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", algorithm=MD5, ` +
    (qop ? `qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` : "") +
    `response="${responseHash}"`
  );
}

/** MD5 shorthand */
function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

module.exports = { getDataFromApi };
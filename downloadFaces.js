require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const OUTPUT_DIR = path.join(__dirname, "faces");
const PAGE_SIZE  = 40;

function getTerminals() {
  try { return JSON.parse(process.env.TERMINALS || "[]"); }
  catch { console.error("Failed to parse TERMINALS from .env"); return []; }
}

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function getPassword(ip) {
  return ["192.168.9.217", "192.168.6.209"].includes(ip) ? "Genesis@564" : "hik12345";
}

// ! if port
// function getPassword(ip) {
//   const bare = ip.split(":")[0];
//   return ["192.168.9.217", "192.168.6.209"].includes(bare) ? "Genesis@564" : "hik12345";
// }

// ---- Build Digest auth header ----
async function getDigestHeader(url, username, password, method = "GET") {
  try {
    await axios({ method, url, timeout: 8000 });
    return "";
  } catch (err) {
    if (err.response?.status === 401) {
      const wwwAuth = err.response.headers["www-authenticate"] || "";
      const realm  = (wwwAuth.match(/realm="([^"]+)"/)  || [])[1] || "";
      const nonce  = (wwwAuth.match(/nonce="([^"]+)"/)  || [])[1] || "";
      const qop    = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1] || "";
      const uri    = new URL(url).pathname + new URL(url).search;
      const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
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
    throw err;
  }
}

// ---- Get all FDLibs ----
async function getAllFDLibs(baseUrl, ip) {
  const url  = `${baseUrl}/ISAPI/Intelligent/FDLib?format=json`;
  const auth = await getDigestHeader(url, "admin", getPassword(ip), "GET");
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { Authorization: auth } });
    const raw = res.data?.FDLib
             ?? res.data?.FDLibBasicInfoList?.FDLibBasicInfo
             ?? res.data?.FDLibBasicInfo ?? null;
    const libs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (libs.length) {
      console.log(`  Libraries: ${libs.map(l => `${l.faceLibType}(FDID=${l.FDID})`).join(", ")}`);
      return libs.map(l => ({ fdid: String(l.FDID), faceLibType: String(l.faceLibType) }));
    }
  } catch (err) {
    console.log(`  [WARN] FDLib fetch failed: ${err.message}`);
  }
  return [{ fdid: "1", faceLibType: "blackFD" }];
}

// ---- Get a session token (used to authenticate image URLs) ----
async function getSessionToken(baseUrl, ip) {
  // The web app appends ?token=<sessionID> to faceURL — get a valid session first
  const url  = `${baseUrl}/ISAPI/Security/userCheck?format=json`;
  const auth = await getDigestHeader(url, "admin", getPassword(ip), "GET");
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { Authorization: auth } });
    const token = res.data?.userCheck?.sessionID ?? res.data?.sessionID ?? null;
    if (token) {
      console.log(`  [TOKEN] Session token: ${token.slice(0, 20)}...`);
      return token;
    }
  } catch (_) {}

  // Fallback: try the users endpoint which also issues tokens
  try {
    const url2  = `${baseUrl}/ISAPI/Security/users?format=json`;
    const auth2 = await getDigestHeader(url2, "admin", getPassword(ip), "GET");
    const res2  = await axios.get(url2, { timeout: 10000, headers: { Authorization: auth2 } });
    const token = res2.headers?.["x-session-id"] ?? res2.data?.token ?? null;
    if (token) {
      console.log(`  [TOKEN] Session token (fallback): ${token.slice(0, 20)}...`);
      return token;
    }
  } catch (_) {}

  console.log(`  [WARN] Could not get session token — will try digest auth on images`);
  return null;
}

// ---- Search via JSON ----
async function fdSearchJson(baseUrl, ip, fdid, faceLibType, position) {
  const password = getPassword(ip);

  // Shape A: flat top-level (what this device wants — confirmed working)
  const bodyA = {
    searchID: "1",
    FDID: fdid,
    faceLibType,
    searchResultPosition: position,
    maxResults: PAGE_SIZE,
  };

  // Shape B: wrapped (older firmware fallback)
  const bodyB = { FDSearchDescription: { ...bodyA } };

  const endpoints = [
    `${baseUrl}/ISAPI/Intelligent/FDLib/FDSearch?format=json`,
    `${baseUrl}/ISAPI/Intelligent/FDLib/Search?format=json`,
  ];

  let lastErr;
  for (const url of endpoints) {
    for (const body of [bodyA, bodyB]) {
      const auth = await getDigestHeader(url, "admin", password, "POST");
      try {
        const res = await axios.post(url, body, {
          timeout: 20000,
          headers: { Authorization: auth, "Content-Type": "application/json" },
        });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
        console.log(`  [TRY] ${url.split(baseUrl)[1]} → HTTP ${status}: ${msg}`);
        lastErr = err;
        if (status === 404) break;
      }
    }
  }
  throw lastErr;
}

// ---- Download a face image by its faceURL ----
async function downloadFaceByUrl(faceUrl, baseUrl, ip, empNo, token) {
  const outPath = path.join(OUTPUT_DIR, `${empNo}.jpg`);
  if (fs.existsSync(outPath)) {
    process.stdout.write("s"); // dot progress for skips
    return false;
  }

  const absUrl = faceUrl.startsWith("http") ? faceUrl : `${baseUrl}${faceUrl}`;

  // Strategy 1: append ?token= (what the browser does)
  if (token) {
    try {
      const res = await axios.get(`${absUrl}?token=${token}`, {
        timeout: 15000,
        responseType: "arraybuffer",
      });
      if (res.data.byteLength > 500) {
        fs.writeFileSync(outPath, Buffer.from(res.data));
        const kb = (res.data.byteLength / 1024).toFixed(1);
        console.log(`  [SAVED] ${empNo}.jpg (${kb} KB) via token`);
        return true;
      }
    } catch (_) {}
  }

  // Strategy 2: digest auth directly on the image URL
  try {
    const auth = await getDigestHeader(absUrl, "admin", getPassword(ip), "GET");
    const res  = await axios.get(absUrl, {
      timeout: 15000,
      responseType: "arraybuffer",
      headers: { Authorization: auth },
    });
    if (res.data.byteLength > 500) {
      fs.writeFileSync(outPath, Buffer.from(res.data));
      const kb = (res.data.byteLength / 1024).toFixed(1);
      console.log(`  [SAVED] ${empNo}.jpg (${kb} KB) via digest`);
      return true;
    }
  } catch (err) {
    throw new Error(`Both token and digest auth failed for ${empNo}: ${err.message}`);
  }

  throw new Error(`Response too small for ${empNo} — likely auth redirect`);
}

// ---- Search one FDLib, download all face images ----
async function searchAndSaveLib(baseUrl, ip, fdid, faceLibType, token) {
  let position = 0, total = null, saved = 0, skipped = 0;

  while (true) {
    let data;
    try {
      data = await fdSearchJson(baseUrl, ip, fdid, faceLibType, position);
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message;
      console.error(`  [HTTP ${err.response?.status}] FDSearch error: ${body}`);
      break;
    }

    if (total === null) {
      // totalMatches = grand total across all pages; numOfMatches = this page
      total = data.totalMatches ?? data.numOfMatches ?? 0;
      console.log(`  [${faceLibType}] ${total} record(s) total`);
      if (total === 0) break;
    }

    // Records live in MatchList on this firmware
    const records = data.MatchList ?? data.FaceDataRecord ?? data.faceDataRecord ?? [];
    const arr = Array.isArray(records) ? records : (records ? [records] : []);
    if (!arr.length) break;

    for (const rec of arr) {
      const empNo  = rec.FPID ?? rec.employeeNo ?? rec.FDID;
      const picUrl = rec.faceURL ?? rec.picURL ?? rec.faceUrl ?? rec.picUrl ?? null;
      const b64Pic = rec.picture ?? rec.faceData ?? rec.FaceData ?? null;

      if (!empNo) { skipped++; continue; }

      if (picUrl) {
        try {
          const wasSaved = await downloadFaceByUrl(picUrl, baseUrl, ip, empNo, token);
          wasSaved ? saved++ : skipped++;
        } catch (e) {
          console.error(`  [ERR] ${empNo}: ${e.message}`);
          skipped++;
        }
      } else if (b64Pic && b64Pic.length > 100) {
        const outPath = path.join(OUTPUT_DIR, `${empNo}.jpg`);
        if (fs.existsSync(outPath)) { skipped++; continue; }
        fs.writeFileSync(outPath, Buffer.from(b64Pic, "base64"));
        console.log(`  [SAVED] ${empNo}.jpg (base64)`);
        saved++;
      } else {
        if (!searchAndSaveLib._logged) {
          searchAndSaveLib._logged = true;
          console.log(`  [DEBUG] Record with no image: ${JSON.stringify(rec).slice(0, 400)}`);
        }
        skipped++;
      }
    }

    position += arr.length;
    console.log(`  Progress: ${Math.min(position, total)}/${total}`);
    if (position >= total || data.responseStatusStrg === "NO MATCH" || data.responseStatusStrg === "END") break;
  }

  return { saved, skipped };
}

// ---- Process one device ----
async function processDevice(terminal) {
  const baseUrl = terminal.api_string.split("/ISAPI/")[0];
  console.log(`\n========================================`);
  console.log(`Device: ${terminal.ip} (${terminal.location || "no location"})`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`========================================`);

  const libs  = await getAllFDLibs(baseUrl, terminal.ip);
  const token = await getSessionToken(baseUrl, terminal.ip);

  let totalSaved = 0, totalSkipped = 0;
  for (const { fdid, faceLibType } of libs) {
    const { saved, skipped } = await searchAndSaveLib(baseUrl, terminal.ip, fdid, faceLibType, token);
    totalSaved   += saved;
    totalSkipped += skipped;
  }
  return { saved: totalSaved, skipped: totalSkipped };
}

// ---- MAIN ----
async function main() {
  console.log("========================================");
  console.log("  Hikvision Face Image Downloader v3");
  console.log("  Strategy: JSON Search → token + digest");
  console.log("  Output: faces/ folder");
  console.log("========================================");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Created folder: ${OUTPUT_DIR}`);
  }

  const terminals = getTerminals();
  if (!terminals.length) { console.error("No terminals in .env"); process.exit(1); }
  console.log(`Processing ${terminals.length} device(s)...\n`);

  let totalSaved = 0, totalSkipped = 0;
  for (const t of terminals) {
    const { saved, skipped } = await processDevice(t);
    totalSaved += saved; totalSkipped += skipped;
  }

  console.log(`\n========================================`);
  console.log(`  Done! Saved: ${totalSaved}  Skipped: ${totalSkipped}`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`========================================`);
}

main().catch(err => { console.error("Fatal error:", err.message); process.exit(1); });
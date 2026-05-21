(() => {
  "use strict";

  // ---------------- Config helpers (DOM dataset) ----------------

  function cfgNode() {
    return /** @type {HTMLElement & { dataset: DOMStringMap }} */ (
      document.getElementById("dicomAnonConfig")
    ) || { dataset: /** @type {DOMStringMap} */ ({}) };
  }

  function rulesBase() {
    const raw = cfgNode().dataset.rulesBase || "/dicom-anonymizer/rules/";
    return raw.endsWith("/") ? raw : raw + "/";
  }

  function defaultProfile() {
    return cfgNode().dataset.defaultProfile || "default";
  }

  function runSaltUrl() {
    const raw =
      cfgNode().dataset.runSaltUrl || "/dicom-anonymizer/api/run-salt/";
    return raw;
  }

  let lastRules = null;
  let cachedRunSalt = null;

  // ---------------- Backend rule loading ----------------

  /**
   * Fetch rules JSON from backend.
   * Backend is required; no embedded fallback rules are used.
   *
   * Compatibility:
   * - supports legacy {"rules":[...]}
   * - prefers {"dicom_rules":[...], "clinical_rules": {...}}
   *
   * @returns {Promise<any>}
   */
  async function fetchRules() {
    const select = /** @type {HTMLSelectElement|null} */ (
      document.getElementById("profileSelect")
    );
    const slug = (select && select.value) || defaultProfile();

    const response = await fetch(
      `${rulesBase()}${encodeURIComponent(slug)}/`,
      {
        credentials: "same-origin"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to load anonymization rules for profile "${slug}" (HTTP ${response.status})`
      );
    }

    const data = await response.json();

    if (!data || typeof data !== "object") {
      throw new Error("Invalid anonymization rules payload");
    }

    if (!data.dicom_rules && data.rules) {
      data.dicom_rules = data.rules;
    }

    if (!Array.isArray(data.dicom_rules)) {
      throw new Error("Rules payload does not contain dicom_rules");
    }

    if (!data.clinical_rules) {
      data.clinical_rules = { columns: [] };
    }

    lastRules = data;
    return data;
  }

  /**
   * Get deterministic per-user run salt from backend.
   * This avoids hardcoding real salts in frontend code.
   *
   * @returns {Promise<string>}
   */
  async function fetchRunSalt() {
    if (cachedRunSalt) {
      return cachedRunSalt;
    }

    const response = await fetch(runSaltUrl(), {
      method: "GET",
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Failed to load run salt (HTTP ${response.status})`);
    }

    const data = await response.json();
    const salt = String(data?.salt || "").trim();

    if (!salt) {
      throw new Error("Backend returned empty run salt");
    }

    cachedRunSalt = salt;
    return salt;
  }

  /**
   * Resolve effective salt for hashing.
   * Priority:
   * 1) per-user run salt from backend endpoint
   * 2) salt from loaded rules JSON
   *
   * @param {any} rulesJson
   * @returns {Promise<string>}
   */
  async function resolveEffectiveSalt(rulesJson) {
    try {
      return await fetchRunSalt();
    } catch (e) {
      console.warn("fetchRunSalt failed, falling back to rules.salt", e);
    }

    const rulesSalt = String(rulesJson?.salt || "").trim();
    if (!rulesSalt) {
      throw new Error("No usable salt available from backend");
    }

    return rulesSalt;
  }

  // ---------------- Deterministic hashing helpers ----------------

  async function _sha256Hex(s) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(s)
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function _uidFromHash(seed) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(seed)
    );
    const arr = new Uint8Array(buf).slice(0, 16);

    let v = 0n;
    for (const b of arr) {
      v = (v << 8n) + BigInt(b);
    }

    return `2.25.${v.toString(10)}`;
  }

  // ---------------- Identifier normalization ----------------

  /**
   * Normalize identifier-like values before hashing/comparison.
   * This prevents mismatches caused by:
   * - leading/trailing spaces
   * - repeated whitespace
   * - NBSP
   * - zero-width Unicode characters
   * - Unicode normalization differences
   *
   * @param {any} value
   * @returns {string}
   */
  function normalizeIdentifierForHash(value) {
    if (value == null) return "";

    let s = String(value);

    try {
      s = s.normalize("NFKC");
    } catch {
      // Ignore if Unicode normalization is unavailable.
    }

    // Remove zero-width characters and BOM.
    s = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");

    // Normalize NBSP to regular spaces.
    s = s.replace(/\u00A0/g, " ");

    // Collapse whitespace and trim.
    s = s.replace(/\s+/g, " ").trim();

    return s;
  }

  /**
   * Create a filesystem-safe token.
   *
   * @param {any} value
   * @param {string} fallback
   * @returns {string}
   */
  function sanitizePathToken(value, fallback = "UNKNOWN") {
    const normalized = normalizeIdentifierForHash(value);
    const safe = normalized.replace(/[^0-9A-Za-z._-]+/g, "_");
    return safe || fallback;
  }

  // ---------------- DICOM byte helpers ----------------

  /**
   * Encode a fixed-length value with DICOM-like padding rules.
   *
   * @param {string} str
   * @param {number} length
   * @param {string|undefined} vr
   * @returns {Uint8Array}
   */
  function _encodeFixed(str, length, vr) {
    const padByte = vr === "UI" ? 0x00 : 0x20;
    const bytes = new Uint8Array(length);
    bytes.fill(padByte);

    const s = String(str || "");
    const n = Math.min(s.length, length);

    for (let i = 0; i < n; i++) {
      bytes[i] = s.charCodeAt(i) & 0x7f;
    }

    return bytes;
  }

  function _readStr(ds, key) {
    try {
      return ds.string(key) ?? "";
    } catch {
      return "";
    }
  }

  function _writeElementString(ds, key, newVal, vrHint) {
    const el = ds.elements[key];
    if (!el || el.length == null || el.dataOffset == null) {
      return false;
    }

    const bytes = _encodeFixed(newVal, el.length, vrHint);
    ds.byteArray.set(bytes, el.dataOffset);
    return true;
  }

  // ---------------- Date / age helpers ----------------

  function _roundTo5(n) {
    return Math.round(n / 5) * 5;
  }

  function _parseAgeAS(s) {
    const m = String(s || "")
      .trim()
      .match(/^(\d{1,3})\s*([YMWD])$/i);

    if (!m) return null;

    const num = parseInt(m[1], 10);
    if (!Number.isFinite(num)) return null;

    return { num, unit: m[2].toUpperCase() };
  }

  function _formatAgeAS(num, unit) {
    const n = Math.max(0, Math.min(999, Math.trunc(num)));
    return String(n).padStart(3, "0") + unit;
  }

  // ---------------- DICOM ID extraction ----------------

  /**
   * Read a DICOM string safely.
   *
   * @param {any} ds
   * @param {string} key
   * @returns {string}
   */
  function _safeDicomString(ds, key) {
    try {
      return ds.string(key) || "";
    } catch {
      return "";
    }
  }

  /**
   * Extract DICOM identifiers from an already parsed dataset.
   * This avoids reparsing the same ArrayBuffer when the caller already has ds.
   *
   * @param {any} ds
   * @returns {{patientId: string, studyId: string, seriesUid: string}}
   */
  function extractDicomIdsFromDataSet(ds) {
    return {
      patientId: normalizeIdentifierForHash(_safeDicomString(ds, "x00100020")),
      studyId: normalizeIdentifierForHash(_safeDicomString(ds, "x00200010")),
      seriesUid: normalizeIdentifierForHash(_safeDicomString(ds, "x0020000e"))
    };
  }

  /**
   * Extract original DICOM identifiers from ArrayBuffer.
   *
   * @param {ArrayBuffer} ab
   * @returns {{patientId: string, studyId: string, seriesUid: string}|null}
   */
  function extractOriginalDicomIdsFromArrayBuffer(ab) {
    try {
      const dicomParser = window.dicomParser;
      if (!dicomParser) return null;

      const byteArray = new Uint8Array(ab);
      const ds = dicomParser.parseDicom(byteArray);

      return extractDicomIdsFromDataSet(ds);
    } catch (e) {
      console.warn("extractOriginalDicomIdsFromArrayBuffer failed", e);
      return null;
    }
  }

  /**
   * Extract anonymized DICOM identifiers from ArrayBuffer.
   *
   * @param {ArrayBuffer} ab
   * @returns {{patientId: string, studyId: string, seriesUid: string}|null}
   */
  function extractAnonymizedDicomIdsFromArrayBuffer(ab) {
    try {
      const dicomParser = window.dicomParser;
      if (!dicomParser) return null;

      const byteArray = new Uint8Array(ab);
      const ds = dicomParser.parseDicom(byteArray);

      return extractDicomIdsFromDataSet(ds);
    } catch (e) {
      console.warn("extractAnonymizedDicomIdsFromArrayBuffer failed", e);
      return null;
    }
  }

  // ---------------- Stable mapping caches ----------------

  const mapPatientName = new Map();
  const mapStudyName = new Map();
  const mapSeriesName = new Map();

  const mapPatientId = new Map();
  const mapStudyId = new Map();
  const mapSeriesUid = new Map();

  async function tokenFor(kind, originalName, salt) {
    const base = normalizeIdentifierForHash(originalName);
    const hex = await _sha256Hex(`${salt}::foldername::${kind}::${base}`);
    return `${kind}_${hex.slice(0, 8).toUpperCase()}`;
  }

  const detMapPatient = new Map();
  const detMapStudy = new Map();
  const detMapSeries = new Map();

  /**
   * Build deterministic tokens for patient/study/series folder names.
   *
   * @param {string} patient
   * @param {string} study
   * @param {string} series
   * @param {string} salt
   * @returns {Promise<{p: string, s: string, r: string}>}
   */
  async function getDeterministicFolderTokens(patient, study, series, salt) {
    if (patient && !detMapPatient.has(patient)) {
      detMapPatient.set(patient, await tokenFor("PAT", patient, salt));
    }
    if (study && !detMapStudy.has(study)) {
      detMapStudy.set(study, await tokenFor("STU", study, salt));
    }
    if (series && !detMapSeries.has(series)) {
      detMapSeries.set(series, await tokenFor("SER", series, salt));
    }

    return {
      p: detMapPatient.get(patient) || patient,
      s: detMapStudy.get(study) || study,
      r: detMapSeries.get(series) || series
    };
  }

  // ---------------- DICOM anonymization ----------------

  function _vrHintForTag(tag) {
    return ["0020000D", "0020000E", "00200052", "00080018"].includes(tag)
      ? "UI"
      : undefined;
  }

  function _keyOfTag(tag) {
    return "x" + String(tag || "").toLowerCase();
  }

  /**
   * Apply backend-loaded anonymization rules to an already parsed DICOM dataset.
   * The caller owns the byteArray/dataset and can extract metadata before/after
   * this function without reparsing the same file.
   *
   * @param {any} ds
   * @param {any} rulesJson
   * @returns {Promise<void>}
   */
  async function _applyDicomRulesToDataSet(ds, rulesJson) {
    if (!rulesJson || !Array.isArray(rulesJson.dicom_rules)) {
      throw new Error("dicom_rules are missing");
    }

    const salt = await resolveEffectiveSalt(rulesJson);
    const dicomRules = rulesJson.dicom_rules;

    for (const rule of dicomRules) {
      const tag = String(rule?.tag || "").toUpperCase();
      if (!tag) continue;

      const key = _keyOfTag(tag);
      const op = String(rule?.op || "").toLowerCase();
      const cur = _readStr(ds, key);
      const vrH = _vrHintForTag(tag);
      const vr = String(rule?.vr || "LO").toUpperCase();

      switch (op) {
        case "set": {
          _writeElementString(ds, key, rule.value ?? "", vrH || vr);
          break;
        }

        case "remove":
        case "clear": {
          _writeElementString(ds, key, "", vrH || vr);
          break;
        }

        case "hash": {
          const normalized = normalizeIdentifierForHash(cur);
          const base = normalized || tag;

          const full = await _sha256Hex(`${salt}|${base}`);
          const requestedRaw = rule.len ?? rule.length;
          const requested = Number.isFinite(Number(requestedRaw))
            ? Math.max(1, Math.floor(Number(requestedRaw)))
            : null;

          const fallbackLen = vr === "SH" ? 16 : 24;
          const outLen = requested ?? fallbackLen;
          const out = full.slice(0, outLen);

          _writeElementString(ds, key, out, vrH || vr);
          break;
        }

        case "hash_uid": {
          const normalized = normalizeIdentifierForHash(cur);
          const base = normalized || tag;
          const uid = await _uidFromHash(`${salt}|${base}|${tag}`);
          _writeElementString(ds, key, uid, "UI");
          break;
        }

        case "age_round_5": {
          const parsed = _parseAgeAS(cur);
          if (!parsed) break;

          const rounded = _roundTo5(parsed.num);
          const out = _formatAgeAS(rounded, parsed.unit);
          _writeElementString(ds, key, out, "AS");
          break;
        }

        default:
          break;
      }
    }
  }

  /**
   * Apply backend-loaded anonymization rules and return the anonymized Blob
   * together with original and anonymized DICOM identifiers.
   *
   * This is the optimized API used by sibling_folder_flow.js so one DICOM file
   * does not need to be parsed again for original IDs and then again for
   * anonymized IDs.
   *
   * @param {ArrayBuffer} ab
   * @param {any} rulesJson
   * @returns {Promise<{blob: Blob, originalIds: {patientId: string, studyId: string, seriesUid: string}, anonymizedIds: {patientId: string, studyId: string, seriesUid: string}}>} 
   */
  async function anonymizeDicomArrayBufferWithMetadata(ab, rulesJson) {
    const dicomParser = window.dicomParser;
    if (!dicomParser) {
      throw new Error("dicomParser is not available");
    }

    const byteArray = new Uint8Array(ab);
    let ds;

    try {
      ds = dicomParser.parseDicom(byteArray);
    } catch (err) {
      if (err && typeof err === "object") {
        err.code = "NOT_DICOM";
      }
      throw err;
    }

    const originalIds = extractDicomIdsFromDataSet(ds);
    await _applyDicomRulesToDataSet(ds, rulesJson);
    const anonymizedIds = extractDicomIdsFromDataSet(ds);

    return {
      blob: new Blob([byteArray.buffer], { type: "application/dicom" }),
      originalIds,
      anonymizedIds
    };
  }

  /**
   * Apply backend-loaded anonymization rules to a DICOM ArrayBuffer.
   *
   * Kept for backward compatibility. New callers that also need metadata should
   * use anonymizeDicomArrayBufferWithMetadata().
   *
   * @param {ArrayBuffer} ab
   * @param {any} rulesJson
   * @returns {Promise<Blob>}
   */
  async function anonymizeDicomArrayBuffer(ab, rulesJson) {
    const result = await anonymizeDicomArrayBufferWithMetadata(ab, rulesJson);
    return result.blob;
  }

  // ---------------- Public API ----------------

  window.siblingDicom = {
    fetchRules,
    fetchRunSalt,
    resolveEffectiveSalt,
    getDeterministicFolderTokens,
    extractDicomIdsFromDataSet,
    extractOriginalDicomIdsFromArrayBuffer,
    extractAnonymizedDicomIdsFromArrayBuffer,
    anonymizeDicomArrayBuffer,
    anonymizeDicomArrayBufferWithMetadata,
    normalizeIdentifierForHash,
    sanitizePathToken,
    mapPatientName,
    mapStudyName,
    mapSeriesName,
    mapPatientId,
    mapStudyId,
    mapSeriesUid
  };
})();
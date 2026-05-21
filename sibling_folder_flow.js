(() => {
  "use strict";

  // ============================== DOM ==============================

  /** @type {(id: string) => HTMLElement | null} */
  const $ = (id) => document.getElementById(id);

  const els = /** @type {const} */ ({
    folderPicker: /** @type {HTMLInputElement | null} */ ($("folderPicker")),
    inputPath: /** @type {HTMLInputElement | null} */ ($("inputPath")),
    btnChooseDest: /** @type {HTMLButtonElement | null} */ ($("btnChooseDest")),
    outputPath: /** @type {HTMLInputElement | null} */ ($("outputPath")),
    btnRun: /** @type {HTMLButtonElement | null} */ ($("btnRun")),
    status: /** @type {HTMLPreElement | null} */ ($("status")),
    bar: /** @type {HTMLDivElement | null} */ ($("bar")),
    progressText: /** @type {HTMLSpanElement | null} */ ($("progressText")),
    profileSelect: /** @type {HTMLSelectElement | null} */ ($("profileSelect")),
    rulesLink: /** @type {HTMLAnchorElement | null} */ ($("rulesLink")),
    anonRootPicker: /** @type {HTMLInputElement | null} */ ($("anonRootPicker")),
    anonRootPath: /** @type {HTMLInputElement | null} */ ($("anonRootPath")),
    btnScanStudies: /** @type {HTMLButtonElement | null} */ ($("btnScanStudies")),
    btnUploadAll: /** @type {HTMLButtonElement | null} */ ($("btnUploadAll")),
    archiveSelect: /** @type {HTMLSelectElement | null} */ ($("archiveSelect")),
    uploadLog: /** @type {HTMLPreElement | null} */ ($("uploadLog")),
    btnDownloadAnonLog: /** @type {HTMLButtonElement | null} */ ($("btnDownloadAnonLog")),
    btnDownloadUploadLog: /** @type {HTMLButtonElement | null} */ ($("btnDownloadUploadLog")),
  });

  // ======================== Shared helpers =========================

  const {
    fmtBytes,
    pathParts,
    isDicomName,
    downloadTxt,
    fmtDuration,
    getCsrfToken,
    summarizeUnsupported,
  } = window.siblingUtils || {};

  const {
    fetchRules,
    fetchRunSalt,
    resolveEffectiveSalt,
    anonymizeDicomArrayBufferWithMetadata,
    normalizeIdentifierForHash,
    sanitizePathToken,
    mapPatientId,
    mapStudyId,
    mapSeriesUid,
  } = window.siblingDicom || {};

  /** @returns {any} */
  const getJSZip = () => window.JSZip;

  if (!window.siblingUtils || !window.siblingDicom) {
    console.warn("sibling_folder_flow.js: missing siblingUtils or siblingDicom; flow disabled.");
    return;
  }

  // ========================== Config helpers ==========================

  function cfg() {
    const el = document.getElementById("dicomAnonConfig");
    if (el && el.dataset) {
      return /** @type {HTMLElement & { dataset: DOMStringMap }} */ (el);
    }
    return /** @type {HTMLElement & { dataset: DOMStringMap }} */ ({
      dataset: /** @type {DOMStringMap} */ ({}),
    });
  }

  /** @returns {string} */
  function rulesBase() {
    const raw = cfg().dataset.rulesBase || "/dicom-anonymizer/rules/";
    return raw.endsWith("/") ? raw : raw + "/";
  }

  /** @returns {string} */
  function defaultProfile() {
    return cfg().dataset.defaultProfile || "default";
  }

  /** @returns {string} */
  function preselectedArchiveId() {
    return cfg().dataset.selectedArchiveId || "";
  }

  /** @returns {string} */
  function uploadUrl() {
    return cfg().dataset.uploadUrl || "/dicom-anonymizer/upload/submit/";
  }

  // ============================== State ==============================

  /** @type {File[]} */ let srcFiles = [];
  /** @type {File[]} */ let skippedUnsupported = [];
  /** @type {Array<{ name: string, reason: string }>} */ let skippedUnreadableDicom = [];
  /** @type {File | null} */ let selectedClinicalFile = null;
  /** @type {string} */ let srcRoot = "";
  /** @type {FileSystemDirectoryHandle | null} */ let destHandle = null;
  /** @type {FileSystemDirectoryHandle | null} */ let liveAnonHandle = null;
  /** @type {Record<string, Record<string, { files: File[]; bytes: number; patientId: string; studyId: string; seriesUid: string }>> | null} */ let seriesIndex = null;
  /** @type {Date | null} */ let startTime = null;

  const seriesCounter = new Map();

  /**
   * Cache parsed first-file metadata to avoid repeated arrayBuffer + parseDicom
   * Key: File object
   * Value: parsed metadata or null on failure
   * @type {Map<File, {
   *   patientName: string;
   *   patientId: string;
   *   studyId: string;
   *   seriesUid: string;
   * } | null>}
   */
  const dicomMetaCache = new Map();

  window.__dicomSeriesIndex = seriesIndex;
  window.__dicomLiveAnonHandle = liveAnonHandle;
  window.__dicomAutoSubdirName = "";

  // ============================== UI helpers ==============================

  /**
   * @param {number} done
   * @param {number} total
   */
  function setProgress(done, total) {
    const safeTotal = Math.max(0, total | 0);
    const safeDone = Math.min(Math.max(0, done | 0), safeTotal);
    const pct = safeTotal ? Math.round((safeDone / safeTotal) * 100) : 0;

    if (els.bar) {
      els.bar.style.width = `${pct}%`;
    }
    if (els.progressText) {
      els.progressText.textContent = `${safeDone} / ${safeTotal} files (${pct}%)`;
    }
  }

  /**
   * @param {string} text
   * @param {string} [filenameHint="anonymization_log.txt"]
   */
  function setAnonStatus(text, filenameHint = "anonymization_log.txt") {
    const area = els.status;
    if (area) {
      area.style.whiteSpace = "pre-wrap";
      area.style.wordBreak = "break-word";
      area.textContent = text;
    }
    const btn = els.btnDownloadAnonLog;
    if (btn) {
      btn.disabled = false;
      btn.onclick = () => downloadTxt(filenameHint, text);
    }
  }

  // ==========================================================
  // UI Refresh & Rule helpers
  // ==========================================================

  function refreshRulesLink() {
    const slug = els.profileSelect?.value || defaultProfile();
    if (els.rulesLink) {
      els.rulesLink.href = `${rulesBase()}${encodeURIComponent(slug)}/`;
    }
  }

  function refreshUIState() {
    const hasArchive = Boolean(els.archiveSelect?.value);
    const anonPickerHasFiles = !!(els.anonRootPicker?.files?.length);
    const haveAnonRoot = Boolean(liveAnonHandle?.name) || anonPickerHasFiles;

    if (els.btnScanStudies) {
      els.btnScanStudies.disabled = !(hasArchive && haveAnonRoot);
    }
  }

  // ==========================================================
  // Filesystem I/O helpers
  // ==========================================================

  async function ensureDir(parentHandle, relPath) {
    const parts = pathParts(relPath);
    let dir = parentHandle;
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create: true });
    }
    return dir;
  }

  async function writeFile(dirHandle, relPath, blob) {
    const parts = pathParts(relPath);
    const fname = parts.pop();
    if (!fname) throw new Error("Invalid file name");
    const dir = await ensureDir(dirHandle, parts.join("/"));
    const fh = await dir.getFileHandle(fname, { create: true });
    const ws = await fh.createWritable();
    await ws.write(blob);
    await ws.close();
  }

  // ==========================================================
  // Helpers: identifiers and grouping
  // ==========================================================

  /**
   * @param {any} value
   * @returns {string}
   */
  function norm(value) {
    if (typeof normalizeIdentifierForHash === "function") {
      return normalizeIdentifierForHash(value);
    }
    if (value == null) return "";
    return String(value).trim();
  }

  /**
   * @param {any} value
   * @param {string} fallback
   * @returns {string}
   */
  function safeToken(value, fallback = "UNKNOWN") {
    if (typeof sanitizePathToken === "function") {
      return sanitizePathToken(value, fallback);
    }
    const s = norm(value).replace(/[^0-9A-Za-z._-]+/g, "_");
    return s || fallback;
  }

  /**
   * @param {string} patientId
   * @param {string} studyId
   * @returns {string}
   */
  function makeStudyKey(patientId, studyId) {
    return `PAT_${safeToken(patientId, "UNKNOWN_PAT")}/STU_${safeToken(studyId, "UNKNOWN_STU")}`;
  }

  /**
   * @param {string} seriesUid
   * @returns {string}
   */
  function makeSeriesName(seriesUid) {
    return `SER_${safeToken(seriesUid, "UNKNOWN_SER")}`;
  }

  /**
   * True if the file should be considered a clinical file candidate.
   * @param {File} file
   * @returns {boolean}
   */
  function isClinicalCandidate(file) {
    const name = String(file?.name || "").toLowerCase();
    return /\.(xlsx|xls|json)$/i.test(name);
  }

  /**
   * Fast/cheap name-based prefilter:
   * - explicit DICOM-like extensions -> yes
   * - files without extension -> maybe
   * - obvious non-DICOM extensions -> no
   *
   * @param {File} file
   * @returns {boolean}
   */
  function isPotentialDicomCandidate(file) {
    const name = String(file?.name || "");
    const lower = name.toLowerCase();

    if (/\.(dcm|dicom|ima)$/i.test(lower)) {
      return true;
    }

    if (
      /\.(pdf|png|jpg|jpeg|gif|webp|svg|bmp|tif|tiff|zip|rar|7z|tar|gz|xz|bz2|csv|tsv|txt|md|doc|docx|ppt|pptx|xls|xlsx|json|xml|html|htm|js|css|py)$/i.test(
        lower
      )
    ) {
      return false;
    }

    // No extension at all -> common in DICOM exports, try safely.
    return !name.includes(".");
  }

  /**
   * Safe DICOM parse.
   * Returns dataset or null. Never throws to the outer flow.
   *
   * @param {ArrayBuffer} ab
   * @returns {any | null}
   */
  function tryParseDicom(ab) {
    try {
      const dicomParser = window.dicomParser;
      if (!dicomParser) return null;

      const byteArray = new Uint8Array(ab);
      return dicomParser.parseDicom(byteArray);
    } catch {
      return null;
    }
  }

  /**
   * Normalize possible identifier object shapes returned by old/new helpers.
   *
   * @param {any} ids
   * @returns {{patientId: string, studyId: string, seriesUid: string}}
   */
  function normalizeDicomIds(ids) {
    if (!ids || typeof ids !== "object") {
      return { patientId: "", studyId: "", seriesUid: "" };
    }

    return {
      patientId: norm(
        ids.patientId ??
          ids.PatientID ??
          ids.patient_id ??
          ids.patientID ??
          ""
      ),
      studyId: norm(
        ids.studyId ??
          ids.StudyID ??
          ids.study_id ??
          ids.studyID ??
          ids.studyInstanceUid ??
          ids.StudyInstanceUID ??
          ""
      ),
      seriesUid: norm(
        ids.seriesUid ??
          ids.SeriesInstanceUID ??
          ids.seriesInstanceUid ??
          ids.series_uid ??
          ids.seriesUID ??
          ""
      ),
    };
  }

  /**
   * @param {{patientId?: string, studyId?: string, seriesUid?: string} | null} ids
   * @returns {boolean}
   */
  function hasUsefulDicomIds(ids) {
    return Boolean(ids && (ids.patientId || ids.studyId || ids.seriesUid));
  }

  /**
   * Run DICOM anonymization and return the output blob together with original
   * and anonymized identifiers.
   *
   * This flow requires siblingDicom.anonymizeDicomArrayBufferWithMetadata().
   * The previous repeated parse/extract/anonymize/parse-output path was removed
   * intentionally, because both changed files must be merged together.
   *
   * @param {ArrayBuffer} buf
   * @param {any} rulesCfg
   * @returns {Promise<{outBlob: Blob, originalIds: {patientId: string, studyId: string, seriesUid: string}, anonymizedIds: {patientId: string, studyId: string, seriesUid: string}}>} 
   */
  async function anonymizeForFolderFlow(buf, rulesCfg) {
    if (typeof anonymizeDicomArrayBufferWithMetadata !== "function") {
      throw new Error(
        "anonymizeDicomArrayBufferWithMetadata is not available. " +
          "Please merge the updated sibling_dicom_anonymizer_core.js together with sibling_folder_flow.js."
      );
    }

    const result = await anonymizeDicomArrayBufferWithMetadata(buf, rulesCfg);

    const outBlob = result?.blob || result?.outBlob || result?.anonymizedBlob || null;
    if (!outBlob) {
      throw new Error("Metadata-aware anonymizer did not return an anonymized Blob.");
    }

    const originalIds = normalizeDicomIds(result?.originalIds);
    const anonymizedIds = normalizeDicomIds(result?.anonymizedIds);

    if (!hasUsefulDicomIds(originalIds)) {
      throw new Error("Metadata-aware anonymizer did not return original DICOM identifiers.");
    }

    if (!hasUsefulDicomIds(anonymizedIds)) {
      throw new Error("Metadata-aware anonymizer did not return anonymized DICOM identifiers.");
    }

    return { outBlob, originalIds, anonymizedIds };
  }

  /**
   * Parse DICOM once and cache a small metadata subset used in scan/preflight.
   * Returns null if the file is not a readable DICOM P10 file.
   *
   * @param {File} file
   * @returns {Promise<{patientName: string, patientId: string, studyId: string, seriesUid: string} | null>}
   */
  async function readDicomMeta(file) {
    if (!file) return null;

    if (dicomMetaCache.has(file)) {
      return dicomMetaCache.get(file) || null;
    }

    try {
      const buf = await file.arrayBuffer();
      const dataSet = tryParseDicom(buf);
      if (!dataSet) {
        dicomMetaCache.set(file, null);
        return null;
      }

      const patientId = norm(dataSet.string("x00100020") || "");
      const studyId =
        norm(dataSet.string("x00200010") || "") ||
        norm(dataSet.string("x0020000d") || "");
      const seriesUid = norm(dataSet.string("x0020000e") || "");

      const meta = {
        patientName: String(dataSet.string("x00100010") || "").trim(),
        patientId,
        studyId,
        seriesUid,
      };

      dicomMetaCache.set(file, meta);
      return meta;
    } catch {
      dicomMetaCache.set(file, null);
      return null;
    }
  }

  /**
   * Build series index based on DICOM metadata, not folder names.
   *
   * @param {Array<File | { file: File; relPath?: string }>} items
   * @returns {Promise<Record<string, Record<string, { files: File[]; bytes: number; patientId: string; studyId: string; seriesUid: string }>>>}
   */
  async function buildSeriesIndex(items) {
    /** @type {Record<string, Record<string, { files: File[]; bytes: number; patientId: string; studyId: string; seriesUid: string }>>} */
    const out = {};

    for (const item of items) {
      const f = /** @type {File} */ (item.file || item);
      const meta = await readDicomMeta(f);
      if (!meta) continue;

      const patientId = meta.patientId || "UNKNOWN_PAT";
      const studyId = meta.studyId || "UNKNOWN_STU";
      const seriesUid = meta.seriesUid || `UNKNOWN_SER_${safeToken(f.name, "FILE")}`;

      const studyKey = makeStudyKey(patientId, studyId);
      const seriesName = makeSeriesName(seriesUid);

      out[studyKey] ??= {};
      out[studyKey][seriesName] ??= {
        files: [],
        bytes: 0,
        patientId,
        studyId,
        seriesUid,
      };

      out[studyKey][seriesName].files.push(f);
      out[studyKey][seriesName].bytes += f.size || 0;
    }

    return out;
  }

  async function zipOneSeries(seriesName, info, compressionLevel = 7) {
    const JSZip = getJSZip();
    const zip = new JSZip();

    const serId = safeToken(info?.seriesUid || seriesName.replace(/^SER_/, ""), "UNKNOWN_SER");
    const patId = safeToken(info?.patientId || "UNKNOWN_PAT", "UNKNOWN_PAT");

    let counter = 1;
    for (const f of info.files) {
      const dcmName = `image_SER_${serId}_PAT_${patId}_${String(counter).padStart(3, "0")}.dcm`;
      zip.file(dcmName, f);
      counter++;
    }

    return zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: compressionLevel },
    });
  }

  window.__dicomZipOneSeries = zipOneSeries;
  window.__dicomUploadUrl = uploadUrl;
  window.__dicomDefaultProfile = defaultProfile;

  // ==========================================================
  // Run-state controls
  // ==========================================================

  function enableRunIfReady() {
    if (els.btnRun) {
      els.btnRun.disabled = !(srcFiles.length && destHandle);
    }
  }

  let autoSubdirName = "";

  function computeAutoName() {
    const now = new Date();
    const t = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
    autoSubdirName = `${srcRoot || "anon"}_anonymized-${t}`;
    window.__dicomAutoSubdirName = autoSubdirName;
    return autoSubdirName;
  }

  /**
   * @param {File} file
   * @returns {Promise<string|null>}
   */
  async function extractSeriesUidToken(file) {
    try {
      const meta = await readDicomMeta(file);
      const uid = String(meta?.seriesUid || "").trim();
      if (!uid) return null;
      return safeToken(uid, "UNKNOWN_SER");
    } catch {
      return null;
    }
  }

  /**
   * @param {File} file
   * @returns {Promise<{ok: boolean, patientName?: string, patientId?: string, studyId?: string, reason?: string}>}
   */
  async function verifyAnonymizedDicom(file) {
    try {
      const meta = await readDicomMeta(file);
      if (!meta) {
        return { ok: false, reason: "Failed to parse DICOM for anonymization check" };
      }

      const patientName = meta.patientName;
      const patientId = meta.patientId;
      const studyId = meta.studyId;

      if (patientName !== "Anonymous") {
        return {
          ok: false,
          patientName,
          patientId,
          studyId,
          reason: 'PatientName must be exactly "Anonymous"',
        };
      }

      if (!patientId || patientId.length < 1 || patientId.length > 6) {
        return {
          ok: false,
          patientName,
          patientId,
          studyId,
          reason: "PatientID must be 1–6 characters long",
        };
      }

      if (!studyId || studyId.length < 1 || studyId.length > 8) {
        return {
          ok: false,
          patientName,
          patientId,
          studyId,
          reason: "StudyID must be 1–8 characters long",
        };
      }

      return { ok: true, patientName, patientId, studyId };
    } catch {
      return { ok: false, reason: "Failed to parse DICOM for anonymization check" };
    }
  }

  // ==========================================================
  // Preflight – check existing items on server
  // ==========================================================

  function _parseExistingPayload(data) {
    const out = { series: new Set(), studies: new Set() };
    if (!data) return out;

    const ex = data.existing || data;

    if (Array.isArray(ex.series)) {
      ex.series
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .forEach((uid) => out.series.add(uid));
    }

    if (Array.isArray(ex.study)) {
      ex.study
        .map((x) => String(x || "").trim())
        .filter((s) => s.includes("/"))
        .forEach((s) => out.studies.add(s));
    }

    return out;
  }

  /**
   * @param {string} archiveRef
   * @param {string[]} seriesUids
   * @returns {Promise<Set<string>>}
   */
  async function serverPreflightSeries(archiveRef, seriesUids) {
    if (!archiveRef) return new Set();

    const uids = Array.from(
      new Set((seriesUids || []).map((x) => String(x || "").trim()).filter(Boolean)),
    );

    if (!uids.length) return new Set();

    const base = `/dicom-anonymizer/api/archives/${encodeURIComponent(archiveRef)}/existing-items/`;
    const token = getCsrfToken();

    const tryFetch = async (url, opts = {}) => {
      try {
        const r = await fetch(url, { credentials: "same-origin", ...opts });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        if (!d) return null;
        const parsed = _parseExistingPayload(d);
        return parsed.series.size ? parsed.series : new Set();
      } catch {
        return null;
      }
    };

    const sPost = await tryFetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": token,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ keys: uids }),
    });
    if (sPost) return sPost;

    const qs = `?keys=${encodeURIComponent(uids.join(","))}`;
    const sGet = await tryFetch(base + qs);
    if (sGet) return sGet;

    const sAll = await tryFetch(base);
    return sAll || new Set();
  }

  window.siblingPreflight = { serverPreflightSeries };

  // ==========================================================
  // Counter + Checkbox helpers
  // ==========================================================

  function updateCounters() {
    const rows = Array.from(document.querySelectorAll("#studyRows tr"));
    const countNew = rows.filter((r) => r.dataset.status === "NEW").length;
    const countConf = rows.filter((r) => r.dataset.status === "CONFLICT").length;
    const checkedRows = rows.filter((r) => r.querySelector(".series-check")?.checked);
    const countSelected = checkedRows.length;

    const selBytes = checkedRows.reduce((sum, r) => {
      const { study, series } = r.dataset;
      return sum + ((seriesIndex?.[study]?.[series]?.bytes) || 0);
    }, 0);

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setText("countNew", `(${countNew})`);
    setText("countConflicts", `(${countConf})`);
    setText("countSelected", `(${countSelected})`);
    setText("summarySelected", String(countSelected));
    setText("summarySize", fmtBytes(selBytes));

    const btnApply = document.getElementById("btnApplyPolicy");
    if (btnApply) {
      btnApply.disabled = !(countSelected && countConf);
    }
  }

  function setHeaderCheckboxState() {
    const rows = Array.from(document.querySelectorAll("#studyRows tr"));
    const total = rows.length;
    const checked = rows.filter((r) => r.querySelector(".series-check")?.checked).length;

    /** @type {HTMLInputElement | null} */
    const hdr = /** @type any */ (document.getElementById("chkHeaderSelect"));
    if (!hdr) return;

    hdr.indeterminate = checked > 0 && checked < total;
    hdr.checked = checked === total && total > 0;

    /** @type {HTMLInputElement | null} */
    const footAll = /** @type any */ (document.getElementById("chkSelectAll"));
    if (footAll) {
      footAll.checked = hdr.checked && !hdr.indeterminate;
    }
  }

  function wireSelectionControls() {
    /** @type {HTMLInputElement | null} */
    const hdr = /** @type any */ (document.getElementById("chkHeaderSelect"));
    const tbody = document.getElementById("studyRows");
    /** @type {HTMLInputElement | null} */
    const footAll = /** @type any */ (document.getElementById("chkSelectAll"));

    if (hdr) {
      hdr.onchange = () => {
        document.querySelectorAll("#studyRows .series-check").forEach((cb) => {
          /** @type {HTMLInputElement} */ (cb).checked = hdr.checked;
        });
        updateCounters();
        setHeaderCheckboxState();
      };
    }

    if (tbody) {
      tbody.onchange = (e) => {
        const t = e.target;

        if (
          t instanceof HTMLInputElement &&
          t.classList.contains("series-check")
        ) {
          updateCounters();
          setHeaderCheckboxState();
          return;
        }

        if (
          t instanceof HTMLSelectElement &&
          t.classList.contains("policy-select")
        ) {
          const row = t.closest("tr");
          /** @type {HTMLInputElement | null} */
          const cb = /** @type any */ (row?.querySelector(".series-check"));
          if (cb) cb.checked = t.value !== "skip";
          updateCounters();
          setHeaderCheckboxState();
        }
      };
    }

    if (footAll && hdr) {
      footAll.onchange = () => {
        hdr.checked = footAll.checked;
        hdr.dispatchEvent(new Event("change"));
      };
    }

    setHeaderCheckboxState();
    updateCounters();
  }

  // ==========================================================
  // XLSX helpers
  // ==========================================================

  function hasXlsxSupport() {
    return typeof XLSX !== "undefined";
  }

  /**
   * @param {File} file
   * @returns {Promise<any[]>}
   */
  async function readXlsxAsJson(file) {
    if (!hasXlsxSupport()) {
      throw new Error("XLSX library is not available.");
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  // ==========================================================
  // Event bindings & main flow
  // ==========================================================

  document.addEventListener("DOMContentLoaded", () => {
    const preset = preselectedArchiveId();
    if (preset && els.archiveSelect && !els.archiveSelect.value) {
      els.archiveSelect.value = preset;
    }
    refreshRulesLink();
    refreshUIState();
    enableRunIfReady();
  });

  els.profileSelect?.addEventListener("change", refreshRulesLink);

  els.folderPicker?.addEventListener("change", (ev) => {
    const files = Array.from(ev.target.files || []);
    selectedClinicalFile = null;
    skippedUnreadableDicom = [];

    // Clinical file is selected explicitly by the user in a separate control.
    // Here we only prepare potential DICOM candidates and obvious unsupported files.
    srcFiles = files.filter((f) => isPotentialDicomCandidate(f));
    skippedUnsupported = files.filter(
      (f) => !isPotentialDicomCandidate(f) && !isClinicalCandidate(f)
    );

    const first = files[0] || null;
    srcRoot = first?.webkitRelativePath?.split("/")?.[0] || "Root";
    if (els.inputPath) {
      els.inputPath.textContent = srcRoot || "— not selected —";
    }

    computeAutoName();
    if (destHandle && els.outputPath) {
      els.outputPath.textContent = `${destHandle.name}/${autoSubdirName}`;
    }

    refreshUIState();
    enableRunIfReady();
  });

  const clinicalPicker = document.getElementById("clinicalFilePicker");
  const clinicalLabel = document.getElementById("inputClDataPath");

  if (clinicalPicker && clinicalLabel) {
    clinicalPicker.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0] || null;
      const logArea = document.getElementById("status") || document.getElementById("uploadLog");

      selectedClinicalFile = file;

      if (file) {
        clinicalLabel.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        clinicalLabel.classList.remove("text-muted");
        clinicalLabel.classList.add("text-success");

        if (/\.(xlsx|xls)$/i.test(file.name) && hasXlsxSupport()) {
          try {
            const jsonData = await readXlsxAsJson(file);
            const ids = new Set(jsonData.map((r) => r["Study_ID"]).filter(Boolean));
            const studyCount = ids.size;

            const msg = [
              "[Clinical Data]",
              `- File selected: ${file.name}`,
              `- Found ${studyCount} unique Study_ID entr${studyCount === 1 ? "y" : "ies"}`,
              "",
            ].join("\n");

            window.__lastClinicalLog = msg.split("\n");

            if (logArea) {
              logArea.textContent = (logArea.textContent ? logArea.textContent + "\n" : "") + msg;
            }
          } catch (err) {
            if (logArea) {
              logArea.textContent += `\nError reading clinical file: ${err && err.message ? err.message : String(err)}`;
            }
          }
        }
      } else {
        selectedClinicalFile = null;
        clinicalLabel.textContent = "Not selected";
        clinicalLabel.classList.remove("text-success");
        clinicalLabel.classList.add("text-muted");
      }
    });
  }

  els.btnChooseDest?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    try {
      if (!window.showDirectoryPicker) {
        throw new Error("Your browser does not support selecting a destination folder.");
      }
      destHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      if (!autoSubdirName) computeAutoName();
      if (els.outputPath) {
        els.outputPath.textContent = `${destHandle.name}/${autoSubdirName}`;
      }
      refreshUIState();
      enableRunIfReady();
    } catch (e) {
      alert(e && e.message ? e.message : String(e));
    }
  });

  document.getElementById("btnChangeAnonRoot")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    try {
      if (!window.showDirectoryPicker) {
        throw new Error("Your browser cannot choose a folder here.");
      }
      const h = await window.showDirectoryPicker({ mode: "readwrite" });
      liveAnonHandle = h;
      window.__dicomLiveAnonHandle = liveAnonHandle;
      if (els.anonRootPath) {
        els.anonRootPath.textContent = h.name;
      }
      refreshUIState();
    } catch (e) {
      alert(e && e.message ? e.message : String(e));
    }
  });

  async function resolveSaltForRun(rulesJson) {
    if (typeof resolveEffectiveSalt === "function") {
      return await resolveEffectiveSalt(rulesJson);
    }

    if (typeof fetchRunSalt === "function") {
      const salt = await fetchRunSalt();
      if (salt) return salt;
    }

    const rulesSalt = String(rulesJson?.salt || "").trim();
    if (!rulesSalt) {
      throw new Error("No usable anonymization salt available");
    }
    return rulesSalt;
  }

  // ==========================================================
  // Anonymize main
  // ==========================================================

  els.btnRun?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!srcFiles.length || !destHandle) return;

    setAnonStatus("Preparing…");
    setProgress(0, srcFiles.length);

    try {
      startTime = new Date();
      skippedUnreadableDicom = [];

      const rulesCfg = await fetchRules();
      const effectiveSalt = await resolveSaltForRun(rulesCfg);

      mapPatientId.clear();
      mapStudyId.clear();
      mapSeriesUid.clear();
      seriesCounter.clear();

      const anonRootName = computeAutoName();
      const anonRoot = await destHandle.getDirectoryHandle(anonRootName, {
        create: true,
      });

      let done = 0;
      let dicomDone = 0;
      let bytesWritten = 0;

      for (const f of srcFiles) {
        try {
          const buf = await f.arrayBuffer();

          const {
            outBlob,
            originalIds,
            anonymizedIds,
          } = await anonymizeForFolderFlow(buf, rulesCfg);

          if (originalIds?.patientId && anonymizedIds?.patientId) {
            mapPatientId.set(originalIds.patientId, anonymizedIds.patientId);
          }
          if (originalIds?.studyId && anonymizedIds?.studyId) {
            mapStudyId.set(originalIds.studyId, anonymizedIds.studyId);
          }
          if (originalIds?.seriesUid && anonymizedIds?.seriesUid) {
            mapSeriesUid.set(originalIds.seriesUid, anonymizedIds.seriesUid);
          }

          const anonPatientId = anonymizedIds?.patientId || "UNKNOWN_PAT";
          const anonStudyId = anonymizedIds?.studyId || "UNKNOWN_STU";
          const anonSeriesUid =
            anonymizedIds?.seriesUid ||
            originalIds?.seriesUid ||
            `UNKNOWN_SER_${safeToken(f.name, "FILE")}`;

          const patFolder = `PAT_${safeToken(anonPatientId, "UNKNOWN_PAT")}`;
          const stuFolder = `STU_${safeToken(anonStudyId, "UNKNOWN_STU")}`;
          const serFolder = `SER_${safeToken(anonSeriesUid, "UNKNOWN_SER")}`;

          const counterKey = `${patFolder}/${stuFolder}/${serFolder}`;
          const prev = seriesCounter.get(counterKey) || 0;
          const counter = prev + 1;
          seriesCounter.set(counterKey, counter);

          const dcmName = `image_SER_${safeToken(anonSeriesUid, "UNKNOWN_SER")}_PAT_${safeToken(anonPatientId, "UNKNOWN_PAT")}_${String(counter).padStart(3, "0")}.dcm`;
          const leafPath = `${patFolder}/${stuFolder}/${serFolder}/${dcmName}`;
          await writeFile(anonRoot, leafPath, outBlob);

          bytesWritten += outBlob.size || 0;
          dicomDone++;
          setProgress(++done, srcFiles.length);
        } catch (err) {
          skippedUnreadableDicom.push({
            name: f.webkitRelativePath || f.name,
            reason:
              err?.code === "NOT_DICOM"
                ? "Not a readable DICOM P10 file"
                : "Failed during DICOM anonymization",
          });
          setProgress(++done, srcFiles.length);
        }
      }

      try {
        const clinicalFile = selectedClinicalFile;

        /** @type {string[]} */
        let clinicalLogLines = [];
        let studyCount = 0;

        if (clinicalFile) {
          if (hasXlsxSupport() && typeof anonymizeClinicalInFolder === "function") {
            const jsonData = await readXlsxAsJson(clinicalFile);
            const ids = new Set(jsonData.map((r) => r["Study_ID"]).filter(Boolean));
            studyCount = ids.size;

            await anonymizeClinicalInFolder([clinicalFile], rulesCfg, anonRoot);

            clinicalLogLines = [
              `- Selected file: ${clinicalFile.name}`,
              `- Found ${studyCount} unique Study_ID entr${studyCount === 1 ? "y" : "ies"}`,
              `- ${clinicalFile.name} anonymized → *_anon.xlsx`,
              "",
            ];
          } else {
            clinicalLogLines = [
              `- Selected clinical file: ${clinicalFile.name}`,
              "- XLSX or clinical anonymizer not available — anonymization skipped.",
              "",
            ];
          }
        } else {
          clinicalLogLines = [
            "- No clinical file selected, clinical anonymization skipped.",
            "",
          ];
        }

        window.__lastClinicalLog = clinicalLogLines;
      } catch {
        window.__lastClinicalLog = [
          "- Clinical anonymization failed.",
          "",
        ];
      }

      const idCsv = [
        `# salt=${effectiveSalt || ""}`,
        "OriginalPatientID,OriginalStudyID,OriginalSeriesUID,AnonPatientID,AnonStudyID,AnonSeriesUID",
        ...[...mapPatientId].map(([o, a]) => `${o},,,${a},,`),
        ...[...mapStudyId].map(([o, a]) => `,${o},,,${a},`),
        ...[...mapSeriesUid].map(([o, a]) => `,,${o},,,,${a}`),
      ].join("\n");

      await writeFile(
        anonRoot,
        "id_mapping.csv",
        new Blob([idCsv], { type: "text/csv" }),
      );

      liveAnonHandle = anonRoot;
      window.__dicomLiveAnonHandle = liveAnonHandle;
      if (els.anonRootPath) {
        els.anonRootPath.textContent = anonRoot.name;
      }
      if (els.btnScanStudies) els.btnScanStudies.disabled = false;
      if (els.btnUploadAll) els.btnUploadAll.disabled = true;

      const finished = new Date();
      const selectedProfile =
        els.profileSelect?.selectedOptions?.[0]?.textContent?.trim() ||
        els.profileSelect?.value ||
        defaultProfile();

      const unsupportedSection = skippedUnsupported.length
        ? ["[Unsupported Files]", ...summarizeUnsupported(skippedUnsupported), ""]
        : [];

      const unreadableSection = skippedUnreadableDicom.length
        ? [
            "[Skipped Non-DICOM / Unreadable Files]",
            ...skippedUnreadableDicom.slice(0, 100).map(
              (x) => `- ${x.name} — ${x.reason}`
            ),
            ...(skippedUnreadableDicom.length > 100
              ? [`- ... and ${skippedUnreadableDicom.length - 100} more`]
              : []),
            "",
          ]
        : [];

      const clinicalSection = window.__lastClinicalLog
        ? ["[Clinical Data]", ...window.__lastClinicalLog]
        : ["[Clinical Data]", "- No clinical XLSX found or processed.", ""];

      const successText = [
        "[Anonymization Summary]",
        `Profile: ${selectedProfile}`,
        `Input:  ${srcRoot}/`,
        `Output: ${destHandle.name}/${anonRoot.name}/`,
        `Started: ${startTime.toISOString().replace("T", " ").split(".")[0]}`,
        `Finished: ${finished.toISOString().replace("T", " ").split(".")[0]}`,
        `DICOM candidates checked: ${srcFiles.length}`,
        `Readable DICOM processed: ${dicomDone}`,
        `Skipped unreadable/non-DICOM candidates: ${skippedUnreadableDicom.length}`,
        `Unsupported files ignored: ${skippedUnsupported.length}`,
        `Approx bytes written: ${fmtBytes(bytesWritten)}`,
        `Duration: ${fmtDuration(finished.getTime() - startTime.getTime())}`,
        "",
        "[Output Structure]",
        "- Final folders are built from anonymized DICOM values only:",
        "- PAT_<anon_patient_id>/STU_<anon_study_id>/SER_<anon_series_uid>/",
        "",
        ...clinicalSection,
        ...unsupportedSection,
        ...unreadableSection,
      ].join("\n");

      setAnonStatus(successText, `${anonRoot.name}_anonymization_log.txt`);
    } catch (e) {
      console.error(e);
      setAnonStatus(
        "Anonymization failed. See console for details.",
        `${srcRoot || "anonymization"}_log.txt`,
      );
    }
  });

  // ==========================================================
  // Recursively read all files from directory handle
  // ==========================================================

  async function readAllFilesFromHandle(dirHandle, path = "") {
    const out = [];
    for await (const [name, entry] of dirHandle.entries()) {
      const relPath = path ? `${path}/${name}` : name;
      if (entry.kind === "file") {
        const file = await entry.getFile();
        out.push({ file, relPath });
      } else if (entry.kind === "directory") {
        out.push(...(await readAllFilesFromHandle(entry, relPath)));
      }
    }
    return out;
  }

  // ==========================================================
  // Scan Studies
  // ==========================================================

  els.btnScanStudies?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (els.uploadLog) els.uploadLog.textContent = "Scanning anonymized root…";

    try {
      /** @type {{file: File; relPath: string}[]} */
      let items = [];
      if (liveAnonHandle) {
        items = await readAllFilesFromHandle(liveAnonHandle);
      } else if (els.anonRootPicker?.files?.length) {
        const files = Array.from(els.anonRootPicker.files);
        items = files.map((f) => ({
          file: f,
          relPath: f.webkitRelativePath || f.name,
        }));
      } else {
        if (els.uploadLog) {
          els.uploadLog.textContent =
            "No anonymized root selected. Either run Step 1 or click 'Choose Folder'.";
        }
        if (els.btnUploadAll) els.btnUploadAll.disabled = true;
        return;
      }

      let clinicalFile = null;
      for (const { file } of items) {
        const name = file.name.toLowerCase();
        if (/\.(xlsx|xls|json)$/i.test(name)) {
          clinicalFile = file;
          break;
        }
      }

      items = items.filter(({ file }) => isPotentialDicomCandidate(file));
      if (!items.length) {
        if (els.uploadLog) {
          els.uploadLog.textContent =
            "0 studies detected (no DICOM candidates found).";
        }
        if (els.btnUploadAll) els.btnUploadAll.disabled = true;
        return;
      }

      seriesIndex = await buildSeriesIndex(items);
      window.__dicomSeriesIndex = seriesIndex;

      const anonFailures = [];
      let checkedSeries = 0;
      let yieldCounter = 0;
      const totalSeriesToCheck = Object.values(seriesIndex).reduce(
        (acc, sMap) => acc + Object.keys(sMap).length,
        0
      );

      for (const [studyKey, sMap] of Object.entries(seriesIndex)) {
        for (const [serName, info] of Object.entries(sMap)) {
          const firstFile = info?.files?.[0] || null;
          if (!firstFile) continue;

          checkedSeries++;
          if (els.uploadLog && checkedSeries % 10 === 1) {
            els.uploadLog.textContent =
              `Scanning anonymized root…\n[Anonymization Check] ${checkedSeries}/${totalSeriesToCheck} series checked…`;
          }

          const res = await verifyAnonymizedDicom(firstFile);
          if (!res.ok) {
            anonFailures.push({
              studyKey,
              serName,
              reason: res.reason || "Unknown reason",
              patientName: res.patientName || "",
              patientId: res.patientId || "",
              studyId: res.studyId || "",
            });
          }

          yieldCounter++;
          if (yieldCounter % 5 === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      if (anonFailures.length) {
        const lines = [];

        lines.push("❌ Upload blocked: non-anonymized DICOM data detected.");
        lines.push("");
        lines.push("All DICOM files must satisfy the anonymization requirements:");
        lines.push('  • PatientName (0010,0010) must be exactly "Anonymous"');
        lines.push("  • PatientID   (0010,0020) must be 1–6 characters long");
        lines.push("  • StudyID     (0020,0010) must be 1–8 characters long");
        lines.push("");
        lines.push(
          "Anonymization violations detected in the following series (first file of each series was checked):"
        );

        for (const f of anonFailures.slice(0, 50)) {
          lines.push(
            `- Study=${f.studyKey} | Series=${f.serName}\n` +
              `    Reason: ${f.reason}\n` +
              `    Found values: PatientName="${f.patientName}", PatientID="${f.patientId}", StudyID="${f.studyId}"`
          );
        }

        if (anonFailures.length > 50) {
          lines.push(`... and ${anonFailures.length - 50} more series`);
        }

        lines.push("");
        lines.push("Required action:");
        lines.push("  • Anonymize the DICOM files according to the rules above");
        lines.push("  • Ensure PatientName / PatientID / StudyID are compliant");
        lines.push("  • Run Scan again before uploading");

        if (els.uploadLog) els.uploadLog.textContent = lines.join("\n");
        if (els.btnUploadAll) els.btnUploadAll.disabled = true;

        window.__dicomAnonCheckFailed = true;
        window.__dicomAnonFailures = anonFailures;
        return;
      }

      window.__dicomAnonCheckFailed = false;
      window.__dicomAnonFailures = [];

      if (els.uploadLog) {
        els.uploadLog.textContent =
          "✓ Anonymization check passed. Building study summary…";
      }

      const archiveSlug =
        els.archiveSelect?.selectedOptions?.[0]?.dataset?.slug || "";
      const archiveId = els.archiveSelect?.value || "";
      const archiveRef = archiveSlug || archiveId;

      const seriesKeys = [];

      for (const [, sMap] of Object.entries(seriesIndex)) {
        for (const [, info] of Object.entries(sMap)) {
          const uidToken = safeToken(info?.seriesUid || "", "UNKNOWN_SER");
          seriesKeys.push(uidToken);
        }
      }

      const conflictSet = await serverPreflightSeries(archiveRef, seriesKeys);

      let clinicalSummary = "[Clinical Data]\n- No clinical metadata file found.\n";
      let hasValidClinicalFile = false;

      if (clinicalFile) {
        try {
          if (/\.(xlsx|xls)$/i.test(clinicalFile.name) && hasXlsxSupport()) {
            const jsonData = await readXlsxAsJson(clinicalFile);
            const rows = Array.isArray(jsonData) ? jsonData : [];
            const ids = new Set(rows.map((r) => r && r["Study_ID"]).filter(Boolean));

            if (rows.length > 0) {
              clinicalSummary =
                `[Clinical Data]\n` +
                `- Found ${clinicalFile.name}\n` +
                `- ${rows.length} row(s) detected\n` +
                `- ${ids.size} unique Study_ID entr${ids.size === 1 ? "y" : "ies"} detected.\n`;
              hasValidClinicalFile = true;
            } else {
              clinicalSummary =
                `[Clinical Data]\n` +
                `- Found ${clinicalFile.name}\n` +
                `- File is empty or contains no usable rows.\n`;
            }
          } else if (clinicalFile.name.toLowerCase().endsWith(".json")) {
            const data = JSON.parse(await clinicalFile.text());
            const rows = Array.isArray(data) ? data : [];
            const ids = new Set(rows.map((r) => r && r["Study_ID"]).filter(Boolean));

            if (rows.length > 0) {
              clinicalSummary =
                `[Clinical Data]\n` +
                `- Found ${clinicalFile.name}\n` +
                `- ${rows.length} row(s) detected\n` +
                `- ${ids.size} unique Study_ID entr${ids.size === 1 ? "y" : "ies"} detected.\n`;
              hasValidClinicalFile = true;
            } else {
              clinicalSummary =
                `[Clinical Data]\n` +
                `- Found ${clinicalFile.name}\n` +
                `- File is empty or contains no usable rows.\n`;
            }
          } else {
            clinicalSummary =
              `[Clinical Data]\n` +
              `- Unsupported file type: ${clinicalFile.name}\n` +
              `- Supported formats: .xlsx, .xls, .json\n`;
          }
        } catch (err) {
          clinicalSummary =
            `[Clinical Data]\n` +
            `- Error parsing ${clinicalFile.name}: ${err && err.message ? err.message : String(err)}\n`;
        }
      }

      const tbody = $("studyRows");
      if (tbody) tbody.innerHTML = "";

      let totalSeries = 0;
      let conflictCount = 0;

      for (const [studyKey, sMap] of Object.entries(seriesIndex)) {
        for (const [seriesName, info] of Object.entries(sMap)) {
          totalSeries++;

          const uidToken = safeToken(info?.seriesUid || "", "UNKNOWN_SER");
          const key = uidToken;
          const isConflict = conflictSet.has(key);
          if (isConflict) conflictCount++;

          const tr = document.createElement("tr");
          tr.dataset.key = key;
          tr.dataset.study = studyKey;
          tr.dataset.series = seriesName;
          tr.dataset.seriesuid = uidToken;
          tr.dataset.conflict = isConflict ? "1" : "0";
          tr.dataset.status = isConflict ? "CONFLICT" : "NEW";

          tr.innerHTML = `
            <td class="text-center">
              <input type="checkbox" class="form-check-input series-check" ${isConflict ? "" : "checked"}>
            </td>
            <td class="p-2">${studyKey}</td>
            <td class="p-2">${seriesName}</td>
            <td class="p-2 text-center">${info.files.length}</td>
            <td class="p-2 text-end">${fmtBytes(info.bytes)}</td>
            <td class="p-2 text-center">
              ${
                isConflict
                  ? '<span class="badge text-bg-warning">CONFLICT</span>'
                  : '<span class="badge text-bg-success">NEW</span>'
              }
            </td>
            <td class="p-2 text-center">
              <select class="form-select form-select-sm policy-select" style="width:auto;" ${isConflict ? "" : "disabled"}>
                <option value="append" selected>Append</option>
                <option value="overwrite">Overwrite</option>
                <option value="skip">Skip</option>
              </select>
            </td>
          `;
          tbody?.appendChild(tr);
        }
      }

      if (hasValidClinicalFile && clinicalFile) {
        const tr = document.createElement("tr");
        tr.dataset.key = "CLINICAL_DATA";
        tr.dataset.study = "CLINICAL";
        tr.dataset.series = "CLINICAL_DATA";
        tr.dataset.conflict = "0";
        tr.dataset.status = "CLINICAL";

        tr.innerHTML = `
          <td class="text-center">
            <input type="checkbox" class="form-check-input series-check" checked>
          </td>
          <td class="p-2" colspan="2"><strong>${clinicalFile.name}</strong></td>
          <td class="p-2 text-center">1</td>
          <td class="p-2 text-end">${fmtBytes(clinicalFile.size)}</td>
          <td class="p-2 text-center"><span class="badge text-bg-info">CLINICAL</span></td>
          <td class="p-2 text-center text-muted">—</td>
        `;
        tbody?.appendChild(tr);
      }

      const uploadBlockedByClinical = totalSeries > 0 && !hasValidClinicalFile;
      window.__dicomClinicalReady = hasValidClinicalFile;
      window.__clinicalFileFromScan = hasValidClinicalFile ? clinicalFile : null;

      const summaryLines = [
        "[Scan Summary]",
        `- ${Object.keys(seriesIndex).length} study/studies, ${totalSeries} series total`,
        `- ${totalSeries - conflictCount} new, ${conflictCount} conflicting`,
        "",
        clinicalSummary,
        "[Preflight]",
        `- Conflicts checked against archive: ${archiveRef}`,
        "",
      ];

      if (uploadBlockedByClinical) {
        summaryLines.push("[Upload Validation]");
        summaryLines.push("- Upload blocked: clinical data file is missing or invalid.");
        summaryLines.push("- Please add a clinical .xlsx/.xls/.json file and run Scan again.");
        summaryLines.push("");
      }

      if (els.uploadLog) els.uploadLog.textContent = summaryLines.join("\n");
      if (els.btnUploadAll) {
        els.btnUploadAll.disabled = totalSeries === 0 || uploadBlockedByClinical;
      }

      const btnSelectNew = $("btnSelectNew");
      if (btnSelectNew) {
        btnSelectNew.onclick = () => {
          document
            .querySelectorAll('#studyRows tr[data-conflict="0"] .series-check')
            .forEach((cb) => {
              /** @type {HTMLInputElement} */ (cb).checked = true;
            });
          updateCounters();
          setHeaderCheckboxState();
        };
      }

      const btnSelectConflicts = $("btnSelectConflicts");
      if (btnSelectConflicts) {
        btnSelectConflicts.onclick = () => {
          document
            .querySelectorAll('#studyRows tr[data-conflict="1"] .series-check')
            .forEach((cb) => {
              /** @type {HTMLInputElement} */ (cb).checked = true;
            });
          updateCounters();
          setHeaderCheckboxState();
        };
      }

      const btnApplyPolicy = $("btnApplyPolicy");
      if (btnApplyPolicy) {
        btnApplyPolicy.onclick = () => {
          const pol =
            /** @type {HTMLSelectElement | null} */ (document.getElementById("conflictBulkPolicy"))?.value ||
            "append";

          document
            .querySelectorAll('#studyRows tr[data-conflict="1"] .policy-select')
            .forEach((sel) => {
              /** @type {HTMLSelectElement} */ (sel).value = pol;
              const row = sel.closest("tr");
              /** @type {HTMLInputElement | null} */
              const cb = /** @type any */ (row?.querySelector(".series-check"));
              if (cb) cb.checked = pol !== "skip";
            });

          updateCounters();
          setHeaderCheckboxState();
        };
      }

      wireSelectionControls();
    } catch (e) {
      console.error("Scan failed:", e);
      alert("Scan failed: " + (e && e.message ? e.message : String(e)));
    }
  });

})();
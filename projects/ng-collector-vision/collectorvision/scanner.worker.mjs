// scanner.worker.mjs
// Runs the full detect → dewarp → embed → search pipeline on a background
// thread so the camera preview's requestAnimationFrame loop is never blocked.
//
// Message protocol
// ----------------
// main → worker:
//   { type: 'init',   manifest }
//   { type: 'frame',  bitmap: ImageBitmap }   (transferred, zero-copy)
//
// worker → main:
//   { type: 'progress', stage, ratio, loaded?, total?, cached?, inferenceMode? }
//   { type: 'ready',    inferenceMode }
//   { type: 'result',   cardPresent, cornersValid, corners, sharpness,
//                       confidence, cardId, secondaryId, score,
//                       rawCorners, detectorInput,
//                       detectorBitmap?, cropBitmap? }
//   { type: 'error',    message }

import * as ort from "https://vision.hippolink.app/vendor/onnxruntime-web/ort.webgpu.min.mjs";

// ---------------------------------------------------------------------------
// HippoLink patch: all CollectorVision assets (models, catalogs, vendor files)
// are served from vision.hippolink.app. The worker is served locally so that
// it can be bundled with the Angular app, but every fetch it makes points to
// the remote host. Absolute https:// paths are passed through unchanged.
// ---------------------------------------------------------------------------
const CV_BASE = "https://vision.hippolink.app";

function assetUrl(path) {
  if (!path) return path;
  return /^https?:\/\//.test(path) ? path : `${CV_BASE}/assets/${path}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DETECTOR_SIZE = 384;
const EMBEDDER_SIZE = 448;
const DEWARP_W = EMBEDDER_SIZE;
const DEWARP_H = EMBEDDER_SIZE;
const DEFAULT_MIN_CORNER_CONFIDENCE = 0.02;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

const ASSET_DB_NAME = "collectorvision-web-scanner";
const ASSET_STORE_NAME = "assets";

// ---------------------------------------------------------------------------
// Math helpers (identical to the originals in app.js)
// ---------------------------------------------------------------------------

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function orientShortestEdgeTop(corners, width, height) {
  const edgeLengths = corners.map(([x1, y1], index) => {
    const [x2, y2] = corners[(index + 1) % corners.length];
    const dx = (x1 - x2) * width;
    const dy = (y1 - y2) * height;
    return Math.hypot(dx, dy);
  });
  let shortestEdge = 0;
  for (let i = 1; i < edgeLengths.length; i += 1) {
    if (edgeLengths[i] < edgeLengths[shortestEdge]) {
      shortestEdge = i;
    }
  }
  return corners.map((_, index) => corners[(index + shortestEdge) % corners.length]);
}

function orderCorners(points, width = null, height = null) {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sorted = [...points].sort(
    ([ax, ay], [bx, by]) => Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx),
  );
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    const score = sorted[i][0] + sorted[i][1];
    if (score < best) {
      best = score;
      start = i;
    }
  }
  const ordered = [
    sorted[start],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ];
  const signedArea = ordered.reduce((sum, [x1, y1], i) => {
    const [x2, y2] = ordered[(i + 1) % ordered.length];
    return sum + (x1 * y2 - x2 * y1);
  }, 0);
  const canonical = signedArea < 0
    ? [ordered[0], ordered[3], ordered[2], ordered[1]]
    : ordered;
  return width && height ? orientShortestEdgeTop(canonical, width, height) : canonical;
}

function quadArea(corners) {
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) * 0.5;
}

function isUsableQuad(corners) {
  if (!corners || corners.length !== 4) {
    return false;
  }
  const area = quadArea(corners);
  if (!Number.isFinite(area) || area < 0.01) {
    return false;
  }
  for (let i = 0; i < corners.length; i += 1) {
    for (let j = i + 1; j < corners.length; j += 1) {
      const dx = corners[i][0] - corners[j][0];
      const dy = corners[i][1] - corners[j][1];
      if ((dx * dx + dy * dy) < 0.0004) {
        return false;
      }
    }
  }
  // Reject non-convex quads.  When the model misses a corner (e.g. on a
  // portrait camera where one corner is out of frame), it often returns 3
  // nearly-collinear points on one edge and one outlier.  That produces a
  // concave quad where one interior angle is reflex — the cross product at
  // that vertex has the opposite sign to the other three.
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i += 1) {
    const prev = corners[(i + 3) % 4];
    const curr = corners[i];
    const next = corners[(i + 1) % 4];
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1])
                - (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross > 0) pos += 1;
    if (cross < 0) neg += 1;
  }
  if (pos > 0 && neg > 0) {
    return false;
  }
  return true;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);

  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-10) {
      throw new Error("Could not solve dewarp transform.");
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
    }
    const scale = a[col][col];
    for (let k = col; k <= size; k += 1) {
      a[col][k] /= scale;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col];
      for (let k = col; k <= size; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }

  return a.map((row) => row[size]);
}

function computeHomography(srcPoints, dstPoints) {
  const matrix = [];
  const vector = [];

  for (let i = 0; i < 4; i += 1) {
    const [x, y] = srcPoints[i];
    const [u, v] = dstPoints[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }

  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(matrix, vector);
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function applyHomography(matrix, x, y) {
  const denom = matrix[6] * x + matrix[7] * y + matrix[8];
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / denom,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denom,
  ];
}

function sampleBilinear(data, width, height, x, y, channel) {
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const i00 = (y0 * width + x0) * 4 + channel;
  const i10 = (y0 * width + x1) * 4 + channel;
  const i01 = (y1 * width + x0) * 4 + channel;
  const i11 = (y1 * width + x1) * 4 + channel;

  const top = data[i00] * (1 - tx) + data[i10] * tx;
  const bottom = data[i01] * (1 - tx) + data[i11] * tx;
  return top * (1 - ty) + bottom * ty;
}

function normalizeEmbedding(embedding) {
  let norm = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-8) {
    for (let i = 0; i < embedding.length; i += 1) {
      embedding[i] /= norm;
    }
  }
  return embedding;
}

function chooseBetterMatch(current, candidate) {
  return candidate.score > current.score ? candidate : current;
}

function snakeToCamel(value) {
  return String(value).replace(/_([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
}

function secondaryCatalogKeyToFieldName(catalogKey) {
  const key = String(catalogKey ?? "").trim();
  if (!key) {
    return null;
  }
  const base = key.replace(/_ids$/i, "_id");
  const fieldName = snakeToCamel(base);
  return fieldName || null;
}

function resolveSecondaryIdSource(catalog = {}) {
  const explicitPath = typeof catalog.secondary_ids === "string"
    ? catalog.secondary_ids
    : null;
  const explicitField = typeof catalog.secondary_id_field === "string"
    ? catalog.secondary_id_field
    : null;

  if (explicitPath) {
    return {
      assetPath: explicitPath,
      fieldName: explicitField || "secondaryId",
    };
  }

  const candidates = Object.entries(catalog)
    .filter(([key, value]) => key !== "card_ids" && /_ids$/i.test(key) && typeof value === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  if (candidates.length === 0) {
    return null;
  }

  const [catalogKey, assetPath] = candidates[0];
  return {
    assetPath,
    fieldName: explicitField || secondaryCatalogKeyToFieldName(catalogKey) || "secondaryId",
  };
}

// ---------------------------------------------------------------------------
// Float16 / catalog decode
// ---------------------------------------------------------------------------

function float16ToFloat32(value) {
  const sign = (value & 0x8000) >> 15;
  const exponent = (value & 0x7c00) >> 10;
  const fraction = value & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign ? -0 : 0;
    }
    return (sign ? -1 : 1) * 2 ** (-14) * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    return fraction ? Number.NaN : (sign ? -Infinity : Infinity);
  }

  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function createFloat16LookupTable() {
  const table = new Float32Array(65536);
  for (let value = 0; value < table.length; value += 1) {
    table[value] = float16ToFloat32(value);
  }
  return table;
}

const FLOAT16_LOOKUP = createFloat16LookupTable();

function wrapFloat16Buffer(buffer) {
  return new Uint16Array(buffer);
}

// ---------------------------------------------------------------------------
// IndexedDB asset cache (same DB as the main thread — shared origin storage)
// ---------------------------------------------------------------------------

function openAssetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
        db.createObjectStore(ASSET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedAsset(key) {
  const db = await openAssetDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, "readonly");
    const store = tx.objectStore(ASSET_STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function writeCachedAsset(key, value) {
  const db = await openAssetDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, "readwrite");
    const store = tx.objectStore(ASSET_STORE_NAME);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// HippoLink patch: HuggingFace .npz catalog support
//
// The CollectorVision Python library publishes catalogs to HuggingFace as
// NumPy archives (.npz).  The browser scanner originally expected pre-converted
// .f32 + .json files, but those are only generated by the Python export script.
// The functions below let us fetch .npz files from HuggingFace directly,
// decompress and parse them in the worker, then cache the parsed result in
// IndexedDB so subsequent sessions never re-download.
//
// .npz is just a ZIP file; each entry is a .npy file (NumPy array).
// We only need two entries: embeddings.npy (float16 matrix) and card_ids.npy
// (fixed-length string array).  No third-party libraries required — ZIP
// decompression uses the browser's built-in DecompressionStream API.
// ---------------------------------------------------------------------------

async function decompressDeflateRaw(buffer) {
  const chunks = [];
  const sink = new WritableStream({ write(chunk) { chunks.push(chunk); } });
  const source = new ReadableStream({
    start(ctrl) { ctrl.enqueue(new Uint8Array(buffer)); ctrl.close(); },
  });
  try {
    await source.pipeThrough(new DecompressionStream("deflate-raw")).pipeTo(sink);
  } catch (err) {
    // "Junk found after end of compressed data" (Chrome/Safari) or similar:
    // The ZIP local-file-header's compressedSz can include trailing bytes such
    // as a data descriptor (CRC + sizes) written after the DEFLATE end-of-stream
    // marker.  By the time DecompressionStream reports the error, every valid
    // decompressed byte is already in `chunks`.  Re-use those bytes instead of
    // failing.  Only re-throw if nothing at all was produced (genuine error).
    if (chunks.length === 0) throw err;
  }
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

async function extractFromNpz(npzBuffer, entryName) {
  // Always read sizes from the Central Directory, not local file headers.
  // Local headers can have compressedSz=0 or a wrong chunk-size value when the
  // file was written with streaming (bit 3 of general purpose flag set) and the
  // actual sizes were written in a data descriptor afterwards.
  // The Central Directory, at the end of the archive, always has correct values.
  const view  = new DataView(npzBuffer);
  const bytes = new Uint8Array(npzBuffer);

  // Locate End-of-Central-Directory record (PK\x05\x06 = 0x06054b50).
  let eocdOffset = -1;
  for (let i = npzBuffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("NPZ: End of Central Directory not found");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset   = view.getUint32(eocdOffset + 16, true);

  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > npzBuffer.byteLength) break;
    if (view.getUint32(pos, true) !== 0x02014b50) break; // Central Directory sig

    const comprMethod  = view.getUint16(pos + 10, true);
    const compressedSz = view.getUint32(pos + 20, true);
    const nameLen      = view.getUint16(pos + 28, true);
    const extraLen     = view.getUint16(pos + 30, true);
    const commentLen   = view.getUint16(pos + 32, true);
    const localOffset  = view.getUint32(pos + 42, true);
    const name         = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));

    if (name === entryName) {
      // Compute data start from the local file header (sizes come from the CD).
      const lhNameLen  = view.getUint16(localOffset + 26, true);
      const lhExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart  = localOffset + 30 + lhNameLen + lhExtraLen;

      console.log(`[CV] ZIP entry "${name}": method=${comprMethod} compressedSz=${compressedSz} dataStart=${dataStart}`);
      const raw = npzBuffer.slice(dataStart, dataStart + compressedSz);
      if (comprMethod === 0) return raw;
      if (comprMethod === 8) return decompressDeflateRaw(raw);
      throw new Error(`Unsupported ZIP compression method: ${comprMethod}`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`"${entryName}" not found in NPZ`);
}

function parseNpyHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.slice(1, 6)) !== "NUMPY") {
    throw new Error("Not a valid .npy file");
  }
  const major      = bytes[6];
  const hdrLen     = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const hdrStart   = major === 1 ? 10 : 12;
  const header     = new TextDecoder().decode(bytes.slice(hdrStart, hdrStart + hdrLen));
  const dataStart  = hdrStart + hdrLen;
  const dtype      = (header.match(/'descr':\s*'([^']+)'/) ?? [])[1] ?? "";
  const shapeRaw   = (header.match(/'shape':\s*\(([^)]*)\)/) ?? [])[1] ?? "";
  const shape      = shapeRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return { dtype, shape, dataStart, buffer };
}

function npyToEmbeddings({ dtype, shape, dataStart, buffer }) {
  const [rows, dims] = shape;

  if (dtype === "<f2" || dtype === "|f2") {
    // Already float16 — slice and return as-is.
    return buffer.slice(dataStart, dataStart + rows * dims * 2);
  }

  if (dtype === "<f4") {
    // HuggingFace catalogs store embeddings as float32.  Convert to float16 so
    // the downstream cosine-search routine (which assumes 2 bytes/element) works
    // without modification.
    console.log(`[CV] Converting ${rows * dims} float32 values to float16…`);
    const src = new Float32Array(buffer, dataStart, rows * dims);
    const dst = new Uint16Array(rows * dims);
    // Bit-level float32→float16 conversion (IEEE 754).
    // Re-uses a single 4-byte scratch buffer to avoid per-element allocation.
    const scratch = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < src.length; i++) {
      scratch.setFloat32(0, src[i], true);
      const b  = scratch.getUint32(0, true);
      const s  = b >>> 31;
      const e  = (b >>> 23) & 0xFF;
      const m  = b & 0x7FFFFF;
      if (e === 0xFF) {
        dst[i] = (s << 15) | 0x7C00 | (m ? 0x0200 : 0); // NaN/Inf
      } else if (e === 0) {
        dst[i] = s << 15;                                  // zero/denormal
      } else {
        const ne = e - 127 + 15;
        dst[i] = ne >= 31 ? (s << 15) | 0x7C00            // overflow → ±Inf
               : ne <= 0  ? s << 15                        // underflow → ±0
               : (s << 15) | (ne << 10) | (m >>> 13);      // normal
      }
    }
    console.log(`[CV] float32→float16 conversion done`);
    return dst.buffer;
  }

  throw new Error(`Unsupported embeddings dtype: ${dtype}`);
}

function npyToCardIds({ dtype, shape, dataStart, buffer }) {
  const count = shape[0];
  const ids   = [];
  const bytes = new Uint8Array(buffer);

  if (dtype.startsWith("|S")) {
    // Fixed-length byte strings, null-padded — typical for ASCII IDs.
    const stride = parseInt(dtype.slice(2), 10);
    for (let i = 0; i < count; i++) {
      const base = dataStart + i * stride;
      let end = base;
      while (end < base + stride && bytes[end] !== 0) end++;
      ids.push(String.fromCharCode(...bytes.subarray(base, end)));
    }

  } else if (dtype.startsWith("<U")) {
    // UTF-32 LE strings — each char is 4 bytes.
    // Fast path: card IDs (TCGplayer integers, Scryfall UUIDs) are pure ASCII.
    // In UTF-32 LE, ASCII char 'X' is stored as [X, 0, 0, 0].  Reading only
    // the first byte of each 4-byte unit avoids DataView.getUint32 overhead
    // and allows a single String.fromCharCode(...) call per card.
    const chars  = parseInt(dtype.slice(2), 10);
    const stride = chars * 4;
    const buf    = new Uint8Array(chars);
    for (let i = 0; i < count; i++) {
      const base = dataStart + i * stride;
      let len = 0;
      for (let j = 0; j < chars; j++) {
        const b = bytes[base + j * 4];
        if (b === 0) break;
        buf[len++] = b;
      }
      ids.push(String.fromCharCode(...buf.subarray(0, len)));
    }

  } else if (dtype === "<i4" || dtype === ">i4") {
    // 32-bit integer IDs (some TCGplayer catalogs store product IDs as int32).
    const le   = dtype === "<i4";
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      ids.push(String(view.getInt32(dataStart + i * 4, le)));
    }

  } else if (dtype === "<i8" || dtype === ">i8") {
    // 64-bit integer IDs.
    const le   = dtype === "<i8";
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      ids.push(String(view.getBigInt64(dataStart + i * 8, le)));
    }

  } else {
    throw new Error(`Unsupported card_ids dtype: ${dtype}`);
  }
  return ids;
}

async function resolveHuggingFaceUrl(catalogKey) {
  // List files in the catalogs/ directory of the HuggingFace repo and pick the
  // latest dated snapshot for the requested catalog key.
  // Filenames: milo1-{catalog_key}-{YYYY-MM-DD}.npz  (lexicographic = chronological)
  const resp = await fetch(
    "https://huggingface.co/api/models/HanClinto/milo/tree/main/catalogs",
  );
  if (!resp.ok) throw new Error(`HuggingFace API error: ${resp.status}`);
  const files   = await resp.json();
  const prefix  = `catalogs/milo1-${catalogKey}-`;
  const matches = files
    .filter(f => f.path?.startsWith(prefix) && f.path?.endsWith(".npz"))
    .sort((a, b) => b.path.localeCompare(a.path)); // newest first (YYYY-MM-DD is lexicographic)
  if (!matches.length) throw new Error(`No HuggingFace snapshot for: ${catalogKey}`);
  return `https://huggingface.co/HanClinto/milo/resolve/main/${matches[0].path}`;
}

async function fetchHuggingFaceCatalog(catalogKey, onStage) {
  try {
    console.log(`[CV] Resolving HuggingFace URL for: ${catalogKey}`);
    const npzUrl     = await resolveHuggingFaceUrl(catalogKey);
    const snapshotId = npzUrl.split("/").pop().replace(".npz", "");
    console.log(`[CV] Resolved to snapshot: ${snapshotId}`);

    const embedKey = `hf:${snapshotId}:embed`;
    const idsKey   = `hf:${snapshotId}:ids`;

    const cachedEmbed = await readCachedAsset(embedKey);
    const cachedIds   = await readCachedAsset(idsKey);
    if (cachedEmbed && cachedIds) {
      console.log(`[CV] Serving ${catalogKey} from IndexedDB cache`);
      onStage?.("catalog", 1, 1, 1, true);
      return { embeddingBuffer: cachedEmbed, ids: cachedIds };
    }

    console.log(`[CV] Downloading ${npzUrl}`);
    const npzBuffer = await fetchWithProgress(npzUrl, "buffer", (ratio, loaded, total) => {
      onStage?.("catalog", ratio * 0.85, loaded, total, false);
    });
    console.log(`[CV] NPZ downloaded: ${npzBuffer.byteLength} bytes`);
    onStage?.("catalog", 0.85);

    console.log("[CV] Extracting embeddings.npy from NPZ…");
    const embedNpyBuf = await extractFromNpz(npzBuffer, "embeddings.npy");
    console.log(`[CV] embeddings.npy extracted: ${embedNpyBuf.byteLength} bytes`);
    onStage?.("catalog", 0.88);

    const embedNpy        = parseNpyHeader(embedNpyBuf);
    console.log(`[CV] embeddings dtype=${embedNpy.dtype} shape=${embedNpy.shape}`);
    const embeddingBuffer = npyToEmbeddings(embedNpy);
    console.log(`[CV] Embedding buffer ready: ${embeddingBuffer.byteLength} bytes`);
    onStage?.("catalog", 0.91);

    console.log("[CV] Extracting card_ids.npy from NPZ…");
    const idsNpyBuf = await extractFromNpz(npzBuffer, "card_ids.npy");
    console.log(`[CV] card_ids.npy extracted: ${idsNpyBuf.byteLength} bytes`);
    onStage?.("catalog", 0.93);

    const idsNpy = parseNpyHeader(idsNpyBuf);
    console.log(`[CV] card_ids dtype=${idsNpy.dtype} shape=${idsNpy.shape}`);
    const ids    = npyToCardIds(idsNpy);
    console.log(`[CV] Decoded ${ids.length} card IDs. First: ${ids[0]}`);
    onStage?.("catalog", 0.96);

    console.log("[CV] Writing embeddings to IndexedDB…");
    await writeCachedAsset(embedKey, embeddingBuffer);
    onStage?.("catalog", 0.98);

    console.log("[CV] Writing card IDs to IndexedDB…");
    await writeCachedAsset(idsKey, ids);
    console.log("[CV] Catalog ready.");
    onStage?.("catalog", 1);

    return { embeddingBuffer, ids };
  } catch (err) {
    console.error(`[CV] fetchHuggingFaceCatalog failed for "${catalogKey}":`, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers with progress reporting + IndexedDB caching
// ---------------------------------------------------------------------------

async function fetchWithProgress(url, responseType, onProgress) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const total = Number.parseInt(response.headers.get("content-length") ?? "0", 10) || 0;
  if (!response.body || total === 0) {
    const payload = responseType === "json" ? await response.json() : await response.arrayBuffer();
    onProgress?.(1, total || 1, total || 1);
    return payload;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded / total, loaded, total);
  }

  const blob = new Blob(chunks);
  if (responseType === "json") {
    return JSON.parse(await blob.text());
  }
  return await blob.arrayBuffer();
}

async function fetchJsonCached(url, version, onProgress) {
  const key = `${version}:${url}:json`;
  const cached = await readCachedAsset(key);
  if (cached) {
    onProgress?.(1, 1, 1, true);
    return cached;
  }
  const json = await fetchWithProgress(url, "json", (ratio, loaded, total) => {
    onProgress?.(ratio, loaded, total, false);
  });
  await writeCachedAsset(key, json);
  return json;
}

async function fetchBufferCached(url, version, onProgress) {
  const key = `${version}:${url}:buffer`;
  const cached = await readCachedAsset(key);
  if (cached) {
    onProgress?.(1, cached.byteLength ?? 1, cached.byteLength ?? 1, true);
    return cached;
  }
  const buffer = await fetchWithProgress(url, "buffer", (ratio, loaded, total) => {
    onProgress?.(ratio, loaded, total, false);
  });
  await writeCachedAsset(key, buffer);
  return buffer;
}

// ---------------------------------------------------------------------------
// WebGPU configuration
// ---------------------------------------------------------------------------

/**
 * Attempts to configure the WebGPU adapter for ort-web.
 * Returns true if WebGPU was configured, false if unavailable.
 * Never throws — a false return means ort-web will fall back to WASM.
 */
async function configureWebGpu() {
  if (!("gpu" in navigator)) {
    return false;
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    return false;
  }

  const requestedStorageBuffers = Math.min(
    10,
    adapter.limits.maxStorageBuffersPerShaderStage ?? 8,
  );
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  Object.defineProperty(adapter, "requestDevice", {
    configurable: true,
    value: async (descriptor = {}) => originalRequestDevice({
      ...descriptor,
      requiredLimits: {
        ...(descriptor.requiredLimits ?? {}),
        maxStorageBuffersPerShaderStage: requestedStorageBuffers,
      },
    }),
  });

  ort.env.webgpu.adapter = adapter;
  // ort.webgpu.min.mjs (new WebGPU EP) — the legacy ort.all.min.mjs JSEP backend
  // silently returned all-zeros for Conv ops on Android (ort-web 1.20–1.24.3).
  // The new EP fixes that, but cornelius.onnx still produces numerically wrong
  // (coherent but incorrect) corner outputs on Android ARM GPUs even with the new EP.
  // See ARCHITECTURE.md “Lessons Learned” for the full history.
  ort.env.webgpu.forceFp16 = false;

  return true;
}

// ---------------------------------------------------------------------------
// Tensor preparation (uses OffscreenCanvas instead of HTMLCanvasElement)
// ---------------------------------------------------------------------------

function fillInputTensorFromContext(ctx, size, tensor) {
  const { data } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;

  for (let i = 0; i < size * size; i += 1) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    tensor[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    tensor[plane * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  return tensor;
}

function createInputTensor(size) {
  return new Float32Array(1 * 3 * size * size);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// ---------------------------------------------------------------------------
// WorkerRuntime — BrowserRuntime ported to run inside a web worker.
// All canvas operations use OffscreenCanvas.
// ---------------------------------------------------------------------------

class WorkerRuntime {
  constructor(
    manifest,
    useWebGpu = false,
    catalogLimit = null,
    rotationInvariant = true,
    minCornerConfidence = DEFAULT_MIN_CORNER_CONFIDENCE,
  ) {
    this.manifest = manifest;
    this.useWebGpu = useWebGpu;
    this.rotationInvariant = rotationInvariant;
    this.minCornerConfidence = clamp01(minCornerConfidence);
    this.catalogLimit = Number.isFinite(catalogLimit) && catalogLimit > 0
      ? Math.floor(catalogLimit)
      : null;
    this.catalogRows = manifest.catalog?.rows ?? 0;
    this.catalogTotalRows = manifest.catalog?.rows ?? 0;
    this.detector = null;
    this.embedder = null;
    this.inputNames = {};
    this.embeddings = null;
    this.cardIds = null;
    this.secondaryIds = null;
    this.secondaryIdField = null;
    this.dewarpCanvas = new OffscreenCanvas(DEWARP_W, DEWARP_H);
    this.dewarpCtx = this.dewarpCanvas.getContext("2d", { willReadFrequently: true });
    this.dewarpImageData = this.dewarpCtx.createImageData(DEWARP_W, DEWARP_H);
    // Reusable 384×384 scratch canvas — what was fed to the detector.
    // Transferred to the main thread as a debug bitmap on each result.
    this.detectorScratchCanvas = new OffscreenCanvas(DETECTOR_SIZE, DETECTOR_SIZE);
    this.detectorScratchCtx = this.detectorScratchCanvas.getContext("2d", { willReadFrequently: true });
    this.detectorInputTensor = createInputTensor(DETECTOR_SIZE);
    this.embedderScratchCanvas = new OffscreenCanvas(EMBEDDER_SIZE, EMBEDDER_SIZE);
    this.embedderScratchCtx = this.embedderScratchCanvas.getContext("2d", { willReadFrequently: true });
    this.embedderInputTensor = createInputTensor(EMBEDDER_SIZE);
    this._lastRawCorners = null;
    this._lastDetectorInput = null;
  }

  updateConfig({ minCornerConfidence } = {}) {
    if (minCornerConfidence !== undefined) {
      this.minCornerConfidence = clamp01(minCornerConfidence);
    }
  }

  async load(onStage) {
    const version = this.manifest.version;
    // Use per-model content hashes as cache keys when available so that a new
    // model weight file (same filename, different content) always busts the
    // IndexedDB entry, even if the bundle version string hasn't changed.
    const hashes = this.manifest.model_hashes ?? {};
    const detectorVersion = hashes.cornelius ?? version;
    const embedderVersion = hashes.milo       ?? version;
    const detectorBuffer = await fetchBufferCached(
      assetUrl(this.manifest.models.cornelius),
      detectorVersion,
      (ratio, loaded, total, cached) => onStage?.("detector", ratio, loaded, total, cached),
    );
    const embedderBuffer = await fetchBufferCached(
      assetUrl(this.manifest.models.milo),
      embedderVersion,
      (ratio, loaded, total, cached) => onStage?.("embedder", ratio, loaded, total, cached),
    );

    // Use as many threads as the device has cores, capped at 4.
    // NOTE: multi-threaded WASM requires SharedArrayBuffer / COOP+COEP headers.
    // Without them ort-web silently falls back to 1 thread.  The COI service
    // worker (coi-serviceworker.js) injects these headers on GitHub Pages so
    // that crossOriginIsolated becomes true and all threads are available.
    // iOS WebKit is prone to killing memory-heavy WASM pages.  Keep the iOS
    // path single-threaded to avoid the extra worker/SAB overhead; other
    // platforms keep the capped multi-threaded fast path.
    const numThreads = isIOS() ? 1 : Math.min(navigator.hardwareConcurrency || 1, 4);
    ort.env.wasm.numThreads = numThreads;
    this.numThreads = numThreads;
    // EP selection: WASM is the safe default.
    // WebGPU is proven broken on Android ARM (issues #9 and #12) but may work
    // on iOS (Metal) and desktop.  The enableWebGpu flag in the init message
    // lets the user opt in from Settings — see ARCHITECTURE.md Lessons Learned.
    const ep = this.useWebGpu ? "webgpu" : "wasm";
    this.detector = await ort.InferenceSession.create(detectorBuffer, {
      executionProviders: [ep],
    });
    this.embedder = await ort.InferenceSession.create(embedderBuffer, {
      executionProviders: [ep],
    });

    this.inputNames.detector = this.detector.inputNames[0];
    this.inputNames.embedder = this.embedder.inputNames[0];

    // Catalog loading: HuggingFace .npz path (no self-hosting required) or the
    // standard pre-converted .f32 + .json path (for self-hosted / CDN assets).
    let embeddingBuffer, ids;
    if (this.manifest.catalog.huggingface_key) {
      const hf = await fetchHuggingFaceCatalog(
        this.manifest.catalog.huggingface_key,
        (stage, ratio, loaded, total, cached) => onStage?.(stage, ratio, loaded, total, cached),
      );
      embeddingBuffer = hf.embeddingBuffer;
      ids             = hf.ids;
    } else {
      embeddingBuffer = await fetchBufferCached(
        assetUrl(this.manifest.catalog.embeddings),
        version,
        (ratio, loaded, total, cached) => onStage?.("catalog", ratio * 0.92, loaded, total, cached),
      );
      ids = await fetchJsonCached(
        assetUrl(this.manifest.catalog.card_ids),
        version,
        (ratio, loaded, total, cached) => onStage?.("catalog", 0.92 + ratio * 0.08, loaded, total, cached),
      );
    }
    const secondarySource = resolveSecondaryIdSource(this.manifest.catalog);
    const secondaryIds = secondarySource
      ? await fetchJsonCached(assetUrl(secondarySource.assetPath), version)
      : null;
    // Keep the catalog in its packed float16 form.  Expanding the full MTG
    // matrix to Float32Array roughly doubles steady-state catalog memory and
    // can push iOS WebKit into tab reloads.  Search converts individual values
    // through a 256 KB lookup table instead.
    const dims = this.manifest.catalog.dims;
    // When using HuggingFace catalogs the manifest has rows: 0 (unknown at
    // authoring time); fall back to ids.length so requestedRows is correct.
    const declaredRows  = this.manifest.catalog.rows || ids.length;
    const requestedRows = this.catalogLimit
      ? Math.min(this.catalogLimit, declaredRows, ids.length)
      : Math.min(declaredRows, ids.length);
    const embeddingBytes = requestedRows * dims * 2;
    // Diagnostic-only catalog limiting still fetches the monolithic asset, so
    // it does not remove the transient load peak.  It does keep only the small
    // prefix after load, which is enough to test steady-state catalog pressure.
    const retainedEmbeddingBuffer = requestedRows < declaredRows
      ? embeddingBuffer.slice(0, embeddingBytes)
      : embeddingBuffer;
    this.embeddings = wrapFloat16Buffer(retainedEmbeddingBuffer);
    this.cardIds = requestedRows < ids.length ? ids.slice(0, requestedRows) : ids;
    this.secondaryIdField = secondarySource?.fieldName ?? null;
    this.secondaryIds = Array.isArray(secondaryIds)
      ? (requestedRows < secondaryIds.length ? secondaryIds.slice(0, requestedRows) : secondaryIds)
      : null;
    this.catalogRows = Math.min(
      requestedRows,
      this.cardIds.length,
      Math.floor(this.embeddings.length / dims),
    );
    this.catalogTotalRows = declaredRows;
  }

  async detect(frameCanvas) {
    const t0 = performance.now();
    const vw = frameCanvas.width;
    const vh = frameCanvas.height;

    // Save a copy of what we fed the model for the debug preview bitmap.
    this.detectorScratchCtx.drawImage(frameCanvas, 0, 0, DETECTOR_SIZE, DETECTOR_SIZE);
    this._lastDetectorInput = `${vw}×${vh} → squash ${DETECTOR_SIZE}×${DETECTOR_SIZE}`;
    const t1 = performance.now();

    const input = fillInputTensorFromContext(
      this.detectorScratchCtx,
      DETECTOR_SIZE,
      this.detectorInputTensor,
    );
    const t2 = performance.now();
    const outputs = await this.detector.run({
      [this.inputNames.detector]: new ort.Tensor("float32", input, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
    });
    const t3 = performance.now();
    const cornersRaw = Array.from(outputs[this.detector.outputNames[0]].data).slice(0, 8);
    const presenceLogit = outputs[this.detector.outputNames[1]].data[0];
    const sharpness = this.detector.outputNames[2]
      ? outputs[this.detector.outputNames[2]].data[0]
      : null;

    const points = [];
    for (let i = 0; i < 8; i += 2) {
      points.push([
        Math.min(Math.max(cornersRaw[i], 0), 1),
        Math.min(Math.max(cornersRaw[i + 1], 0), 1),
      ]);
    }

    this._lastRawCorners = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join("  ");
    const t4 = performance.now();

    const confidence = sharpness ?? sigmoid(presenceLogit);
    return {
      corners: orderCorners(points, vw, vh),
      sharpness,
      confidence,
      cardPresent: confidence >= this.minCornerConfidence,
      timing: {
        detectorDrawMs: t1 - t0,
        detectorInputMs: t2 - t1,
        detectorRunMs: t3 - t2,
        detectorPostMs: t4 - t3,
        detectMs: t4 - t0,
      },
    };
  }

  dewarp(frameCanvas, corners) {
    const t0 = performance.now();
    const width = frameCanvas.width;
    const height = frameCanvas.height;
    const srcPts = [
      corners[0][0] * width, corners[0][1] * height,
      corners[1][0] * width, corners[1][1] * height,
      corners[2][0] * width, corners[2][1] * height,
      corners[3][0] * width, corners[3][1] * height,
    ];
    const dstPts = [
      0, 0,
      DEWARP_W - 1, 0,
      DEWARP_W - 1, DEWARP_H - 1,
      0, DEWARP_H - 1,
    ];
    const sourcePoints = [
      [srcPts[0], srcPts[1]],
      [srcPts[2], srcPts[3]],
      [srcPts[4], srcPts[5]],
      [srcPts[6], srcPts[7]],
    ];
    const targetPoints = [
      [dstPts[0], dstPts[1]],
      [dstPts[2], dstPts[3]],
      [dstPts[4], dstPts[5]],
      [dstPts[6], dstPts[7]],
    ];
    const inverse = computeHomography(targetPoints, sourcePoints);
    const t1 = performance.now();
    const srcData = frameCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
    const dstData = this.dewarpImageData;
    const t2 = performance.now();

    for (let y = 0; y < DEWARP_H; y += 1) {
      for (let x = 0; x < DEWARP_W; x += 1) {
        const [sx, sy] = applyHomography(inverse, x, y);
        const offset = (y * DEWARP_W + x) * 4;
        dstData.data[offset] = sampleBilinear(srcData.data, width, height, sx, sy, 0);
        dstData.data[offset + 1] = sampleBilinear(srcData.data, width, height, sx, sy, 1);
        dstData.data[offset + 2] = sampleBilinear(srcData.data, width, height, sx, sy, 2);
        dstData.data[offset + 3] = 255;
      }
    }

    const t3 = performance.now();
    this.dewarpCtx.putImageData(dstData, 0, 0);
    const t4 = performance.now();
    this._lastDewarpTiming = {
      dewarpSetupMs: t1 - t0,
      dewarpReadMs: t2 - t1,
      dewarpWarpMs: t3 - t2,
      dewarpWriteMs: t4 - t3,
      dewarpMs: t4 - t0,
    };
    return this.dewarpCanvas;
  }

  async embed(cropCanvas, rotate180 = false) {
    const t0 = performance.now();
    this.embedderScratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.embedderScratchCtx.clearRect(0, 0, EMBEDDER_SIZE, EMBEDDER_SIZE);
    if (rotate180) {
      this.embedderScratchCtx.translate(EMBEDDER_SIZE, EMBEDDER_SIZE);
      this.embedderScratchCtx.rotate(Math.PI);
    }
    this.embedderScratchCtx.drawImage(cropCanvas, 0, 0, EMBEDDER_SIZE, EMBEDDER_SIZE);
    this.embedderScratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    const t1 = performance.now();
    const input = fillInputTensorFromContext(
      this.embedderScratchCtx,
      EMBEDDER_SIZE,
      this.embedderInputTensor,
    );
    const t2 = performance.now();
    const outputs = await this.embedder.run({
      [this.inputNames.embedder]: new ort.Tensor("float32", input, [1, 3, EMBEDDER_SIZE, EMBEDDER_SIZE]),
    });
    const t3 = performance.now();
    const embedding = normalizeEmbedding(Float32Array.from(outputs[this.embedder.outputNames[0]].data));
    const t4 = performance.now();
    return {
      embedding,
      timing: {
        embedDrawMs: t1 - t0,
        embedInputMs: t2 - t1,
        embedRunMs: t3 - t2,
        embedPostMs: t4 - t3,
        embedMs: t4 - t0,
      },
    };
  }

  async identify(cropCanvas) {
    const upright = await this.embed(cropCanvas);
    const tSearchStart = performance.now();
    let best = { ...this.search(upright.embedding), orientation: "upright" };
    let searchMs = performance.now() - tSearchStart;
    let timing = upright.timing;

    if (this.rotationInvariant) {
      const rotated = await this.embed(cropCanvas, true);
      const tRotatedSearchStart = performance.now();
      const rotatedBest = { ...this.search(rotated.embedding), orientation: "rotated_180" };
      searchMs += performance.now() - tRotatedSearchStart;
      timing = sumTiming(timing, rotated.timing);
      best = chooseBetterMatch(best, rotatedBest);
    }

    return { best, timing, searchMs };
  }

  search(query) {
    const dims = this.manifest.catalog.dims;
    const rows = this.catalogRows ?? this.manifest.catalog.rows;
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let row = 0; row < rows; row += 1) {
      const offset = row * dims;
      let score = 0;
      for (let col = 0; col < dims; col += 1) {
        score += FLOAT16_LOOKUP[this.embeddings[offset + col]] * query[col];
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = row;
      }
    }

    const secondaryId = this.secondaryIds?.[bestIndex] ?? null;
    const best = {
      score: bestScore,
      cardId: this.cardIds[bestIndex],
      secondaryId,
      secondaryIdField: this.secondaryIdField,
    };
    if (this.secondaryIdField && secondaryId !== null && secondaryId !== undefined) {
      best[this.secondaryIdField] = secondaryId;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Frame pipeline
// ---------------------------------------------------------------------------

let runtime = null;
// Reusable OffscreenCanvas sized to the incoming frame — resized as needed.
let frameCanvas = null;
let frameCtx = null;

async function processFrame(bitmap, captureRequested = false, includeDebugBitmaps = false) {
  const tFrameStart = performance.now();
  if (!frameCanvas || frameCanvas.width !== bitmap.width || frameCanvas.height !== bitmap.height) {
    frameCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
  }
  frameCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const tFrameReady = performance.now();

  // Snapshot the frame for the capture bundle (zero-copy, worker → main).
  let captureFrameBitmap = null;
  if (captureRequested) {
    const snap = new OffscreenCanvas(frameCanvas.width, frameCanvas.height);
    snap.getContext("2d").drawImage(frameCanvas, 0, 0);
    captureFrameBitmap = snap.transferToImageBitmap();
  }
  const tCaptureReady = performance.now();

  const detection = await runtime.detect(frameCanvas);
  const baseTiming = {
    frameDrawMs: tFrameReady - tFrameStart,
    captureMs: tCaptureReady - tFrameReady,
    ...detection.timing,
  };

  if (!detection.cardPresent) {
    const transfer0 = captureFrameBitmap ? [captureFrameBitmap] : [];
    self.postMessage({
      type: "result",
      captureRequested,
      captureFrameBitmap,
      cardPresent: false,
      cornersValid: false,
      corners: detection.corners,
      sharpness: detection.sharpness,
      confidence: detection.confidence,
      cardId: null,
      secondaryId: null,
      secondaryIdField: runtime?.secondaryIdField ?? null,
      score: null,
      rawCorners: runtime._lastRawCorners,
      detectorInput: runtime._lastDetectorInput,
      detectorBitmap: null,
      cropBitmap: null,
      timing: roundTiming({ ...baseTiming, dewarpMs: 0, embedMs: 0, searchMs: 0, totalMs: performance.now() - tFrameStart }),
    }, transfer0);
    return;
  }

  // Transfer debug bitmaps only when the settings preview is open or an
  // explicit capture is requested.  On mobile Safari, transferring ImageBitmap
  // objects every successful frame can put enough pressure on WebKit's GPU
  // process to reload the page.
  const detectorBitmap = includeDebugBitmaps
    ? runtime.detectorScratchCanvas.transferToImageBitmap()
    : null;
  const cornersValid = isUsableQuad(detection.corners);

  if (!cornersValid) {
    const transfer1 = detectorBitmap ? [detectorBitmap] : [];
    if (captureFrameBitmap) transfer1.push(captureFrameBitmap);
    self.postMessage({
      type: "result",
      captureRequested,
      captureFrameBitmap,
      cardPresent: true,
      cornersValid: false,
      corners: detection.corners,
      sharpness: detection.sharpness,
      confidence: detection.confidence,
      cardId: null,
      secondaryId: null,
      secondaryIdField: runtime?.secondaryIdField ?? null,
      score: null,
      rawCorners: runtime._lastRawCorners,
      detectorInput: runtime._lastDetectorInput,
      detectorBitmap,
      cropBitmap: null,
      timing: roundTiming({ ...baseTiming, dewarpMs: 0, embedMs: 0, searchMs: 0, totalMs: performance.now() - tFrameStart }),
    }, transfer1);
    return;
  }

  const cropCanvas = runtime.dewarp(frameCanvas, detection.corners);
  const { best, timing: embedTiming, searchMs } = await runtime.identify(cropCanvas);

  // Transfer the dewarp canvas bitmap (zero-copy) then it gets a fresh blank.
  const cropBitmap = includeDebugBitmaps ? cropCanvas.transferToImageBitmap() : null;

  const transfer2 = [];
  if (detectorBitmap) transfer2.push(detectorBitmap);
  if (cropBitmap) transfer2.push(cropBitmap);
  if (captureFrameBitmap) transfer2.push(captureFrameBitmap);
  const resultMessage = {
    type: "result",
    captureRequested,
    captureFrameBitmap,
    cardPresent: true,
    cornersValid: true,
    corners: detection.corners,
    sharpness: detection.sharpness,
    confidence: detection.confidence,
    cardId: best.cardId,
    secondaryId: best.secondaryId,
    secondaryIdField: best.secondaryIdField,
    score: best.score,
    orientation: best.orientation,
    rawCorners: runtime._lastRawCorners,
    detectorInput: runtime._lastDetectorInput,
    detectorBitmap,
    cropBitmap,
    timing: roundTiming({
      ...baseTiming,
      ...runtime._lastDewarpTiming,
      ...embedTiming,
      searchMs,
      totalMs: performance.now() - tFrameStart,
    }),
  };
  if (best.secondaryIdField && best.secondaryId !== null && best.secondaryId !== undefined) {
    resultMessage[best.secondaryIdField] = best.secondaryId;
  }
  self.postMessage(resultMessage, transfer2);
}

function sumTiming(first, second) {
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return Object.fromEntries(
    [...keys].map((key) => [key, (first[key] ?? 0) + (second[key] ?? 0)]),
  );
}

function roundTiming(timing) {
  return Object.fromEntries(Object.entries(timing).map(([key, value]) => [
    key,
    Math.round((Number(value) || 0) * 10) / 10,
  ]));
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const enableWebGpu = data.enableWebGpu === true;
      const webgpuReady = enableWebGpu ? await configureWebGpu() : false;
      const useWebGpu = webgpuReady; // only true if both requested and available
      const inferenceMode = useWebGpu ? "WebGPU" : "WASM";
      self.postMessage({ type: "progress", stage: "webgpu", inferenceMode });
      self.postMessage({ type: "progress", stage: "dewarp", ratio: 1 });

      const catalogLimit = Number.isFinite(data.catalogLimit) && data.catalogLimit > 0
        ? Math.floor(data.catalogLimit)
        : null;
      runtime = new WorkerRuntime(
        data.manifest,
        useWebGpu,
        catalogLimit,
        data.rotationInvariant !== false,
        data.minCornerConfidence,
      );
      await runtime.load((stage, ratio, loaded, total, cached) => {
        self.postMessage({ type: "progress", stage, ratio, loaded, total, cached });
      });

      self.postMessage({
        type: "ready",
        inferenceMode,
        numThreads: runtime.numThreads ?? 1,
        catalogRows: runtime.catalogRows,
        catalogTotalRows: runtime.catalogTotalRows,
        catalogLimit: runtime.catalogLimit,
      });

    } else if (data.type === "frame") {
      await processFrame(
        data.bitmap,
        data.captureRequested ?? false,
        data.includeDebugBitmaps ?? false,
      );
    } else if (data.type === "config") {
      runtime?.updateConfig({
        minCornerConfidence: data.minCornerConfidence,
      });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error) });
  }
};

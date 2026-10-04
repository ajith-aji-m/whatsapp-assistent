import crypto from "node:crypto";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const ROOT_FOLDER_NAME = "Personal Assistant";
const MEMORY_FILE_NAME = "personalMemory.json";
const ERROR_LOG_FILE_NAME = "errorLog.txt";

let oauthState = null;
let runtimeRefreshToken = "";
let accessToken = null;
let accessTokenExpiresAt = 0;
let driveCache = { folderId: null, memoryFileId: null, checkedAt: 0 };

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}
function refreshToken() { return process.env.GOOGLE_DRIVE_REFRESH_TOKEN || runtimeRefreshToken; }

export function isGoogleDriveConfigured() { return configured() && !!refreshToken(); }
export function getGoogleDriveStatus() {
  return { configured: configured(), connected: isGoogleDriveConfigured(), rootFolder: ROOT_FOLDER_NAME };
}

export function createGoogleDriveAuthUrl() {
  if (!configured()) throw new Error("Google Drive OAuth is not configured.");
  oauthState = crypto.randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: DRIVE_SCOPE,
    state: oauthState,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleDriveCode(code, state) {
  if (!configured()) throw new Error("Google Drive OAuth is not configured.");
  if (!oauthState || state !== oauthState) throw new Error("Invalid Google OAuth state.");
  oauthState = null;
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Google token exchange failed.");
  if (!data.refresh_token) throw new Error("Google did not return a refresh token. Re-authorize with consent.");
  runtimeRefreshToken = data.refresh_token;
  accessToken = data.access_token || null;
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  driveCache = { folderId: null, memoryFileId: null, checkedAt: 0 };
  return { refreshToken: data.refresh_token, scope: data.scope || DRIVE_SCOPE };
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const token = refreshToken();
  if (!token) throw new Error("Google Drive is not connected. Complete OAuth and set GOOGLE_DRIVE_REFRESH_TOKEN.");
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: token,
    grant_type: "refresh_token",
  });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Google access-token refresh failed.");
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  return accessToken;
}

async function driveRequest(url, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 401) { accessToken = null; accessTokenExpiresAt = 0; }
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.error?.message || `Google Drive API failed: ${response.status}`);
  return data;
}

async function findFile(name, parentId, mimeType) {
  const escaped = name.replace(/'/g, "\\'");
  const q = [`name = '${escaped}'`, "trashed = false", parentId ? `'${parentId}' in parents` : null, mimeType ? `mimeType = '${mimeType}'` : null].filter(Boolean).join(" and ");
  const params = new URLSearchParams({ q, pageSize: "10", fields: "files(id,name,mimeType,modifiedTime)", spaces: "drive" });
  const data = await driveRequest(`${DRIVE_API}?${params.toString()}`);
  return data.files?.[0] || null;
}

async function ensureFolder(name, parentId = null) {
  const existing = await findFile(name, parentId, "application/vnd.google-apps.folder");
  if (existing) return existing.id;
  const body = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];
  const data = await driveRequest(DRIVE_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return data.id;
}

async function ensureTextFile(name, folderId, initialContent = "") {
  const existing = await findFile(name, folderId, "text/plain");
  if (existing) return existing.id;
  const boundary = `drive-boundary-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType: "text/plain", parents: [folderId] });
  const content = initialContent;
  const multipart = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", metadata, `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", content, `--${boundary}--`, ""].join("\r\n");
  const data = await driveRequest(`${DRIVE_API}?uploadType=multipart`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  return data.id;
}

async function ensureDriveMemoryFile() {
  const now = Date.now();
  if (driveCache.memoryFileId && now - driveCache.checkedAt < 30_000) return driveCache.memoryFileId;
  driveCache.folderId = await ensureFolder(ROOT_FOLDER_NAME);
  driveCache.memoryFileId = await ensureMemoryFile(driveCache.folderId);
  driveCache.checkedAt = now;
  return driveCache.memoryFileId;
}

export async function readPersonalMemoryFromDrive() {
  if (!isGoogleDriveConfigured()) return null;
  const fileId = await ensureDriveMemoryFile();
  const token = await getAccessToken();
  const response = await fetch(`${DRIVE_API}/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not read personalMemory.json from Drive: ${response.status}`);
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || typeof parsed.facts !== "object") throw new Error("Drive personalMemory.json has an invalid format.");
  return parsed;
}

async function ensureMemoryFile(folderId) {
  const existing = await findFile(MEMORY_FILE_NAME, folderId, "application/json");
  if (existing) return existing.id;
  const boundary = `drive-boundary-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: MEMORY_FILE_NAME, mimeType: "application/json", parents: [folderId] });
  const content = JSON.stringify({ version: 1, updatedAt: null, facts: {} }, null, 2);
  const multipart = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", metadata, `--${boundary}`, "Content-Type: application/json", "", content, `--${boundary}--`, ""].join("\r\n");
  const data = await driveRequest(`${DRIVE_API}?uploadType=multipart`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  return data.id;
}

async function ensureErrorLogFile(folderId) {
  return ensureTextFile(ERROR_LOG_FILE_NAME, folderId, "");
}

async function ensureDriveErrorLogFile() {
  driveCache.folderId = await ensureFolder(ROOT_FOLDER_NAME);
  return ensureErrorLogFile(driveCache.folderId);
}

export async function readLatestErrorLog() {
  if (!isGoogleDriveConfigured()) return null;
  const fileId = await ensureDriveErrorLogFile();
  const token = await getAccessToken();
  const response = await fetch(DRIVE_API + "/" + fileId + "?alt=media", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!response.ok) throw new Error("Could not read errorLog.txt from Drive: " + response.status);
  return (await response.text()).trim() || null;
}

export async function writeLatestErrorLog(error = {}) {
  if (!isGoogleDriveConfigured()) return false;
  const fileId = await ensureDriveErrorLogFile();
  const token = await getAccessToken();
  const entry = [
    `Timestamp: ${new Date().toISOString()}`,
    `Type: ${String(error.type || "Application Error")}`,
    `Message: ${String(error.message || "Unknown error").replace(/\\s+/g, " ").trim().slice(0, 2000)}`,
    error.context ? `Context: ${String(error.context).replace(/\\s+/g, " ").trim().slice(0, 1000)}` : ""
  ].filter(Boolean).join("\n");
  const response = await fetch(`${DRIVE_API}/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain; charset=utf-8" },
    body: entry
  });
  if (!response.ok) throw new Error(`Could not write errorLog.txt to Drive: ${response.status}`);
  return true;
}

export async function writePersonalMemoryToDrive(memory) {
  if (!isGoogleDriveConfigured()) return false;
  const fileId = await ensureDriveMemoryFile();
  const token = await getAccessToken();
  const response = await fetch(`${DRIVE_API}/${fileId}?uploadType=media`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(memory, null, 2) });
  if (!response.ok) throw new Error(`Could not write personalMemory.json to Drive: ${response.status}`);
  return true;
}
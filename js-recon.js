import fs from 'node:fs/promises';
import path from 'path';
import axios from 'axios';
import mysql from 'mysql2/promise';
import pc from 'picocolors';
import { fileURLToPath } from 'node:url';
import { sendTelegramMessage } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret Access Key', regex: /(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
  { name: 'AWS Session Token', regex: /(?:aws_session_token|AWS_SESSION_TOKEN)\s*[=:]\s*[A-Za-z0-9/+=]{16,}/gi },
  { name: 'S3 Bucket', regex: /([a-z0-9.-]{3,255}\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com)|s3[.-]([a-z0-9-]+)\.amazonaws\.com/gi },
  { name: 'Google API Key', regex: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'Basic Auth', regex: /(?:username|user|login|password|pwd|pass)\s*[:=]\s*['\"]?[^'\"\s]{3,80}/gi },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g },
  { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g }
];

function normalizeHost(value) {
  if (!value) return '';
  let host = value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host.toLowerCase();
}

function buildAllowedHosts(engagement, extraDomains = []) {
  const domains = new Set();
  if (Array.isArray(engagement.domains)) {
    engagement.domains.forEach((d) => {
      if (d) domains.add(normalizeHost(d));
    });
  }
  if (engagement.targetDomain) {
    domains.add(normalizeHost(engagement.targetDomain));
  }
  extraDomains.forEach((d) => {
    if (d) domains.add(normalizeHost(d));
  });
  return [...domains].filter(Boolean);
}

function cacheFilePath(engagement) {
  const baseDir = engagement.subdomainMonitor?.subdomainsDirectory
    ? path.resolve(engagement.subdomainMonitor.subdomainsDirectory)
    : path.resolve(__dirname, 'subdomains', engagement.engagementCode);
  return path.join(baseDir, '.js-recon-cache.json');
}

async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { knownJsUrls: {} };
  }
}

async function saveCache(cachePath, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
}

async function fetchText(url, timeoutSeconds = 15) {
  try {
    const response = await axios.get(url, {
      timeout: timeoutSeconds * 1000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OhMyBounty/1.0; +https://example.com)'
      }
    });
    return response.data;
  } catch (error) {
    console.log(pc.yellow(`[!] JS recon fetch failed: ${url} - ${error.message}`));
    return null;
  }
}

function extractJsUrls(html, baseUrl) {
  const urls = new Set();
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = scriptRegex.exec(html))) {
    try {
      const absUrl = new URL(match[1], baseUrl).href;
      urls.add(absUrl);
    } catch {
      // ignore invalid URLs
    }
  }
  return [...urls];
}

function isAllowedHost(url, allowedHosts) {
  try {
    const host = normalizeHost(new URL(url).hostname);
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function findSecrets(text) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    const matches = [...new Set(text.match(pattern.regex) || [])];
    if (matches.length > 0) {
      findings.push({ name: pattern.name, matches: matches.slice(0, 5) });
    }
  }
  return findings;
}

async function getDbConnection() {
  const cfg = {
    host: process.env.MYSQL_HOST || 'mysql',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: process.env.MYSQL_DATABASE || 'omb'
  };

  for (let i = 0; i < 10; i += 1) {
    try {
      return await mysql.createConnection(cfg);
    } catch (error) {
      console.log(pc.yellow(`[i] Waiting for MySQL in JS recon... (${i + 1}/10)`));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error('MySQL not available for JS recon');
}

async function listKnownSubdomains(engagement) {
  try {
    const connection = await getDbConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`${engagement.engagementCode}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subdomain VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const [rows] = await connection.query(
      `SELECT subdomain FROM \`${engagement.engagementCode}\``
    );
    await connection.end();
    return rows
      .map((row) => normalizeHost(row.subdomain))
      .filter(Boolean);
  } catch (error) {
    console.log(pc.red(`[!] Failed to list known subdomains: ${error.message}`));
    return [];
  }
}

function buildMessageForFindings(engagement, newJsUrls, secretResults, scanTargets) {
  let message = `<b>🧠 JS Recon results for ${engagement.name}</b>\n\n`;
  message += `• <i>Targets scanned:</i> ${scanTargets.join(', ')}\n`;
  if (newJsUrls.length > 0) {
    message += `• <b>New JS files:</b> ${newJsUrls.length}\n`;
    newJsUrls.slice(0, 10).forEach((url) => {
      message += `  • <a href="${url}">${url}</a>\n`;
    });
    if (newJsUrls.length > 10) {
      message += `  • +${newJsUrls.length - 10} more\n`;
    }
  }
  if (secretResults.length > 0) {
    message += `• <b>Secrets found:</b> ${secretResults.length}\n`;
    secretResults.slice(0, 5).forEach((result) => {
      message += `  • <b>${result.url}</b> - ${result.findings.map((f) => f.name).join(', ')}\n`;
    });
  }
  if (newJsUrls.length === 0 && secretResults.length === 0) {
    message += `<i>No new JS files or secrets detected on this scan.</i>\n`;
  }
  return message;
}

async function scanJsFile(url, cache, allowedHosts, timeoutSeconds) {
  const normalizedUrl = url.trim();
  const isKnown = Boolean(cache.knownJsUrls[normalizedUrl]);
  const content = await fetchText(normalizedUrl, timeoutSeconds);
  if (!content) {
    return null;
  }

  const findings = findSecrets(content);
  cache.knownJsUrls[normalizedUrl] = new Date().toISOString();
  return { url: normalizedUrl, newJs: !isKnown, findings };
}

async function scanDomainScripts(domain, allowedHosts, cache, timeoutSeconds) {
  const result = {
    domain,
    scanned: [],
    secrets: []
  };

  const baseUrl = `https://${domain}`;
  let html = await fetchText(baseUrl, timeoutSeconds);
  if (!html) {
    html = await fetchText(`http://${domain}`, timeoutSeconds);
  }
  if (!html) {
    return result;
  }

  const scriptUrls = extractJsUrls(html, baseUrl).filter((scriptUrl) =>
    isAllowedHost(scriptUrl, allowedHosts)
  );

  for (const scriptUrl of scriptUrls) {
    const scan = await scanJsFile(scriptUrl, cache, allowedHosts, timeoutSeconds);
    if (!scan) continue;
    result.scanned.push(scan);
    if (scan.findings.length > 0) {
      result.secrets.push(scan);
    }
  }

  return result;
}

async function scanTargets(engagement, scanDomains, cache) {
  const allowedHosts = buildAllowedHosts(engagement, scanDomains);
  const domainResults = [];
  for (const domain of scanDomains) {
    if (!domain) continue;
    const normalized = normalizeHost(domain);
    if (!normalized) continue;
    const result = await scanDomainScripts(normalized, allowedHosts, cache, engagement.jsRecon?.scanTimeoutSeconds || 15);
    domainResults.push(result);
  }
  return domainResults;
}

function aggregateScanResults(domainResults) {
  const newJsUrls = [];
  const secretResults = [];
  for (const entry of domainResults) {
    for (const scan of entry.scanned) {
      if (scan.newJs) {
        newJsUrls.push(scan.url);
      }
      if (scan.findings.length > 0) {
        secretResults.push({ url: scan.url, findings: scan.findings });
      }
    }
  }
  return { newJsUrls, secretResults };
}

export async function scanNewSubdomain(engagement, subdomain) {
  if (!engagement.jsRecon?.enabled || !engagement.jsRecon.scanOnNewSubdomain) {
    return;
  }

  const cachePath = cacheFilePath(engagement);
  const cache = await loadCache(cachePath);
  const normalizedSubdomain = normalizeHost(subdomain);
  if (!normalizedSubdomain) {
    return;
  }

  const scanDomains = [normalizedSubdomain];
  const domainResults = await scanTargets(engagement, scanDomains, cache);
  await saveCache(cachePath, cache);

  const { newJsUrls, secretResults } = aggregateScanResults(domainResults);
  if (secretResults.length === 0) {
    return;
  }

  const message = buildMessageForFindings(
    engagement,
    newJsUrls,
    secretResults,
    scanDomains
  );
  await sendTelegramMessage(message);
}

export async function runFullJsRecon(engagement) {
  if (!engagement.jsRecon?.enabled) {
    return;
  }

  const cachePath = cacheFilePath(engagement);
  const cache = await loadCache(cachePath);
  const baseDomains = buildAllowedHosts(engagement);
  const knownSubdomains = await listKnownSubdomains(engagement);
  const scanDomains = [...new Set([...baseDomains, ...knownSubdomains])];
  if (scanDomains.length === 0) {
    return;
  }

  const domainResults = await scanTargets(engagement, scanDomains, cache);
  await saveCache(cachePath, cache);

  const { newJsUrls, secretResults } = aggregateScanResults(domainResults);
  if (newJsUrls.length === 0 && secretResults.length === 0) {
    return;
  }

  const message = buildMessageForFindings(
    engagement,
    newJsUrls,
    secretResults,
    scanDomains
  );
  await sendTelegramMessage(message);
}

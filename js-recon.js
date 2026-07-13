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
  { 
    name: 'AWS Access Key ID', 
    regex: /AKIA[0-9A-Z]{16}/g,
    validate: (match) => /^AKIA[0-9A-Z]{16}$/.test(match)
  },
  { 
    name: 'AWS Secret Access Key', 
    regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    validate: (match) => /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match) && /[/+=]/.test(match)
  },
  { 
    name: 'Google API Key', 
    regex: /AIza[0-9A-Za-z\-_]{35}/g,
    validate: (match) => /^AIza[0-9A-Za-z\-_]{35}$/.test(match)
  },
  { 
    name: 'Slack Token', 
    regex: /xox[baprs]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
    validate: (match) => match.length > 50
  },
  { 
    name: 'Private Key', 
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    validate: () => true
  },
  { 
    name: 'GitHub Token', 
    regex: /ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36}/g,
    validate: (match) => match.length === 40
  },
  { 
    name: 'Stripe Key', 
    regex: /sk_(live|test)_[A-Za-z0-9]{24,}/g,
    validate: (match) => match.startsWith('sk_')
  },
  { 
    name: 'JWT Token', 
    regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
    validate: (match) => {
      const parts = match.split('.');
      return parts.length === 3 && parts[0].startsWith('eyJ') && parts[1].startsWith('eyJ');
    }
  }
];

function normalizeHost(value) {
  if (!value) return '';
  let host = value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host.toLowerCase();
}

function buildAllowedHosts(engagement, extraDomains = []) {
  const domains = new Set();
  if (Array.isArray(engagement.targets)) {
    for (const target of engagement.targets) {
      if (Array.isArray(target.domains)) {
        target.domains.forEach((d) => d && domains.add(normalizeHost(d)));
      }
    }
  }
  if (Array.isArray(engagement.domains)) {
    engagement.domains.forEach((d) => d && domains.add(normalizeHost(d)));
  }
  if (engagement.targetDomain) {
    domains.add(normalizeHost(engagement.targetDomain));
  }
  extraDomains.forEach((d) => d && domains.add(normalizeHost(d)));
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
    return { knownJsUrls: {}, knownSecrets: {} };
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
      if (absUrl.endsWith('.js')) urls.add(absUrl);
    } catch {}
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

function findSecrets(text, url) {
  const allFindings = [];
  for (const pattern of SECRET_PATTERNS) {
    const rawMatches = [...new Set(text.match(pattern.regex) || [])];
    const validMatches = rawMatches
      .map(m => m.trim())
      .filter(m => m.length > 10)
      .filter(m => pattern.validate ? pattern.validate(m) : true)
      .filter(m => {
        const lower = m.toLowerCase();
        if (lower.includes('example') || lower.includes('placeholder') || lower.includes('test')) return false;
        if (lower.includes('undefined') || lower.includes('null') || lower.includes('function')) return false;
        if (lower.includes('jquery') || lower.includes('bootstrap') || lower.includes('lodash')) return false;
        return true;
      });
    
    if (validMatches.length > 0) {
      allFindings.push({ 
        name: pattern.name, 
        matches: validMatches.slice(0, 3),
        url 
      });
    }
  }
  return allFindings;
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

async function sendSecretNotification(engagement, finding) {
  for (const match of finding.matches) {
    const truncated = match.length > 60 ? match.slice(0, 60) + '...' : match;
    const message = `<b>🔑 NEW SECRET FOUND in ${engagement.name}</b>\n\n` +
      `• <b>Type:</b> ${finding.name}\n` +
      `• <b>URL:</b> <code>${finding.url}</code>\n` +
      `• <b>Value:</b> <code>${truncated}</code>\n` +
      `• <i>${new Date().toISOString()}</i>`;
    
    try {
      await sendTelegramMessage(message);
      console.log(pc.green(`[+] Secret notification sent: ${finding.name}`));
    } catch (e) {
      console.log(pc.red(`[!] Failed to send secret notification: ${e.message}`));
    }
  }
}

async function scanJsFile(url, cache, allowedHosts, timeoutSeconds) {
  const normalizedUrl = url.trim();
  const isKnown = Boolean(cache.knownJsUrls[normalizedUrl]);
  const content = await fetchText(normalizedUrl, timeoutSeconds);
  if (!content) {
    return null;
  }

  const findings = findSecrets(content, normalizedUrl);
  
  const newFindings = [];
  for (const finding of findings) {
    for (const match of finding.matches) {
      const secretKey = `${finding.name}:${match}`;
      if (!cache.knownSecrets || !cache.knownSecrets[secretKey]) {
        if (!cache.knownSecrets) cache.knownSecrets = {};
        cache.knownSecrets[secretKey] = {
          url: normalizedUrl,
          foundAt: new Date().toISOString()
        };
        newFindings.push({ ...finding, matches: [match] });
      }
    }
  }

  cache.knownJsUrls[normalizedUrl] = new Date().toISOString();
  return { url: normalizedUrl, newJs: !isKnown, findings: newFindings, allFindings: findings };
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
      result.secrets.push(...scan.findings);
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
        secretResults.push(...scan.findings);
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
  
  for (const entry of domainResults) {
    for (const finding of entry.secrets) {
      await sendSecretNotification(engagement, finding);
    }
  }
  
  await saveCache(cachePath, cache);
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
  
  for (const entry of domainResults) {
    for (const finding of entry.secrets) {
      await sendSecretNotification(engagement, finding);
    }
  }
  
  await saveCache(cachePath, cache);

  const { newJsUrls, secretResults } = aggregateScanResults(domainResults);
  if (newJsUrls.length === 0 && secretResults.length === 0) {
    return;
  }

  let message = `<b>🧠 JS Recon summary for ${engagement.name}</b>\n\n`;
  message += `• <i>Targets scanned:</i> ${scanDomains.length}\n`;
  if (newJsUrls.length > 0) {
    message += `• <b>New JS files:</b> ${newJsUrls.length}\n`;
  }
  if (secretResults.length > 0) {
    message += `• <b>New secrets found:</b> ${secretResults.length} (see individual alerts above)\n`;
  }
  
  try {
    await sendTelegramMessage(message);
  } catch (e) {
    console.log(pc.red(`[!] Failed to send summary: ${e.message}`));
  }
}
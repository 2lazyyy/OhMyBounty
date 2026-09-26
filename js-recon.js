import fs from 'node:fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import axios from 'axios';
import mysql from 'mysql2/promise';
import pc from 'picocolors';
import { fileURLToPath } from 'node:url';
import { sendDiscordMessage, sendTelegramMessage } from './utils.js';
import { parseLinkFinderOutput, parseSecretFinderOutput } from './js-recon-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFilePromise = promisify(execFile);
const missingAnalyzerWarnings = new Set();

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
    return { knownJsUrls: {}, knownSecrets: {}, knownEndpoints: {} };
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
      if (isJavaScriptUrl(absUrl)) urls.add(absUrl);
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
        url,
        source: 'Built-in'
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

async function runPythonAnalyzer(scriptPath, inputPath, timeoutSeconds) {
  try {
    await fs.access(scriptPath);
    const { stdout } = await execFilePromise(
      process.env.PYTHON_BIN || 'python3',
      [scriptPath, '-i', inputPath, '-o', 'cli'],
      { timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout;
  } catch (error) {
    const warningKey = `${scriptPath}:${error.code || error.message}`;
    if (!missingAnalyzerWarnings.has(warningKey)) {
      missingAnalyzerWarnings.add(warningKey);
      console.log(pc.yellow(`[!] JS analyzer unavailable (${scriptPath}): ${error.message}`));
    }
    return error.stdout?.toString() || '';
  }
}

async function runExternalAnalyzers(content, url, jsRecon) {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'ohmybounty-js-tools-'));
  const inputPath = path.join(tempDir, 'asset.js');

  try {
    await fs.writeFile(inputPath, content, 'utf-8');
    const timeoutSeconds = Math.max(10, Number(jsRecon.toolTimeoutSeconds) || 30);
    const [secretOutput, linkOutput] = await Promise.all([
      jsRecon.secretFinderEnabled === false
        ? ''
        : runPythonAnalyzer(
          process.env.SECRETFINDER_SCRIPT || '/opt/SecretFinder/SecretFinder.py',
          inputPath,
          timeoutSeconds
        ),
      jsRecon.linkFinderEnabled === false
        ? ''
        : runPythonAnalyzer(
          process.env.LINKFINDER_SCRIPT || '/opt/LinkFinder/linkfinder.py',
          inputPath,
          timeoutSeconds
        )
    ]);

    return {
      secretFindings: parseSecretFinderOutput(secretOutput, url),
      linkFindings: parseLinkFinderOutput(linkOutput, url)
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function scanJsFile(url, cache, allowedHosts, timeoutSeconds, jsRecon) {
  const normalizedUrl = url.trim();
  const isKnown = Boolean(cache.knownJsUrls[normalizedUrl]);
  const content = await fetchText(normalizedUrl, timeoutSeconds);
  if (!content) {
    return null;
  }

  if (!cache.knownSecrets) cache.knownSecrets = {};
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

  const knownSecretMatches = new Set(
    Object.keys(cache.knownSecrets).map((key) => key.slice(key.indexOf(':') + 1))
  );
  const externalFindings = await runExternalAnalyzers(content, normalizedUrl, jsRecon);
  const reportedSecretValues = new Set();
  for (const finding of externalFindings.secretFindings) {
    const match = finding.matches[0];
    const secretKey = `SecretFinder:${finding.name}:${match}`;
    if (cache.knownSecrets[secretKey]) continue;
    cache.knownSecrets[secretKey] = {
      url: normalizedUrl,
      foundAt: new Date().toISOString()
    };
    if (!knownSecretMatches.has(match) && !reportedSecretValues.has(match)) {
      newFindings.push(finding);
      reportedSecretValues.add(match);
    }
  }

  if (!cache.knownEndpoints) cache.knownEndpoints = {};
  const newLinkFindings = [];
  for (const finding of externalFindings.linkFindings) {
    const endpointKey = `${normalizedUrl}:${finding.endpoint}`;
    if (cache.knownEndpoints[endpointKey]) continue;
    cache.knownEndpoints[endpointKey] = { foundAt: new Date().toISOString() };
    newLinkFindings.push(finding);
  }

  cache.knownJsUrls[normalizedUrl] = new Date().toISOString();
  return {
    url: normalizedUrl,
    content,
    newJs: !isKnown,
    findings: newFindings,
    linkFindings: newLinkFindings,
    allFindings: findings
  };
}

function isJavaScriptUrl(value) {
  try {
    return /\.m?js$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

async function crawlJavaScriptUrls(domain, allowedHosts, timeoutSeconds, crawlDepth) {
  const urls = new Set();
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'ohmybounty-katana-'));
  const outputPath = path.join(tempDir, 'crawl.txt');
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const crawlScope = `^https?://([a-z0-9-]+\\.)*${escapedDomain}(:\\d+)?(/|$)`;

  try {
    await execFilePromise('katana', [
      '-u', `https://${domain}`,
      '-jc',
      '-silent',
      '-d', String(Math.max(1, Number(crawlDepth) || 3)),
      '-timeout', String(timeoutSeconds),
      '-cs', crawlScope,
      '-o', outputPath
    ], { timeout: timeoutSeconds * 1000 * 4, maxBuffer: 10 * 1024 * 1024 });
    const output = await fs.readFile(outputPath, 'utf-8');
    for (const line of output.split(/\r?\n/)) {
      const url = line.trim();
      if (isJavaScriptUrl(url) && isAllowedHost(url, allowedHosts)) {
        urls.add(url);
      }
    }
  } catch (error) {
    console.log(pc.yellow(`[!] Katana crawl failed for ${domain}: ${error.message}`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return [...urls];
}

function latestJsDirectory(engagement) {
  const baseDir = engagement.subdomainMonitor?.subdomainsDirectory
    ? path.resolve(engagement.subdomainMonitor.subdomainsDirectory)
    : path.resolve(__dirname, 'subdomains', engagement.engagementCode);
  return path.join(baseDir, 'latest', 'javascript');
}

async function writeLatestJsArtifacts(engagement, domainResults) {
  const outputDir = latestJsDirectory(engagement);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const urls = [...new Set(domainResults.flatMap((entry) => entry.discoveredJsUrls))].sort();
  const assets = [];
  const savedUrls = new Set();

  for (const entry of domainResults) {
    for (const scan of entry.scanned) {
      if (savedUrls.has(scan.url)) continue;
      savedUrls.add(scan.url);

      const parsedUrl = new URL(scan.url);
      const host = parsedUrl.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const name = path.basename(parsedUrl.pathname).replace(/[^a-zA-Z0-9._-]/g, '_') || 'script.js';
      const hash = createHash('sha256').update(scan.url).digest('hex').slice(0, 12);
      const fileName = `${host}-${hash}-${name}`;
      await fs.writeFile(path.join(outputDir, fileName), scan.content, 'utf-8');
      assets.push({ url: scan.url, file: fileName });
    }
  }

  await fs.writeFile(path.join(outputDir, 'urls.txt'), `${urls.join('\n')}${urls.length ? '\n' : ''}`);
  await fs.writeFile(path.join(outputDir, 'files.json'), JSON.stringify(assets, null, 2));
  const findings = {
    secrets: domainResults.flatMap((entry) => entry.secrets),
    endpoints: domainResults.flatMap((entry) => entry.linkFindings)
  };
  await fs.writeFile(path.join(outputDir, 'findings.json'), JSON.stringify(findings, null, 2));
  return { outputDir, urls };
}

async function reportJsFilesToDiscord(engagement, domainCount, outputDir, urls) {
  if (urls.length === 0) return;

  const header = `Targets scanned: ${domainCount}\nJS files found: ${urls.length}\nLatest files: ${outputDir}\n\n`;
  const messages = [];
  let current = header;
  for (const url of urls) {
    const line = `• ${url}\n`;
    if (current.length + line.length > 3500 && current !== header) {
      messages.push(current);
      current = header;
    }
    current += line;
  }
  if (current !== header) messages.push(current);

  for (let index = 0; index < messages.length; index += 1) {
    const suffix = messages.length > 1 ? ` (${index + 1}/${messages.length})` : '';
    await sendDiscordMessage(`JavaScript files: ${engagement.name}${suffix}`, messages[index]);
  }
}

async function reportToolFindingsToDiscord(engagement, domainResults) {
  const secrets = domainResults.flatMap((entry) => entry.secrets);
  const endpoints = domainResults.flatMap((entry) => entry.linkFindings);
  const reportLines = async (title, header, lines) => {
    if (lines.length === 0) return;
    const messages = [];
    let current = header;
    for (const line of lines) {
      const reportLine = `• ${line}\n`;
      if (current.length + reportLine.length > 3500 && current !== header) {
        messages.push(current);
        current = header;
      }
      current += reportLine.length > 3500
        ? `${reportLine.slice(0, 3400)}… [truncated; see latest/javascript/findings.json]\n`
        : reportLine;
    }
    if (current !== header) messages.push(current);
    for (let index = 0; index < messages.length; index += 1) {
      const suffix = messages.length > 1 ? ` (${index + 1}/${messages.length})` : '';
      await sendDiscordMessage(`${title}: ${engagement.name}${suffix}`, messages[index]);
    }
  };

  await reportLines(
    'Secrets detected',
    `SecretFinder and built-in scan: ${secrets.length} new finding(s)\n\n`,
    secrets.flatMap((finding) => finding.matches.map((match) =>
      `${finding.source || 'Built-in'} / ${finding.name}: ${match}\n  JS: ${finding.url}`
    ))
  );
  await reportLines(
    'Endpoints found',
    `LinkFinder: ${endpoints.length} new endpoint(s)\n\n`,
    endpoints.map((finding) => `${finding.endpoint}\n  JS: ${finding.url}`)
  );
}

async function scanDomainScripts(domain, allowedHosts, cache, timeoutSeconds, crawlDepth, jsRecon) {
  const result = {
    domain,
    scanned: [],
    secrets: [],
    linkFindings: [],
    discoveredJsUrls: []
  };

  let baseUrl = `https://${domain}`;
  let html = await fetchText(baseUrl, timeoutSeconds);
  if (!html) {
    baseUrl = `http://${domain}`;
    html = await fetchText(`http://${domain}`, timeoutSeconds);
  }

  const scriptUrls = new Set([
    ...(html ? extractJsUrls(html, baseUrl) : []),
    ...await crawlJavaScriptUrls(domain, allowedHosts, timeoutSeconds, crawlDepth)
  ]);

  for (const scriptUrl of scriptUrls) {
    if (!isAllowedHost(scriptUrl, allowedHosts) || !isJavaScriptUrl(scriptUrl)) continue;
    result.discoveredJsUrls.push(scriptUrl);
    const scan = await scanJsFile(scriptUrl, cache, allowedHosts, timeoutSeconds, jsRecon);
    if (!scan) continue;
    result.scanned.push(scan);
    if (scan.findings.length > 0) {
      result.secrets.push(...scan.findings);
    }
    if (scan.linkFindings.length > 0) {
      result.linkFindings.push(...scan.linkFindings);
    }
  }

  return result;
}

async function scanTargets(engagement, scanDomains, cache) {
  const allowedHosts = buildAllowedHosts(engagement);
  const domainResults = [];
  for (const domain of scanDomains) {
    if (!domain) continue;
    const normalized = normalizeHost(domain);
    if (!normalized) continue;
    if (!allowedHosts.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`))) {
      console.log(pc.yellow(`[!] Skipping out-of-scope JS target: ${normalized}`));
      continue;
    }
    const result = await scanDomainScripts(
      normalized,
      allowedHosts,
      cache,
      engagement.jsRecon?.scanTimeoutSeconds || 15,
      engagement.jsRecon?.crawlDepth || 3,
      engagement.jsRecon || {}
    );
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

export async function scanNewSubdomain(engagement, subdomain, notifications = {}) {
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
  const { outputDir, urls } = await writeLatestJsArtifacts(engagement, domainResults);
  
  for (const entry of domainResults) {
    for (const finding of entry.secrets) {
      await sendSecretNotification(engagement, finding);
    }
  }
  
  await saveCache(cachePath, cache);
  if (notifications.discord) {
    await reportJsFilesToDiscord(engagement, scanDomains.length, outputDir, urls);
    await reportToolFindingsToDiscord(engagement, domainResults);
  }
}

export async function runFullJsRecon(engagement, notifications = {}) {
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
  const { outputDir, urls } = await writeLatestJsArtifacts(engagement, domainResults);
  
  for (const entry of domainResults) {
    for (const finding of entry.secrets) {
      await sendSecretNotification(engagement, finding);
    }
  }
  
  await saveCache(cachePath, cache);

  if (notifications.discord) {
    await reportJsFilesToDiscord(engagement, scanDomains.length, outputDir, urls);
    await reportToolFindingsToDiscord(engagement, domainResults);
  }

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
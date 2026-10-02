import fs from 'node:fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import pc from 'picocolors';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { runFullJsRecon } from './js-recon.js';
import { sendTelegramMessage } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
async function sendDiscord(title, message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'OhMyBounty',
        content: `**${title}**\n${message}`
      })
    });
  } catch (e) {
    console.log(pc.red(`[!] Discord error: ${e.message}`));
  }
}

async function loadConfig() {
  const data = await fs.readFile(path.join(__dirname, 'config.json'), 'utf-8');
  return JSON.parse(data);
}

async function getDbConnection(dbName = null) {
  const cfg = {
    host: process.env.MYSQL_HOST || 'mysql',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
  };
  if (dbName) cfg.database = dbName;
  for (let i = 0; i < 10; i++) {
    try {
      return await mysql.createConnection(cfg);
    } catch (e) {
      console.log(pc.yellow(`[i] Waiting for MySQL... (${i + 1}/10)`));
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('MySQL not available');
}

async function ensureDatabase() {
  const conn = await getDbConnection();
  const dbName = process.env.MYSQL_DATABASE || 'omb';
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.end();
}

// Extract clean domain from various tool output formats
function extractDomain(line) {
  if (!line || typeof line !== 'string') return null;
  
  let value = line.trim();
  
  // Remove https:// or http:// prefix
  value = value.replace(/^https?:\/\//i, '');
  
  // Remove any trailing path, query params, or fragments
  value = value.split('/')[0].split('?')[0].split('#')[0];
  
  // Remove port if present
  value = value.replace(/:\d+$/, '');
  
  return value.trim().toLowerCase();
}

function isValidSubdomain(value) {
  if (!value || typeof value !== 'string') return false;
  
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 253) return false;
  
  // Reject email addresses
  if (trimmed.includes('@')) return false;
  if (trimmed.toLowerCase().startsWith('mailto:')) return false;
  
  // Reject anything with spaces
  if (/\s/.test(trimmed)) return false;
  
  // Reject IP addresses (v4 and v6)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return false;
  if (/^[\da-fA-F:]+$/.test(trimmed) && trimmed.includes(':')) return false; // IPv6 heuristic
  
  // Reject netblocks (contains /)
  if (trimmed.includes('/')) return false;
  
  // Reject ASN entries
  if (/\(\s*ASN\s*\)/i.test(trimmed)) return false;
  if (/^\d+\s+\(ASN\)/i.test(trimmed)) return false;
  
  // Reject tool metadata rather than hostnames.
  if (/\([^)]+\)/.test(trimmed)) return false;
  
  // Must contain at least one dot (domain.tld)
  if (!trimmed.includes('.')) return false;
  
  // Must look like a valid domain
  // Each label: starts with alphanumeric, ends with alphanumeric, can contain hyphens in middle
  // TLD: at least 2 chars, only letters
  const parts = trimmed.split('.');
  if (parts.length < 2) return false;
  
  const tld = parts[parts.length - 1];
  if (!/^[a-zA-Z]{2,}$/.test(tld)) return false;
  
  for (const part of parts) {
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?$/.test(part) && part !== '*') {
      return false;
    }
  }
  
  // Reject common false positive patterns
  const lower = trimmed.toLowerCase();
  if (lower.includes('(netblock)') || lower.includes('(ipaddress)') || 
      lower.includes('(fqdn)') || lower.includes('(asn)')) return false;
  
  return true;
}

async function getAllTxtFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'latest') {
        files.push(...await getAllTxtFiles(fullPath));
      } else if (entry.isFile() && path.extname(entry.name) === '.txt') {
        files.push(fullPath);
      }
    }
  } catch (e) {}
  return files;
}

async function notifyNewSubdomain(engagement, subdomain, config) {
  const title = `New subdomain found in ${engagement.name}`;
  const details = `Subdomain: ${subdomain}`;
  if (config.notifications.telegram) {
    await sendTelegramMessage(`<b>${title}</b>\n\n<code>${details}</code>`);
  }
  if (config.notifications.discord) {
    await sendDiscord(title, details);
  }
}

function getEngagementDomains(engagement) {
  const domains = new Set();
  if (Array.isArray(engagement.targets)) {
    for (const target of engagement.targets) {
      if (Array.isArray(target.domains)) {
        target.domains.forEach((domain) => domain && domains.add(domain));
      }
      if (target.domain) {
        domains.add(target.domain);
      }
    }
  }
  if (Array.isArray(engagement.domains)) {
    engagement.domains.forEach((domain) => domain && domains.add(domain));
  }
  if (engagement.targetDomain) {
    domains.add(engagement.targetDomain);
  }
  return [...domains];
}

async function runToolsForEngagement(engagement) {
  if (!engagement.subdomainMonitor?.runTools) return;

  const outputDir = engagement.subdomainMonitor.subdomainsDirectory;
  const targetDomains = getEngagementDomains(engagement);

  if (targetDomains.length === 0) {
    targetDomains.push(engagement.name.toLowerCase().replace(/\s+/g, ''));
  }

  await fs.mkdir(outputDir, { recursive: true });

  const shellScript = path.join(__dirname, 'tools', 'run-subdomain-tools.sh');
  try {
    await fs.access(shellScript);
    const env = {
      ...process.env,
      ENGAGEMENT_CODE: engagement.engagementCode,
      TARGET_DOMAINS: targetDomains.join(' '),
      OUTPUT_DIR: outputDir
    };
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [shellScript], {
        cwd: __dirname,
        env,
        stdio: 'inherit'
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Enumeration script exited with ${signal || code}`));
        }
      });
    });
    console.log(pc.green(`[+] Shell script done for ${engagement.name}`));
  } catch (e) {
    console.log(pc.red(`[!] Built-in enumeration failed: ${e.message}`));
  }
}

async function processSubdomainFiles() {
  await ensureDatabase();
  const config = await loadConfig();

  for (const engagement of config.engagements) {
    if (!engagement.enabled || !engagement.subdomainMonitor?.enabled) continue;

    const outputDir = engagement.subdomainMonitor.subdomainsDirectory;
    const txtFiles = await getAllTxtFiles(outputDir);
    if (txtFiles.length === 0) continue;

    console.log(pc.yellow(`[i] ${engagement.name}: ${txtFiles.length} file(s) to process`));

    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'mysql',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'root',
      database: process.env.MYSQL_DATABASE || 'omb',
    });

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${engagement.engagementCode}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subdomain VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    let foundNewSubdomains = false;
    const discoveredSubdomainsThisRun = new Set();
    const latestDir = path.join(outputDir, 'latest');
    await fs.mkdir(latestDir, { recursive: true });

    for (const filePath of txtFiles) {
      try {
        const data = await fs.readFile(filePath, 'utf-8');

        // Extract and validate each line
        const rawLines = data.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        const subdomains = [];
        for (const line of rawLines) {
          const extracted = extractDomain(line);
          if (extracted && isValidSubdomain(extracted)) {
            subdomains.push(extracted);
          } else {
            console.log(pc.gray(`[-] Filtered out: ${line.slice(0, 80)}`));
          }
        }

        // Deduplicate
        const uniqueSubdomains = [...new Set(subdomains)];
        for (const subdomain of uniqueSubdomains) {
          discoveredSubdomainsThisRun.add(subdomain);

          const [rows] = await conn.query(
            `SELECT * FROM \`${engagement.engagementCode}\` WHERE subdomain = ?`,
            [subdomain]
          );
          if (rows.length === 0) {
            console.log(pc.green(`[+] New subdomain discovered: ${subdomain}`));
            foundNewSubdomains = true;

            if (!engagement.subdomainMonitor.storeMode) {
              await notifyNewSubdomain(engagement, subdomain, config);
            } else {
              console.log(pc.yellow(`[+] Storing live target (storeMode): ${subdomain}`));
            }

            await conn.query(
              `INSERT INTO \`${engagement.engagementCode}\` (subdomain) VALUES (?)`,
              [subdomain]
            );
          }
        }

        if (uniqueSubdomains.length > 0) {
          console.log(pc.green(`[+] ${engagement.name}: processed ${uniqueSubdomains.length} discovered subdomains`));
        }
      } catch (error) {
        console.log(pc.red(`[!] Failed to process subdomain file ${filePath}: ${error.message}`));
      } finally {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          console.log(pc.gray(`[i] File already processed or missing: ${filePath}`));
        }
      }
    }

    const latestSubdomains = [...discoveredSubdomainsThisRun].sort();
    await fs.writeFile(
      path.join(latestDir, 'subdomains.txt'),
      `${latestSubdomains.join('\n')}${latestSubdomains.length ? '\n' : ''}`
    );

    await conn.end();

    if (
      foundNewSubdomains &&
      engagement.jsRecon?.enabled &&
      engagement.jsRecon?.scanOnNewSubdomain
    ) {
      try {
        await runFullJsRecon(engagement, { discord: config.notifications.discord });
      } catch (e) {
        console.log(pc.red(`[!] Full JS recon failed for ${engagement.name}: ${e.message}`));
      }
    }
  }
}

console.log(pc.cyan('[+] OhMyBounty Subdomain Scanner starting...'));

cron.schedule('0 */3 * * *', async () => {
  console.log(pc.yellow(`[+] ${new Date().toISOString()} Running subdomain tools...`));
  const config = await loadConfig();
  for (const e of config.engagements) {
    if (e.enabled && e.subdomainMonitor?.enabled && e.subdomainMonitor?.runTools) {
      await runToolsForEngagement(e);
    }
  }
  console.log(pc.green('[+] Tool run complete'));
});

cron.schedule('*/10 * * * *', async () => {
  console.log(pc.yellow(`[+] ${new Date().toISOString()} Checking subdomain files...`));
  await processSubdomainFiles();
  console.log(pc.blue('[i] Next check in 10 minutes'));
});

cron.schedule('0 */4 * * *', async () => {
  console.log(pc.yellow(`[+] ${new Date().toISOString()} Running full JS recon for all engagements...`));
  const config = await loadConfig();
  for (const e of config.engagements) {
    if (e.enabled && e.jsRecon?.enabled) {
      await runFullJsRecon(e, { discord: config.notifications.discord });
    }
  }
  console.log(pc.green('[+] Full JS recon run complete'));
});

await processSubdomainFiles();
console.log(pc.green('[+] Scanner ready. Tools: every 3h. File check: every 10m. Full JS recon: every 4h.'));
import fs from 'node:fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import 'dotenv/config';
import pc from 'picocolors';
import { fileURLToPath } from 'node:url';
import { scanNewSubdomain, runFullJsRecon } from './js-recon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = promisify(exec);

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.log(pc.red(`[!] Telegram error: ${e.message}`));
  }
}

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
  
  // Handle amass output: "domain.com (FQDN) --> relation --> target.com (FQDN)"
  // Extract the last domain-like token before any (TYPE) annotation
  const amassMatch = value.match(/([a-zA-Z0-9][a-zA-Z0-9\-_]*\.[a-zA-Z0-9][a-zA-Z0-9\-_]*\.[a-zA-Z]{2,})(?:\s*\([^)]+\))?$/);
  if (amassMatch) {
    value = amassMatch[1];
  }
  
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
  
  // Reject anything with parentheses (amass metadata)
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
      if (entry.isDirectory()) {
        files.push(...await getAllTxtFiles(fullPath));
      } else if (entry.isFile() && path.extname(entry.name) === '.txt') {
        files.push(fullPath);
      }
    }
  } catch (e) {}
  return files;
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

  const tools = engagement.subdomainMonitor.tools || [];
  const outputDir = engagement.subdomainMonitor.subdomainsDirectory;
  const targetDomains = getEngagementDomains(engagement);

  if (targetDomains.length === 0) {
    targetDomains.push(engagement.name.toLowerCase().replace(/\s+/g, ''));
  }

  await fs.mkdir(outputDir, { recursive: true });

  for (const targetDomain of targetDomains) {
    for (const template of tools) {
      const cmd = template
        .replaceAll('{domain}', targetDomain)
        .replaceAll('{output}', outputDir);
      console.log(pc.yellow(`[+] Tool: ${cmd}`));
      try {
        await execPromise(cmd, { timeout: 600000, cwd: __dirname });
      } catch (e) {
        console.log(pc.red(`[!] Failed: ${e.message}`));
      }
    }

    const shellScript = path.join(__dirname, 'tools', 'run-subdomain-tools.sh');
    try {
      await fs.access(shellScript);
      const env = {
        ...process.env,
        ENGAGEMENT_CODE: engagement.engagementCode,
        TARGET_DOMAIN: targetDomain,
        OUTPUT_DIR: outputDir
      };
      await execPromise(`bash "${shellScript}"`, { timeout: 900000, env });
      console.log(pc.green(`[+] Shell script done for ${engagement.name} (${targetDomain})`));
    } catch (e) {
      // Optional
    }
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

    for (const filePath of txtFiles) {
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

      let newCount = 0;
      for (const subdomain of uniqueSubdomains) {
        const [rows] = await conn.query(
          `SELECT * FROM \`${engagement.engagementCode}\` WHERE subdomain = ?`,
          [subdomain]
        );
        if (rows.length === 0) {
          console.log(pc.green(`[+] New: ${subdomain}`));
          newCount++;

          // Only notify if NOT in storeMode
          if (!engagement.subdomainMonitor.storeMode) {
            if (config.notifications.telegram) {
              const msg = `<b>🌐 New subdomain in ${engagement.name}</b>\n\n• <code>${subdomain}</code>\n• <i>Found by scanner</i>\n• <i>${new Date().toISOString()}</i>`;
              await sendTelegram(msg);
            }
            if (config.notifications.discord) {
              await sendDiscord(`New subdomain in ${engagement.name}`, subdomain);
            }
          } else {
            console.log(pc.yellow(`[+] Storing (storeMode): ${subdomain}`));
          }

          await conn.query(
            `INSERT INTO \`${engagement.engagementCode}\` (subdomain) VALUES (?)`,
            [subdomain]
          );

          // JS recon only if enabled
          if (engagement.jsRecon?.enabled) {
            try {
              await scanNewSubdomain(engagement, subdomain);
            } catch (e) {
              console.log(pc.red(`[!] JS recon failed for ${subdomain}: ${e.message}`));
            }
          }
        }
      }

      if (newCount > 0) {
        console.log(pc.green(`[+] ${engagement.name}: ${newCount} new subdomains inserted`));
      }
      await fs.unlink(filePath);
    }

    await conn.end();
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
      await runFullJsRecon(e);
    }
  }
  console.log(pc.green('[+] Full JS recon run complete'));
});

await processSubdomainFiles();
console.log(pc.green('[+] Scanner ready. Tools: every 3h. File check: every 10m. Full JS recon: every 4h.'));
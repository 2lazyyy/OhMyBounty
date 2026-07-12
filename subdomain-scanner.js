import fs from 'node:fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import 'dotenv/config';
import pc from 'picocolors';
import { fileURLToPath } from 'node:url';

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

async function runToolsForEngagement(engagement) {
  if (!engagement.subdomainMonitor?.runTools) return;

  const tools = engagement.subdomainMonitor.tools || [];
  const outputDir = engagement.subdomainMonitor.subdomainsDirectory;
  const targetDomain = engagement.targetDomain || engagement.name.toLowerCase().replace(/\s+/g, '');

  await fs.mkdir(outputDir, { recursive: true });

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
    console.log(pc.green(`[+] Shell script done for ${engagement.name}`));
  } catch (e) {
    // Optional
  }
}

async function processSubdomainFiles() {
  await ensureDatabase();
  const config = await loadConfig();

  for (const engagement of config.engagements) {
    if (!engagement.enabled || !engagement.subdomainMonitor?.enabled) continue;

    const outputDir = engagement.subdomainMonitor.subdomainsDirectory;
    let files;
    try {
      files = await fs.readdir(outputDir);
    } catch (e) { continue; }

    const txtFiles = files.filter(f => path.extname(f) === '.txt');
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

    for (const file of txtFiles) {
      const filePath = path.resolve(outputDir, file);
      const data = await fs.readFile(filePath, 'utf-8');
      const subdomains = data.split('\n')
        .map(s => s.trim().replace(/\r?\n|\r/g, ' ').replace(/^https?:\/\//, ''))
        .filter(s => s.length > 2);

      let newCount = 0;
      for (const subdomain of subdomains) {
        const [rows] = await conn.query(
          `SELECT * FROM \`${engagement.engagementCode}\` WHERE subdomain = ?`,
          [subdomain]
        );
        if (rows.length === 0) {
          console.log(pc.green(`[+] New: ${subdomain}`));
          newCount++;

          if (config.notifications.telegram) {
            const msg = `<b>🌐 New subdomain in ${engagement.name}</b>\n\n• <code>${subdomain}</code>\n• <i>Found by scanner</i>\n• <i>${new Date().toISOString()}</i>`;
            await sendTelegram(msg);
          }
          if (config.notifications.discord) {
            await sendDiscord(`New subdomain in ${engagement.name}`, subdomain);
          }

          await conn.query(
            `INSERT INTO \`${engagement.engagementCode}\` (subdomain) VALUES (?)`,
            [subdomain]
          );
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

await processSubdomainFiles();
console.log(pc.green('[+] Scanner ready. Tools: every 3h. File check: every 10m.'));

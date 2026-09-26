import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

function normalizeHost(value) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function parseHttpxOutput(output, candidates) {
  const allowedHosts = new Set(candidates.map(normalizeHost).filter(Boolean));
  const liveTargets = new Map();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const result = JSON.parse(line);
      const url = new URL(result.url);
      const host = normalizeHost(result.input || url.hostname);
      const statusCode = Number(result.status_code ?? result.statusCode);
      if (
        !allowedHosts.has(host) ||
        !Number.isInteger(statusCode) ||
        statusCode < 100 ||
        statusCode > 599
      ) {
        continue;
      }

      liveTargets.set(host, {
        host,
        url: url.href,
        statusCode,
        title: typeof result.title === 'string' ? result.title : ''
      });
    } catch {
      continue;
    }
  }

  return [...liveTargets.values()];
}

export async function probeLiveTargets(candidates) {
  if (candidates.length === 0) return [];

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'omb-httpx-'));
  const inputPath = path.join(tempDir, 'candidates.txt');
  try {
    await fs.writeFile(inputPath, `${candidates.join('\n')}\n`, 'utf-8');
    const { stdout } = await execFilePromise('httpx', [
      '-l', inputPath,
      '-silent',
      '-no-color',
      '-json',
      '-status-code',
      '-title'
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    return parseHttpxOutput(stdout, candidates);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
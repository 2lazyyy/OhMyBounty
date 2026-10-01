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

export async function probeLiveTargets(candidates, options = {}) {
  const uniqueCandidates = [...new Set(
    (candidates || [])
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .filter(Boolean)
      .map((candidate) => normalizeHost(candidate) || candidate)
      .filter(Boolean)
  )];

  if (uniqueCandidates.length === 0) return [];

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'omb-httpx-'));
  const inputPath = path.join(tempDir, 'candidates.txt');
  const execFileFn = options.execFileFn || execFilePromise;

  try {
    await fs.writeFile(inputPath, `${uniqueCandidates.join('\n')}\n`, 'utf-8');
    const { stdout } = await execFileFn('httpx', [
      '-l', inputPath,
      '-silent',
      '-no-color',
      '-json',
      '-status-code',
      '-title'
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    return parseHttpxOutput(stdout, uniqueCandidates);
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
    if (code.includes('TIMEOUT') || code.includes('ENOENT') || code.includes('EACCES') || code.includes('ECONN') || /timed out|not found|required dependencies were not installed|command failed/i.test(message)) {
      console.warn(`[!] httpx probe failed for ${uniqueCandidates.length} candidates: ${message}`);
      return [];
    }

    console.warn(`[!] httpx probe failed unexpectedly for ${uniqueCandidates.length} candidates: ${message}`);
    return [];
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
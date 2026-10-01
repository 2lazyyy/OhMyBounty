import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHttpxOutput, probeLiveTargets } from '../live-targets.js';

test('handles httpx timeouts without crashing the scanner', async () => {
  const result = await probeLiveTargets(['example.com'], {
    execFileFn: async () => {
      const error = new Error('timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    }
  });

  assert.deepEqual(result, []);
});

test('accepts only candidate hosts with valid HTTP response status', () => {
  const output = [
    JSON.stringify({ input: 'www.example.com', url: 'https://www.example.com/', status_code: 200, title: 'Home' }),
    JSON.stringify({ input: 'offline.example.com', url: 'https://offline.example.com/', status_code: 0 }),
    JSON.stringify({ input: 'other.example.com', url: 'https://other.example.com/', status_code: 200 }),
    'not json'
  ].join('\n');

  assert.deepEqual(parseHttpxOutput(output, ['example.com', 'offline.example.com']), [
    {
      host: 'example.com',
      url: 'https://www.example.com/',
      statusCode: 200,
      title: 'Home'
    }
  ]);
});

test('accepts error HTTP statuses as live responses', () => {
  const output = JSON.stringify({
    input: 'app.example.com',
    url: 'http://app.example.com/',
    status_code: 403
  });

  assert.equal(parseHttpxOutput(output, ['app.example.com'])[0]?.statusCode, 403);
});
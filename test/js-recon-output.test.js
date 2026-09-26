import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLinkFinderOutput, parseSecretFinderOutput } from '../js-recon-output.js';

test('parses SecretFinder findings and preserves multiline secret values', () => {
  const url = 'https://app.example.com/assets/app.js';
  const output = [
    '[ + ] URL: file:///tmp/asset.js',
    'aws_access_key_id\t->\tAKIAABCDEFGHIJKLMNOP',
    'private_key\t->\t-----BEGIN PRIVATE KEY-----',
    'private-key-line-one',
    'private-key-line-two',
    '-----END PRIVATE KEY-----'
  ].join('\n');

  assert.deepEqual(parseSecretFinderOutput(output, url), [
    {
      name: 'aws_access_key_id',
      matches: ['AKIAABCDEFGHIJKLMNOP'],
      url,
      source: 'SecretFinder'
    },
    {
      name: 'private_key',
      matches: [
        '-----BEGIN PRIVATE KEY-----\nprivate-key-line-one\nprivate-key-line-two\n-----END PRIVATE KEY-----'
      ],
      url,
      source: 'SecretFinder'
    }
  ]);
});

test('decodes and deduplicates LinkFinder endpoint output', () => {
  const url = 'https://app.example.com/assets/app.js';
  const output = '/api/search?term=a&amp;limit=10\n/api/search?term=a&amp;limit=10\n';

  assert.deepEqual(parseLinkFinderOutput(output, url), [
    {
      endpoint: '/api/search?term=a&limit=10',
      url,
      source: 'LinkFinder'
    }
  ]);
});
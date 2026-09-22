import { describe, expect, test } from 'vitest';
import {
  assertDestinationAllowed,
  defaultDestinationPolicy,
  isPrivateAddress,
  type DestinationPolicy,
} from '../src/core/destination.js';
import { ValidationError } from '../src/core/errors.js';

const policy = defaultDestinationPolicy();
const allows = (url: string, p: DestinationPolicy = policy) =>
  expect(() => assertDestinationAllowed(url, p)).not.toThrow();
const refuses = (url: string, p: DestinationPolicy = policy) =>
  expect(() => assertDestinationAllowed(url, p)).toThrow(ValidationError);

describe('assertDestinationAllowed', () => {
  test('allows ordinary public and internal hostnames', () => {
    allows('https://example.com/path');
    allows('https://pager.internal/rota');
    allows('http://wiki.corp.example:8080/');
  });

  test('refuses a redirect loop back to the service itself', () => {
    refuses('http://go/oncall');
    refuses('http://localhost:3000/oncall');
    refuses('https://go.corp.example/x', { ...policy, selfHosts: new Set(['go.corp.example']) });
  });

  test('refuses loopback, link-local, private and metadata destinations', () => {
    refuses('http://127.0.0.1/');
    refuses('http://169.254.169.254/latest/meta-data/');
    refuses('http://10.0.0.5/');
    refuses('http://172.16.0.1/');
    refuses('http://192.168.1.1/');
    refuses('http://100.64.0.1/');
    refuses('http://[::1]/');
    refuses('http://[fe80::1]/');
    refuses('http://[fd00::1]/');
    refuses('http://[::ffff:10.0.0.1]/');
    refuses('http://metadata.google.internal/');
    refuses('http://app.localhost/');
  });

  test('lets an operator opt in to private addresses', () => {
    const permissive = { ...policy, allowPrivateAddresses: true };
    allows('http://10.0.0.5/', permissive);
    allows('http://169.254.169.254/', permissive);
    // ...but a loop is still a loop.
    refuses('http://go/x', permissive);
  });
});

describe('isPrivateAddress', () => {
  test('is false for hostnames and public addresses', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('[2001:db8::1]')).toBe(false);
  });
});

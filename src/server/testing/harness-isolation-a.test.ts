import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '.';
import { assertOwnDatabase } from './isolation';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

it('has a database no other file can see', () => assertOwnDatabase(t, expect));

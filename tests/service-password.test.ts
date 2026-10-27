import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateServicePassword,
  SERVICE_PASSWORD_ENTROPY_BITS,
  SERVICE_PASSWORD_MAX_LENGTH,
  SERVICE_PASSWORD_SYMBOLS,
  SERVICE_PASSWORD_WORDS,
  SERVICE_PASSWORD_WORD_COUNT,
} from "../lib/service-password";

function withDraws<T>(draws: number[], run: () => T): { value: T; used: number } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let used = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(array: Uint32Array) {
        assert.ok(array instanceof Uint32Array);
        assert.equal(array.length, 1);
        assert.ok(used < draws.length, "Unexpected extra random draw");
        array[0] = draws[used++];
        return array;
      },
    },
  });
  try {
    return { value: run(), used };
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
}

test("the local word set is unique and provides at least 64 bits with the chosen format", () => {
  assert.equal(SERVICE_PASSWORD_WORDS.length, 128);
  assert.equal(new Set(SERVICE_PASSWORD_WORDS).size, 128);
  assert.equal(Object.isFrozen(SERVICE_PASSWORD_WORDS), true);
  assert.ok(SERVICE_PASSWORD_WORDS.every(word => /^[A-Z][a-z]{2,7}$/.test(word)));
  assert.equal(SERVICE_PASSWORD_WORD_COUNT, 7);
  assert.equal(new Set(SERVICE_PASSWORD_SYMBOLS).size, 8);
  const expected = 7 * Math.log2(128) + Math.log2(10_000) + Math.log2(8);
  assert.ok(Math.abs(SERVICE_PASSWORD_ENTROPY_BITS - expected) < 0.000_001);
  assert.ok(SERVICE_PASSWORD_ENTROPY_BITS >= 64);
  assert.ok(SERVICE_PASSWORD_MAX_LENGTH < 80);
});

test("secure draws choose seven local words, a padded four-digit suffix and a symbol", () => {
  const result = withDraws([0, 1, 2, 3, 4, 5, 6, 4, 7], generateServicePassword);
  assert.equal(result.value, "Abricot-Acajou-Alpaga-Ananas-Ancre-Arlequin-Arrosoir-0004?");
  assert.equal(result.used, 9);
  assert.ok(result.value.length >= 12 && result.value.length <= SERVICE_PASSWORD_MAX_LENGTH);
});

test("out of range random values are discarded instead of introducing modulo bias", () => {
  const result = withDraws([
    0, 1, 2, 3, 4, 5, 6,
    0xffff_ffff,
    4_294_960_000,
    4_294_959_999,
    7,
  ], generateServicePassword);
  assert.match(result.value, /-9999\?$/);
  assert.equal(result.used, 11);
});

test("the longest allowed words still fit the documented maximum length", () => {
  const longestIndex = SERVICE_PASSWORD_WORDS.findIndex(word => word.length === 8);
  assert.ok(longestIndex >= 0);
  const result = withDraws([...Array(7).fill(longestIndex), 9999, 0], generateServicePassword);
  assert.equal(result.value.length, SERVICE_PASSWORD_MAX_LENGTH);
});

test("absence of browser cryptographic randomness fails closed", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    assert.throws(generateServicePassword, /aléatoire sécurisée/);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("a cryptographic random source error is propagated without a weaker fallback", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const failure = new Error("Random source unavailable");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues() { throw failure; } },
  });
  try {
    assert.throws(generateServicePassword, error => error === failure);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

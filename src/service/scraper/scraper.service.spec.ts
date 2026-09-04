import { describe, expect, it } from 'vitest';
import { parseBrazilianCurrency } from './scraper.service.js';

describe('parseBrazilianCurrency', () => {
  it('converts a Brazilian currency value to a number', () => {
    expect(parseBrazilianCurrency('R$ 1.234,56')).toBe(1234.56);
  });

  it('returns null when the value is absent', () => {
    expect(parseBrazilianCurrency(null)).toBeNull();
  });
});

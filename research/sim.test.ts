import { expect, test } from 'bun:test';
import { seed, rnd, dirichlet, binomial, multinomial, poisson, scoreLine, linearScoring, T } from './engine.ts';

test('rng is deterministic for a given seed', () => {
  seed(42); const a = [rnd(), rnd(), rnd()];
  seed(42); const b = [rnd(), rnd(), rnd()];
  expect(a).toEqual(b);
});

test('dirichlet shares sum to one and stay non-negative', () => {
  seed(7);
  const s = dirichlet([0.4, 2, 5, 0.001]);
  expect(s.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
  for (const v of s) expect(v).toBeGreaterThanOrEqual(0);
});

test('multinomial conserves the event count', () => {
  seed(9);
  expect(multinomial(4, [1, 3, 0.5]).reduce((a, b) => a + b, 0)).toBe(4);
  expect(multinomial(3, [0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(0); // no weight -> nothing allocated
});

test('discrete draws respect their support', () => {
  seed(11);
  for (let i = 0; i < 200; i++) {
    const b = binomial(10, 0.3);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(10);
    expect(poisson(2)).toBeGreaterThanOrEqual(0);
  }
  expect(binomial(10, 0)).toBe(0);
  expect(binomial(10, 1)).toBe(10);
});

test('the same stat line scores differently under each league', () => {
  const line = { pass_yd: 300, pass_td: 2, pass_int: 1, rush_yd: 40, rush_td: 1, rec: 6, rec_yd: 90, rec_td: 1 };
  const halfPpr = { rec: 0.5, pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1, pass_td: 4, pass_int: -1, rush_td: 6, rec_td: 6 };
  const fifthPointPerYard = { rec: 0.5, pass_yd: 0.05, rush_yd: 0.2, rec_yd: 0.2, pass_td: 4, pass_int: -2, rush_td: 6, rec_td: 6 };
  const fullPpr = { rec: 1, pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1, pass_td: 4, pass_int: -2, rush_td: 6, rec_td: 6 };
  expect(scoreLine(line, halfPpr)).toBeCloseTo(47, 6);
  expect(scoreLine(line, fifthPointPerYard)).toBeCloseTo(62, 6);
  expect(scoreLine(line, fullPpr)).toBeCloseTo(49, 6);
});

test('yardage bonuses are thresholds, not per-yard multipliers', () => {
  const s = { rec_yd: 0.1, bonus_rec_yd_100: 3 };
  expect(linearScoring(s)).toEqual({ rec_yd: 0.1 });
  expect(scoreLine({ rec_yd: 99 }, s)).toBeCloseTo(9.9, 6);
  expect(scoreLine({ rec_yd: 100 }, s)).toBeCloseTo(13, 6);
});

test('shipped tunables are the values the 2025 backtest selected', () => {
  expect(T.hlPlayer).toBe(6);
  expect(T.hlTeam).toBe(5);
  expect(T.lookbackPlayer).toBe(14);
  expect(T.lookbackTeam).toBe(12);
  expect(T.shrinkShare).toBe(2.5);
});

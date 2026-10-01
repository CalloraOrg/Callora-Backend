// Importing the repository module pulls in ../db/index.js, which opens a
// better-sqlite3 connection at load time. Mock it so the unit under test
// (InMemoryPlansRepository) can be imported without touching a real database.
// This mirrors the pattern used in src/routes/plans.test.ts.
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) };
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
    transaction() {
      return (fn: () => void) => fn();
    }
  };
});

import { InMemoryPlansRepository } from './plansRepository.js';
import type { Plan } from '../db/schema.js';

// Seed chosen so that price order, name order, and request order all differ,
// making each sort/filter assertion unambiguous.
//   id        name     priceUsdc  requestsPerMonth
//   plan_c    Micro    0          100
//   plan_a    Zephyr   10.00      1000
//   plan_d    Bravo    29.99      10000
//   plan_b    Alpha    50.00      5000
const seedPlans: Plan[] = [
  {
    id: 'plan_a',
    name: 'Zephyr',
    description: 'Alpha-late name, mid price',
    priceUsdc: '10.00',
    requestsPerMonth: 1000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'plan_b',
    name: 'Alpha',
    description: 'Alpha-first name, highest price',
    priceUsdc: '50.00',
    requestsPerMonth: 5000,
    createdAt: '2024-01-02T00:00:00.000Z',
  },
  {
    id: 'plan_c',
    name: 'Micro',
    description: 'Cheapest, fewest requests',
    priceUsdc: '0',
    requestsPerMonth: 100,
    createdAt: '2024-01-03T00:00:00.000Z',
  },
  {
    id: 'plan_d',
    name: 'Bravo',
    description: 'Mid price, most requests',
    priceUsdc: '29.99',
    requestsPerMonth: 10000,
    createdAt: '2024-01-04T00:00:00.000Z',
  },
];

function freshRepo(): InMemoryPlansRepository {
  // Deep-ish copy of the seed so per-test mutations never leak between tests.
  return new InMemoryPlansRepository(seedPlans.map((p) => ({ ...p })));
}

const ids = (plans: Plan[]): string[] => plans.map((p) => p.id);

describe('InMemoryPlansRepository', () => {
  describe('list() with no filters', () => {
    it('returns every seeded plan', async () => {
      const repo = freshRepo();
      const result = await repo.list();
      expect(result).toHaveLength(seedPlans.length);
      expect(ids(result).sort()).toEqual(['plan_a', 'plan_b', 'plan_c', 'plan_d']);
    });

    it('returns an empty array when nothing is seeded', async () => {
      const repo = new InMemoryPlansRepository();
      await expect(repo.list()).resolves.toEqual([]);
    });

    it('treats an omitted filters argument the same as an empty object', async () => {
      const repo = freshRepo();
      const withArg = await repo.list({});
      const withoutArg = await repo.list();
      expect(ids(withArg).sort()).toEqual(ids(withoutArg).sort());
    });
  });

  describe('sorting', () => {
    it('sorts by price_asc (ascending numeric price)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ sort: 'price_asc' });
      expect(ids(result)).toEqual(['plan_c', 'plan_a', 'plan_d', 'plan_b']);
      const prices = result.map((p) => parseFloat(p.priceUsdc));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('sorts by price_desc (descending numeric price)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ sort: 'price_desc' });
      expect(ids(result)).toEqual(['plan_b', 'plan_d', 'plan_a', 'plan_c']);
      const prices = result.map((p) => parseFloat(p.priceUsdc));
      expect(prices).toEqual([...prices].sort((a, b) => b - a));
    });

    it('sorts by name_asc (A→Z)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ sort: 'name_asc' });
      // Alpha, Bravo, Micro, Zephyr
      expect(ids(result)).toEqual(['plan_b', 'plan_d', 'plan_c', 'plan_a']);
      expect(result.map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Micro', 'Zephyr']);
    });

    it('sorts by name_desc (Z→A)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ sort: 'name_desc' });
      expect(ids(result)).toEqual(['plan_a', 'plan_c', 'plan_d', 'plan_b']);
      expect(result.map((p) => p.name)).toEqual(['Zephyr', 'Micro', 'Bravo', 'Alpha']);
    });

    it('compares prices numerically, not lexicographically', async () => {
      // '0' < '10.00' < '29.99' < '50.00' numerically; a string sort would put
      // '10.00' before '29.99' too, so use a case that breaks lexicographic
      // ordering: 9 vs 10.
      const repo = new InMemoryPlansRepository([
        { ...seedPlans[0], id: 'p9', priceUsdc: '9' },
        { ...seedPlans[0], id: 'p10', priceUsdc: '10' },
      ]);
      const asc = await repo.list({ sort: 'price_asc' });
      expect(ids(asc)).toEqual(['p9', 'p10']);
    });
  });

  describe('filtering', () => {
    it('filters by priceMin (inclusive, >=)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ priceMin: '10.00' });
      expect(result.every((p) => parseFloat(p.priceUsdc) >= 10)).toBe(true);
      expect(ids(result).sort()).toEqual(['plan_a', 'plan_b', 'plan_d']);
    });

    it('filters by priceMax (inclusive, <=)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ priceMax: '29.99' });
      expect(result.every((p) => parseFloat(p.priceUsdc) <= 29.99)).toBe(true);
      expect(ids(result).sort()).toEqual(['plan_a', 'plan_c', 'plan_d']);
    });

    it('filters by minRequests (inclusive, >=)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ minRequests: 5000 });
      expect(result.every((p) => p.requestsPerMonth >= 5000)).toBe(true);
      expect(ids(result).sort()).toEqual(['plan_b', 'plan_d']);
    });

    it('returns an empty array when no plan matches', async () => {
      const repo = freshRepo();
      await expect(repo.list({ priceMin: '1000' })).resolves.toEqual([]);
    });
  });

  describe('filter combination (AND semantics)', () => {
    it('combines priceMin and priceMax', async () => {
      const repo = freshRepo();
      const result = await repo.list({ priceMin: '10.00', priceMax: '30' });
      // 10 <= price <= 30 → plan_a (10), plan_d (29.99)
      expect(ids(result).sort()).toEqual(['plan_a', 'plan_d']);
    });

    it('combines priceMin and minRequests (both must hold)', async () => {
      const repo = freshRepo();
      const result = await repo.list({ priceMin: '10.00', minRequests: 5000 });
      // price >= 10 AND requests >= 5000 → plan_b (50/5000), plan_d (29.99/10000)
      // plan_a (10/1000) is excluded because it fails the request threshold.
      expect(ids(result).sort()).toEqual(['plan_b', 'plan_d']);
    });

    it('combines all three filters', async () => {
      const repo = freshRepo();
      const result = await repo.list({
        priceMin: '10.00',
        priceMax: '40',
        minRequests: 5000,
      });
      // 10 <= price <= 40 AND requests >= 5000 → only plan_d (29.99/10000);
      // plan_b (50) fails priceMax, plan_a (1000) fails minRequests.
      expect(ids(result)).toEqual(['plan_d']);
    });

    it('applies filters and sort together', async () => {
      const repo = freshRepo();
      const result = await repo.list({ priceMin: '10.00', sort: 'price_desc' });
      // price >= 10 → plan_b (50), plan_d (29.99), plan_a (10), sorted desc
      expect(ids(result)).toEqual(['plan_b', 'plan_d', 'plan_a']);
    });
  });

  describe('findById()', () => {
    it('returns the matching plan', async () => {
      const repo = freshRepo();
      const plan = await repo.findById('plan_b');
      expect(plan).toMatchObject({ id: 'plan_b', name: 'Alpha', priceUsdc: '50.00' });
    });

    it('returns undefined for an unknown id', async () => {
      const repo = freshRepo();
      await expect(repo.findById('does_not_exist')).resolves.toBeUndefined();
    });

    it('returns undefined for an empty-string id', async () => {
      const repo = freshRepo();
      await expect(repo.findById('')).resolves.toBeUndefined();
    });
  });

  describe('immutability of returned objects', () => {
    it('mutating a plan returned by list() does not change the repository', async () => {
      const repo = freshRepo();
      const [first] = await repo.list({ sort: 'name_asc' }); // plan_b / Alpha
      first.name = 'MUTATED';
      first.priceUsdc = '999.99';

      const reread = await repo.findById(first.id);
      expect(reread?.name).toBe('Alpha');
      expect(reread?.priceUsdc).toBe('50.00');

      const listAgain = await repo.list({ sort: 'name_asc' });
      expect(listAgain[0].name).toBe('Alpha');
    });

    it('mutating a plan returned by findById() does not change the repository', async () => {
      const repo = freshRepo();
      const plan = await repo.findById('plan_a');
      expect(plan).toBeDefined();
      plan!.requestsPerMonth = 999999;

      const reread = await repo.findById('plan_a');
      expect(reread?.requestsPerMonth).toBe(1000);
    });

    it('returns a distinct object on each read', async () => {
      const repo = freshRepo();
      const a = await repo.findById('plan_a');
      const b = await repo.findById('plan_a');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it('is isolated from later mutations of the original seed array', async () => {
      const seed: Plan[] = seedPlans.map((p) => ({ ...p }));
      const repo = new InMemoryPlansRepository(seed);

      // Mutate the caller's seed objects after construction.
      seed[0].name = 'SEED_MUTATED';
      seed[0].priceUsdc = '1234.56';

      const reread = await repo.findById(seed[0].id);
      expect(reread?.name).toBe('Zephyr');
      expect(reread?.priceUsdc).toBe('10.00');
    });
  });
});

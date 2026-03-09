const mockRedis = require('../../__mocks__/redisMock').createRedisMock();
jest.mock('../../db/redis', () => mockRedis);

jest.mock('../../utils/geoCache', () => ({
  getCached: jest.fn(),
  setCache: jest.fn(),
  waitForNominatimSlot: jest.fn().mockResolvedValue(undefined),
  TTL_7D: 604800,
}));

global.fetch = jest.fn();

const { extractCityFromCoords } = require('../../utils/extractCity');
const geoCache = require('../../utils/geoCache');

describe('extractCityFromCoords', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    geoCache.getCached.mockResolvedValue(null);
    geoCache.setCache.mockResolvedValue(undefined);
  });

  test('returns null when lat is null', async () => {
    expect(await extractCityFromCoords(null, -117)).toBeNull();
  });

  test('returns null when lng is null', async () => {
    expect(await extractCityFromCoords(32, null)).toBeNull();
  });

  test('returns null when both are null', async () => {
    expect(await extractCityFromCoords(null, null)).toBeNull();
  });

  test('returns cached value on cache hit', async () => {
    geoCache.getCached.mockResolvedValue('Tijuana');
    const result = await extractCityFromCoords(32.5, -117.0);
    expect(result).toBe('Tijuana');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('calls Nominatim API on cache miss and returns city', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { city: 'Tijuana' } }),
    });

    const result = await extractCityFromCoords(32.5, -117.0);
    expect(result).toBe('Tijuana');
    expect(geoCache.waitForNominatimSlot).toHaveBeenCalled();
    expect(geoCache.setCache).toHaveBeenCalledWith(expect.any(String), 'Tijuana', 604800);
  });

  test('uses town when city is not available', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { town: 'Rosarito' } }),
    });
    expect(await extractCityFromCoords(32.3, -117.0)).toBe('Rosarito');
  });

  test('uses municipality when city and town are not available', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { municipality: 'Ensenada' } }),
    });
    expect(await extractCityFromCoords(31.8, -116.6)).toBe('Ensenada');
  });

  test('uses county as last fallback', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { county: 'SomeCounty' } }),
    });
    expect(await extractCityFromCoords(31, -116)).toBe('SomeCounty');
  });

  test('strips "Municipio de" prefix', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { city: 'Municipio de Tijuana' } }),
    });
    expect(await extractCityFromCoords(32.5, -117.0)).toBe('Tijuana');
  });

  test('strips "municipio de" prefix case-insensitive', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { municipality: 'municipio de Playas de Rosarito' } }),
    });
    expect(await extractCityFromCoords(32.3, -117.0)).toBe('Playas de Rosarito');
  });

  test('returns null when API returns not ok', async () => {
    global.fetch.mockResolvedValue({ ok: false });
    expect(await extractCityFromCoords(32.5, -117.0)).toBeNull();
    expect(geoCache.setCache).not.toHaveBeenCalled();
  });

  test('returns null when address has no city/town/municipality/county', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { country: 'Mexico' } }),
    });
    expect(await extractCityFromCoords(32.5, -117.0)).toBeNull();
    expect(geoCache.setCache).not.toHaveBeenCalled();
  });

  test('returns null when no address at all', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    expect(await extractCityFromCoords(32.5, -117.0)).toBeNull();
  });
});

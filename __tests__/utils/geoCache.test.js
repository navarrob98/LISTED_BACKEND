const mockRedis = require('../../__mocks__/redisMock').createRedisMock();
jest.mock('../../db/redis', () => mockRedis);

const { getCached, setCache, waitForNominatimSlot, TTL_24H, TTL_7D, autocompleteKey, geocodeKey, reverseGeocodeKey, detailsKey } = require('../../utils/geoCache');

describe('geoCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCached', () => {
    test('returns null when redis returns null', async () => {
      mockRedis.get.mockResolvedValue(null);
      expect(await getCached('key')).toBeNull();
    });

    test('returns parsed JSON when redis has data', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ city: 'Tijuana' }));
      expect(await getCached('key')).toEqual({ city: 'Tijuana' });
    });

    test('returns null on invalid JSON', async () => {
      mockRedis.get.mockResolvedValue('not-json{');
      expect(await getCached('key')).toBeNull();
    });
  });

  describe('setCache', () => {
    test('stores stringified data with TTL', async () => {
      await setCache('mykey', { a: 1 }, 300);
      expect(mockRedis.set).toHaveBeenCalledWith('mykey', '{"a":1}', 'EX', 300);
    });
  });

  describe('waitForNominatimSlot', () => {
    test('returns immediately when lock acquired', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await waitForNominatimSlot();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'geo:nominatim:last',
        expect.any(Number),
        'PX', 1100, 'NX'
      );
    });

    test('waits and retries when lock not acquired', async () => {
      mockRedis.set
        .mockResolvedValueOnce(null)  // first attempt fails
        .mockResolvedValueOnce('OK'); // second succeeds
      mockRedis.pttl.mockResolvedValue(50);

      await waitForNominatimSlot();
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(mockRedis.pttl).toHaveBeenCalled();
    });

    test('uses default wait when pttl returns negative', async () => {
      mockRedis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('OK');
      mockRedis.pttl.mockResolvedValue(-1);

      await waitForNominatimSlot();
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
    });
  });

  describe('key builders', () => {
    test('autocompleteKey formats correctly', () => {
      expect(autocompleteKey('MX', '  Tijuana  ')).toBe('geo:ac:mx:tijuana');
    });

    test('geocodeKey formats correctly', () => {
      expect(geocodeKey('MX', 'Calle 1')).toBe('geo:gc:mx:calle 1');
    });

    test('reverseGeocodeKey formats with 5 decimal places', () => {
      expect(reverseGeocodeKey(32.123456789, -117.123456789)).toBe('geo:rg:32.12346:-117.12346');
    });

    test('detailsKey formats correctly', () => {
      expect(detailsKey('place123')).toBe('geo:det:place123');
    });
  });

  describe('constants', () => {
    test('TTL_24H is 86400', () => expect(TTL_24H).toBe(86400));
    test('TTL_7D is 604800', () => expect(TTL_7D).toBe(604800));
  });
});

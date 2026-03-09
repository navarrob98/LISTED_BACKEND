// Shared mock for db/pool
// Usage: const { pool, mockQuery, mockPromiseQuery } = require('../__mocks__/dbMock');

function createPoolMock() {
  const mockQuery = jest.fn();
  const mockPromiseQuery = jest.fn();
  const mockGetConnection = jest.fn();
  const mockRelease = jest.fn();
  const mockEnd = jest.fn();

  const connMock = {
    query: mockPromiseQuery,
    release: mockRelease,
  };

  const pool = {
    query: mockQuery,
    promise: jest.fn(() => ({
      query: mockPromiseQuery,
      getConnection: mockGetConnection.mockResolvedValue(connMock),
    })),
    getConnection: jest.fn((cb) => cb(null, { release: mockRelease })),
    end: mockEnd,
  };

  return { pool, mockQuery, mockPromiseQuery, mockGetConnection, connMock, mockRelease, mockEnd };
}

module.exports = { createPoolMock };

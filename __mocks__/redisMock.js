// Shared mock for db/redis
function createRedisMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    zadd: jest.fn().mockResolvedValue(1),
    zcard: jest.fn().mockResolvedValue(0),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    pttl: jest.fn().mockResolvedValue(-2),
    call: jest.fn().mockResolvedValue(null),
    quit: jest.fn().mockResolvedValue('OK'),
    duplicate: jest.fn(function () { return createRedisMock(); }),
  };
}

module.exports = { createRedisMock };

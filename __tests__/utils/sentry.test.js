jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setUser: jest.fn(),
}));

describe('utils/sentry', () => {
  let Sentry;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('@sentry/node', () => ({
      init: jest.fn(),
      setUser: jest.fn(),
    }));
  });

  test('calls Sentry.init with correct config', () => {
    const mockSentry = require('@sentry/node');
    require('../../utils/sentry');
    expect(mockSentry.init).toHaveBeenCalledTimes(1);
    const cfg = mockSentry.init.mock.calls[0][0];
    expect(cfg.serverName).toBe('listed-backend');
    expect(cfg).toHaveProperty('dsn');
    expect(cfg).toHaveProperty('beforeSend');
  });

  test('beforeSend filters CORS errors', () => {
    const mockSentry = require('@sentry/node');
    require('../../utils/sentry');
    const cfg = mockSentry.init.mock.calls[0][0];
    const beforeSend = cfg.beforeSend;

    expect(beforeSend({ message: 'Not allowed by CORS' })).toBeNull();
    expect(beforeSend({ message: 'Something Not allowed by CORS policy' })).toBeNull();
  });

  test('beforeSend passes through normal events', () => {
    const mockSentry = require('@sentry/node');
    require('../../utils/sentry');
    const cfg = mockSentry.init.mock.calls[0][0];
    const beforeSend = cfg.beforeSend;

    const normalEvent = { message: 'some error' };
    expect(beforeSend(normalEvent)).toBe(normalEvent);
  });

  test('beforeSend handles events with no message', () => {
    const mockSentry = require('@sentry/node');
    require('../../utils/sentry');
    const cfg = mockSentry.init.mock.calls[0][0];
    const beforeSend = cfg.beforeSend;

    const event = {};
    expect(beforeSend(event)).toBe(event);
  });

  test('exports the Sentry module', () => {
    const result = require('../../utils/sentry');
    expect(result).toHaveProperty('init');
  });

  test('tracesSampleRate is 0 in non-production', () => {
    const mockSentry = require('@sentry/node');
    require('../../utils/sentry');
    const cfg = mockSentry.init.mock.calls[0][0];
    expect(cfg.tracesSampleRate).toBe(0);
  });
});

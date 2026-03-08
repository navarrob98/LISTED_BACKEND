const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN_BACKEND,
  enabled: !!process.env.SENTRY_DSN_BACKEND,
  serverName: 'listed-backend',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
  beforeSend(event) {
    const msg = event.message || '';
    if (msg.includes('Not allowed by CORS')) return null;
    return event;
  },
});

module.exports = Sentry;

const express = require('express');

module.exports = function registerRoutes(app) {
  // Health check: sin body parser, se registra antes de cualquier middleware pesado
  // para que Railway siga recibiendo 200 aunque el resto del stack esté saturado.
  app.use('/', require('./health'));

  // Stripe webhook MUST be registered BEFORE express.json() so it gets raw body.
  app.use('/', require('./payments'));

  // JSON body parser for all remaining routes
  app.use(express.json());

  // All other routes (require parsed JSON body)
  app.use('/', require('./auth'));
  app.use('/', require('./users'));
  app.use('/', require('./agents'));
  app.use('/', require('./properties'));
  app.use('/', require('./admin'));
  app.use('/', require('./chat'));
  app.use('/', require('./appointments'));
  app.use('/', require('./misc'));
  app.use('/', require('./favorites'));
  app.use('/', require('./ai'));
  app.use('/', require('./leads'));
  app.use('/', require('./savedSearches'));
  app.use('/', require('./findAgent'));
  app.use('/', require('./ratings'));
};

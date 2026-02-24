const express = require('express');

module.exports = function registerRoutes(app) {
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
};

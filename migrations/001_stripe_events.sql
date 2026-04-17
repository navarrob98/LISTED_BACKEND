-- Tracking de eventos Stripe procesados para idempotencia.
-- Stripe reintenta webhooks en error → sin esto, el mismo pago se procesa múltiples veces.
-- Corre una vez contra la DB de producción.

CREATE TABLE IF NOT EXISTS stripe_events (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_processed_at (processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nota: Stripe guarda event.id por 30 días en su lado. Nosotros podemos limpiar
-- registros viejos periódicamente (cron) con:
--   DELETE FROM stripe_events WHERE processed_at < DATE_SUB(NOW(), INTERVAL 60 DAY);

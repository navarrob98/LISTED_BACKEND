require('dotenv').config({ path: 'temporary.env' });
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  // 200 default para soportar picos de ~200 req/seg sin encolar indefinidamente.
  // Verificar que el plan MySQL de Railway permita >= connectionLimit conexiones.
  connectionLimit: Number(process.env.MYSQL_POOL_LIMIT) || 200,
  waitForConnections: true,
  // queueLimit=200: si todas las conexiones están busy y 200 requests en cola,
  // el 201 falla rápido en vez de esperar indefinido → mejor señal a Railway/cliente.
  queueLimit: Number(process.env.MYSQL_QUEUE_LIMIT) || 200,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
  connectTimeout: 10000,
  ssl: process.env.MYSQL_SSL === 'false' ? undefined : { rejectUnauthorized: false },
});

module.exports = pool;

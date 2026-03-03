require('dotenv').config({ path: 'temporary.env' });
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  connectionLimit: Number(process.env.MYSQL_POOL_LIMIT) || 50,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
  connectTimeout: 10000,
  ssl: process.env.MYSQL_SSL === 'false' ? undefined : { rejectUnauthorized: false },
});

module.exports = pool;

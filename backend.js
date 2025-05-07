const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = 3306;
console.log(temoporary.env.db_key);

// Middleware
app.use(cors());
app.use(bodyParser.json());

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: temoporary.env.db_key,
    database: 'listed_property_sell',
    connectionLimit: 10
});

// Test database connection
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database!');
    connection.release();
});

// Endpoints

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});

app.post('/properties/add', (req, res) => {
    const { type, address, price, monthly_pay, bedrooms, bathrooms, land, construction, description } = req.body;
    const query = 'INSERT INTO properties (type, address, price, monthly_pay, bedrooms, bathrooms, land, construction, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [type, address, price, monthly_pay, bedrooms, bathrooms, land, construction, description];
  
    pool.query(query, values, (err, results) => {
        if (err) {
            console.error('Error saving property:', err);
            res.status(500).json({ error: 'Failed to save property' });
            return;
        }
        res.json({ message: 'Property saved successfully', insertId: results.insertId });
    });
});

app.get('/properties', (req, res) => {
    const query = 'SELECT * FROM properties';

    pool.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching properties:', err);
            res.status(500).json({ error: 'Failed to fetch properties' });
            return;
        }
        res.json(results);
    });
});
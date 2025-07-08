require('dotenv').config({ path: 'temporary.env' });

const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');

const app = express();
const port = 3000;
const dbPassword = process.env.DB_KEY;
const jwtSecret = process.env.JWT_SECRET;

// Middleware
app.use(cors());
app.use(bodyParser.json());

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: dbPassword,
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

// Property Endpoints

app.listen(port, '0.0.0.0', () => {
    console.log(`Backend server listening on port ${port}`);
});

// Add property
app.post('/properties/add', authenticateToken, (req, res) => {
  const {
    type,
    address,
    price,
    monthly_pay,
    bedrooms,
    bathrooms,
    half_bathrooms,
    land,
    construction,
    description,
    sell_rent,
    date_build,
    estate_type,
    parking_spaces,
    stories,
    private_pool,
    new_construction,
    water_serv,
    electricity_serv,
    sewer_serv,
    garbage_collection_serv,
    solar,
    ac,
    laundry_room,
    lat,
    lng,
  } = req.body;
  const created_by = req.user.id;
  const query = `
    INSERT INTO properties (
      type, address, price, monthly_pay,
      bedrooms, bathrooms, half_bathrooms,
      land, construction, description,
      sell_rent, date_build, estate_type,
      parking_spaces, stories,
      private_pool, new_construction,
      water_serv, electricity_serv,
      sewer_serv, garbage_collection_serv,
      solar, ac, laundry_room, lat, lng, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const values = [
    type,
    address,
    price || null,
    monthly_pay || null,
    bedrooms,
    bathrooms,
    half_bathrooms || null,
    land,
    construction,
    description || null,
    sell_rent || null,
    date_build || null,
    estate_type || null,
    parking_spaces || null,
    stories || null,
    private_pool ? 1 : 0,
    new_construction ? 1 : 0,
    water_serv ? 1 : 0,
    electricity_serv ? 1 : 0,
    sewer_serv ? 1 : 0,
    garbage_collection_serv ? 1 : 0,
    solar ? 1 : 0,
    ac ? 1 : 0,
    laundry_room ? 1 : 0,
    lat || null,
    lng || null,
    created_by
  ];
  
    pool.query(query, values, (err, results) => {
        if (err) {
            console.error('Error saving property:', err);
            res.status(500).json({ error: 'Failed to save property' });
            return;
        }
        console.log('Property saved successfully')
        res.json({ message: 'Property saved successfully', insertId: results.insertId });
    });
});

// Edit property by id
app.put('/properties/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const fields = req.body; // todos los campos que el cliente quiera actualizar
  if (!id || Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  // Solo permite actualizar campos válidos, evita SQL injection:
  const allowedFields = [
    'type','price','monthly_pay','images','address','bedrooms','bathrooms','half_bathrooms',
    'land','construction','sell_rent','date_build','home_type','parking_spaces','stories',
    'private_pool','new_construction','water_serv','electricity_serv','sewer_serv',
    'garbage_collection_serv','solar','ac','laundry_room','description','lat','lng'
  ];

  // Filtra solo los campos que sí puedes actualizar
  const setFields = [];
  const values = [];
  for (const key in fields) {
    if (allowedFields.includes(key)) {
      setFields.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (setFields.length === 0) {
    return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  }

  values.push(id, req.user.id);

  const query = `
    UPDATE properties
    SET ${setFields.join(', ')}
    WHERE id = ? AND created_by = ?
  `;

  pool.query(query, values, (err, results) => {
    if (err) return res.status(500).json({ error: 'No se pudo actualizar', details: err });
    if (results.affectedRows === 0) return res.status(404).json({ error: 'Propiedad no encontrada o no autorizada' });
    res.json({ message: 'Actualizada', updatedFields: setFields.map(f => f.split('=')[0].trim()) });
  });
});

// Get properties in a specific region
app.get('/properties', (req, res) => {
  const { minLat, maxLat, minLng, maxLng } = req.query;
  if (
    minLat === undefined || maxLat === undefined ||
    minLng === undefined || maxLng === undefined
  ) {
    return res.status(400).json({ error: 'Faltan parámetros de región' });
  }
  const query = `
    SELECT *
    FROM properties
    WHERE lat BETWEEN ? AND ?
      AND lng BETWEEN ? AND ?
  `;

  pool.query(
    query,
    [Number(minLat), Number(maxLat), Number(minLng), Number(maxLng)],
    (err, results) => {
      if (err) {
        console.error('Error fetching properties:', err);
        res.status(500).json({ error: 'Failed to fetch properties' });
        return;
      }
      res.json(results);
    }
  );
});

// Get property by id
app.get('/properties/:id', (req, res) => {
  const { id } = req.params;
  pool.query('SELECT * FROM properties WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error al buscar la propiedad' });
    if (results.length === 0) return res.status(404).json({ error: 'No encontrada' });
    console.log('Got property with id: ', id)
    res.json(results[0]);
  });
});

// GET solo las del usuario logueado
app.get('/my-properties', authenticateToken, (req, res) => {
  const userId = req.user.id; // El id del usuario autenticado del token

  const query = `
    SELECT * FROM properties
    WHERE created_by = ?
    ORDER BY id DESC
  `;
  // console.log('Request to my-properties with', req, userId)
  pool.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error getting user properties:', err);
      return res.status(500).json({ error: 'Error al obtener tus propiedades.' });
    }
    console.log('Results: ', results)
    res.json(results);
  });
});

// Delete property
app.delete('/properties/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM properties WHERE id = ?';
  
    pool.query(query, [id], (err, result) => {
      if (err) {
        console.error('Error deleting property:', err);
        res.status(500).json({ error: 'Failed to delete property' });
        return;
      }
      console.log('Property deleted successfully')
      res.json({ message: 'Property deleted successfully' });
    });
  });

  // User Endpoints

  // Register new user
  app.post('/users/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const query = "INSERT INTO users (name, email, password, type) VALUES (?, ?, ?, ?)";
      pool.query(query, [name, email, hashedPassword, 'regular'], (err, result) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'El correo ya está registrado.' });
          }
          return res.status(500).json({ error: 'Error al registrar el usuario.' });
        }
        const userId = result.insertId;
        const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET, {
        expiresIn: '1h',
        });
        res.status(201).json({
            message: 'Usuario registrado con éxito.',
            token,
            user: {
              id: userId,
              name,
              email, 
              type: 'regular'
            },
          });
        console.log('Usuario agregado correctamente')
      });
    } catch (error) {
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  });

  // Register new agent
  app.post('/agents/register', async (req, res) => {
    const { name, email, password, phone, license } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const query = "INSERT INTO users (name, email, password, phone, license, type ) VALUES (?, ?, ?, ?, ?, ?)";
      pool.query(query, [name, email, hashedPassword, phone, license, 'agente'], (err, result) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "El email ya existe" });
          }
          return res.status(500).json({ error: 'Error al registrar el usuario.' });
        }
        const userId = result.insertId;
        const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET, {
        expiresIn: '1h',
        });
        res.status(201).json({
            message: 'Usuario registrado con éxito.',
            token,
            user: {
              id: userId,
              name,
              email,
              phone,
              license,
              type: 'agente'
            },
          });
        console.log('Usuario agregado correctamente')
      });
    } catch (error) {
      console.log('error:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  });
  
// User log in
app.post('/users/login', (req, res) => {
  const { email, password } = req.body;
  const query = 'SELECT * FROM users WHERE email = ?';

  pool.query(query, [email], async (err, results) => {
    if (err) return res.status(500).json({ error: 'Error al buscar el usuario.' });

    if (results.length === 0) {
      return res.status(400).json({ error: 'Usuario no encontrado.' });
    }

    const user = results[0];
    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.type },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      message: 'Login exitoso.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone ?? null, 
        user_type: user.type ?? null
      },
    });
  });
});

app.put('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { phone, email, password } = req.body;
  let updates = [];
  let values = [];

  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
  if (email !== undefined) { updates.push('email = ?'); values.push(email); }
  if (password !== undefined) {
    const hashedPassword = bcrypt.hashSync(password, 10);
    updates.push('password = ?');
    values.push(hashedPassword);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(id);

  pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values,
    (err, results) => {
      if (err) return res.status(500).json({ error: 'No se pudo actualizar' });
      pool.query('SELECT id, name, email, phone FROM users WHERE id = ?', [id], (err2, rows) => {
        if (err2 || !rows[0]) return res.json({ message: 'Actualizado' });
        res.json(rows[0]);
      });
    }
  );
});

  //  Auth endpoint

  // Endpoint para validar token
  app.get('/auth/validate', authenticateToken, (req, res) => {
    const { id, email, type } = req.user;
    const query = 'SELECT name, email, type FROM users WHERE id = ? LIMIT 1';
    pool.query(query, [id], (err, results) => {
      if (err || results.length === 0) {
        return res.status(401).json({ error: 'Usuario no encontrado.' });
      }
      const user = results[0];
      res.json({
        valid: true,
        id,
        name: user.name,
        email: user.email,
        user_type: user.type,
      });
      console.log('auth: ', user);
    });
  });

  // Buying Power endpoints

  // POST Guardar Buying Power
  app.post('/api/buying-power', (req, res) => {
    const { user_id, annual_income, down_payment, monthly_debt, monthly_target, loan_years, target_price } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id es requerido' });
  
    const query = `
      INSERT INTO buying_power
        (user_id, annual_income, down_payment, monthly_debt, monthly_target, loan_years, target_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        annual_income = VALUES(annual_income),
        down_payment = VALUES(down_payment),
        monthly_debt = VALUES(monthly_debt),
        monthly_target = VALUES(monthly_target),
        loan_years = VALUES(loan_years),
        target_price = VALUES(target_price),
        updated_at = CURRENT_TIMESTAMP
    `;
    const values = [user_id, annual_income, down_payment, monthly_debt, monthly_target, loan_years, target_price];
  
    pool.query(query, values, (err, result) => {
      if (err) {
        console.error('Error guardando buying power:', err);
        return res.status(500).json({ error: 'Error guardando datos' });
      }
      res.json({ ok: true, message: "Buying power guardado o actualizado" });
    });
  });

// GET Consultar Buying Power de un usuario
  app.get('/api/buying-power/:user_id', (req, res) => {
    const { user_id } = req.params;

    const query = `
      SELECT * FROM buying_power
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;

    pool.query(query, [user_id], (err, results) => {
      if (err) {
        console.error('Error consultando buying power:', err);
        return res.status(500).json({ error: 'Error consultando datos' });
      }
      if (results.length === 0) return res.status(404).json({ error: "No encontrado" });
      res.json(results[0]);
    });
  });
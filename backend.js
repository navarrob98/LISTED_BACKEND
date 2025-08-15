require('dotenv').config({ path: 'temporary.env' });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');

const app = express();
const port = process.env.PORT || 3000;
const dbPassword = process.env.DB_KEY;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// const pool = mysql.createPool({
//   host: process.env.MYSQLHOST,
//   user: process.env.MYSQLUSER,
//   password: process.env.MYSQLPASSWORD,
//   database: process.env.MYSQLDATABASE,
//   port: process.env.MYSQLPORT,
// });

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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
server.listen(port, '0.0.0.0', () => {
  console.log(`Backend server + Socket.io listening on port ${port}`);
});

// Property Endpoints
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
    images
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

    const propertyId = results.insertId;
    // Guardar imágenes si existen
    if (Array.isArray(images) && images.length > 0) {
      // Prepara los datos
      const imageValues = images.map(url => [propertyId, url]);
      // Inserta todas las imágenes en un solo query
      pool.query(
        'INSERT INTO property_images (property_id, image_url) VALUES ?',
        [imageValues],
        (imgErr, imgResults) => {
          if (imgErr) {
            console.error('Error saving images:', imgErr);
            // Se guarda la propiedad aunque falle una imagen
            res.status(201).json({ 
              message: 'Property saved, but failed to save some images', 
              propertyId 
            });
            return;
          }
          // Todo OK
          res.status(201).json({ 
            message: 'Property and images saved successfully', 
            propertyId 
          });
        }
      );
    } else {
      // Si no hay imágenes, responde normal
      res.status(201).json({ 
        message: 'Property saved successfully', 
        propertyId 
      });
    }
  });
});

// Edit property by id (con manejo de imágenes por URL)
app.put('/properties/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const incoming = req.body || {};

  if (!id || Object.keys(incoming).length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  // 1) Manejo de imágenes (arrays opcionales)
  const imagesAdd = Array.isArray(incoming.images_add) ? incoming.images_add.filter(Boolean) : [];
  const imagesRemove = Array.isArray(incoming.images_remove_urls) ? incoming.images_remove_urls.filter(Boolean) : [];

  // 2) Campos permitidos de la tabla properties (según tu esquema)
  const colTypes = {
    address: 'string',
    price: 'number',
    monthly_pay: 'number',
    bedrooms: 'int',
    bathrooms: 'number',
    land: 'number',
    construction: 'number',
    description: 'string',
    type: 'string',
    half_bathrooms: 'int',
    sell_rent: 'string',
    date_build: 'int',
    estate_type: 'string',
    parking_spaces: 'int',
    stories: 'int',
    private_pool: 'bool',
    new_construction: 'bool',
    water_serv: 'bool',
    electricity_serv: 'bool',
    sewer_serv: 'bool',
    garbage_collection_serv: 'bool',
    solar: 'bool',
    ac: 'bool',
    laundry_room: 'bool',
    lat: 'float',
    lng: 'float',
  };

  const setFragments = [];
  const values = [];

  const castValue = (val, type) => {
    if (val === '' || val === undefined) return null;
    if (type === 'string') return String(val).trim();
    if (type === 'int') { const n = parseInt(val, 10); return Number.isFinite(n) ? n : null; }
    if (type === 'float' || type === 'number') { const n = parseFloat(val); return Number.isFinite(n) ? n : null; }
    if (type === 'bool') {
      if (val === true || val === 'true' || val === 1 || val === '1') return 1;
      if (val === false || val === 'false' || val === 0 || val === '0') return 0;
      return val ? 1 : 0;
    }
    return val;
  };

  for (const key of Object.keys(incoming)) {
    if (!(key in colTypes)) continue;
    const casted = castValue(incoming[key], colTypes[key]);
    setFragments.push(`${key} = ?`);
    values.push(casted);
  }

  // Verifica que el usuario sea dueño de la propiedad
  const checkOwnerSql = `SELECT id FROM properties WHERE id = ? AND created_by = ?`;
  pool.query(checkOwnerSql, [id, req.user.id], (chkErr, chkRows) => {
    if (chkErr) return res.status(500).json({ error: 'Error de permisos' });
    if (chkRows.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Inicia operaciones sobre imágenes
    const doRemovals = (cb) => {
      if (!imagesRemove.length) return cb();
      const placeholders = imagesRemove.map(() => '?').join(',');
      const delSql = `
        DELETE FROM property_images
        WHERE property_id = ? AND image_url IN (${placeholders})
      `;
      pool.query(delSql, [id, ...imagesRemove], (delErr) => cb(delErr));
    };

    const doAdds = (cb) => {
      if (!imagesAdd.length) return cb();
      const values = imagesAdd.map(url => [id, url]);
      const insSql = `INSERT INTO property_images (property_id, image_url) VALUES ?`;
      pool.query(insSql, [values], (insErr) => cb(insErr));
    };

    // Ejecuta: borrar → agregar → update properties
    doRemovals((remErr) => {
      if (remErr) return res.status(500).json({ error: 'No se pudieron eliminar imágenes' });

      doAdds((addErr) => {
        if (addErr) return res.status(500).json({ error: 'No se pudieron agregar imágenes' });

        if (setFragments.length === 0) {
          // No hay update de properties, solo imágenes
          return res.json({ message: 'Actualizada (imágenes)', updatedFields: [] });
        }

        values.push(id, req.user.id);
        const sql = `
          UPDATE properties
          SET ${setFragments.join(', ')}
          WHERE id = ? AND created_by = ?
        `;
        pool.query(sql, values, (err, result) => {
          if (err) return res.status(500).json({ error: 'No se pudo actualizar', details: err });
          if (result.affectedRows === 0) return res.status(404).json({ error: 'Propiedad no encontrada o no autorizada' });
          res.json({
            message: 'Actualizada',
            updatedFields: setFragments.map(f => f.split('=')[0].trim()),
          });
        });
      });
    });
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
    SELECT p.*, 
      (SELECT image_url FROM property_images pi WHERE pi.property_id = p.id LIMIT 1) AS images
    FROM properties p
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
      console.log('get properties ping');
      res.json(results);
    }
  );
});

// Get property by id
app.get('/properties/:id', (req, res) => {
  const { id } = req.params;

  pool.query(
    `
      SELECT properties.*, users.name as owner_name 
      FROM properties
      JOIN users ON properties.created_by = users.id
      WHERE properties.id = ?
    `, 
    [id], 
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error al buscar la propiedad' });
      if (results.length === 0) return res.status(404).json({ error: 'No encontrada' });

      const property = results[0];

      // Ahora consulta las imágenes
      pool.query(
        `SELECT image_url FROM property_images WHERE property_id = ?`, 
        [id], 
        (imgErr, imgResults) => {
          if (imgErr) {
            console.error('Error fetching images:', imgErr);
            return res.json({ ...property, images: [] });
          }
          const images = imgResults.map(img => img.image_url);
          res.json({ ...property, images });
        }
      );
    }
  );
});

app.get('/my-properties', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const query = `
    SELECT 
      p.*, 
      (
        SELECT image_url 
        FROM property_images 
        WHERE property_id = p.id 
        ORDER BY id ASC 
        LIMIT 1
      ) AS images
    FROM properties p
    WHERE p.created_by = ?
    ORDER BY p.id DESC
  `;

  pool.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error getting user properties:', err);
      return res.status(500).json({ error: 'Error al obtener tus propiedades.' });
    }
    console.log('my properties endpoint ping');
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
  app.post('/users/register', async (req, res) => {
    const { name, last_name, email, password } = req.body;
    if (!name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const query = "INSERT INTO users (name, last_name, email, password, type) VALUES (?, ?, ?, ?, ?)";
      pool.query(query, [name, last_name, email, hashedPassword, 'regular'], (err, result) => {
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
            last_name, // <-- Agregado
            email, 
            type: 'regular'
          },
        });
        console.log('Usuario agregado correctamente');
      });
    } catch (error) {
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  });

// Register new agent
app.post('/agents/register', async (req, res) => {
  const { name, last_name, email, password, phone, license, work_start, work_end } = req.body;
  if (!name || !last_name || !email || !password || !work_start || !work_end) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (incluyendo horario laboral).' });
  }
  // Validar formato HH:mm
  const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!regex.test(work_start) || !regex.test(work_end)) {
    return res.status(400).json({ error: 'Horario laboral en formato inválido. Usa HH:mm.' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = `
      INSERT INTO users (name, last_name, email, password, phone, license, type, work_start, work_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    pool.query(query, [name, last_name, email, hashedPassword, phone, license, 'agente', work_start || null, work_end || null], (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: "El email ya existe" });
        }
        console.log(err);
        return res.status(500).json({ error: 'Error al registrar el usuario.', err });
      }
      const userId = result.insertId;
      const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET, {
      expiresIn: '3h',
      });
      res.status(201).json({
          message: 'Usuario registrado con éxito.',
          token,
          user: {
            id: userId,
            name,
            last_name,
            email,
            phone,
            license,
            type: 'agente',
            work_start: work_start || null,
            work_end: work_end || null
          },
        });
      console.log('Usuario agregado correctamente')
    });
  } catch (error) {
    console.log('error:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Actualizar horario laboral del agente (requiere token)
app.put('/agents/:id/work-schedule', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { work_start, work_end } = req.body;

  if (!work_start || !work_end) {
    return res.status(400).json({ error: 'Debes enviar ambos campos: work_start y work_end.' });
  }

  const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!regex.test(work_start) || !regex.test(work_end)) {
    return res.status(400).json({ error: 'Horario laboral en formato inválido. Usa HH:mm.' });
  }

  if (parseInt(id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado.' });
  }

  pool.query(
    'UPDATE users SET work_start = ?, work_end = ? WHERE id = ? AND type = "agente"',
    [work_start, work_end, id],
    (err, result) => {
      if (err) return res.status(500).json({ error: 'Error actualizando horario.' });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'No se actualizó (id no encontrado o no es agente).' });
      res.json({ message: 'Horario actualizado correctamente.' });
    }
  );
});

// Obtener horario laboral de un agente
app.get('/agents/:id', (req, res) => {
  const { id } = req.params;
  pool.query(
    'SELECT id, name, last_name, phone, work_start, work_end FROM users WHERE id = ? AND type = "agente" LIMIT 1',
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error al consultar el horario.' });
      if (!results.length) return res.status(404).json({ error: 'Agente no encontrado.' });
      res.json(results[0]);
    }
  );
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
      { expiresIn: '3h' }
    );

    res.json({
      message: 'Login exitoso.',
      token,
      user: {
        id: user.id,
        name: user.name,
        last_name: user.last_name,
        email: user.email,
        phone: user.phone ?? null, 
        user_type: user.type ?? null
      },
    });
  });
});

// Get user name (and optionally more data) by id
app.get('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  pool.query(
    'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error buscando usuario' });
      if (!results.length) return res.status(404).json({ error: 'No encontrado' });
      res.json(results[0]);
    }
  );
});

app.put('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { phone, email, password, work_start, work_end, name, last_name } = req.body;
  let updates = [];
  let values = [];

  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
  if (email !== undefined) { updates.push('email = ?'); values.push(email); }
  if (password !== undefined) {
    const hashedPassword = bcrypt.hashSync(password, 10);
    updates.push('password = ?');
    values.push(hashedPassword);
  }
  if (work_start !== undefined) { updates.push('work_start = ?'); values.push(work_start); }
  if (work_end !== undefined) { updates.push('work_end = ?'); values.push(work_end); }
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (last_name !== undefined) { updates.push('last_name = ?'); values.push(last_name); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(id);

  pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values,
    (err, results) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'No se pudo actualizar' });}
      pool.query(
        'SELECT id, name, last_name, email, phone, work_start, work_end FROM users WHERE id = ?', 
        [id], 
        (err2, rows) => {
          if (err2 || !rows[0]) return res.json({ message: 'Actualizado' });
          res.json(rows[0]);
        }
      );
    }
  );
});

  //  Auth endpoint
// Endpoint para validar token
app.get('/auth/validate', authenticateToken, (req, res) => {
  const { id, email, type } = req.user;
  const query = 'SELECT name, last_name, email, phone, type FROM users WHERE id = ? LIMIT 1';
  pool.query(query, [id], (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }
    const user = results[0];
    res.json({
      valid: true,
      id,
      name: user.name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      user_type: user.type,
    });
    console.log('auth: ', user);
  });
});

  // Buying Power endpoints

// POST: crear/actualizar buying power
app.post('/api/buying-power', authenticateToken, (req, res) => {
  const { 
    user_id,
    annual_income,
    down_payment,
    monthly_debt,
    monthly_target,
    annual_interest_rate, // DECIMAL(6,4) guardado como decimal (ej. 0.10 para 10%)
    loan_years,
    suggested_price       // DECIMAL(22,2)
  } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id es requerido' });
  }
  if (suggested_price === undefined || suggested_price === null) {
    return res.status(400).json({ error: 'suggested_price es requerido' });
  }

  const sql = `
    INSERT INTO buying_power
      (user_id, annual_income, down_payment, monthly_debt, monthly_target, annual_interest_rate, loan_years, suggested_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      annual_income       = VALUES(annual_income),
      down_payment        = VALUES(down_payment),
      monthly_debt        = VALUES(monthly_debt),
      monthly_target      = VALUES(monthly_target),
      annual_interest_rate= VALUES(annual_interest_rate),
      loan_years          = VALUES(loan_years),
      suggested_price     = VALUES(suggested_price),
      updated_at          = CURRENT_TIMESTAMP
  `;

  const params = [
    user_id,
    annual_income ?? null,
    down_payment ?? null,
    monthly_debt ?? null,
    monthly_target ?? null,
    annual_interest_rate ?? null,
    loan_years ?? null,
    suggested_price ?? null,
  ];

  pool.query(sql, params, (err) => {
    if (err) {
      console.error('Error guardando buying power:', err);
      return res.status(500).json({ error: 'Error guardando datos' });
    }
    res.json({ ok: true, message: 'Buying power guardado o actualizado' });
  });
});

// GET: obtener último buying power del usuario (incluye suggested_price y annual_interest_rate)
app.get('/api/buying-power/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;

  const sql = `
    SELECT *
    FROM buying_power
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `;

  pool.query(sql, [user_id], (err, rows) => {
    if (err) {
      console.error('Error consultando buying power:', err);
      return res.status(500).json({ error: 'Error consultando datos' });
    }
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  });
});

  // Chat socket.io endpoints

  io.on('connection', (socket) => {
    // Recibe el userId del usuario conectado
    socket.on('join', ({ userId }) => {
      if (userId) {
        socket.join('user_' + userId); // cada usuario en su sala única
      }
    });

    // Enviar mensaje
    socket.on('send_message', (data) => {
      // data = { sender_id, receiver_id, property_id, message }
      const { sender_id, receiver_id, property_id, message, file_url, file_name } = data;
      if (!sender_id || !receiver_id || (!message && !file_url)) return;

      // Guarda el mensaje en la BD
      const query = `
        INSERT INTO chat_messages (property_id, sender_id, receiver_id, message, file_url, file_name )
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      pool.query(query, [property_id || null, sender_id, receiver_id, message, file_url, file_name], (err, result) => {
        if (err) return;
        const msgObj = {
          id: result.insertId,
          property_id,
          sender_id,
          receiver_id,
          message,
          file_url,
          file_name,
          created_at: new Date().toISOString()
        };
        pool.query(
          `DELETE FROM hidden_chats
           WHERE user_id = ? AND chat_with_user_id = ? AND (property_id <=> ?)`,
          [receiver_id, sender_id, property_id ?? null],
          (err2) => {
            if (err2) {
              console.error('Error limpiando hidden_chats:', err2);
            }
          }
        );
        // Emite a ambos usuarios (receptor y emisor)
        io.to('user_' + sender_id).emit('receive_message', msgObj);
        io.to('user_' + receiver_id).emit('receive_message', msgObj);
      });

    // Eliminar mensaje
    socket.on('delete_message', ({ message_id, user_id }) => {
      if (!message_id || !user_id) return;
    
      const q = `
        SELECT sender_id, receiver_id, property_id
        FROM chat_messages
        WHERE id = ?
        LIMIT 1
      `;
      pool.query(q, [message_id], (err, rows) => {
        if (err || !rows.length) return;
        const msg = rows[0];
    
        // autoriza solo participantes
        if (String(msg.sender_id) !== String(user_id) &&
            String(msg.receiver_id) !== String(user_id)) {
          return;
        }
    
        pool.query(
          'UPDATE chat_messages SET is_deleted = 1 WHERE id = ?',
          [message_id],
          (updErr) => {
            if (updErr) return;
    
            // notifica a ambos
            io.to('user_' + msg.sender_id).emit('message_deleted', { message_id });
            io.to('user_' + msg.receiver_id).emit('message_deleted', { message_id });
          }
        );
      });
    });
  });
});



// GET Cargar historial entre dos usuarios y por propiedad
app.get('/api/chat/messages', authenticateToken, (req, res) => {
  const { user_id, property_id } = req.query;
  const me = req.user.id;
  if (!user_id) return res.status(400).json({ error: 'Faltan campos' });

  let query = `
  SELECT *
  FROM chat_messages
  WHERE is_deleted = 0
    AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
  `;
  const params = [me, user_id, user_id, me];
  if (property_id) {
    query += ' AND property_id = ?';
    params.push(property_id);
  }
  query += ' ORDER BY created_at ASC';

  // Marca los mensajes recibidos como leídos
  const markAsRead = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ? AND sender_id = ? AND (property_id = ? OR ? IS NULL)
  `;

  pool.query(query, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'No se pudo obtener los mensajes' });

    // Marcar como leídos solo si hay property_id (ajusta según tu lógica)
    pool.query(markAsRead, [me, user_id, property_id || null, property_id || null], (err2) => {
      // No importa si hay error aquí para mostrar mensajes
      res.json(results);
    });
  });
});

// GET Lista de conversaciones del usuario (resumen, no historial completo)
app.get('/api/chat/my-chats', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT
      t.chat_with_user_id,
      u.name AS chat_with_user_name,
      u.last_name AS chat_with_user_last_name,
      t.property_id,
      p.address AS property_address,
      p.price        AS property_price,
      p.monthly_pay  AS property_monthly_pay,
      p.type         AS property_type,
      cm.created_at  AS last_message_at,
      cm.message     AS last_message,
      (
        SELECT COUNT(*)
        FROM chat_messages m
        WHERE m.sender_id = t.chat_with_user_id
          AND m.receiver_id = ?
          AND (m.property_id <=> t.property_id)
          AND m.is_read = 0
          AND m.is_deleted = 0
      ) AS unread_count
    FROM (
      SELECT
        IF(sender_id = ?, receiver_id, sender_id) AS chat_with_user_id,
        property_id,
        MAX(id) AS last_msg_id
      FROM chat_messages
      WHERE (sender_id = ? OR receiver_id = ?)
        AND is_deleted = 0
      GROUP BY chat_with_user_id, property_id
    ) t
    JOIN chat_messages cm ON cm.id = t.last_msg_id
    JOIN users u          ON u.id = t.chat_with_user_id
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN hidden_chats h
      ON h.user_id = ?
     AND h.chat_with_user_id = t.chat_with_user_id
     AND (h.property_id <=> t.property_id)
    WHERE h.user_id IS NULL
    ORDER BY cm.created_at DESC
  `;

  // Orden: (1) unread_count.receiver_id, (2) IF(...), (3) WHERE sender_id, (4) WHERE receiver_id, (5) h.user_id
  const params = [userId, userId, userId, userId, userId];

  pool.query(sql, params, (err, rows) => {
    if (err) {
      console.error('Error en my-chats:', err);
      return res.status(500).json({ error: 'Error fetching chats' });
    }
    res.json(rows);
  });
});

// Ocultar chat SOLO para el usuario actual
app.post('/api/chat/hide-chat', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { chat_with_user_id, property_id } = req.body;
  if (!chat_with_user_id) return res.status(400).json({ error: 'Faltan campos' });

  const sql = `
    INSERT INTO hidden_chats (user_id, chat_with_user_id, property_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE hidden_at = CURRENT_TIMESTAMP
  `;
  const params = [userId, chat_with_user_id, property_id ?? null];

  pool.query(sql, params, (err, result) => {
    if (err) {
      console.error('[hide-chat] INSERT error:', err, { params });
      return res.status(500).json({ error: 'No se pudo ocultar' });
    }
    console.log('[hide-chat] ok', { params, insertId: result.insertId });
    res.json({ ok: true });
  });
});


// PUT: Marcar mensajes como leídos
app.put('/api/chat/mark-read', authenticateToken, (req, res) => {
  const { user_id, chat_with_user_id, property_id } = req.body;
  if (!user_id || !chat_with_user_id) return res.status(400).json({ error: 'Faltan campos' });
  let query = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ?
      AND sender_id = ?
  `;
  const params = [user_id, chat_with_user_id];
  if (property_id) {
    query += ' AND property_id = ?';
    params.push(property_id);
  } else {
    query += ' AND property_id IS NULL';
  }
  pool.query(query, params, (err, result) => {
    if (err) return res.status(500).json({ error: 'No se pudo marcar como leído' });
    res.json({ ok: true });
  });
});

app.delete('/api/chat/delete-chat', authenticateToken, (req, res) => {
  const { user_id, chat_with_user_id, property_id } = req.body;
  if (!user_id || !chat_with_user_id || !property_id) {
    return res.status(400).json({ error: 'Faltan campos' });
  }
  const query = `
    DELETE FROM chat_messages
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND property_id = ?
  `;
  const params = [user_id, chat_with_user_id, chat_with_user_id, user_id, property_id];
  pool.query(query, params, (err, result) => {
    if (err) {
      console.error('Error eliminando chat:', err);
      return res.status(500).json({ error: 'Error eliminando chat' });
    }
    res.json({ ok: true, deleted: result.affectedRows });
  });
});

// Tenant profile Endpoints

// POST Crear o actualizar perfil de rentero
app.post('/api/tenant-profile', authenticateToken, (req, res) => {
  const user_id = req.user.id;
  const {
    preferred_move_date,
    preferred_contract_duration,
    estimated_monthly_income,
    has_guarantor,
    guarantor_has_own_home,
    family_size,
    has_pets,
    pets_count
  } = req.body;

  // Permite valores null (enviados como undefined del frontend)
  const query = `
    INSERT INTO tenant_profiles (
      user_id, preferred_move_date, preferred_contract_duration,
      estimated_monthly_income, has_guarantor, guarantor_has_own_home,
      family_size, has_pets, pets_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      preferred_move_date = VALUES(preferred_move_date),
      preferred_contract_duration = VALUES(preferred_contract_duration),
      estimated_monthly_income = VALUES(estimated_monthly_income),
      has_guarantor = VALUES(has_guarantor),
      guarantor_has_own_home = VALUES(guarantor_has_own_home),
      family_size = VALUES(family_size),
      has_pets = VALUES(has_pets),
      pets_count = VALUES(pets_count),
      updated_at = CURRENT_TIMESTAMP
  `;

  pool.query(query, [
    user_id,
    preferred_move_date || null,
    preferred_contract_duration || null,
    estimated_monthly_income || null,
    has_guarantor ? 1 : 0,
    guarantor_has_own_home ? 1 : 0,
    family_size || null,
    has_pets ? 1 : 0,
    pets_count || null
  ], (err, result) => {
    if (err) {
      console.error('Error guardando tenant profile:', err);
      return res.status(500).json({ error: 'Error guardando perfil de rentero' });
    }
    res.json({ ok: true, message: 'Perfil guardado correctamente' });
  });
});

app.get('/api/tenant-profile/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;
  pool.query(
    'SELECT * FROM tenant_profiles WHERE user_id = ? LIMIT 1',
    [user_id],
    (err, results) => {
      if (err) {
        console.error('Error consultando tenant profile:', err);
        return res.status(500).json({ error: 'Error consultando perfil' });
      }
      if (!results.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      console.log('results: ', results);
      res.json(results[0]);
    }
  );
});

// PUT: Actualizar cualquier campo del perfil de rentero del usuario autenticado
app.put('/api/tenant-profile/:id', authenticateToken, (req, res) => {
  const { id } = req.params;  // Este es el id del registro en tenant_profiles
  const user_id = req.user.id;
  const {
    preferred_move_date,
    preferred_contract_duration,
    estimated_monthly_income,
    has_guarantor,
    guarantor_has_own_home,
    family_size,
    has_pets,
    pets_count
  } = req.body;

  // Junta solo los campos enviados
  const updates = [];
  const values = [];

  if (preferred_move_date !== undefined) {
    updates.push('preferred_move_date = ?');
    values.push(preferred_move_date || null);
  }
  if (preferred_contract_duration !== undefined) {
    updates.push('preferred_contract_duration = ?');
    values.push(preferred_contract_duration || null);
  }
  if (estimated_monthly_income !== undefined) {
    updates.push('estimated_monthly_income = ?');
    values.push(estimated_monthly_income || null);
  }
  if (has_guarantor !== undefined) {
    updates.push('has_guarantor = ?');
    values.push(has_guarantor ? 1 : 0);
  }
  if (guarantor_has_own_home !== undefined) {
    updates.push('guarantor_has_own_home = ?');
    values.push(guarantor_has_own_home ? 1 : 0);
  }
  if (family_size !== undefined) {
    updates.push('family_size = ?');
    values.push(family_size || null);
  }
  if (has_pets !== undefined) {
    updates.push('has_pets = ?');
    values.push(has_pets ? 1 : 0);
  }
  if (pets_count !== undefined) {
    updates.push('pets_count = ?');
    values.push(pets_count || null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No se enviaron campos para actualizar' });
  }

  values.push(id, user_id);

  // Verifica que el perfil pertenezca al usuario autenticado
  const query = `
    UPDATE tenant_profiles
    SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `;

  pool.query(query, values, (err, result) => {
    if (err) {
      console.error('Error actualizando tenant profile:', err);
      return res.status(500).json({ error: 'Error actualizando perfil de rentero' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Perfil de rentero no encontrado o no autorizado' });
    }
    res.json({ ok: true, message: 'Perfil actualizado correctamente' });
  });
});
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
const port = 3000;
const dbPassword = process.env.DB_KEY;

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
    const { sender_id, receiver_id, property_id, message } = data;
    if (!sender_id || !receiver_id || !message) return;

    // Guarda el mensaje en la BD
    const query = `
      INSERT INTO chat_messages (property_id, sender_id, receiver_id, message)
      VALUES (?, ?, ?, ?)
    `;
    pool.query(query, [property_id || null, sender_id, receiver_id, message], (err, result) => {
      if (err) return;
      const msgObj = {
        id: result.insertId,
        property_id,
        sender_id,
        receiver_id,
        message,
        created_at: new Date()
      };
      // Emite a ambos usuarios (receptor y emisor)
      io.to('user_' + sender_id).emit('receive_message', msgObj);
      io.to('user_' + receiver_id).emit('receive_message', msgObj);
    });
  });
});

// GET Cargar historial entre dos usuarios y opcional por propiedad
app.get('/api/chat/messages', authenticateToken, (req, res) => {
  const { user_id, property_id } = req.query;
  const me = req.user.id;
  if (!user_id) return res.status(400).json({ error: 'Faltan campos' });

  let query = `
    SELECT * FROM chat_messages
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
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
  if (!userId) return res.status(400).json({ error: 'Falta user_id' });

  const query = `
    SELECT
        t.chat_with_user_id,
        u.name AS chat_with_user_name,
        t.property_id,
        p.address AS property_address,
        p.price AS property_price,
        p.monthly_pay AS property_monthly_pay,   -- agrega este
        p.type AS property_type,
        t.last_message_at,
        t.last_message,
        (
          SELECT COUNT(*) FROM chat_messages m
          WHERE m.sender_id = t.chat_with_user_id
            AND m.receiver_id = ?
            AND (m.property_id = t.property_id OR (m.property_id IS NULL AND t.property_id IS NULL))
            AND m.is_read = 0
        ) AS unread_count
    FROM (
        SELECT
            IF(sender_id = ?, receiver_id, sender_id) AS chat_with_user_id,
            property_id,
            MAX(created_at) AS last_message_at,
            SUBSTRING_INDEX(GROUP_CONCAT(message ORDER BY created_at DESC), ',', 1) AS last_message
        FROM chat_messages
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY chat_with_user_id, property_id
    ) t
    JOIN users u ON u.id = t.chat_with_user_id
    LEFT JOIN properties p ON t.property_id = p.id
    ORDER BY t.last_message_at DESC
    `;

  const params = [userId, userId, userId, userId];

  pool.query(query, params, (err, results) => {
    if (err) {
      console.error('Error en my-chats:', err);
      return res.status(500).json({ error: 'Error fetching chats' });
    }
    res.json(results);
  });
});

// PUT: Marcar mensajes como leídos
app.put('/api/chat/mark-read', authenticateToken, (req, res) => {
  console.log('removing...');
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
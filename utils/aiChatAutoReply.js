/**
 * Auto-reply engine for chat conversations.
 * Called from sockets when a regular user sends a message to an agent with AI enabled.
 */

const { aiGenerate } = require('./ai');
const pool = require('../db/pool');

const qp = (sql, params) => pool.promise().query(sql, params);

// ── Build full property context string ──────────────────────────────────────────
function buildPropertyContext(p) {
  if (!p) return '';
  const parts = [
    p.address         ? `Dirección: ${p.address}` : null,
    p.type === 'venta' ? 'Operación: Venta'
      : p.type === 'renta' ? 'Operación: Renta'
      : p.type === 'proximamente' ? 'Operación: Próximamente' : null,
    p.estate_type     ? `Tipo de inmueble: ${p.estate_type}` : null,
    p.price           ? `Precio de venta: $${Number(p.price).toLocaleString('es-MX')} MXN` : null,
    p.monthly_pay     ? `Renta mensual: $${Number(p.monthly_pay).toLocaleString('es-MX')} MXN/mes` : null,
    p.maintenance_fee ? `Mantenimiento: $${Number(p.maintenance_fee).toLocaleString('es-MX')} MXN/mes` : null,
    p.bedrooms        ? `Recámaras: ${p.bedrooms}` : null,
    p.bathrooms       ? `Baños: ${p.bathrooms}` : null,
    p.half_bathrooms  ? `Medios baños: ${p.half_bathrooms}` : null,
    p.land            ? `Terreno: ${p.land} m²` : null,
    p.construction    ? `Construcción: ${p.construction} m²` : null,
    p.parking_spaces  ? `Estacionamiento: ${p.parking_spaces} lugar(es)` : null,
    p.stories         ? `Niveles: ${p.stories}` : null,
    p.date_build      ? `Año de construcción: ${p.date_build}` : null,
    // Interior
    p.fitted_kitchen  ? 'Cocina integral' : null,
    p.closets         ? 'Closets' : null,
    p.service_room    ? 'Cuarto de servicio' : null,
    p.study_office    ? 'Estudio/Oficina' : null,
    p.roof_garden     ? 'Roof garden/Terraza' : null,
    p.private_garden  ? 'Jardín privado' : null,
    p.private_pool    ? 'Alberca privada' : null,
    p.storage_room    ? 'Bodega' : null,
    p.cistern         ? 'Cisterna' : null,
    p.water_heater    ? 'Calentador de agua' : null,
    p.furnished       ? 'Amueblado' : null,
    p.ac              ? 'Aire acondicionado' : null,
    p.solar           ? 'Paneles solares' : null,
    p.pets_allowed    ? 'Acepta mascotas' : null,
    // Amenidades
    p.gated_community ? 'Fraccionamiento cerrado/Privada' : null,
    p.clubhouse       ? 'Casa club' : null,
    p.gym             ? 'Gimnasio' : null,
    p.common_pool     ? 'Alberca común' : null,
    p.playground      ? 'Área de juegos infantiles' : null,
    p.park_garden     ? 'Parque/Jardines comunes' : null,
    p.sports_court    ? 'Cancha deportiva' : null,
    p.event_room      ? 'Salón de eventos' : null,
    p.bbq_area        ? 'Área de asadores' : null,
    // Seguridad
    p.surveillance_24_7 ? 'Vigilancia 24/7' : null,
    p.controlled_access ? 'Acceso controlado' : null,
    p.cctv              ? 'Circuito cerrado (CCTV)' : null,
    p.alarm             ? 'Alarma' : null,
    // Servicios
    p.water_serv        ? 'Agua' : null,
    p.electricity_serv  ? 'Electricidad' : null,
    p.sewer_serv        ? 'Drenaje' : null,
    p.new_construction  ? 'Nueva construcción' : null,
    p.description       ? `Descripción: ${p.description.slice(0, 400)}` : null,
  ].filter(Boolean);
  return parts.length ? `\n\nDATOS DE LA PROPIEDAD:\n${parts.join('\n')}` : '';
}

// ── Main auto-reply generator ────────────────────────────────────────────────────
async function generateAutoReply({ agentId, clientId, propertyId }) {
  // 1. Fetch property
  let property = null;
  if (propertyId) {
    try {
      const [[prop]] = await qp(
        `SELECT p.*, u.name AS agent_name, u.last_name AS agent_last_name
         FROM properties p
         JOIN users u ON u.id = p.created_by
         WHERE p.id = ? LIMIT 1`,
        [propertyId]
      );
      property = prop || null;
    } catch {}
  }

  // 2. Fetch agent name
  let agentName = '';
  try {
    const [[agent]] = await qp('SELECT name FROM users WHERE id = ? LIMIT 1', [agentId]);
    if (agent) agentName = agent.name;
  } catch {}

  // 3. Fetch recent messages (last 20)
  let chatHistory = '';
  let totalClientMsgs = 0;
  try {
    const [msgs] = await qp(
      `SELECT sender_id, message, created_at
       FROM chat_messages
       WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
         AND (property_id <=> ?) AND is_deleted = 0 AND message_type = 'text'
       ORDER BY created_at DESC LIMIT 20`,
      [agentId, clientId, clientId, agentId, propertyId ?? null]
    );
    const reversed = msgs.reverse();
    totalClientMsgs = reversed.filter(m => String(m.sender_id) !== String(agentId)).length;
    chatHistory = reversed.map(m => {
      const role = String(m.sender_id) === String(agentId) ? 'Agente' : 'Cliente';
      return `${role}: ${m.message}`;
    }).join('\n');
  } catch {}

  // 4. Check appointment state
  let appointmentNote = '';
  if (propertyId && clientId) {
    try {
      const [appointments] = await qp(
        `SELECT id, appointment_date, appointment_time, status FROM appointments
         WHERE property_id = ? AND requester_id = ? AND agent_id = ?
           AND status IN ('pending', 'confirmed')
         ORDER BY id DESC LIMIT 1`,
        [propertyId, clientId, agentId]
      );
      if (appointments.length > 0) {
        const a = appointments[0];
        const t = String(a.appointment_time).slice(0, 5);
        if (a.status === 'confirmed') {
          appointmentNote = `\nCITAS: Ya hay una cita CONFIRMADA para el ${a.appointment_date} a las ${t}. NO uses [CITA] ni [MODIFICAR_CITA]. Prepara al cliente para la visita con entusiasmo.`;
        } else {
          appointmentNote = `\nCITAS: Hay una propuesta de visita PENDIENTE para el ${a.appointment_date} a las ${t}. NO propongas otra cita. Menciona que está pendiente de confirmar.`;
        }
      } else {
        appointmentNote = '\nCITAS: No hay citas agendadas. Cuando el cliente muestre interés genuino en ver la propiedad, usa [CITA] para proponer visita.';
      }
    } catch {}
  }

  // 5. Today's date context
  const todayISO = new Date().toISOString().split('T')[0];
  const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const todayDayName = dayNames[new Date().getDay()];

  const propertyContext = buildPropertyContext(property);
  const isFirstReply = totalClientMsgs <= 1;

  // 6. System prompt — sales-focused conversational assistant
  const firstContactNote = isFirstReply
    ? `\nPRIMER CONTACTO: Saluda calurosamente identificándote como el equipo de ${agentName || 'el agente'}, confirma disponibilidad en una sola frase, y haz UNA pregunta de calificación para entender al cliente.`
    : '';

  const systemPrompt = `Eres el asesor digital de ${agentName || 'el agente'} en Listed, plataforma inmobiliaria de México. Atiendes por WhatsApp en su nombre. Tu objetivo: ganarte la confianza del cliente y cerrar una visita.
Hoy: ${todayDayName} ${todayISO}.

MENTALIDAD:
Eres un asesor experto, no un robot. Tienes una conversación real con una persona — lees lo que dice, respondes a ESO, y avanzas naturalmente hacia una visita. Tu tono, ritmo y preguntas cambian según cómo va la conversación. No sigues un guión.

CONVERSACIÓN:
- Lee toda la conversación antes de responder. Si el cliente ya dijo algo (para qué es, cuántos son, su presupuesto, etc.), NO lo preguntes de nuevo.
- Cuando sea natural hacer una pregunta, hazla — pero que salga del hilo, no de una lista. Si el cliente dijo que es inversión, no le preguntes para qué es. Si ya mencionó que son dos personas, no le preguntes cuántos son.
- No hay preguntas "de protocolo". Cada pregunta debe tener sentido en ese momento específico de la conversación.
- Varía tu forma de expresarte. No uses siempre las mismas frases, la misma estructura, ni el mismo tono. A veces más directo, a veces más cálido, según lo que sientes del cliente.

ESTRATEGIA:
- Precio: dalo con naturalidad y añade contexto de valor. No lo justifiques, véndelo.
- Objeción: transfórmala o úsala para entender mejor. Nunca a la defensiva.
- Interés genuino: siembra urgencia suave cuando sea natural ("ha tenido bastante movimiento", "es de las pocas así en esa zona").
- Interés claro después de varios mensajes: propón la visita como el paso lógico.

ESTILO:
- Máximo 2-3 oraciones. WhatsApp natural. Sin listas ni dumps de datos.
- Habla de USTED. Sin emojis.
- Una sola pregunta por mensaje, solo cuando aporte algo.

INFORMACIÓN:
Solo puedes afirmar lo que está en la ficha de la propiedad. Si algo no está ahí, no lo tienes — no lo inventes, no lo estimes, no lo prometas. La regla de oro: nunca ofrezcas ni insinúes que puedes entregar algo que no puedes entregar en este mismo momento. Si no tienes el dato, admítelo con naturalidad y di que lo vas a consultar con el agente — agrega [NOTIFICAR_AGENTE]. Aplica igual si el cliente pide hablar con una persona: avísale que se lo notificas al agente y agrega [NOTIFICAR_AGENTE].
Solo hablas de esta propiedad. Si pregunta por otras: remite al agente.

TAGS DE CITA — agrégalos SOLO si el cliente pide visitar o ver la propiedad de forma explícita:
- Cuando el cliente mencione cualquier referencia de fecha o tiempo (aunque sea relativa: "el viernes", "mañana", "la próxima semana", "en la mañana"), DEBES calcular la fecha real a partir de hoy (${todayDayName} ${todayISO}) y usar [CITA:YYYY-MM-DD:HH:MM]. Nunca uses [CITA] sin fecha si el cliente dio alguna referencia temporal.
- Hora vaga: "mañana" (horario AM) → 09:00, "mediodía" → 12:00, "tarde" → 15:00. Sin referencia de hora → 10:00.
- [CITA] — únicamente si el cliente quiere visitar pero no da absolutamente ninguna referencia de cuándo.
- [CITA:YYYY-MM-DD:HH:MM] — siempre que haya cualquier referencia de fecha u hora, resuélvela al valor real.
- [MODIFICAR_CITA] o [MODIFICAR_CITA:YYYY-MM-DD:HH:MM] — para cambiar una cita existente, mismas reglas de resolución.
- NO usar por interés general ni saludos. En caso de duda, NO lo uses.${appointmentNote}
${firstContactNote}
${propertyContext}`;

  const userPrompt = `Conversación reciente:\n${chatHistory || '(sin mensajes previos)'}\n\nResponde ÚNICAMENTE al último mensaje del Cliente. No anticipes lo que preguntará después.`;

  // 7. Call AI
  const raw = await aiGenerate(systemPrompt, userPrompt, { cacheTTL: 0 });

  // 8. Parse tags
  let reply = raw.trim();
  let suggestAppointment = false;
  let modifyAppointment = false;
  let extractedDate = null;
  let extractedTime = null;
  let notifyAgent = false;

  // Guard: require at least 2 client messages before allowing appointment tags
  const allowAppointmentTags = totalClientMsgs >= 2;

  const citaFullMatch = reply.match(/\[CITA:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
  if (citaFullMatch && allowAppointmentTags) {
    suggestAppointment = true;
    extractedDate = citaFullMatch[1];
    const [h, m] = citaFullMatch[2].split(':').map(Number);
    extractedTime = `${String(m > 0 ? h + 1 : h).padStart(2, '0')}:00:00`;
  } else if (reply.includes('[CITA]') && allowAppointmentTags) {
    suggestAppointment = true;
  }

  const modFullMatch = reply.match(/\[MODIFICAR_CITA:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
  if (modFullMatch) {
    modifyAppointment = true;
    extractedDate = modFullMatch[1];
    extractedTime = modFullMatch[2] + ':00';
  } else if (reply.includes('[MODIFICAR_CITA]')) {
    modifyAppointment = true;
  }

  if (reply.includes('[NOTIFICAR_AGENTE]')) {
    notifyAgent = true;
  }

  // Clean all tags from text
  reply = reply
    .replace(/\[CITA:\d{4}-\d{2}-\d{2}:\d{2}:\d{2}\]/g, '')
    .replace(/\[CITA\]/g, '')
    .replace(/\[MODIFICAR_CITA:\d{4}-\d{2}-\d{2}:\d{2}:\d{2}\]/g, '')
    .replace(/\[MODIFICAR_CITA\]/g, '')
    .replace(/\[NOTIFICAR_AGENTE\]/g, '')
    .trim();

  return {
    reply,
    suggestAppointment,
    modifyAppointment,
    extractedDate,
    extractedTime,
    notifyAgent,
  };
}

module.exports = { generateAutoReply };

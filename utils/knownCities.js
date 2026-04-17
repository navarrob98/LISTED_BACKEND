// Réplica de listed/utils/mexicoCities.ts para el backend.
// Usado para detectar queries de ciudades y cachearlas permanentemente en Redis.

const mexicoCities = {
  "Aguascalientes": {
    state: "Aguascalientes",
    cities: ["Aguascalientes", "Calvillo", "Jesús María", "Pabellón de Arteaga", "Rincón de Romos", "San Francisco de los Romo"]
  },
  "Baja California": {
    state: "Baja California",
    cities: ["Tijuana", "Mexicali", "Ensenada", "Rosarito", "Tecate", "San Felipe", "San Quintín"]
  },
  "Baja California Sur": {
    state: "Baja California Sur",
    cities: ["La Paz", "Cabo San Lucas", "San José del Cabo", "Loreto", "Ciudad Constitución", "Guerrero Negro", "Todos Santos"]
  },
  "Campeche": {
    state: "Campeche",
    cities: ["Campeche", "Ciudad del Carmen", "Champotón", "Escárcega", "Calkiní"]
  },
  "Chiapas": {
    state: "Chiapas",
    cities: ["Tuxtla Gutiérrez", "San Cristóbal de las Casas", "Tapachula", "Comitán", "Palenque", "Chiapa de Corzo", "Tonalá"]
  },
  "Chihuahua": {
    state: "Chihuahua",
    cities: ["Chihuahua", "Ciudad Juárez", "Cuauhtémoc", "Delicias", "Parral", "Nuevo Casas Grandes", "Camargo"]
  },
  "Coahuila": {
    state: "Coahuila",
    cities: ["Saltillo", "Torreón", "Monclova", "Piedras Negras", "Acuña", "Sabinas", "Parras"]
  },
  "Colima": {
    state: "Colima",
    cities: ["Colima", "Manzanillo", "Tecomán", "Villa de Álvarez", "Armería"]
  },
  "CDMX": {
    state: "Ciudad de México",
    cities: ["Ciudad de México", "CDMX"]
  },
  "Durango": {
    state: "Durango",
    cities: ["Durango", "Gómez Palacio", "Lerdo", "Santiago Papasquiaro", "Guadalupe Victoria"]
  },
  "Guanajuato": {
    state: "Guanajuato",
    cities: ["León", "Irapuato", "Celaya", "Salamanca", "Guanajuato", "San Miguel de Allende", "Pénjamo", "Valle de Santiago", "Silao", "Dolores Hidalgo"]
  },
  "Guerrero": {
    state: "Guerrero",
    cities: ["Acapulco", "Chilpancingo", "Iguala", "Zihuatanejo", "Taxco", "Chilapa", "Tlapa"]
  },
  "Hidalgo": {
    state: "Hidalgo",
    cities: ["Pachuca", "Tulancingo", "Tizayuca", "Tula", "Huejutla", "Ixmiquilpan", "Actopan"]
  },
  "Jalisco": {
    state: "Jalisco",
    cities: ["Guadalajara", "Zapopan", "Tlaquepaque", "Tonalá", "Puerto Vallarta", "Tlajomulco", "Lagos de Moreno", "Tepatitlán", "Chapala", "Tequila"]
  },
  "México": {
    state: "Estado de México",
    cities: ["Toluca", "Ecatepec", "Nezahualcóyotl", "Naucalpan", "Tlalnepantla", "Cuautitlán Izcalli", "Texcoco", "Atizapán", "Chalco", "Valle de Chalco"]
  },
  "Michoacán": {
    state: "Michoacán",
    cities: ["Morelia", "Uruapan", "Zamora", "Lázaro Cárdenas", "Pátzcuaro", "Apatzingán", "Zitácuaro", "La Piedad"]
  },
  "Morelos": {
    state: "Morelos",
    cities: ["Cuernavaca", "Jiutepec", "Cuautla", "Temixco", "Yautepec", "Jojutla"]
  },
  "Nayarit": {
    state: "Nayarit",
    cities: ["Tepic", "Bahía de Banderas", "Xalisco", "Compostela", "Ixtlán del Río", "San Blas"]
  },
  "Nuevo León": {
    state: "Nuevo León",
    cities: ["Monterrey", "Guadalupe", "San Nicolás de los Garza", "Apodaca", "Santa Catarina", "San Pedro Garza García", "Escobedo", "García", "Cadereyta"]
  },
  "Oaxaca": {
    state: "Oaxaca",
    cities: ["Oaxaca", "Salina Cruz", "Tuxtepec", "Juchitán", "Huajuapan", "Puerto Escondido", "Tehuantepec"]
  },
  "Puebla": {
    state: "Puebla",
    cities: ["Puebla", "Tehuacán", "San Martín Texmelucan", "Atlixco", "Cholula", "Cuautlancingo", "Teziutlán"]
  },
  "Querétaro": {
    state: "Querétaro",
    cities: ["Querétaro", "San Juan del Río", "Corregidora", "El Marqués", "Tequisquiapan", "Cadereyta"]
  },
  "Quintana Roo": {
    state: "Quintana Roo",
    cities: ["Cancún", "Playa del Carmen", "Chetumal", "Cozumel", "Tulum", "Isla Mujeres", "Bacalar"]
  },
  "San Luis Potosí": {
    state: "San Luis Potosí",
    cities: ["San Luis Potosí", "Soledad de Graciano Sánchez", "Ciudad Valles", "Matehuala", "Rioverde", "Tamazunchale"]
  },
  "Sinaloa": {
    state: "Sinaloa",
    cities: ["Culiacán", "Mazatlán", "Los Mochis", "Guasave", "Guamúchil", "Navolato", "El Fuerte"]
  },
  "Sonora": {
    state: "Sonora",
    cities: ["Hermosillo", "Ciudad Obregón", "Nogales", "San Luis Río Colorado", "Navojoa", "Guaymas", "Caborca", "Puerto Peñasco"]
  },
  "Tabasco": {
    state: "Tabasco",
    cities: ["Villahermosa", "Cárdenas", "Comalcalco", "Huimanguillo", "Macuspana", "Paraíso"]
  },
  "Tamaulipas": {
    state: "Tamaulipas",
    cities: ["Reynosa", "Matamoros", "Nuevo Laredo", "Tampico", "Ciudad Victoria", "Ciudad Madero", "Altamira", "Ciudad Mante"]
  },
  "Tlaxcala": {
    state: "Tlaxcala",
    cities: ["Tlaxcala", "Apizaco", "Huamantla", "San Pablo del Monte", "Chiautempan"]
  },
  "Veracruz": {
    state: "Veracruz",
    cities: ["Veracruz", "Xalapa", "Coatzacoalcos", "Poza Rica", "Córdoba", "Minatitlán", "Orizaba", "Boca del Río", "Tuxpan", "Papantla"]
  },
  "Yucatán": {
    state: "Yucatán",
    cities: ["Mérida", "Valladolid", "Progreso", "Tizimín", "Ticul", "Motul"]
  },
  "Zacatecas": {
    state: "Zacatecas",
    cities: ["Zacatecas", "Fresnillo", "Guadalupe", "Jerez", "Río Grande", "Sombrerete"]
  }
};

// Normaliza: lowercase, strip accents
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Construye Set de todas las ciudades + estados normalizados
const KNOWN_SET = new Set();
for (const stateData of Object.values(mexicoCities)) {
  KNOWN_SET.add(normalize(stateData.state));
  for (const city of stateData.cities) {
    KNOWN_SET.add(normalize(city));
  }
}

// Checa si un input (posiblemente con ", Mexico" al final) es una ciudad conocida
function isKnownCity(input) {
  const cleaned = normalize(input)
    .replace(/,?\s*(mexico|méxico)\s*$/i, '')
    .trim();
  return KNOWN_SET.has(cleaned);
}

// Devuelve el nombre limpio normalizado (para usarlo como cache key)
function normalizeCityKey(input) {
  return normalize(input)
    .replace(/,?\s*(mexico|méxico)\s*$/i, '')
    .trim();
}

module.exports = { isKnownCity, normalizeCityKey, mexicoCities };

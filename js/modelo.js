/**
 * Modelo físico simplificado del microclima del invernadero de orquídeas.
 *
 * Es un módulo ES puro (sin DOM) para que pueda ejecutarse tanto en el
 * navegador (simulador en GitHub Pages) como en Node.js (pruebas automatizadas).
 *
 * Puntos de ajuste del caso: humedad relativa ≈ 80 % y temperatura 18 °C – 24 °C
 * (noche – día).
 */

/** Escenarios que el operador del simulador puede forzar. */
export const ESCENARIOS = {
  normal: {
    nombre: 'Operación normal',
    descripcion: 'Clima controlado dentro de los puntos de ajuste óptimos.',
    dT: 0, dH: 0, inestabilidad: 0
  },
  ola_calor: {
    nombre: 'Ola de calor',
    descripcion: 'Radiación intensa: la temperatura sube y la humedad cae.',
    dT: 7, dH: -12, inestabilidad: 0.2
  },
  noche_fria: {
    nombre: 'Helada nocturna',
    descripcion: 'Falla de calefacción: temperatura bajo el mínimo.',
    dT: -6, dH: 4, inestabilidad: 0.1
  },
  ambiente_seco: {
    nombre: 'Ambiente seco',
    descripcion: 'Ventilación excesiva / humidificador apagado.',
    dT: 1, dH: -20, inestabilidad: 0.15
  },
  exceso_humedad: {
    nombre: 'Exceso de humedad',
    descripcion: 'Riesgo de hongos: humedad sobre el máximo.',
    dT: -1, dH: 14, inestabilidad: 0.1
  },
  falla_climatizacion: {
    nombre: 'Falla de climatización',
    descripcion: 'Control inestable: oscilaciones amplias.',
    dT: 3, dH: -6, inestabilidad: 1.2
  }
};

export const FALLAS = {
  ninguna: 'Sin falla',
  congelada: 'Lectura congelada',
  erratica: 'Valores erráticos',
  intermitente: 'Conexión intermitente'
};

export const CONDICIONES_POR_DEFECTO = {
  humedadObjetivo: 80,
  humedadMin: 70,
  humedadMax: 90,
  temperaturaNoche: 18,
  temperaturaDia: 24,
  horaInicioDia: 7,
  horaInicioNoche: 19
};

/** PRNG determinista (mulberry32) para pruebas reproducibles. */
export function crearAleatorio(semilla = Date.now()) {
  let a = semilla >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Número con distribución normal estándar (Box-Muller). */
export function gaussiano(rand = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export const limitar = (v, min, max) => Math.min(max, Math.max(min, v));
export const redondear = (v, dec = 1) => Math.round(v * 10 ** dec) / 10 ** dec;

/** Hora decimal local (ej. 14.5 = 14:30). */
export function horaDecimal(fecha) {
  return fecha.getHours() + fecha.getMinutes() / 60 + fecha.getSeconds() / 3600;
}

export function esDeDia(fecha, cond = CONDICIONES_POR_DEFECTO) {
  const h = horaDecimal(fecha);
  return h >= cond.horaInicioDia && h < cond.horaInicioNoche;
}

/**
 * Temperatura que el sistema de climatización intenta mantener.
 * Curva sinusoidal con mínimo de madrugada (~02:00) y máximo a las 14:00,
 * acotada con un margen de seguridad dentro del rango 18–24 °C.
 */
export function temperaturaObjetivo(fecha, cond = CONDICIONES_POR_DEFECTO) {
  const media = (cond.temperaturaNoche + cond.temperaturaDia) / 2;
  const amplitud = ((cond.temperaturaDia - cond.temperaturaNoche) / 2) * 0.8;
  const h = horaDecimal(fecha);
  return media + amplitud * Math.cos(((h - 14) / 24) * 2 * Math.PI);
}

/** La humedad relativa baja cuando la temperatura sube (correlación inversa). */
export function humedadObjetivo(temperatura, cond = CONDICIONES_POR_DEFECTO) {
  const media = (cond.temperaturaNoche + cond.temperaturaDia) / 2;
  return cond.humedadObjetivo - 1.2 * (temperatura - media);
}

export function crearEstadoAmbiente(fecha = new Date(), cond = CONDICIONES_POR_DEFECTO) {
  const temperatura = temperaturaObjetivo(fecha, cond);
  return {
    temperatura,
    humedad: humedadObjetivo(temperatura, cond),
    aporteRiego: 0,
    fase: 0
  };
}

/**
 * Avanza el modelo `dt` segundos. Dinámica de primer orden hacia el objetivo,
 * más perturbaciones del escenario, ajustes manuales y efecto del riego/nebulización.
 */
export function pasoAmbiente(estado, opciones = {}) {
  const {
    fecha = new Date(),
    dt = 1,
    escenario = 'normal',
    ajusteTemperatura = 0,
    ajusteHumedad = 0,
    riegoActivo = false,
    cond = CONDICIONES_POR_DEFECTO,
    rand = Math.random,
    tau = 45
  } = opciones;

  const esc = ESCENARIOS[escenario] || ESCENARIOS.normal;
  const alfa = 1 - Math.exp(-dt / tau);
  const fase = estado.fase + dt / 30;

  // Aporte del riego: sube rápido mientras está activo y decae lentamente.
  const aporteObjetivo = riegoActivo ? 12 : 0;
  const tauRiego = riegoActivo ? 20 : 90;
  const aporteRiego = estado.aporteRiego + (aporteObjetivo - estado.aporteRiego) * (1 - Math.exp(-dt / tauRiego));

  const oscilacion = esc.inestabilidad * 2.5 * Math.sin(fase);
  const tObjetivo = temperaturaObjetivo(fecha, cond) + esc.dT + ajusteTemperatura + oscilacion - aporteRiego * 0.08;
  let temperatura = estado.temperatura + (tObjetivo - estado.temperatura) * alfa + gaussiano(rand) * 0.02 * Math.sqrt(dt);

  const hObjetivo = humedadObjetivo(temperatura, cond) + esc.dH + ajusteHumedad + aporteRiego - oscilacion * 1.5;
  let humedad = estado.humedad + (hObjetivo - estado.humedad) * alfa + gaussiano(rand) * 0.05 * Math.sqrt(dt);

  temperatura = limitar(temperatura, -10, 50);
  humedad = limitar(humedad, 5, 100);

  return { temperatura, humedad, aporteRiego, fase };
}

/**
 * Lectura de un sensor concreto: valor del ambiente + desviación propia de la
 * zona/calibración + ruido de medición + falla inyectada.
 */
export function leerSensor(ambiente, sensor, opciones = {}) {
  const { ruido = 0.3, falla = 'ninguna', rand = Math.random, ultimaLectura = null } = opciones;

  if (falla === 'congelada' && ultimaLectura) {
    return { temperatura: ultimaLectura.temperatura, humedad: ultimaLectura.humedad };
  }

  const factorErratico = falla === 'erratica' ? 18 : 1;
  const temperatura = ambiente.temperatura + (sensor.offsetTemperatura || 0) + gaussiano(rand) * ruido * 0.4 * factorErratico;
  const humedad = ambiente.humedad + (sensor.offsetHumedad || 0) + gaussiano(rand) * ruido * 1.2 * factorErratico;

  return {
    temperatura: redondear(limitar(temperatura, -40, 85), 1),
    humedad: redondear(limitar(humedad, 0, 100), 1)
  };
}

/** Intensidad de señal simulada (dBm) según el protocolo. */
export function calcularRssi(protocolo, rand = Math.random) {
  const base = protocolo === 'BLE' ? -72 : -55;
  return Math.round(base + gaussiano(rand) * 5);
}

/** Construye el mensaje JSON que el nodo publica en MQTT. */
export function construirLectura({ sensor, valores, ts = Date.now(), bateria = null, rssi, intervalo, secuencia }) {
  return {
    sensorId: sensor.id,
    nombre: sensor.nombre,
    modelo: sensor.modelo,
    protocolo: sensor.protocolo,
    zona: sensor.zona,
    gateway: sensor.gateway,
    temperatura: valores.temperatura,
    humedad: valores.humedad,
    bateria: bateria === null ? null : redondear(bateria, 1),
    rssi,
    intervalo,
    secuencia,
    ts
  };
}

/**
 * OrquídeaSense · Simulador de sensores IoT (se publica en GitHub Pages).
 *
 * Cada nodo virtual se comporta como un microcontrolador real:
 *  - ESP32 (Wi-Fi) publica directamente al broker MQTT.
 *  - nRF52 (Bluetooth LE) anuncia sus lecturas a un gateway BLE que las reenvía por MQTT.
 * Además el simulador expone un actuador de riego/nebulización que responde a
 * comandos enviados por el panel de monitoreo.
 */
import {
  ESCENARIOS, FALLAS, CONDICIONES_POR_DEFECTO,
  crearEstadoAmbiente, pasoAmbiente, leerSensor, calcularRssi, construirLectura, esDeDia
} from './modelo.js';
import { crearVistaInvernadero } from './invernadero.js';

const CLAVE_LS = 'orquideasense-simulador';
const DURACION_EMPAREJAMIENTO_MS = 120_000;
const MAX_CONSOLA = 250;
const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const estadoGuardado = JSON.parse(localStorage.getItem(CLAVE_LS) || '{}');

const app = {
  config: null,
  topicos: null,
  cliente: null,
  conectado: false,
  ejecutando: true,
  ambiente: null,
  escenario: estadoGuardado.escenario || 'normal',
  ajusteTemperatura: 0,
  ajusteHumedad: 0,
  ruido: 0.3,
  intervalo: estadoGuardado.intervalo || 5,
  sensores: [],
  riego: { activo: false, zona: 'Todas', inicio: 0, fin: 0, origen: null },
  mensajes: 0,
  clienteId: `sim-${Math.random().toString(16).slice(2, 10)}`,
  vista: null
};

function guardarEstado() {
  localStorage.setItem(CLAVE_LS, JSON.stringify({
    escenario: app.escenario,
    intervalo: app.intervalo,
    vinculados: app.sensores.filter((s) => s.vinculado).map((s) => s.def.id)
  }));
}

function crearTopicos(base) {
  return {
    lectura: (id) => `${base}/sensores/${id}/lectura`,
    emparejar: `${base}/sensores/+/emparejar`,
    respuestaEmparejar: (id) => `${base}/sensores/${id}/emparejar/respuesta`,
    desvincular: `${base}/sensores/+/desvincular`,
    descubrir: `${base}/gateway/descubrir`,
    respuestaDescubrir: `${base}/gateway/descubrir/respuesta`,
    riegoComando: `${base}/actuadores/riego/comando`,
    riegoEstado: `${base}/actuadores/riego/estado`,
    simuladorEstado: `${base}/simulador/estado`,
    panelEstado: `${base}/panel/estado`
  };
}

/* ------------------------------------------------------------------ */
/* Consola y notificaciones                                           */
/* ------------------------------------------------------------------ */
function registrar(tipo, mensaje, topico) {
  const lista = $('#registro-consola');
  const li = document.createElement('li');
  const hora = new Date().toLocaleTimeString('es-CL', { hour12: false });
  const etiquetas = { pub: 'PUB', sub: 'SUB', sys: 'SYS', err: 'ERR' };
  li.innerHTML = `<span class="t">${hora}</span><span class="d ${tipo}">${etiquetas[tipo]}</span><span class="m"></span>`;
  const m = li.querySelector('.m');
  if (topico) {
    const b = document.createElement('b');
    b.textContent = topico.replace(app.config?.topicBase ?? '', '…');
    m.append(b, ' ');
  }
  m.append(mensaje);
  lista.appendChild(li);
  while (lista.children.length > MAX_CONSOLA) lista.firstChild.remove();
  if ($('#chk-auto-scroll').checked) lista.scrollTop = lista.scrollHeight;
}

function toast(titulo, texto, tipo = '') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.innerHTML = '<strong></strong><span></span>';
  t.querySelector('strong').textContent = titulo;
  t.querySelector('span').textContent = texto;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('saliendo'); setTimeout(() => t.remove(), 300); }, 4200);
}

function pildora(id, estado, texto) {
  const p = $(id);
  p.dataset.estado = estado;
  p.querySelector('.texto').textContent = texto;
}

/* ------------------------------------------------------------------ */
/* MQTT                                                               */
/* ------------------------------------------------------------------ */
function publicar(topico, datos, opciones = {}) {
  if (!app.cliente || !app.conectado) {
    registrar('err', 'Sin conexión con el broker: mensaje descartado', topico);
    return false;
  }
  const carga = typeof datos === 'string' ? datos : JSON.stringify(datos);
  app.cliente.publish(topico, carga, { qos: opciones.qos ?? 0, retain: !!opciones.retain });
  if (!opciones.silencioso) registrar('pub', carga.length > 180 ? `${carga.slice(0, 180)}…` : carga, topico);
  return true;
}

function publicarEstadoSimulador() {
  publicar(app.topicos.simuladorEstado, {
    online: true,
    clienteId: app.clienteId,
    version: VERSION,
    escenario: app.escenario,
    intervalo: app.intervalo,
    sensores: app.sensores.filter((s) => s.encendido).length,
    ts: Date.now()
  }, { retain: true, qos: 1, silencioso: true });
}

function publicarEstadoRiego() {
  publicar(app.topicos.riegoEstado, { ...app.riego, ts: Date.now() }, { retain: true, qos: 1 });
}

function conectarMqtt() {
  const { url } = app.config.broker;
  const t = app.topicos;
  pildora('#pildora-mqtt', 'conectando', 'Conectando broker…');
  registrar('sys', `Conectando a ${url} como ${app.clienteId}`);

  app.cliente = window.mqtt.connect(url, {
    clientId: app.clienteId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 4000,
    connectTimeout: 12_000,
    will: { topic: t.simuladorEstado, payload: JSON.stringify({ online: false, ts: Date.now() }), qos: 1, retain: true }
  });

  app.cliente.on('connect', () => {
    app.conectado = true;
    pildora('#pildora-mqtt', 'conectado', `Broker ${new URL(url).hostname}`);
    registrar('sys', 'Conectado al broker MQTT');
    const subs = [t.emparejar, t.desvincular, t.descubrir, t.riegoComando, t.panelEstado];
    app.cliente.subscribe(subs, { qos: 1 }, (err) => {
      if (err) registrar('err', `Error al suscribirse: ${err.message}`);
      else subs.forEach((s) => registrar('sub', 'suscrito', s));
    });
    publicarEstadoSimulador();
    publicarEstadoRiego();
  });
  app.cliente.on('reconnect', () => pildora('#pildora-mqtt', 'conectando', 'Reconectando…'));
  app.cliente.on('offline', () => { app.conectado = false; pildora('#pildora-mqtt', 'error', 'Broker sin conexión'); });
  app.cliente.on('close', () => { app.conectado = false; });
  app.cliente.on('error', (err) => { registrar('err', `MQTT: ${err.message}`); pildora('#pildora-mqtt', 'error', 'Error de broker'); });
  app.cliente.on('message', manejarMensaje);
}

function manejarMensaje(topico, buffer) {
  let datos;
  try { datos = JSON.parse(buffer.toString()); } catch { return; }
  const t = app.topicos;

  if (topico === t.panelEstado) {
    if (datos.online) pildora('#pildora-panel', 'conectado', 'Panel conectado');
    else pildora('#pildora-panel', 'desconectado', 'Panel sin conectar');
    return;
  }

  registrar('sub', JSON.stringify(datos), topico);

  if (topico === t.descubrir) return responderDescubrimiento(datos);
  if (topico === t.riegoComando) return ejecutarComandoRiego(datos);

  const partes = topico.split('/');
  const accion = partes.at(-1);
  const sensorId = partes.at(-2);
  const sensor = app.sensores.find((s) => s.def.id === sensorId);
  if (!sensor) return;
  if (accion === 'emparejar') return responderEmparejamiento(sensor, datos);
  if (accion === 'desvincular') {
    sensor.vinculado = false;
    guardarEstado();
    renderSensor(sensor);
    toast('Sensor desvinculado', `${sensor.def.nombre} fue desvinculado desde el panel.`);
  }
}

/* ------------------------------------------------------------------ */
/* Emparejamiento y descubrimiento (RF3)                              */
/* ------------------------------------------------------------------ */
function responderDescubrimiento(solicitud) {
  // Solo los nodos encendidos pueden responder al escaneo.
  const dispositivos = app.sensores
    .filter((s) => s.encendido)
    .filter((s) => !solicitud.protocolo || solicitud.protocolo === s.def.protocolo)
    .map((s) => ({
      id: s.def.id,
      nombre: s.def.nombre,
      modelo: s.def.modelo,
      protocolo: s.def.protocolo,
      zona: s.def.zona,
      gateway: s.def.gateway,
      modoEmparejamiento: s.modoEmparejamiento,
      vinculado: s.vinculado,
      rssi: calcularRssi(s.def.protocolo)
    }));
  publicar(app.topicos.respuestaDescubrir, { solicitudId: solicitud.solicitudId, clienteId: app.clienteId, dispositivos, ts: Date.now() }, { qos: 1 });
}

function responderEmparejamiento(sensor, solicitud) {
  if (!sensor.encendido) {
    registrar('err', `${sensor.def.id} está apagado: no puede responder a la solicitud`);
    return; // Un nodo apagado no responde → el panel detecta el timeout.
  }
  const responder = (ok, codigo, mensaje) => publicar(app.topicos.respuestaEmparejar(sensor.def.id), {
    solicitudId: solicitud.solicitudId, sensorId: sensor.def.id, ok, codigo, mensaje,
    sensor: ok ? { ...sensor.def, pin: undefined, offsetTemperatura: undefined, offsetHumedad: undefined } : undefined,
    intervalo: app.intervalo, ts: Date.now()
  }, { qos: 1 });

  if (!sensor.modoEmparejamiento) {
    responder(false, 'NO_MODO_EMPAREJAMIENTO', 'El sensor no está en modo emparejamiento.');
    return;
  }
  if (String(solicitud.pin).trim() !== sensor.def.pin) {
    responder(false, 'PIN_INCORRECTO', 'El PIN ingresado no coincide.');
    toast('PIN incorrecto', `Intento fallido de emparejar ${sensor.def.nombre}.`, 'error');
    return;
  }
  sensor.vinculado = true;
  sensor.modoEmparejamiento = false;
  guardarEstado();
  responder(true, 'OK', 'Sensor emparejado correctamente.');
  toast('¡Sensor emparejado!', `${sensor.def.nombre} quedó vinculado al panel.`, 'exito');
  renderSensor(sensor);
  setTimeout(() => transmitir(sensor, Date.now()), 400); // lectura inmediata para verificación
}

/* ------------------------------------------------------------------ */
/* Actuador de riego                                                  */
/* ------------------------------------------------------------------ */
function ejecutarComandoRiego(cmd) {
  if (cmd.accion === 'detener') return detenerRiego(cmd.origen || 'panel');
  if (cmd.accion === 'iniciar') {
    const minutos = Math.min(Math.max(Number(cmd.duracionMin) || 1, 0.1), 120);
    iniciarRiego(minutos, cmd.zona || 'Todas', cmd.origen || 'panel');
  }
}

function iniciarRiego(minutos, zona, origen) {
  const ahora = Date.now();
  app.riego = { activo: true, zona, inicio: ahora, fin: ahora + minutos * 60_000, origen };
  publicarEstadoRiego();
  app.vista.establecerRiego(true, zona);
  renderRiego();
  toast('Riego iniciado', `${zona} · ${minutos} min (${origen})`, 'agua');
}

function detenerRiego(origen) {
  if (!app.riego.activo) return;
  app.riego = { ...app.riego, activo: false, fin: Date.now(), origen };
  publicarEstadoRiego();
  app.vista.establecerRiego(false);
  renderRiego();
  toast('Riego detenido', `Electroválvula cerrada (${origen}).`);
}

function renderRiego() {
  const r = app.riego;
  $('#actuador-riego').dataset.activo = r.activo;
  $('#btn-detener-riego').disabled = !r.activo;
  if (r.activo) {
    const resta = Math.max(0, Math.round((r.fin - Date.now()) / 1000));
    $('#actuador-estado').textContent = 'Nebulizando…';
    $('#actuador-detalle').textContent = `${r.zona} · quedan ${Math.floor(resta / 60)}:${String(resta % 60).padStart(2, '0')} · origen: ${r.origen}`;
  } else {
    $('#actuador-estado').textContent = 'Electroválvula cerrada';
    $('#actuador-detalle').textContent = 'Esperando comandos del panel o activación manual.';
  }
}

/* ------------------------------------------------------------------ */
/* Sensores                                                           */
/* ------------------------------------------------------------------ */
function crearSensores(defs) {
  const vinculados = new Set(estadoGuardado.vinculados || []);
  return defs.map((def, i) => ({
    def,
    encendido: true,
    falla: 'ninguna',
    modoEmparejamiento: false,
    emparejamientoHasta: 0,
    vinculado: vinculados.has(def.id),
    bateria: def.protocolo === 'BLE' ? 70 + ((i * 37) % 30) : null,
    rssi: calcularRssi(def.protocolo),
    ultima: null,
    secuencia: 0,
    historial: [],
    proxima: Date.now() + 800 + i * 650,
    tarjeta: null
  }));
}

function crearTarjeta(sensor) {
  const nodo = $('#plantilla-sensor').content.firstElementChild.cloneNode(true);
  const { def } = sensor;
  nodo.dataset.protocolo = def.protocolo;
  nodo.id = `sensor-${def.id}`;
  nodo.querySelector('.badge-protocolo').textContent = def.protocolo === 'BLE' ? 'BLUETOOTH LE' : 'WI-FI';
  nodo.querySelector('.sensor-nombre').textContent = def.nombre;
  nodo.querySelector('.sensor-modelo').textContent = `${def.id} · ${def.modelo}`;
  nodo.querySelector('.sensor-zona').textContent = `📍 ${def.zona} · vía ${def.gateway}`;

  const chk = nodo.querySelector('.chk-encendido');
  chk.id = `chk-encendido-${def.id}`;
  chk.addEventListener('change', () => {
    sensor.encendido = chk.checked;
    if (!sensor.encendido) sensor.modoEmparejamiento = false;
    registrar('sys', `${def.id} ${sensor.encendido ? 'encendido' : 'apagado'}`);
    renderSensor(sensor);
    publicarEstadoSimulador();
  });

  const sel = nodo.querySelector('.sel-falla');
  sel.id = `sel-falla-${def.id}`;
  for (const [valor, texto] of Object.entries(FALLAS)) sel.add(new Option(texto, valor));
  sel.addEventListener('change', () => {
    sensor.falla = sel.value;
    registrar('sys', `${def.id}: falla inyectada → ${FALLAS[sel.value]}`);
  });

  const btn = nodo.querySelector('.btn-emparejar');
  btn.id = `btn-emparejar-${def.id}`;
  btn.addEventListener('click', () => {
    if (!sensor.encendido) return toast('Nodo apagado', 'Enciende el sensor antes de emparejarlo.', 'error');
    sensor.modoEmparejamiento = !sensor.modoEmparejamiento;
    sensor.emparejamientoHasta = Date.now() + DURACION_EMPAREJAMIENTO_MS;
    registrar('sys', `${def.id}: modo emparejamiento ${sensor.modoEmparejamiento ? 'activado' : 'cancelado'}`);
    renderSensor(sensor);
  });

  sensor.tarjeta = nodo;
  return nodo;
}

function renderSensor(sensor) {
  const n = sensor.tarjeta;
  if (!n) return;
  n.dataset.encendido = sensor.encendido;
  if (sensor.ultima) {
    n.querySelector('.val-temp').textContent = sensor.ultima.temperatura.toFixed(1);
    n.querySelector('.val-hum').textContent = sensor.ultima.humedad.toFixed(1);
  }
  const nivel = sensor.rssi > -55 ? 4 : sensor.rssi > -67 ? 3 : sensor.rssi > -78 ? 2 : 1;
  n.querySelectorAll('.barras b').forEach((b, i) => b.classList.toggle('on', sensor.encendido && i < nivel));
  n.querySelector('.meta-rssi em').textContent = sensor.encendido ? `${sensor.rssi} dBm` : '— dBm';
  n.querySelector('.meta-bateria').textContent = sensor.bateria === null ? '🔌 Red eléctrica' : `🔋 ${sensor.bateria.toFixed(0)} %`;
  const vinc = n.querySelector('.meta-vinculo');
  vinc.textContent = sensor.vinculado ? '● Vinculado' : '○ Sin vincular';
  vinc.classList.toggle('vinculado', sensor.vinculado);

  const panelPin = n.querySelector('.panel-pin');
  panelPin.hidden = !sensor.modoEmparejamiento;
  n.querySelector('.pin').textContent = sensor.def.pin;
  n.querySelector('.btn-emparejar').textContent = sensor.modoEmparejamiento ? 'Cancelar' : 'Modo emparejamiento';
  if (sensor.modoEmparejamiento) {
    const s = Math.max(0, Math.round((sensor.emparejamientoHasta - Date.now()) / 1000));
    n.querySelector('.pin-cuenta').textContent = `Visible ${s} s · ingrésalo en "Conectar Sensores" del panel`;
  }
  app.vista.actualizarNodo(sensor.def.id, { encendido: sensor.encendido, emparejando: sensor.modoEmparejamiento, valores: sensor.ultima });
}

function dibujarSparkline(sensor) {
  const canvas = sensor.tarjeta.querySelector('.sparkline');
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const datos = sensor.historial;
  if (datos.length < 2) return;
  const serie = (clave, color) => {
    const vals = datos.map((d) => d[clave]);
    const min = Math.min(...vals) - 0.5;
    const max = Math.max(...vals) + 0.5;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 4 - ((v - min) / (max - min)) * (h - 8);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  serie('humedad', 'hsla(198, 92%, 60%, 0.9)');
  serie('temperatura', 'hsla(20, 90%, 68%, 0.9)');
}

function transmitir(sensor, ahora) {
  sensor.proxima = ahora + app.intervalo * 1000;
  const valores = leerSensor(app.ambiente, sensor.def, { ruido: app.ruido, falla: sensor.falla, ultimaLectura: sensor.ultima });
  sensor.ultima = valores;
  sensor.rssi = calcularRssi(sensor.def.protocolo);
  if (sensor.bateria !== null) sensor.bateria = Math.max(0, sensor.bateria - 0.01);
  sensor.historial.push(valores);
  if (sensor.historial.length > 40) sensor.historial.shift();
  sensor.secuencia += 1;
  renderSensor(sensor);
  dibujarSparkline(sensor);

  if (sensor.falla === 'intermitente' && Math.random() < 0.5) {
    registrar('err', `${sensor.def.id}: paquete perdido (conexión intermitente)`);
    return;
  }

  const lectura = construirLectura({
    sensor: sensor.def, valores, bateria: sensor.bateria, rssi: sensor.rssi,
    intervalo: app.intervalo, secuencia: sensor.secuencia, ts: ahora
  });
  if (publicar(app.topicos.lectura(sensor.def.id), lectura)) {
    app.mensajes += 1;
    $('#contador-mensajes').textContent = app.mensajes;
    app.vista.transmitir(sensor.def.id);
    sensor.tarjeta.classList.remove('destello');
    void sensor.tarjeta.offsetWidth;
    sensor.tarjeta.classList.add('destello');
  }
}

/* ------------------------------------------------------------------ */
/* Bucle principal                                                    */
/* ------------------------------------------------------------------ */
function tick() {
  const ahora = Date.now();
  const fecha = new Date(ahora);
  const cond = app.config.condicionesOptimas || CONDICIONES_POR_DEFECTO;

  if (app.riego.activo && ahora >= app.riego.fin) detenerRiego('temporizador');

  app.ambiente = pasoAmbiente(app.ambiente, {
    fecha, dt: 1, escenario: app.escenario, cond,
    ajusteTemperatura: app.ajusteTemperatura, ajusteHumedad: app.ajusteHumedad,
    riegoActivo: app.riego.activo
  });

  const dia = esDeDia(fecha, cond);
  $('#hora-actual').textContent = fecha.toLocaleTimeString('es-CL', { hour12: false });
  $('#icono-ciclo').textContent = dia ? '☀️' : '🌙';
  app.vista.establecerCiclo(dia);
  app.vista.establecerAmbiente(app.ambiente.temperatura, app.ambiente.humedad);
  $('#amb-temperatura').textContent = app.ambiente.temperatura.toFixed(1);
  $('#amb-humedad').textContent = app.ambiente.humedad.toFixed(1);
  if (app.riego.activo) renderRiego();

  for (const s of app.sensores) {
    if (s.modoEmparejamiento) {
      if (ahora > s.emparejamientoHasta) s.modoEmparejamiento = false;
      renderSensor(s);
    }
    if (app.ejecutando && s.encendido && ahora >= s.proxima) transmitir(s, ahora);
  }
}

/* ------------------------------------------------------------------ */
/* Controles                                                          */
/* ------------------------------------------------------------------ */
function enlazarControles() {
  const selEsc = $('#sel-escenario');
  for (const [clave, esc] of Object.entries(ESCENARIOS)) selEsc.add(new Option(esc.nombre, clave));
  selEsc.value = app.escenario;
  const describir = () => { $('#desc-escenario').textContent = ESCENARIOS[app.escenario].descripcion; };
  describir();
  selEsc.addEventListener('change', () => {
    app.escenario = selEsc.value;
    describir();
    guardarEstado();
    publicarEstadoSimulador();
    registrar('sys', `Escenario → ${ESCENARIOS[app.escenario].nombre}`);
  });

  const rT = $('#rng-temperatura');
  const rH = $('#rng-humedad');
  const rR = $('#rng-ruido');
  const actualizar = () => {
    app.ajusteTemperatura = Number(rT.value);
    app.ajusteHumedad = Number(rH.value);
    app.ruido = Number(rR.value);
    $('#out-temperatura').textContent = `${app.ajusteTemperatura > 0 ? '+' : ''}${app.ajusteTemperatura.toFixed(1)} °C`;
    $('#out-humedad').textContent = `${app.ajusteHumedad > 0 ? '+' : ''}${app.ajusteHumedad} %`;
    $('#out-ruido').textContent = app.ruido.toFixed(1);
  };
  [rT, rH, rR].forEach((r) => r.addEventListener('input', actualizar));
  actualizar();

  const selInt = $('#sel-intervalo');
  selInt.value = String(app.intervalo);
  selInt.addEventListener('change', () => {
    app.intervalo = Number(selInt.value);
    const ahora = Date.now();
    app.sensores.forEach((s, i) => { s.proxima = ahora + 300 + i * 400; });
    guardarEstado();
    publicarEstadoSimulador();
    registrar('sys', `Intervalo de transmisión → ${app.intervalo} s`);
  });

  $('#btn-restablecer').addEventListener('click', () => {
    rT.value = 0; rH.value = 0; rR.value = 0.3;
    selEsc.value = 'normal'; app.escenario = 'normal';
    describir(); actualizar(); guardarEstado(); publicarEstadoSimulador();
    toast('Ajustes restablecidos', 'El entorno vuelve a operación normal.');
  });

  $('#btn-simulacion').addEventListener('click', (e) => {
    app.ejecutando = !app.ejecutando;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(app.ejecutando));
    btn.querySelector('span').textContent = app.ejecutando ? 'Pausar' : 'Reanudar';
    btn.querySelector('svg').innerHTML = app.ejecutando
      ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>'
      : '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    registrar('sys', app.ejecutando ? 'Simulación reanudada' : 'Simulación en pausa (sin transmisiones)');
  });

  $('#btn-riego').addEventListener('click', () => iniciarRiego(2, 'Todas', 'manual (simulador)'));
  $('#btn-detener-riego').addEventListener('click', () => detenerRiego('manual (simulador)'));
  $('#btn-limpiar-consola').addEventListener('click', () => { $('#registro-consola').innerHTML = ''; });
}

/* ------------------------------------------------------------------ */
/* Inicio                                                             */
/* ------------------------------------------------------------------ */
async function iniciar() {
  try {
    const resp = await fetch('config.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    app.config = await resp.json();
  } catch (err) {
    $('#nombre-invernadero').textContent = 'No se pudo cargar config.json';
    registrar('err', `No se pudo cargar config.json: ${err.message}`);
    return;
  }

  const { config } = app;
  app.topicos = crearTopicos(config.topicBase);
  $('#nombre-invernadero').textContent = `${config.invernadero.nombre} · ${config.sensores.length} nodos`;
  $('#info-broker').textContent = config.broker.url;
  $('#info-topico').textContent = `${config.topicBase}/#`;
  $('#info-cliente').textContent = app.clienteId;

  app.ambiente = crearEstadoAmbiente(new Date(), config.condicionesOptimas);
  app.sensores = crearSensores(config.sensores);
  app.vista = crearVistaInvernadero($('#svg-invernadero'), config.sensores);

  const rejilla = $('#rejilla-sensores');
  app.sensores.forEach((s) => rejilla.appendChild(crearTarjeta(s)));
  app.sensores.forEach(renderSensor);

  enlazarControles();
  renderRiego();

  if (!window.mqtt) {
    registrar('err', 'No se cargó la librería MQTT (js/vendor/mqtt.min.js)');
    pildora('#pildora-mqtt', 'error', 'Librería MQTT ausente');
  } else {
    conectarMqtt();
  }

  tick();
  setInterval(tick, 1000);
}

iniciar();

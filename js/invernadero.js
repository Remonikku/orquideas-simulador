/**
 * Construye y anima el diagrama SVG del invernadero:
 * bancadas con orquídeas, nodos sensores, gateways (AP Wi-Fi y gateway BLE)
 * y el broker MQTT en la nube.
 */
const NS = 'http://www.w3.org/2000/svg';
const COLORES_FLOR = ['hsl(310,75%,72%)', 'hsl(275,60%,70%)', 'hsl(330,80%,82%)', 'hsl(48,90%,70%)'];

function el(tag, attrs = {}, padre) {
  const nodo = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) nodo.setAttribute(k, v);
  if (padre) padre.appendChild(nodo);
  return nodo;
}

export function crearVistaInvernadero(svg, sensores) {
  svg.innerHTML = '';
  const defs = el('defs', {}, svg);
  defs.innerHTML = `
    <linearGradient id="g-cielo-dia" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f4f7a"/><stop offset="1" stop-color="#0d2238"/>
    </linearGradient>
    <linearGradient id="g-cielo-noche" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05060f"/><stop offset="1" stop-color="#0b1020"/>
    </linearGradient>
    <linearGradient id="g-cristal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsla(190,70%,80%,0.10)"/><stop offset="1" stop-color="hsla(190,70%,80%,0.02)"/>
    </linearGradient>
    <radialGradient id="g-sol"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#ffb54a" stop-opacity="0"/></radialGradient>`;

  // Cielo día / noche
  const cieloNoche = el('rect', { x: 0, y: 0, width: 900, height: 470, fill: 'url(#g-cielo-noche)', class: 'svg-cielo' }, svg);
  const cieloDia = el('rect', { x: 0, y: 0, width: 900, height: 470, fill: 'url(#g-cielo-dia)', class: 'svg-cielo' }, svg);
  const estrellas = el('g', { class: 'svg-cielo' }, svg);
  for (let i = 0; i < 40; i++) {
    el('circle', { cx: (i * 137) % 900, cy: (i * 59) % 150, r: (i % 3) * 0.5 + 0.6, fill: '#fff', opacity: 0.3 + (i % 5) * 0.12 }, estrellas);
  }
  const astro = el('g', {}, svg);
  const halo = el('circle', { cx: 90, cy: 70, r: 46, fill: 'url(#g-sol)' }, astro);
  const disco = el('circle', { cx: 90, cy: 70, r: 18, fill: '#ffe08a' }, astro);

  // Broker MQTT en la nube
  const nube = el('g', { class: 'svg-nube' }, svg);
  el('path', { d: 'M400 72 a22 22 0 0 1 8-40 a30 30 0 0 1 56-6 a24 24 0 0 1 36 22 a18 18 0 0 1 -4 36 z' }, nube);
  el('text', { x: 452, y: 60 }, nube).textContent = 'Broker MQTT';
  const puntoNube = { x: 452, y: 82 };

  // Estructura del invernadero
  el('rect', { x: 0, y: 420, width: 900, height: 50, class: 'svg-suelo' }, svg);
  el('path', { d: 'M110 420 L110 225 Q450 95 790 225 L790 420 Z', fill: 'url(#g-cristal)', class: 'svg-cristal' }, svg);
  for (let x = 180; x < 790; x += 70) {
    const yTecho = 225 - (1 - ((x - 450) / 340) ** 2) * 65;
    el('line', { x1: x, y1: yTecho, x2: x, y2: 420, class: 'svg-costilla' }, svg);
  }
  el('line', { x1: 110, y1: 225, x2: 790, y2: 225, class: 'svg-costilla' }, svg);

  const lecturaAmbiente = el('text', { x: 450, y: 200, class: 'svg-etiqueta', style: 'font-size:15px;font-weight:600;fill:#e8eef5' }, svg);
  lecturaAmbiente.textContent = '-- °C · -- %';

  // Gateways
  const gateways = {
    WIFI: { x: 230, y: 250, id: 'AP-INVERNADERO', etiqueta: 'AP Wi-Fi' },
    BLE: { x: 670, y: 250, id: 'GW-BLE-01', etiqueta: 'Gateway BLE' }
  };
  const capaEnlaces = el('g', {}, svg);
  const capaNiebla = el('g', {}, svg);
  const capaPlantas = el('g', {}, svg);
  const capaNodos = el('g', {}, svg);
  const capaPaquetes = el('g', {}, svg);

  for (const [proto, gw] of Object.entries(gateways)) {
    const curva = `M${gw.x} ${gw.y - 14} Q${(gw.x + puntoNube.x) / 2} ${gw.y - 110} ${puntoNube.x} ${puntoNube.y}`;
    el('path', { d: curva, class: 'svg-enlace mqtt' }, capaEnlaces);
    const g = el('g', { class: `svg-gateway ${proto === 'BLE' ? 'ble' : 'wifi'}` }, capaNodos);
    el('rect', { x: gw.x - 46, y: gw.y - 14, width: 92, height: 28, rx: 8 }, g);
    el('text', { x: gw.x, y: gw.y + 4 }, g).textContent = gw.etiqueta;
  }

  // Bancadas, plantas y nodos
  const n = sensores.length;
  const inicio = 140;
  const fin = 760;
  const hueco = 22;
  const ancho = (fin - inicio - hueco * (n - 1)) / n;
  const nodos = new Map();

  sensores.forEach((s, i) => {
    const x0 = inicio + i * (ancho + hueco);
    const cx = x0 + ancho / 2;
    const proto = s.protocolo === 'BLE' ? 'ble' : 'wifi';
    const gw = gateways[s.protocolo] || gateways.WIFI;

    // Bancada
    el('rect', { x: x0, y: 372, width: ancho, height: 16, rx: 3, class: 'svg-bancada' }, capaPlantas);
    el('line', { x1: x0 + 8, y1: 388, x2: x0 + 8, y2: 420, stroke: '#4a382b', 'stroke-width': 4 }, capaPlantas);
    el('line', { x1: x0 + ancho - 8, y1: 388, x2: x0 + ancho - 8, y2: 420, stroke: '#4a382b', 'stroke-width': 4 }, capaPlantas);
    el('text', { x: cx, y: 438, class: 'svg-etiqueta' }, capaPlantas).textContent = s.zona.split('·')[0].trim();
    el('text', { x: cx, y: 453, class: 'svg-etiqueta-chica' }, capaPlantas).textContent = (s.zona.split('·')[1] || '').trim();

    // Orquídeas
    const plantas = Math.max(3, Math.floor(ancho / 34));
    for (let p = 0; p < plantas; p++) {
      const px = x0 + 14 + (p * (ancho - 28)) / (plantas - 1);
      if (Math.abs(px - cx) < 16) continue;
      el('rect', { x: px - 7, y: 362, width: 14, height: 10, rx: 2, fill: '#6b4a35' }, capaPlantas);
      el('ellipse', { cx: px - 6, cy: 360, rx: 9, ry: 3.5, class: 'svg-hoja', transform: `rotate(-18 ${px - 6} 360)` }, capaPlantas);
      el('ellipse', { cx: px + 6, cy: 360, rx: 9, ry: 3.5, class: 'svg-hoja', transform: `rotate(18 ${px + 6} 360)` }, capaPlantas);
      const alto = 26 + ((p * 7) % 12);
      el('path', { d: `M${px} 358 Q${px + 8} ${358 - alto / 2} ${px + 4} ${358 - alto}`, stroke: 'hsl(130,35%,40%)', 'stroke-width': 1.6, fill: 'none' }, capaPlantas);
      const color = COLORES_FLOR[(i + p) % COLORES_FLOR.length];
      const fx = px + 4;
      const fy = 358 - alto;
      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2;
        el('ellipse', { cx: fx + Math.cos(ang) * 4, cy: fy + Math.sin(ang) * 4, rx: 3.6, ry: 2.6, fill: color, class: 'svg-petalo', transform: `rotate(${(ang * 180) / Math.PI} ${fx + Math.cos(ang) * 4} ${fy + Math.sin(ang) * 4})` }, capaPlantas);
      }
      el('circle', { cx: fx, cy: fy, r: 1.8, fill: '#fff3b0' }, capaPlantas);
    }

    // Niebla / riego
    const niebla = el('g', { class: 'svg-niebla' }, capaNiebla);
    el('line', { x1: x0, y1: 262, x2: x0 + ancho, y2: 262, stroke: 'hsla(198,92%,60%,0.6)', 'stroke-width': 3 }, niebla);
    for (let d = 0; d < 9; d++) {
      el('circle', { cx: x0 + 10 + (d * (ancho - 20)) / 8, cy: 268, r: 2.2, style: `animation-delay:${(d % 4) * 0.33}s` }, niebla);
    }

    // Enlace sensor → gateway
    const ny = 322;
    const enlace = el('path', { d: `M${cx} ${ny} Q${(cx + gw.x) / 2} ${ny - 40} ${gw.x} ${gw.y + 14}`, class: `svg-enlace ${proto}` }, capaEnlaces);

    // Nodo
    const g = el('g', { class: `svg-nodo ${proto}` }, capaNodos);
    const onda = el('circle', { cx, cy: ny, r: 12, class: 'onda' }, g);
    el('circle', { cx, cy: ny, r: 14, class: 'cuerpo' }, g);
    el('text', { x: cx, y: ny, class: 'icono' }, g).textContent = proto === 'ble' ? 'B' : 'W';
    const valor = el('text', { x: cx, y: ny - 24, class: 'valor' }, g);
    valor.textContent = '--';
    el('title', {}, g).textContent = `${s.nombre} (${s.id})`;

    nodos.set(s.id, { g, onda, valor, enlace, niebla, cx, ny, gw, zona: s.zona });
  });

  return {
    actualizarNodo(id, { encendido, emparejando, valores }) {
      const nodo = nodos.get(id);
      if (!nodo) return;
      nodo.g.classList.toggle('apagado', !encendido);
      nodo.g.classList.toggle('emparejando', !!emparejando);
      nodo.enlace.classList.toggle('apagado', !encendido);
      if (valores) nodo.valor.textContent = `${valores.temperatura.toFixed(1)}° · ${Math.round(valores.humedad)}%`;
      if (!encendido) nodo.valor.textContent = 'OFF';
    },
    transmitir(id) {
      const nodo = nodos.get(id);
      if (!nodo) return;
      nodo.g.classList.remove('transmite');
      void nodo.g.getBoundingClientRect();
      nodo.g.classList.add('transmite');
      const paquete = el('circle', { cx: 0, cy: 0, r: 4, class: 'svg-paquete' }, capaPaquetes);
      const pasos = [
        { transform: `translate(${nodo.cx}px, ${nodo.ny}px)` },
        { transform: `translate(${nodo.gw.x}px, ${nodo.gw.y}px)`, offset: 0.45 },
        { transform: `translate(${puntoNube.x}px, ${puntoNube.y}px)` }
      ];
      const anim = paquete.animate(pasos, { duration: 1300, easing: 'ease-in-out' });
      anim.onfinish = () => paquete.remove();
    },
    establecerCiclo(esDia) {
      cieloDia.style.opacity = esDia ? 1 : 0;
      estrellas.style.opacity = esDia ? 0 : 1;
      disco.setAttribute('fill', esDia ? '#ffe08a' : '#dfe6f5');
      halo.style.opacity = esDia ? 1 : 0.25;
      cieloNoche.style.opacity = 1;
    },
    establecerRiego(activo, zona) {
      for (const nodo of nodos.values()) {
        const aplica = activo && (!zona || zona === 'Todas' || nodo.zona === zona);
        nodo.niebla.classList.toggle('activa', aplica);
      }
    },
    establecerAmbiente(t, h) {
      lecturaAmbiente.textContent = `${t.toFixed(1)} °C · ${h.toFixed(1)} % HR`;
    }
  };
}

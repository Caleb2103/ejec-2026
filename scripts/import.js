// Importa data/EJEC_2026.xlsx a MongoDB (colección `personas`).
// Uso: npm run import [-- ruta/al/archivo.xlsx]
// Es idempotente: hace upsert por nombre normalizado y solo rellena campos vacíos.
import 'dotenv/config';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { MongoClient } from 'mongodb';

const DATA_DIR = path.resolve('data');

function resolveFile() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const preferred = path.join(DATA_DIR, 'EJEC_2026.xlsx');
  if (fs.existsSync(preferred)) return preferred;
  const any = fs.readdirSync(DATA_DIR).find((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'));
  if (!any) throw new Error('No se encontró ningún .xlsx en data/');
  return path.join(DATA_DIR, any);
}

export const normName = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// "JEREMY MACEDO lozano" -> "Jeremy Macedo Lozano"
const titulo = (s) =>
  s.replace(/\s+/g, ' ').toLocaleLowerCase('es').replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('es'));

const str = (v) => {
  const s = String(v ?? '').trim();
  return s === '-' ? '' : s;
};

function normZona(v) {
  const s = str(v);
  if (!s || /^-+$/.test(s)) return 'Sin zona';
  const m = s.match(/^(?:zona|z)?\s*(\d+)$/i);
  if (m) return `Zona ${Number(m[1])}`;
  return s.toUpperCase();
}

function normGenero(v) {
  const s = str(v).toUpperCase();
  return s === 'M' || s === 'F' ? s : null;
}

function normEdad(v) {
  const n = parseInt(str(v), 10);
  return Number.isFinite(n) ? n : null;
}

function normBus(v) {
  const s = str(v);
  if (!s) return null;
  if (/^avanzada$/i.test(s)) return 'Avanzada';
  if (/^cuenta\s*propia$/i.test(s)) return 'Cuenta Propia';
  const m = s.match(/^bus\s*(\d)$/i);
  return m ? `Bus ${m[1]}` : s;
}

// Devuelve las filas como objetos usando la fila `headerRow` (0-based) como encabezados.
function readSheet(wb, name, headerRow) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`No existe la hoja "${name}"`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[headerRow].map((h) => String(h).trim());
  return { headers, rows: rows.slice(headerRow + 1) };
}

function col(headers, name) {
  const i = headers.findIndex((h) => normName(h) === normName(name));
  if (i === -1) throw new Error(`No se encontró la columna "${name}"`);
  return i;
}

function parseServidores(wb) {
  const { headers, rows } = readSheet(wb, 'SERVIDORES', 1);
  const c = {
    nombre: col(headers, 'Nombres y Apellido'),
    zona: col(headers, 'Zona'),
    celular: col(headers, 'Celular'),
    edad: col(headers, 'Edad'),
    genero: col(headers, 'Genero'),
    area: col(headers, 'Area'),
    bus: col(headers, 'BUS'),
  };
  // Las notas tipo "No ira al EJEC" están en la columna sin encabezado justo después de BUS.
  const notasCol = c.bus + 1;
  return rows
    .filter((r) => str(r[c.nombre]))
    .map((r) => ({
      nombre: titulo(str(r[c.nombre])),
      tipo: 'servidor',
      zona: normZona(r[c.zona]),
      genero: normGenero(r[c.genero]),
      edad: normEdad(r[c.edad]),
      celular: str(r[c.celular]),
      area: str(r[c.area]),
      bus: normBus(r[c.bus]),
      notas: headers[notasCol] ? '' : str(r[notasCol]),
    }));
}

function parseVivientes(wb) {
  const { headers, rows } = readSheet(wb, 'VIVIENTES', 1);
  const c = {
    nombre: col(headers, 'Nombres y Apellidos'),
    zona: col(headers, 'Zona'),
    dni: col(headers, 'DNI'),
    edad: col(headers, 'Edad'),
    celular: col(headers, 'Celular'),
    genero: col(headers, 'Genero'),
  };
  return rows
    .filter((r) => str(r[c.nombre]))
    .map((r) => ({
      nombre: titulo(str(r[c.nombre])),
      tipo: 'viviente',
      zona: normZona(r[c.zona]),
      genero: normGenero(r[c.genero]),
      edad: normEdad(r[c.edad]),
      celular: str(r[c.celular]),
      dni: str(r[c.dni]),
      bus: null,
      notas: '',
    }));
}

function parseCuartos(wb) {
  const { headers, rows } = readSheet(wb, 'Listado general', 1);
  const cn = col(headers, 'Nombre');
  const ch = col(headers, 'Habitación');
  const map = new Map();
  for (const r of rows) {
    const nombre = str(r[cn]);
    const cuarto = str(r[ch]);
    if (nombre && cuarto) map.set(normName(nombre), { nombre, cuarto });
  }
  return map;
}

const isEmpty = (v) => v === undefined || v === null || v === '';

async function main() {
  const file = resolveFile();
  console.log(`Leyendo ${path.relative(process.cwd(), file)}`);
  const wb = XLSX.readFile(file);

  const personas = [...parseServidores(wb), ...parseVivientes(wb)];
  const cuartos = parseCuartos(wb);
  for (const p of personas) {
    p.nombreNorm = normName(p.nombre);
    p.cuarto = cuartos.get(p.nombreNorm)?.cuarto ?? null;
  }

  // Algunos DNS (p. ej. el hotspot del iPhone) responden mal a la consulta SRV de Atlas:
  // si falla, usar DNS públicos.
  if (process.env.MONGODB_URI?.startsWith('mongodb+srv://')) {
    const host = new URL(process.env.MONGODB_URI).hostname;
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`).catch(() => dns.setServers(['1.1.1.1', '8.8.8.8']));
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const coll = client.db(process.env.DB_NAME).collection('personas');
  await coll.createIndex({ nombreNorm: 1 }, { unique: true });
  await coll.createIndex({ nombre: 1 });
  await coll.createIndex({ tipo: 1, zona: 1 });

  const existing = new Map((await coll.find().toArray()).map((d) => [d.nombreNorm, d]));
  const ops = [];
  let nuevos = 0;
  let actualizados = 0;
  for (const p of personas) {
    const prev = existing.get(p.nombreNorm);
    if (!prev) {
      nuevos++;
      ops.push({ insertOne: { document: { ...p, llego: false, horaLlegada: null } } });
      continue;
    }
    // Solo rellenar campos vacíos: nunca pisar lo editado en la app.
    const $set = {};
    for (const [k, v] of Object.entries(p)) {
      if (isEmpty(prev[k]) && !isEmpty(v)) $set[k] = v;
    }
    if (prev.llego === undefined) $set.llego = false;
    if (prev.horaLlegada === undefined) $set.horaLlegada = null;
    if (Object.keys($set).length) {
      actualizados++;
      ops.push({ updateOne: { filter: { _id: prev._id }, update: { $set } } });
    }
  }
  if (ops.length) await coll.bulkWrite(ops);

  // Reporte (sobre el estado final en la BD)
  const docs = await coll.find().sort({ nombre: 1 }).toArray();
  const servidores = docs.filter((d) => d.tipo === 'servidor');
  const vivientes = docs.filter((d) => d.tipo === 'viviente');
  const nombresBD = new Set(docs.map((d) => d.nombreNorm));
  const sinCuarto = docs.filter((d) => isEmpty(d.cuarto));
  const noCoinciden = [...cuartos.entries()].filter(([k]) => !nombresBD.has(k)).map(([, v]) => v);
  const sinBus = servidores.filter((d) => isEmpty(d.bus));
  const conNotas = docs.filter((d) => !isEmpty(d.notas));
  const zonas = [...new Set(docs.map((d) => d.zona))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

  const list = (arr, fmt) => arr.forEach((x) => console.log('   - ' + fmt(x)));
  console.log('\n===== REPORTE DE IMPORTACIÓN =====');
  console.log(`Nuevos: ${nuevos} · Con campos rellenados: ${actualizados}`);
  console.log(`Total en BD: ${docs.length}  (servidores: ${servidores.length}, vivientes: ${vivientes.length})`);
  console.log(`\nPersonas sin cuarto: ${sinCuarto.length}`);
  list(sinCuarto, (d) => `${d.nombre} (${d.tipo}, ${d.zona})`);
  console.log(`\nNombres del listado de cuartos sin coincidencia: ${noCoinciden.length}`);
  list(noCoinciden, (v) => `${v.nombre} → ${v.cuarto}`);
  console.log(`\nServidores sin bus: ${sinBus.length}`);
  list(sinBus, (d) => `${d.nombre} (${d.zona})`);
  console.log(`\n⚠ Personas con notas: ${conNotas.length}`);
  list(conNotas, (d) => `${d.nombre}: "${d.notas}"`);
  console.log(`\nZonas distintas (${zonas.length}): ${zonas.join(', ')}`);

  await client.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

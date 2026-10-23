import 'dotenv/config';
import dns from 'node:dns';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';

const { MONGODB_URI, DB_NAME, ADMIN_PASSWORD, PORT = 3000 } = process.env;
const BUSES = ['Avanzada', 'Bus 1', 'Bus 2', 'Bus 3', 'Cuenta Propia'];
const BUSES_NOCHE = ['Bus 1', 'Bus 2', 'Bus 3'];
const grupoBus = (bus) => (bus === 'Avanzada' ? 'avanzada' : BUSES_NOCHE.includes(bus) ? 'noche' : 'otros');

// Algunos DNS (p. ej. el hotspot del iPhone) responden mal a la consulta SRV de Atlas:
// si falla, usar DNS públicos.
if (MONGODB_URI?.startsWith('mongodb+srv://')) {
  const host = new URL(MONGODB_URI).hostname;
  await dns.promises.resolveSrv(`_mongodb._tcp.${host}`).catch(() => dns.setServers(['1.1.1.1', '8.8.8.8']));
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const personas = client.db(DB_NAME).collection('personas');
await personas.createIndex({ nombre: 1 });
await personas.createIndex({ tipo: 1, zona: 1 });

const normName = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use('/api', (req, res, next) => {
  if (!ADMIN_PASSWORD || req.get('x-admin-password') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Clave incorrecta' });
  }
  next();
});

function buildFilter({ tipo, zona, llego, bus, q }) {
  const filter = {};
  if (tipo) filter.tipo = tipo;
  if (zona) filter.zona = zona;
  if (bus === 'sin') filter.bus = null; // también coincide si el campo no existe
  else if (bus === 'noche') filter.bus = { $in: BUSES_NOCHE };
  else if (bus) filter.bus = bus;
  if (llego === 'true') filter.llego = true;
  if (llego === 'false') filter.llego = { $ne: true };
  if (q && normName(q)) filter.nombreNorm = { $regex: escapeRegex(normName(q)) };
  return filter;
}

app.get('/api/personas', async (req, res) => {
  const list = await personas
    .find(buildFilter(req.query))
    .sort({ nombre: 1 })
    .collation({ locale: 'es' })
    .toArray();
  res.json(list);
});

// Arma el $set con los campos permitidos. Devuelve [$set, error].
function buildSet(body) {
  const $set = {};
  if ('llego' in body) {
    $set.llego = body.llego === true;
    $set.horaLlegada = $set.llego ? new Date() : null;
  }
  if ('bus' in body) {
    const bus = body.bus || null;
    if (bus !== null && !BUSES.includes(bus)) return [null, 'Bus inválido'];
    $set.bus = bus;
  }
  if ('cuarto' in body) $set.cuarto = String(body.cuarto ?? '').trim() || null;
  if ('notas' in body) $set.notas = String(body.notas ?? '').trim();
  if ('familia' in body) {
    const familia = String(body.familia ?? '').trim().toUpperCase();
    if (familia && !/^\d{1,2} - [HM]$/.test(familia)) return [null, 'Familia inválida (ej. 1 - M)'];
    $set.familia = familia || null;
  }
  if (!Object.keys($set).length) return [null, 'Nada que actualizar'];
  return [$set, null];
}

// Edición masiva: { ids: [...], ...campos }
app.patch('/api/personas', async (req, res) => {
  const { ids, ...fields } = req.body ?? {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => ObjectId.isValid(id))) {
    return res.status(400).json({ error: 'Selección inválida' });
  }
  const [$set, error] = buildSet(fields);
  if (error) return res.status(400).json({ error });

  const _id = { $in: ids.map((id) => new ObjectId(id)) };
  const { llego, horaLlegada, familia, ...rest } = $set;
  if (Object.keys(rest).length) await personas.updateMany({ _id }, { $set: rest });
  // La familia solo aplica a vivientes
  if ('familia' in $set) await personas.updateMany({ _id, tipo: 'viviente' }, { $set: { familia } });
  // Al marcar llegada no pisar la hora de quienes ya habían llegado
  if ('llego' in $set) await personas.updateMany({ _id, llego: llego ? { $ne: true } : true }, { $set: { llego, horaLlegada } });
  res.json({ ok: true, count: ids.length });
});

app.patch('/api/personas/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
  const [$set, error] = buildSet(req.body ?? {});
  if (error) return res.status(400).json({ error });

  const doc = await personas.findOneAndUpdate(
    { _id: new ObjectId(req.params.id) },
    { $set },
    { returnDocument: 'after' }
  );
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  res.json(doc);
});

app.get('/api/resumen', async (req, res) => {
  const docs = await personas.find({}, { projection: { tipo: 1, zona: 1, bus: 1, familia: 1, llego: 1 } }).toArray();
  const blank = () => ({ total: 0, llegaron: 0, faltan: 0 });
  const add = (obj, d) => {
    obj.total++;
    d.llego ? obj.llegaron++ : obj.faltan++;
  };
  const total = blank();
  const porTipo = { servidor: blank(), viviente: blank() };
  const porZona = {};
  const porBus = {};
  const porZonaDetalle = {}; // zona -> grupo de bus -> tipo -> conteos
  const porFamilia = {}; // solo vivientes
  for (const d of docs) {
    add(total, d);
    add((porTipo[d.tipo] ??= blank()), d);
    add((porZona[d.zona] ??= blank()), d);
    add((porBus[d.bus || 'Sin bus'] ??= blank()), d);
    const grupos = ((porZonaDetalle[d.zona] ??= {})[grupoBus(d.bus)] ??= {});
    add((grupos[d.tipo] ??= blank()), d);
    if (d.tipo === 'viviente') add((porFamilia[d.familia || 'Sin familia'] ??= blank()), d);
  }
  const sinBusServidores = docs.filter((d) => d.tipo === 'servidor' && !d.bus).length;
  res.json({ ...total, porTipo, porZona, porBus, porZonaDetalle, porFamilia, sinBusServidores });
});

app.get('/api/zonas', async (req, res) => {
  const zonas = await personas.distinct('zona');
  res.json(zonas.sort((a, b) => a.localeCompare(b, 'es', { numeric: true })));
});

app.get('/api/export/faltan.csv', async (req, res) => {
  const docs = await personas
    .find({ llego: { $ne: true } })
    .sort({ zona: 1, nombre: 1 })
    .collation({ locale: 'es', numericOrdering: true })
    .toArray();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    ['nombre', 'tipo', 'zona', 'celular', 'cuarto', 'bus'],
    ...docs.map((d) => [d.nombre, d.tipo, d.zona, d.celular, d.cuarto, d.bus]),
  ].map((row) => row.map(cell).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="faltan.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
});

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
